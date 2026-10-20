// state/status-summary.json: the newest run's fields the hub's Status page shows (last run, funnel,
// prescreen, usage, sources, quota, review budget, expired login, plan change), so the Status page reads
// this small file and state/reports-index.json instead of a payload of tens of megabytes.
//
//   Writers: the pipeline after every payload write (src/index.mjs, through writeReportPayload), the
//   payload compaction (src/payload-maintenance.mjs), and any letter save or rename (refreshStatusLetters).
//   loadStatusSummary (the hub) checks the summary against the newest reports-index entry: a summary
//   written for another date, or for another mtime or size of the newest payload, is rebuilt from that
//   payload once (one read) and written back.
import fs from 'node:fs/promises';
import path from 'node:path';
import { readPayloadFile, resolvePayloadFile } from './payload-store.mjs';
import { countLetters } from './reports-index.mjs';

export const STATUS_SUMMARY_VERSION = 1;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// The meta fields src/hub/services.mjs buildStatusView (and the quota, sources, login, and plan-change
// views it calls) read from the newest payload.
export const STATUS_META_FIELDS = [
  'date', 'generatedAt', 'lastUpdatedAt', 'completedAt', 'trigger', 'engine', 'scoringModel',
  'matchCount', 'candidateCount', 'reviewedThisRun', 'deferredCount', 'maxReviewedPerRun', 'expiredBacklogCount', 'runsToday',
  'funnel', 'usage', 'prescreen', 'sourceCounts', 'quota', 'budgetAlert', 'budgetHistory', 'authExpired', 'planChange',
];

export function statusSummaryPath(root) {
  return path.join(root, 'state', 'status-summary.json');
}

export async function readStatusSummary(root, io = fs) {
  try {
    const raw = JSON.parse(await io.readFile(statusSummaryPath(root), 'utf8'));
    if (raw?.version === STATUS_SUMMARY_VERSION && raw.source && typeof raw.source === 'object') return raw;
  } catch {}
  return null;
}

export async function writeStatusSummary(root, summary, io = fs) {
  const file = statusSummaryPath(root);
  await io.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await io.writeFile(temp, `${JSON.stringify(summary, null, 2)}\n`);
  await io.rename(temp, file);
}

// `latest` is null when the newest payload is unreadable or malformed (the Status page then says
// "no report yet", as it did when it read the payload itself).
export function statusSummaryOf(date, payload, { mtimeMs = null, size = null, letters = { count: 0 }, now = new Date() } = {}) {
  const valid = Boolean(payload?.meta?.date) && Array.isArray(payload?.matches);
  let latest = null;
  if (valid) {
    const meta = {};
    for (const field of STATUS_META_FIELDS) if (payload.meta[field] !== undefined) meta[field] = payload.meta[field];
    meta.matchCount = payload.meta.matchCount ?? payload.matches.length;
    // The Status page describes the prescreen by its counts; the list of dropped titles stays in the payload.
    if (meta.prescreen && Array.isArray(meta.prescreen.dropped)) meta.prescreen = { ...meta.prescreen, dropped: [] };
    latest = { complete: payload.complete === true, letterCount: letters.count, meta };
  }
  return { version: STATUS_SUMMARY_VERSION, updatedAt: now.toISOString(), source: { date, payloadMtimeMs: mtimeMs, payloadSize: size }, latest };
}

// The pipeline's write. A rewrite of an older date (a recovered report) leaves the newest one in place.
export async function updateStatusSummary(root, payload, { io = fs, now = new Date() } = {}) {
  const date = payload?.meta?.date;
  if (!DATE_PATTERN.test(String(date || ''))) return null;
  const stored = await readStatusSummary(root, io);
  if (stored?.source?.date && stored.source.date > date) return stored;
  const resolved = await resolvePayloadFile(root, date, io);
  const summary = statusSummaryOf(date, payload, { mtimeMs: resolved?.info.mtimeMs ?? null, size: resolved?.info.size ?? null, letters: await countLetters(root, date, io), now });
  await writeStatusSummary(root, summary, io);
  return summary;
}

// After a letter is saved or renamed for the newest date.
export async function refreshStatusLetters(root, date, { io = fs, now = new Date() } = {}) {
  const stored = await readStatusSummary(root, io);
  if (!stored?.latest || stored.source.date !== date) return null;
  const letters = await countLetters(root, date, io);
  const summary = { ...stored, updatedAt: now.toISOString(), latest: { ...stored.latest, letterCount: letters.count } };
  await writeStatusSummary(root, summary, io);
  return summary;
}

// The hub's read: `newest` is the newest reports-index entry. `rebuilt` says whether the payload was read.
export async function loadStatusSummary(root, newest, { io = fs, now = new Date() } = {}) {
  if (!newest) return { summary: null, rebuilt: false };
  const stored = await readStatusSummary(root, io);
  const current = stored && stored.source.date === newest.date && stored.source.payloadMtimeMs === newest.payloadMtimeMs && stored.source.payloadSize === newest.payloadSize;
  if (current) return { summary: stored, rebuilt: false };
  let read = null;
  try { read = await readPayloadFile(root, newest.date, io); } catch {}
  const summary = statusSummaryOf(newest.date, read?.payload || null, { mtimeMs: read?.info.mtimeMs ?? newest.payloadMtimeMs ?? null, size: read?.info.size ?? newest.payloadSize ?? null, letters: await countLetters(root, newest.date, io), now });
  await writeStatusSummary(root, summary, io).catch(() => {});
  return { summary, rebuilt: true };
}

// The payload-shaped view the Status page's helpers take (`latest?.meta?.…`, `latest.complete`).
export function summaryAsPayload(summary) {
  if (!summary?.latest) return null;
  return { complete: summary.latest.complete === true, meta: summary.latest.meta, matches: [] };
}
