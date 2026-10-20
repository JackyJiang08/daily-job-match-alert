// Brings the stored day payloads to the form their age calls for (src/payload-store.mjs): slim, gzip after
// GZIP_AFTER_DAYS, archived (matches and Run Summary only) after the retention period.
//
//   mode 'all'   every payload (npm run payloads:compact: the one-time pass over payloads written before the
//                slim rule, with a backup of each file before it is rewritten)
//   mode 'aged'  only payloads past GZIP_AFTER_DAYS (the nightly run: newer payloads are already written slim)
//
// A payload the reports index already records in its target form (same mtime, size, gzip, and form) is
// skipped without being read. Every rewrite updates the reports index entry and, for the newest date, the
// Status summary.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { DEFAULT_RETENTION_DAYS, GZIP_AFTER_DAYS, STORAGE_VERSION, applyStorageTarget, decodePayloadBytes, encodePayload, listPayloadFiles, storageTarget, writePayloadFile } from './payload-store.mjs';
import { readReportsIndex, updateReportsIndex } from './reports-index.mjs';
import { updateStatusSummary } from './status-summary.mjs';

const gzip = promisify(zlib.gzip);

export function backupDirectoryFor(root, now = new Date()) {
  return path.join(root, 'state', 'backups', `payloads-${now.toISOString().replace(/[:.]/g, '-')}`);
}

function inTargetForm(payload, target, compressed) {
  return compressed === target.gzip && payload?.storage?.form === target.form && payload.storage.version === STORAGE_VERSION;
}

// Returns one row per payload: { date, action: 'unchanged' | 'compacted' | 'failed', form, gzip, before,
// after, backup, error }. Sizes are bytes on disk.
export async function maintainPayloads(root, { now = new Date(), retention = DEFAULT_RETENTION_DAYS, gzipAfterDays = GZIP_AFTER_DAYS, mode = 'aged', backupDirectory = null, dryRun = false, io = fs } = {}) {
  const files = (await listPayloadFiles(root, io)).reverse();
  const index = await readReportsIndex(root, io);
  const rows = [];
  for (const { date, file, gzip: compressed } of files) {
    const target = storageTarget(date, now, { retention, gzipAfterDays });
    if (mode === 'aged' && target.age <= gzipAfterDays) continue;
    const info = await io.stat(file).catch(() => null);
    if (!info) continue;
    const entry = index?.dates?.[date];
    if (entry && entry.payloadMtimeMs === info.mtimeMs && entry.payloadSize === info.size && entry.gzip === compressed && compressed === target.gzip && entry.form === target.form) {
      rows.push({ date, action: 'unchanged', form: target.form, gzip: compressed, before: info.size, after: info.size });
      continue;
    }
    let raw;
    let payload;
    try {
      raw = await io.readFile(file);
      payload = await decodePayloadBytes(raw, compressed);
      if (!payload?.meta?.date || !Array.isArray(payload.matches)) throw new Error('payload lacks meta.date or matches[]');
    } catch (error) {
      rows.push({ date, action: 'failed', before: info.size, after: info.size, error: error.message });
      continue;
    }
    if (inTargetForm(payload, target, compressed)) {
      rows.push({ date, action: 'unchanged', form: target.form, gzip: compressed, before: info.size, after: info.size });
      continue;
    }
    const next = applyStorageTarget(payload, target, { now });
    if (dryRun) {
      rows.push({ date, action: 'compacted', form: target.form, gzip: target.gzip, before: info.size, after: (await encodePayload(next, { gzip: target.gzip })).length, dryRun: true });
      continue;
    }
    let backup = null;
    if (backupDirectory) {
      await io.mkdir(backupDirectory, { recursive: true });
      backup = path.join(backupDirectory, `report-payload-${date}.json.gz`);
      await io.writeFile(backup, compressed ? raw : await gzip(raw));
    }
    const written = await writePayloadFile(root, next, { gzip: target.gzip, io });
    await updateReportsIndex(root, next, { io, now }).catch(() => {});
    await updateStatusSummary(root, next, { io, now }).catch(() => {});
    rows.push({ date, action: 'compacted', form: target.form, gzip: target.gzip, before: info.size, after: written.bytes, backup });
  }
  return rows;
}

export function maintenanceTotals(rows) {
  const before = rows.reduce((sum, row) => sum + Number(row.before || 0), 0);
  const after = rows.reduce((sum, row) => sum + Number(row.after || 0), 0);
  return { files: rows.length, compacted: rows.filter(row => row.action === 'compacted').length, failed: rows.filter(row => row.action === 'failed').length, before, after };
}
