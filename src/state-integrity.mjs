// Startup integrity check for state/ (the nightly run and the hub both run it).
//
//   Files   every top-level state/*.json except the day payloads (src/payload-store.mjs reads and indexes
//           those) must parse. state.json and ats-boards.json fall back to their own backups when they do
//           not (src/json-file.mjs readJsonWithBackups), so they are reported by their readers instead.
//   Seen    state/integrity.json records how many seen entries state.json held when the pipeline last
//           wrote it. A state.json that now holds less than half of that (replaced, truncated, restored
//           from an old copy, or deleted) would make the next run treat thousands of old postings as new or
//           re-baseline whole boards without a word; the drop goes to the report header, a warning, and
//           the hub's Status banner instead.
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJsonWithBackups, writeJsonAtomic } from './json-file.mjs';
import { formatCount, formatLocalDateTime } from './time-format.mjs';

export const INTEGRITY_VERSION = 1;
// The day payloads (src/payload-store.mjs PAYLOAD_FILE_PATTERN; not imported, so the report renderer can use
// this module without the payload store).
const PAYLOAD_FILE_PATTERN = /^report-payload-\d{4}-\d{2}-\d{2}\.json(\.gz)?$/;
// A drop to less than this share of the recorded count is reported.
export const SEEN_DROP_SHARE = 0.5;
// Files whose readers restore a backup themselves (and warn about it).
export const SELF_HEALING_FILES = ['state.json', 'ats-boards.json'];

export function integrityPath(root) {
  return path.join(root, 'state', 'integrity.json');
}

export function seenCountOf(state) {
  const seen = state?.seen;
  return seen && typeof seen === 'object' && !Array.isArray(seen) ? Object.keys(seen).length : 0;
}

export async function readIntegrityRecord(root, io = fs) {
  try {
    const raw = JSON.parse(await io.readFile(integrityPath(root), 'utf8'));
    return raw && typeof raw === 'object' && Number.isFinite(Number(raw.seenCount)) ? raw : null;
  } catch {
    return null;
  }
}

// Called after every state.json write of the pipeline.
export async function recordSeenCount(root, count, { io = fs, now = new Date() } = {}) {
  const record = { version: INTEGRITY_VERSION, seenCount: Number(count) || 0, recordedAt: now.toISOString() };
  await writeJsonAtomic(integrityPath(root), record, { io });
  return record;
}

// { previous, current, recordedAt, detectedAt } when `current` is below SEEN_DROP_SHARE of the recorded count.
export function seenDrop(record, current, now = new Date()) {
  const previous = Number(record?.seenCount) || 0;
  if (previous <= 0 || !(Number(current) < previous * SEEN_DROP_SHARE)) return null;
  return { previous, current: Number(current) || 0, recordedAt: record.recordedAt || null, detectedAt: now.toISOString() };
}

export function seenDropMessage(drop, timeZone) {
  if (!drop) return null;
  const share = Math.round((1 - drop.current / drop.previous) * 100);
  const when = drop.recordedAt ? ` since it was last written (${formatLocalDateTime(drop.recordedAt, timeZone)})` : '';
  return `state.json lost most of its seen postings: ${formatCount(drop.current)} now against ${formatCount(drop.previous)}${when}, ${share}% fewer. Postings reported before may come back as new and boards may be baselined again. If this was not intended, restore a backup (npm run restore -- <zip>) before the next run.`;
}

// [{ name, ok, error }] for every top-level state/*.json but the payloads and `skip`.
export async function checkStateFiles(root, { io = fs, skip = [] } = {}) {
  const directory = path.join(root, 'state');
  let names = [];
  try { names = await io.readdir(directory); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const results = [];
  for (const name of names.filter(item => item.endsWith('.json') && !PAYLOAD_FILE_PATTERN.test(item) && !skip.includes(item)).sort()) {
    try {
      JSON.parse(await io.readFile(path.join(directory, name), 'utf8'));
      results.push({ name, ok: true });
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EISDIR') continue;
      results.push({ name, ok: false, error: String(error?.message || error).slice(0, 200) });
    }
  }
  return results;
}

// The whole check. `seenCount` is given when the caller has already parsed state.json (the run, the hub's
// state view); otherwise state.json is read here (its backups too, without restoring anything).
export async function checkIntegrity(root, { io = fs, now = new Date(), seenCount = null } = {}) {
  let current = seenCount;
  let stateRestored = null;
  if (current == null) {
    const read = await readJsonWithBackups(path.join(root, 'state', 'state.json'), { io, fallback: {} }).catch(() => ({ value: {}, restored: null }));
    current = seenCountOf(read.value);
    stateRestored = read.restored;
  }
  // state.json itself was parsed by the caller or just above.
  const files = await checkStateFiles(root, { io, skip: ['state.json'] });
  if (stateRestored) files.unshift({ name: 'state.json', ok: false, error: stateRestored.error, backup: stateRestored.from ? path.basename(stateRestored.from) : null });
  const record = await readIntegrityRecord(root, io);
  return {
    checkedAt: now.toISOString(),
    files,
    corrupt: files.filter(file => !file.ok).map(file => file.name),
    stateRestored,
    seen: { current, previous: record ? Number(record.seenCount) : null, recordedAt: record?.recordedAt || null },
    seenDrop: seenDrop(record, current, now),
  };
}
