// state/reports-index.json: one small entry per report date, so the hub's Reports list and sidebar never
// read the day payloads (a busy night's payload is tens of megabytes; 50 of them took about two seconds
// per page). Each entry holds the generation time, the match count, the deferred ("carried to the next
// run") and carried-over counts, the letter count, whether the day is complete, the few fields the sidebar
// and Settings show (last run time, the quota events, an expired login), and the payload's mtime and size.
//
//   Writers: the pipeline after every payload write (src/index.mjs), and any letter save or rename
//   (the hub and the nightly letters pass) through refreshIndexLetters.
//   syncReportsIndex (the hub) stats the payloads, rebuilds an entry whose payload mtime or size no
//   longer matches (or that is missing: the first call builds the whole index from the payloads once),
//   recounts letters whose date directory changed, drops dates whose payload is gone, and writes the
//   file back only when something changed. Stats are cheap; no payload is read once the index is current.
//   A payload stored as .json.gz (src/payload-store.mjs) is read the same way; the entry records the form.
import fs from 'node:fs/promises';
import path from 'node:path';
import { listPayloadFiles, payloadReviewedCount, readPayloadFile, resolvePayloadFile } from './payload-store.mjs';

export const REPORTS_INDEX_VERSION = 2;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const COMPANY_PATTERN = /^[A-Za-z0-9]{1,80}$/;

export function reportsIndexPath(root) {
  return path.join(root, 'state', 'reports-index.json');
}

function lettersDatePath(root, date) {
  return path.join(root, 'private', 'cover-letters', date);
}

async function statOrNull(io, file) {
  try { return await io.stat(file); } catch { return null; }
}

export async function readReportsIndex(root, io = fs) {
  try {
    const raw = JSON.parse(await io.readFile(reportsIndexPath(root), 'utf8'));
    if (raw?.version === REPORTS_INDEX_VERSION && raw.dates && typeof raw.dates === 'object' && !Array.isArray(raw.dates)) return raw;
  } catch {}
  return null;
}

// Written to a temporary file and renamed, so a reader never sees half an index.
export async function writeReportsIndex(root, index, io = fs) {
  const file = reportsIndexPath(root);
  await io.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await io.writeFile(temp, `${JSON.stringify(index, null, 2)}\n`);
  await io.rename(temp, file);
}

// Letters saved for a report date: private/cover-letters/<date>/<Company>/letter.json.
export async function countLetters(root, date, io = fs) {
  const directory = lettersDatePath(root, date);
  const info = await statOrNull(io, directory);
  if (!info) return { count: 0, mtimeMs: null };
  let names = [];
  try { names = await io.readdir(directory); } catch { return { count: 0, mtimeMs: info.mtimeMs }; }
  let count = 0;
  for (const name of names.filter(item => COMPANY_PATTERN.test(item))) {
    if (await statOrNull(io, path.join(directory, name, 'letter.json'))) count += 1;
  }
  return { count, mtimeMs: info.mtimeMs };
}

// The entry for one payload. An unreadable or malformed payload still gets an entry (no counts), the
// same as the list showed before.
export function indexEntry(date, payload, { mtimeMs = null, size = null, gzip = false, letters = { count: 0, mtimeMs: null } } = {}) {
  const valid = Boolean(payload?.meta?.date) && Array.isArray(payload?.matches);
  const meta = valid ? payload.meta : {};
  return {
    date,
    valid,
    generatedAt: meta.generatedAt || null,
    lastUpdatedAt: meta.lastUpdatedAt || null,
    completedAt: meta.completedAt || null,
    matchCount: valid ? (meta.matchCount ?? payload.matches.length) : null,
    deferredCount: valid ? Number(meta.deferredCount || 0) : null,
    carriedCount: valid ? payload.matches.filter(job => job?.carriedOver).length : null,
    letterCount: letters.count,
    // meta.matchCount as written (the Status page's last 7 days show it, or nothing when absent).
    metaMatchCount: valid ? (meta.matchCount ?? null) : null,
    reviewedCount: valid ? payloadReviewedCount(payload) : null,
    warningsCount: valid && Array.isArray(meta.warnings) ? meta.warnings.length : 0,
    complete: valid && payload.complete === true,
    quotaLastEvent: meta.quota?.lastEvent || null,
    quotaEvents: Array.isArray(meta.quota?.events) ? meta.quota.events : [],
    authExpired: meta.authExpired || null,
    form: valid ? (payload.storage?.form || 'full') : null,
    gzip,
    payloadMtimeMs: mtimeMs,
    payloadSize: size,
    lettersMtimeMs: letters.mtimeMs,
  };
}

async function readPayloadOrNull(root, date, io) {
  try { return (await readPayloadFile(root, date, io))?.payload || null; } catch { return null; }
}

function emptyIndex() {
  return { version: REPORTS_INDEX_VERSION, updatedAt: null, dates: {} };
}

// The pipeline's write: the payload it just wrote is in memory, so only stats are needed.
export async function updateReportsIndex(root, payload, { io = fs, now = new Date() } = {}) {
  const date = payload?.meta?.date;
  if (!DATE_PATTERN.test(String(date || ''))) return null;
  const resolved = await resolvePayloadFile(root, date, io);
  const index = (await readReportsIndex(root, io)) || emptyIndex();
  index.dates[date] = indexEntry(date, payload, { mtimeMs: resolved?.info.mtimeMs ?? null, size: resolved?.info.size ?? null, gzip: resolved?.gzip === true, letters: await countLetters(root, date, io) });
  index.updatedAt = now.toISOString();
  await writeReportsIndex(root, index, io);
  return index.dates[date];
}

// After a letter is saved or renamed: only the letter count of that date changes.
export async function refreshIndexLetters(root, date, { io = fs, now = new Date() } = {}) {
  if (!DATE_PATTERN.test(String(date || ''))) return null;
  const index = await readReportsIndex(root, io);
  if (!index?.dates?.[date]) return null;
  const letters = await countLetters(root, date, io);
  index.dates[date] = { ...index.dates[date], letterCount: letters.count, lettersMtimeMs: letters.mtimeMs };
  index.updatedAt = now.toISOString();
  await writeReportsIndex(root, index, io);
  return index.dates[date];
}

// The hub's read: entries newest first, the index brought up to date first. `rebuilt` lists the dates
// whose payload had to be read.
export async function syncReportsIndex(root, { io = fs, now = new Date() } = {}) {
  const files = await listPayloadFiles(root, io);
  const dates = files.map(item => item.date);
  const stored = await readReportsIndex(root, io);
  const index = stored || emptyIndex();
  let changed = !stored;
  const rebuilt = [];
  for (const { date, file, gzip } of files) {
    const info = await statOrNull(io, file);
    const entry = index.dates[date];
    if (!entry || !info || entry.payloadMtimeMs !== info.mtimeMs || entry.payloadSize !== info.size || entry.gzip !== gzip) {
      const payload = await readPayloadOrNull(root, date, io);
      index.dates[date] = indexEntry(date, payload, { mtimeMs: info?.mtimeMs ?? null, size: info?.size ?? null, gzip, letters: await countLetters(root, date, io) });
      rebuilt.push(date);
      changed = true;
      continue;
    }
    const lettersInfo = await statOrNull(io, lettersDatePath(root, date));
    if ((lettersInfo?.mtimeMs ?? null) !== (entry.lettersMtimeMs ?? null)) {
      const letters = await countLetters(root, date, io);
      index.dates[date] = { ...entry, letterCount: letters.count, lettersMtimeMs: letters.mtimeMs };
      changed = true;
    }
  }
  for (const date of Object.keys(index.dates)) {
    if (!dates.includes(date)) { delete index.dates[date]; changed = true; }
  }
  if (changed) {
    index.updatedAt = now.toISOString();
    await writeReportsIndex(root, index, io).catch(() => {});
  }
  return { entries: dates.map(date => index.dates[date]), rebuilt, changed };
}

// The sidebar and Settings read the latest day's run fields through this payload-shaped view.
export function entryAsPayload(entry) {
  if (!entry || !entry.valid) return null;
  return {
    complete: entry.complete === true,
    meta: { date: entry.date, generatedAt: entry.generatedAt, lastUpdatedAt: entry.lastUpdatedAt, completedAt: entry.completedAt, authExpired: entry.authExpired, quota: entry.quotaLastEvent || entry.quotaEvents?.length ? { lastEvent: entry.quotaLastEvent || undefined, events: entry.quotaEvents || [] } : undefined, matchCount: entry.matchCount },
    matches: [],
  };
}
