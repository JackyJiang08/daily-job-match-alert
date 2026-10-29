// The hub's login watch (2026-10-29). Every AUTH_CHECK_INTERVAL_MS it asks the Claude CLI for its login
// (`claude auth status`, through the hub's connections probe). Signed out (loggedIn false, authMethod none, or a
// status command that fails) marks the hub's auth state expired, so the sidebar, the Status banner, and the
// Connections card say "Claude signed out", and posts the macOS notification "Claude is signed out. Run claude
// auth login --claudeai" at most once per local day (private/hub/auth-watch.json keeps the day). Signed in
// again clears what the watch itself marked; a failure a run or a letter call reported stays until Refresh or
// the next run that works.
import path from 'node:path';
import { AUTH_EXPIRED_NOTIFICATION } from '../engines/engine-errors.mjs';
import { writeJsonAtomic } from '../json-file.mjs';
import { localDate } from '../time-format.mjs';
import { errorSummary } from '../warnings.mjs';

export const AUTH_CHECK_INTERVAL_MS = 10 * 60 * 1000;
export const AUTH_WATCH_SOURCE = 'login check';

export function authWatchLogPath(hubDirectory) {
  return path.join(hubDirectory, 'auth-watch.json');
}

async function readLog(io, file) {
  try {
    const raw = JSON.parse(await io.readFile(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

// options: io, hubDirectory, now(), probe() → the Claude connection ({ installed, connected, signedOut, reason }),
// authState (ctx.authState), notify(text), timeZone() → the configured zone, intervalMs.
export function createAuthWatch(options) {
  const { io, hubDirectory, probe, authState } = options;
  const now = options.now || (() => new Date());
  const notify = options.notify || (async () => false);
  const timeZone = options.timeZone || (() => 'America/Chicago');
  const intervalMs = Number(options.intervalMs || AUTH_CHECK_INTERVAL_MS);
  const logFile = authWatchLogPath(hubDirectory);
  let timer = null;
  let checking = null;
  let lastCheck = null;

  async function evaluate() {
    const at = now();
    const claude = await probe();
    if (!claude || claude.installed === false) return { at, outcome: 'skipped', reason: 'Claude Code CLI not found' };
    if (claude.signedOut) {
      // The first time it is seen keeps its time; later checks do not move it.
      if (!authState.claude?.expired) authState.expire(claude.reason || 'Claude is signed out', AUTH_WATCH_SOURCE);
      const day = localDate(at, await timeZone());
      const log = await readLog(io, logFile);
      if (log.notifiedOn === day) return { at, outcome: 'signed-out', notified: false };
      await notify(AUTH_EXPIRED_NOTIFICATION);
      await writeJsonAtomic(logFile, { notifiedOn: day, at: at.toISOString() }, { io, mode: 0o600 });
      return { at, outcome: 'signed-out', notified: true };
    }
    if (claude.connected && authState.claude?.expired && authState.claude.source === AUTH_WATCH_SOURCE) authState.clear();
    return { at, outcome: claude.connected ? 'signed-in' : 'not-connected' };
  }

  async function check() {
    if (checking) return checking;
    checking = (async () => {
      try {
        lastCheck = await evaluate();
      } catch (error) {
        lastCheck = { at: now(), outcome: 'error', reason: errorSummary(error) };
      } finally {
        checking = null;
      }
      return lastCheck;
    })();
    return checking;
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { check().catch(() => {}); }, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { check, start, stop, status: () => ({ running: Boolean(timer), intervalMs, lastCheck }) };
}
