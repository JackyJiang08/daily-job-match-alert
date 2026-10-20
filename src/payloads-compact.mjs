// npm run payloads:compact -- [--dry-run]
// One pass over every stored day payload under the rules of src/payload-store.mjs: slim (full JDs only for
// postings that went to the final review), gzip for payloads more than 30 days old, matches and Run Summary
// only past the retention period (Settings → Pipeline, default 90 days). Each file is backed up to
// state/backups/payloads-<time>/ (gzip) before it is rewritten. Prints the size of every payload before and
// after, and the totals. Takes the run lock, so it never races a run. --dry-run reads and reports only.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { acquireRunLock, releaseRunLock } from './lock.mjs';
import { backupDirectoryFor, maintainPayloads, maintenanceTotals } from './payload-maintenance.mjs';
import { GZIP_AFTER_DAYS, retentionDays } from './payload-store.mjs';
import { syncReportsIndex } from './reports-index.mjs';
import { formatBytes } from './hub/report-timing.mjs';

function arg(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

export function compactReport(rows, { dryRun = false, backupDirectory = null, retention, gzipAfterDays = GZIP_AFTER_DAYS } = {}) {
  const lines = [`${dryRun ? 'Dry run: nothing written. ' : ''}Slim every payload; gzip after ${gzipAfterDays} days; matches and Run Summary only after ${retention} days.`];
  for (const row of rows) {
    const form = row.action === 'failed' ? `failed: ${row.error}` : `${row.action === 'unchanged' ? 'unchanged' : '→'} ${row.form}${row.gzip ? ' (gzip)' : ''}`;
    lines.push(`  ${row.date}  ${formatBytes(row.before).padStart(9)} → ${formatBytes(row.after).padStart(9)}  ${form}`);
  }
  const totals = maintenanceTotals(rows);
  const saved = totals.before ? Math.round((1 - totals.after / totals.before) * 100) : 0;
  lines.push(`Total: ${totals.files} payload(s), ${totals.compacted} rewritten${totals.failed ? `, ${totals.failed} failed` : ''}: ${formatBytes(totals.before)} → ${formatBytes(totals.after)} (${saved}% smaller)`);
  if (backupDirectory && totals.compacted && !dryRun) lines.push(`Backups: ${backupDirectory}`);
  return lines.join('\n');
}

export async function main(argv = process.argv, { now = new Date(), log = line => console.log(line) } = {}) {
  const config = await loadConfig(arg(argv, '--config', 'config.json'));
  const dryRun = argv.includes('--dry-run');
  const lock = await acquireRunLock(path.join(config.root, 'state', '.lock'));
  if (!lock.acquired) {
    log(`A run is in progress (PID ${lock.pid}); try again when it finishes.`);
    return { skipped: true, pid: lock.pid };
  }
  try {
    const retention = retentionDays(config);
    const backupDirectory = dryRun ? null : backupDirectoryFor(config.root, now);
    const rows = await maintainPayloads(config.root, { now, retention, mode: 'all', backupDirectory, dryRun });
    if (!dryRun) await syncReportsIndex(config.root, { now });
    log(compactReport(rows, { dryRun, backupDirectory, retention }));
    return { rows, totals: maintenanceTotals(rows), backupDirectory };
  } finally {
    await releaseRunLock(lock).catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
