// Storage of the day payloads (state/report-payload-<date>.json) and the rules that keep them small.
//
//   Slim       Only the postings that went to the final review (scored by the model, or sent to it and
//              left with local scores when it was unavailable) keep their full JD. Every other posting in
//              `reviewed` (the local prefilter's non-candidates) keeps its title, company, location, source,
//              links, dates, scores, and why it was not reviewed. The title-prefilter and prescreen lists
//              in meta are cut to the same kind of fields. The matches are never touched. The pipeline
//              writes every payload slim, and a same-day rerun merges into the slim payload under the same
//              rule; `npm run payloads:compact` slims the payloads written before this rule.
//   Gzip       A payload more than GZIP_AFTER_DAYS old is stored as report-payload-<date>.json.gz. Every
//              reader goes through readPayloadFile, which takes either form (the plain file wins when both
//              exist: it is the newer write).
//   Archived   A payload older than the retention period (config.reports.payloadRetentionDays, default
//              90, Settings → Pipeline) keeps only its matches and the Run Summary fields of meta.
//
// payload.storage records the form ({ form: 'slim' | 'archived', version, reviewedCount when archived }).
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { isSemanticCandidate } from './subscription-match.mjs';
import { canonicalUrl, sha256 } from './utils.mjs';
import { writeFileAtomic } from './json-file.mjs';

const gunzip = promisify(zlib.gunzip);
const gzip = promisify(zlib.gzip);

export const PAYLOAD_PREFIX = 'report-payload-';
export const PAYLOAD_FILE_PATTERN = /^report-payload-(\d{4}-\d{2}-\d{2})\.json(\.gz)?$/;
export const STORAGE_VERSION = 1;
export const GZIP_AFTER_DAYS = 30;
export const DEFAULT_RETENTION_DAYS = 90;
export const MINIMUM_RETENTION_DAYS = 31;
export const MAXIMUM_RETENTION_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;

export function payloadFilePath(root, date, { gzip: compressed = false } = {}) {
  return path.join(root, 'state', `${PAYLOAD_PREFIX}${date}.json${compressed ? '.gz' : ''}`);
}

export function retentionDays(config) {
  const value = Number(config?.reports?.payloadRetentionDays);
  return Number.isInteger(value) && value >= MINIMUM_RETENTION_DAYS && value <= MAXIMUM_RETENTION_DAYS ? value : DEFAULT_RETENTION_DAYS;
}

// Whole days between the end of the report date (UTC, as the seen-state pruning counts) and now.
export function payloadAgeDays(date, now = new Date()) {
  const end = new Date(`${date}T23:59:59Z`).getTime();
  return Number.isFinite(end) ? Math.floor((now.getTime() - end) / DAY_MS) : 0;
}

// One entry per report date, newest first: { date, file, gzip }. A date stored both ways (a crash between
// writing the .gz and removing the .json) is listed once, with the plain file.
export async function listPayloadFiles(root, io = fs) {
  let names = [];
  try { names = await io.readdir(path.join(root, 'state')); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const byDate = new Map();
  for (const name of names) {
    const match = PAYLOAD_FILE_PATTERN.exec(name);
    if (!match) continue;
    const compressed = Boolean(match[2]);
    if (byDate.has(match[1]) && compressed) continue;
    byDate.set(match[1], { date: match[1], file: path.join(root, 'state', name), gzip: compressed });
  }
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}

// The file that holds a date's payload and its stat, or null.
export async function resolvePayloadFile(root, date, io = fs) {
  for (const compressed of [false, true]) {
    const file = payloadFilePath(root, date, { gzip: compressed });
    const info = await io.stat(file).catch(() => null);
    if (info) return { date, file, gzip: compressed, info };
  }
  return null;
}

export async function decodePayloadBytes(bytes, compressed) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return JSON.parse((compressed ? await gunzip(buffer) : buffer).toString('utf8'));
}

// { payload, file, gzip, info } or null when no file exists; a file that does not parse throws.
export async function readPayloadFile(root, date, io = fs) {
  const resolved = await resolvePayloadFile(root, date, io);
  if (!resolved) return null;
  let bytes;
  try { bytes = await io.readFile(resolved.file); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  return { ...resolved, bytes: bytes.length, payload: await decodePayloadBytes(bytes, resolved.gzip) };
}

export async function encodePayload(payload, { gzip: compressed = false, pretty = true } = {}) {
  const text = pretty ? `${JSON.stringify(payload, null, 2)}\n` : JSON.stringify(payload);
  return compressed ? gzip(Buffer.from(text, 'utf8')) : Buffer.from(text, 'utf8');
}

// Written through writeFileAtomic (temporary file, fsync, rename); the other form of the same date is
// removed afterwards, so a reader always finds exactly one complete file.
export async function writePayloadFile(root, payload, { gzip: compressed = false, io = fs } = {}) {
  const date = payload.meta.date;
  const file = payloadFilePath(root, date, { gzip: compressed });
  const bytes = await encodePayload(payload, { gzip: compressed });
  await writeFileAtomic(file, bytes, { io });
  await io.rm(payloadFilePath(root, date, { gzip: !compressed }), { force: true });
  return { file, gzip: compressed, bytes: bytes.length };
}

// ---------------------------------------------------------------------------------------------- slim

export function reportJobKey(job) {
  return sha256(canonicalUrl(job.finalUrl || job.url) || job.finalUrl || job.url);
}

// The posting went to the final review: the model scored it, or it was sent and kept local scores because
// review was unavailable, or (local_only scoring) it passed the local prefilter that decides who is sent.
export function wentToFinalReview(job) {
  if (job?.jdOmitted) return false;
  if (job?.semanticReviewed === true) return true;
  if (job?.matchLevel === 'unreviewed' || job?.scoringEngine === 'local_fallback') return true;
  return isSemanticCandidate(job || {});
}

// Fields a slim posting keeps: what identifies it (title, company, location, source, links), its dates,
// its scores, why it was not reviewed (eligibility, blockers, exclusionReason), and the few flags the next
// run's merge and seen marking read (semanticReviewed, matchLevel, scoringEngine, enrichment).
export const SLIM_JOB_FIELDS = [
  'title', 'company', 'location', 'source', 'sourceKind', 'url', 'finalUrl', 'originalUrl',
  'postedAt', 'postedAtPrecision', 'freshnessBasis', 'discoveredAt', 'roleType',
  'bestScore', 'scores', 'recommendedTrack', 'matchLevel', 'scoringEngine', 'scoringModel', 'semanticReviewed', 'prescreenScore',
  'eligibility', 'blockers', 'enrichment', 'enrichmentReason', 'enrichmentRetryable',
];

function roleRelevance(job) {
  return Math.max(0, ...Object.values(job.scoreDetails || {}).map(detail => Number(detail?.roleRelevance) || 0));
}

export function exclusionReason(job) {
  if (job.exclusionReason) return job.exclusionReason;
  if (job.eligibility?.exclusion?.reason) return `hard filter: ${job.eligibility.exclusion.reason}`;
  if (Array.isArray(job.blockers) && job.blockers.length) return `blocker: ${job.blockers.join('; ')}`;
  return `not sent to review: role relevance ${roleRelevance(job)} below 14`;
}

export function slimJob(job) {
  if (job?.jdOmitted) return job;
  const slim = {};
  for (const field of SLIM_JOB_FIELDS) if (job[field] !== undefined) slim[field] = job[field];
  // The resolved and original links are kept only when they differ from the URL (every reader falls back to it).
  for (const field of ['finalUrl', 'originalUrl']) if (slim[field] === slim.url) delete slim[field];
  // Alternates (the same requisition on other career-site paths) are marked seen with the primary.
  if (Array.isArray(job.alternates) && job.alternates.length) slim.alternates = job.alternates.map(item => ({ url: item.url }));
  slim.exclusionReason = exclusionReason(job);
  slim.jdOmitted = true;
  return slim;
}

const PREFILTER_FIELDS = ['company', 'title', 'location', 'source', 'url', 'postedAt', 'rule'];
const PRESCREEN_FIELDS = ['url', 'title', 'company', 'location', 'score'];

function pick(item, fields) {
  const result = {};
  for (const field of fields) if (item?.[field] !== undefined) result[field] = item[field];
  return result;
}

function slimMeta(meta) {
  const next = { ...meta };
  if (Array.isArray(meta?.prefilter?.titleExcluded)) next.prefilter = { ...meta.prefilter, titleExcluded: meta.prefilter.titleExcluded.map(item => pick(item, PREFILTER_FIELDS)) };
  if (Array.isArray(meta?.prescreen?.dropped)) next.prescreen = { ...meta.prescreen, dropped: meta.prescreen.dropped.map(item => pick(item, PRESCREEN_FIELDS)) };
  return next;
}

// The payload under the slim rule. Matches (and their copies in `reviewed`) keep everything.
export function slimPayload(payload) {
  const matched = new Set((payload.matches || []).map(reportJobKey));
  const reviewed = (payload.reviewed || []).map(job => (matched.has(reportJobKey(job)) || wentToFinalReview(job) ? job : slimJob(job)));
  const form = payload.storage?.form === 'archived' ? 'archived' : 'slim';
  return { ...payload, meta: slimMeta(payload.meta || {}), reviewed, storage: { ...(payload.storage || {}), form, version: STORAGE_VERSION } };
}

// ---------------------------------------------------------------------------------------------- archive

// The Run Summary (the workbook's first sheet) and the report header, kept after the retention period.
export const RUN_SUMMARY_META_FIELDS = [
  'date', 'applicationDate', 'runDate', 'timeZone', 'generatedAt', 'firstGeneratedAt', 'lastUpdatedAt', 'completedAt', 'completedAtLocal',
  'runsToday', 'trigger', 'engine', 'scoringModel', 'lookbackHours', 'minimumMatchScore', 'resumeTracks',
  'collectedCount', 'reviewedCount', 'matchCount', 'candidateCount', 'reviewedThisRun', 'deferredCount', 'maxReviewedPerRun', 'expiredBacklogCount',
  'reviewedLast90Days', 'runCounts', 'eligibilityExclusions', 'warnings', 'quota', 'authExpired', 'autoLetters',
];

export function archivePayload(payload, { now = new Date() } = {}) {
  if (payload.storage?.form === 'archived') return payload;
  return {
    meta: pick(payload.meta || {}, RUN_SUMMARY_META_FIELDS),
    matches: payload.matches || [],
    reviewed: [],
    complete: payload.complete === true,
    storage: { form: 'archived', version: STORAGE_VERSION, archivedAt: now.toISOString(), reviewedCount: Array.isArray(payload.reviewed) ? payload.reviewed.length : 0 },
  };
}

// The number of postings a payload reviewed, also after it was archived.
export function payloadReviewedCount(payload) {
  if (payload?.storage?.form === 'archived' && payload.storage.reviewedCount != null) return Number(payload.storage.reviewedCount);
  return Array.isArray(payload?.reviewed) ? payload.reviewed.length : 0;
}

// What a payload of this age should become: { form: 'slim' | 'archived', gzip }.
export function storageTarget(date, now, { retention = DEFAULT_RETENTION_DAYS, gzipAfterDays = GZIP_AFTER_DAYS } = {}) {
  const age = payloadAgeDays(date, now);
  return { form: age > retention ? 'archived' : 'slim', gzip: age > gzipAfterDays, age };
}

export function applyStorageTarget(payload, target, { now = new Date() } = {}) {
  const slim = slimPayload(payload);
  return target.form === 'archived' ? archivePayload(slim, { now }) : slim;
}
