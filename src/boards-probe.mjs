// npm run boards:probe -- [--limit 20] [--kind workday] [--board <key>] [--all]
// Polls a handful of registered ATS boards and prints, per board, the outcome and the reason behind a
// failure (error.cause: ENOTFOUND, ECONNRESET, UND_ERR_CONNECT_TIMEOUT, a certificate error, an HTTP
// status). Read-only: no scoring, no state or registry write, no snapshot, no notification, and no
// subscription CLI is started. Each board gets one request (one page for Workday and SmartRecruiters).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATS_KINDS, OUTAGE_MINIMUM_FAILURES, OUTAGE_SHARE, boardLabel, causeTally, causeTallyText, pollBoard, readRegistry, registryPath } from './collectors/ats-boards.mjs';
import { loadConfig } from './config.mjs';
import { mapLimit } from './utils.mjs';
import { errorCause, errorSummary, isNetworkError } from './warnings.mjs';

export const DEFAULT_PROBE_LIMIT = 20;

// Without --board or --kind: the enabled, non-dormant boards taken in turn from each ATS kind (so 20
// boards are 4 Greenhouse, 4 Lever, 4 Ashby, 4 Workday, 4 SmartRecruiters when each has that many).
// --all includes dormant and disabled boards.
export function pickProbeBoards(registry, { limit = DEFAULT_PROBE_LIMIT, kinds = [], keys = [], all = false } = {}) {
  const boards = Object.values(registry.boards).filter(board => board && typeof board === 'object');
  if (keys.length) return keys.map(key => registry.boards[key]).filter(Boolean);
  const eligible = boards
    .filter(board => all || (board.enabled !== false && !board.dormant))
    .filter(board => !kinds.length || kinds.includes(board.kind))
    .sort((a, b) => String(a.key).localeCompare(String(b.key)));
  const byKind = new Map();
  for (const board of eligible) {
    if (!byKind.has(board.kind)) byKind.set(board.kind, []);
    byKind.get(board.kind).push(board);
  }
  const queues = Object.keys(ATS_KINDS).map(kind => byKind.get(kind) || []).filter(queue => queue.length);
  const picked = [];
  while (picked.length < limit && queues.some(queue => queue.length)) {
    for (const queue of queues) if (queue.length && picked.length < limit) picked.push(queue.shift());
  }
  return picked;
}

export async function probeBoards(boards, { fetchImpl = fetch, network = {}, lookbackHours = 24, now = new Date(), concurrency = 3, clock = () => Date.now() } = {}) {
  const headers = { 'user-agent': network.userAgent || 'DailyJobMatchAlert/0.1' };
  return mapLimit(boards, Math.max(1, Number(concurrency) || 1), async original => {
    // A copy: the probe never touches the registry's etags or counters.
    const board = { ...original };
    const started = clock();
    try {
      const polled = await pollBoard(board, { fetchImpl, headers, timeoutMs: network.timeoutMs, now, lookbackHours, conditional: false, maximumWorkdayPages: 1, maximumSmartRecruitersPages: 1 });
      return { key: board.key, label: boardLabel(board), kind: board.kind, ok: true, status: polled.status, jobs: polled.jobs.length, ms: clock() - started, error: null, code: null, network: false };
    } catch (error) {
      return { key: board.key, label: boardLabel(board), kind: board.kind, ok: false, status: Number.isInteger(error?.status) ? error.status : null, jobs: null, ms: clock() - started, error: errorSummary(error), code: errorCause(error)?.code || null, network: isNetworkError(error), raw: error };
    }
  });
}

export function probeSummary(results) {
  const failed = results.filter(result => !result.ok);
  const unreachable = failed.filter(result => result.network);
  const localNetwork = unreachable.length >= Math.min(OUTAGE_MINIMUM_FAILURES, results.length) && unreachable.length > results.length * OUTAGE_SHARE;
  return { probed: results.length, ok: results.length - failed.length, failed: failed.length, unreachable: unreachable.length, causes: causeTally(failed.map(result => result.raw), 5), localNetwork };
}

export function formatProbe(results, summary) {
  const lines = results.map(result => result.ok
    ? `OK    ${result.label} [${result.key}] HTTP ${result.status}, ${result.jobs} posting(s), ${result.ms} ms`
    : `FAIL  ${result.label} [${result.key}] ${result.error}${result.code ? ` [cause ${result.code}]` : ''}${result.network ? ' (no answer: network)' : ''}, ${result.ms} ms`);
  lines.push('');
  lines.push(`${summary.ok} of ${summary.probed} board(s) answered; ${summary.failed} failed${summary.failed ? ` (${causeTallyText(summary.causes)})` : ''}.`);
  if (summary.localNetwork) lines.push(`Most boards gave no answer at all: this looks like this Mac's network (DNS, Wi-Fi, VPN, or sleep), not the boards.`);
  lines.push('Nothing was scored or saved; state/ was not changed.');
  return lines.join('\n');
}

function argValues(argv, name) {
  const values = [];
  argv.forEach((value, index) => { if (value === name && argv[index + 1]) values.push(argv[index + 1]); });
  return values;
}

export async function runProbe(argv = process.argv.slice(2), { log = console.log, fetchImpl, load = loadConfig } = {}) {
  const configPath = argValues(argv, '--config')[0] || 'config.json';
  const config = await load(configPath, { notify: () => {} });
  const limitText = argValues(argv, '--limit')[0];
  const limit = limitText == null ? DEFAULT_PROBE_LIMIT : Number.parseInt(limitText, 10);
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`--limit must be a positive whole number, not "${limitText}"`);
  const registry = await readRegistry(registryPath(config));
  const boards = pickProbeBoards(registry, { limit, kinds: argValues(argv, '--kind'), keys: argValues(argv, '--board'), all: argv.includes('--all') });
  if (!boards.length) {
    log(`No ATS boards to probe in ${path.relative(process.cwd(), registryPath(config)) || registryPath(config)}.`);
    return { results: [], summary: probeSummary([]) };
  }
  log(`Probing ${boards.length} board(s), ${Number(config.network?.concurrency || 3)} at a time…`);
  const results = await probeBoards(boards, { network: config.network || {}, lookbackHours: config.lookbackHours, concurrency: config.network?.concurrency || 3, ...(fetchImpl ? { fetchImpl } : {}) });
  const summary = probeSummary(results);
  log(formatProbe(results, summary));
  return { results, summary };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runProbe().catch(error => {
    console.error(errorSummary(error));
    process.exitCode = 1;
  });
}
