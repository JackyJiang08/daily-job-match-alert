// Auto catch-up after a network outage. A nightly run cut short by this Mac's network leaves
// state.incompleteRun (see recordIncompleteRun in src/index.mjs). Every CHECK_INTERVAL_MS the hub checks
// whether it can redo it now, and when every condition holds it starts the same run as Run Now
// (trigger auto_catchup) and posts "Network back, catching up tonight's run". The conditions:
//   - Settings > Pipeline "Auto catch-up after network outage" is on (config.autoCatchUp.enabled);
//   - an incomplete record exists, fewer than MAXIMUM_ATTEMPTS catch-ups were started for its date, and
//     the next scheduled nightly run after it has not come (that run takes over from then on);
//   - the Mac has not slept since the previous check (the wall clock did not run ahead of the monotonic
//     clock by CLOCK_JUMP_MS; a maintenance wake shows up the same way);
//   - light probes of GitHub and a Greenhouse endpoint both answer;
//   - no run holds the lock.
// Attempts are counted in private/hub/auto-catchup.json, so a hub restart does not reset the cap. The
// pipeline clears the record when the catch-up collects normally.
import path from 'node:path';
import { CLOCK_JUMP_MS, createRunClock } from '../collectors/ats-boards.mjs';
import { errorSummary } from '../warnings.mjs';
import { writeJsonAtomic } from '../json-file.mjs';

export const CHECK_INTERVAL_MS = 10 * 60 * 1000;
export const MAXIMUM_ATTEMPTS = 2;
export const CATCH_UP_NOTIFICATION = "Network back, catching up tonight's run";
export const PROBE_URLS = [
  { name: 'GitHub', url: 'https://api.github.com/' },
  { name: 'Greenhouse', url: 'https://boards-api.greenhouse.io/v1/boards/greenhouse' },
];
const PROBE_TIMEOUT_MS = 10_000;

export function autoCatchUpEnabled(config) {
  return config?.autoCatchUp?.enabled !== false;
}

// Both endpoints must answer with a 2xx; any failure names the endpoint and the reason.
export async function probeNetwork({ fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS, urls = PROBE_URLS } = {}) {
  const results = await Promise.all(urls.map(async ({ name, url }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { headers: { 'user-agent': 'DailyJobMatchAlert/0.1', accept: 'application/json' }, signal: controller.signal });
      await response.body?.cancel?.().catch(() => {});
      return response.ok ? { name, ok: true } : { name, ok: false, error: `HTTP ${response.status}` };
    } catch (error) {
      return { name, ok: false, error: error?.name === 'AbortError' ? `timeout after ${timeoutMs} ms` : errorSummary(error) };
    } finally {
      clearTimeout(timer);
    }
  }));
  const failed = results.filter(result => !result.ok);
  return { ok: failed.length === 0, results, error: failed.map(result => `${result.name}: ${result.error}`).join('; ') || null };
}

export function catchUpLogPath(hubDirectory) {
  return path.join(hubDirectory, 'auto-catchup.json');
}

async function readLog(io, file) {
  try {
    const raw = JSON.parse(await io.readFile(file, 'utf8'));
    return { attempts: raw?.attempts && typeof raw.attempts === 'object' && !Array.isArray(raw.attempts) ? raw.attempts : {} };
  } catch {
    return { attempts: {} };
  }
}

async function writeLog(io, file, log) {
  await writeJsonAtomic(file, log, { io, mode: 0o600 });
}

// options: readState() → state, loadConfig() → config, schedule() → { hour, minute }, nextScheduledRun
// (instant, timeZone, hour, minute) → Date, runManager ({ availability, start }), notify(text), io,
// hubDirectory, now(), probe(), clock (createRunClock-like, reset on each check), intervalMs.
export function createAutoCatchUp(options) {
  const { io, hubDirectory, runManager, readState, loadConfig, schedule, nextScheduledRun } = options;
  const now = options.now || (() => new Date());
  const probe = options.probe || (() => probeNetwork());
  const notify = options.notify || (async () => false);
  const intervalMs = Number(options.intervalMs || CHECK_INTERVAL_MS);
  const newClock = options.newClock || (() => createRunClock());
  const logFile = catchUpLogPath(hubDirectory);
  // The previous check (or hub start): a sleep since then shows as a clock jump.
  let clock = newClock();
  let lastCheck = null;
  let nextCheckAt = new Date(now().getTime() + intervalMs).toISOString();
  let timer = null;
  let checking = null;

  async function evaluate() {
    const at = now();
    const jumpMs = clock.jumpMs();
    clock = newClock();
    const config = await loadConfig();
    if (!autoCatchUpEnabled(config)) return { at, outcome: 'off', reason: 'Auto catch-up after network outage is switched off in Settings' };
    const state = await readState();
    const record = state?.incompleteRun && typeof state.incompleteRun === 'object' ? state.incompleteRun : null;
    if (!record) return { at, outcome: 'idle', reason: 'No incomplete run' };
    const { hour, minute } = await schedule();
    const deadline = nextScheduledRun(new Date(record.firstAt || record.at), config.timeZone || 'America/Chicago', hour, minute);
    if (deadline && at >= deadline) return { at, outcome: 'expired', record, deadline, reason: `The nightly run at ${deadline.toISOString()} takes over` };
    const log = await readLog(io, logFile);
    const attempts = Array.isArray(log.attempts[record.date]) ? log.attempts[record.date] : [];
    if (attempts.length >= MAXIMUM_ATTEMPTS) return { at, outcome: 'limit', record, deadline, attempts: attempts.length, reason: `Already caught up ${attempts.length} time(s) for ${record.date}` };
    if (jumpMs >= CLOCK_JUMP_MS) return { at, outcome: 'waiting', record, deadline, attempts: attempts.length, reason: `The Mac was asleep since the last check (clock jumped ${Math.round(jumpMs / 60_000)} min)` };
    const network = await probe();
    if (!network.ok) return { at, outcome: 'waiting', record, deadline, attempts: attempts.length, reason: `Network still down: ${network.error}` };
    const gate = await runManager.availability();
    if (!gate.available) return { at, outcome: 'waiting', record, deadline, attempts: attempts.length, reason: gate.reason };
    // Counted before starting, so a run that dies early still uses up an attempt.
    log.attempts[record.date] = [...attempts, { at: at.toISOString(), reason: record.reason }];
    for (const date of Object.keys(log.attempts).sort().slice(0, -14)) delete log.attempts[date];
    await writeLog(io, logFile, log);
    try {
      await runManager.start({ trigger: 'auto_catchup' });
    } catch (error) {
      return { at, outcome: 'waiting', record, deadline, attempts: attempts.length + 1, reason: `Could not start the run: ${errorSummary(error)}` };
    }
    await notify(CATCH_UP_NOTIFICATION).catch(() => {});
    return { at, outcome: 'started', record, deadline, attempts: attempts.length + 1, reason: CATCH_UP_NOTIFICATION };
  }

  async function check() {
    if (checking) return checking;
    checking = (async () => {
      try {
        lastCheck = await evaluate();
      } catch (error) {
        lastCheck = { at: now(), outcome: 'error', reason: errorSummary(error) };
      } finally {
        nextCheckAt = new Date(now().getTime() + intervalMs).toISOString();
        checking = null;
      }
      return lastCheck;
    })();
    return checking;
  }

  function start() {
    if (timer) return;
    nextCheckAt = new Date(now().getTime() + intervalMs).toISOString();
    timer = setInterval(() => { check().catch(() => {}); }, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  // For the Status page: the last check, when the next one runs, and the attempts for the open record.
  async function status(state = null) {
    const record = state?.incompleteRun && typeof state.incompleteRun === 'object' ? state.incompleteRun : null;
    const log = await readLog(io, logFile);
    const attempts = record && Array.isArray(log.attempts[record.date]) ? log.attempts[record.date] : [];
    return {
      running: Boolean(timer), intervalMs, nextCheckAt: timer ? nextCheckAt : null, maximumAttempts: MAXIMUM_ATTEMPTS,
      attempts: attempts.length, attemptLog: attempts,
      lastCheck: lastCheck ? { ...lastCheck, at: lastCheck.at instanceof Date ? lastCheck.at.toISOString() : lastCheck.at, deadline: lastCheck.deadline instanceof Date ? lastCheck.deadline.toISOString() : lastCheck.deadline || null, record: undefined } : null,
    };
  }

  return { check, start, stop, status };
}
