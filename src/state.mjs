import { canonicalUrl, sha256, unique } from './utils.mjs';
import { NEW_SINCE_LAST_POLL, freshnessInstant, isNewSinceLastPoll, postedAtPrecision } from './posting-fields.mjs';

export function normalizeState(value) {
  const state = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    ...state,
    seen: state.seen && typeof state.seen === 'object' && !Array.isArray(state.seen) ? state.seen : {},
  };
}

export function seenUrls(job) {
  return unique([job.originalUrl, job.finalUrl, job.url].map(canonicalUrl));
}

function completedEntry(entry) {
  if (!entry) return false;
  if (typeof entry.completed === 'boolean') return entry.completed;
  if (Number.isFinite(Number(entry.attempts))) return Number(entry.attempts) >= 3;
  return true;
}

export function jobSeenStatus(state, job) {
  const seen = normalizeState(state).seen;
  const entries = seenUrls(job).map(url => seen[sha256(url)]).filter(Boolean);
  return {
    attempts: entries.reduce((maximum, entry) => Math.max(maximum, Number(entry.attempts ?? 1) || 0), 0),
    completed: entries.some(completedEntry),
  };
}

export function isJobSeen(state, job) {
  return jobSeenStatus(state, job).completed;
}

// A seen entry written by a source baseline (first poll of a board or list) carries `baseline: true`
// and the posting date the source reported, so a later migration can tell old postings from new ones.
export function isBaselineEnrichment(value) {
  return /_baseline$/.test(String(value || ''));
}

// Seen entries (format 2, 2026-10-29) are keyed by sha256 of the canonical original and final URL (two keys
// when they differ) and hold only what the pipeline reads back:
//   firstSeen     when the posting was first marked (the 90-day retention basis with lastAttempt)
//   lastAttempt   only when it differs from firstSeen
//   attempts, completed          only while a failed enrichment may still be retried, or after more than one
//                                attempt (a missing pair means one attempt, done)
//   baseline, postedAt           only on source-baseline entries (releaseRecentBaselines reads the date)
// The URLs, the enrichment outcome, and the error are not kept: the day payloads hold the postings.
export const SEEN_FORMAT = 2;
export const SEEN_RETENTION_DAYS = 90;

function validInstant(value) {
  if (!value) return null;
  const stamp = new Date(value);
  return Number.isNaN(stamp.getTime()) ? null : String(value);
}

function seenEntry({ firstSeen, lastAttempt, attempts, completed, baseline, postedAt }) {
  const entry = { firstSeen };
  if (lastAttempt && lastAttempt !== firstSeen) entry.lastAttempt = lastAttempt;
  // Kept while a retry may follow, and after more than one attempt (how many it took); a missing pair means one
  // attempt, done.
  if (!completed || attempts > 1) { entry.attempts = attempts; entry.completed = completed; }
  if (baseline) {
    entry.baseline = true;
    if (postedAt) entry.postedAt = postedAt;
  }
  return entry;
}

export function markJobSeen(state, job, seenAt) {
  const normalized = normalizeState(state);
  state.seen = normalized.seen;
  const originalUrl = canonicalUrl(job.originalUrl || job.url);
  const finalUrl = canonicalUrl(job.finalUrl || job.url);
  const previous = jobSeenStatus(state, job);
  const enrichmentFailed = job.enrichment === 'failed';
  const attempts = previous.completed ? previous.attempts : previous.attempts + 1;
  const unrecoverable = enrichmentFailed && job.enrichmentRetryable === false;
  const completed = previous.completed || !enrichmentFailed || unrecoverable || attempts >= 3;
  for (const url of unique([originalUrl, finalUrl])) {
    const key = sha256(url);
    const before = state.seen[key];
    const baseline = isBaselineEnrichment(job.enrichment) || before?.baseline === true;
    state.seen[key] = seenEntry({ firstSeen: before?.firstSeen || seenAt, lastAttempt: seenAt, attempts, completed, baseline, postedAt: job.postedAt || before?.postedAt || null });
  }
  return { attempts, completed };
}

// An entry written before format 2 ({ url, originalUrl, finalUrl, firstSeen, lastAttempt, attempts, completed,
// lastEnrichment, lastError, postedAt, baseline }) in the format-2 shape. Same key, same seen/retry verdict,
// same retention basis; an entry with no readable time gets `now`, so the 90-day retention reaches it too.
export function slimSeenEntry(entry, now = new Date()) {
  const fallback = (now instanceof Date ? now : new Date(now)).toISOString();
  const firstSeen = validInstant(entry?.firstSeen) || validInstant(entry?.lastAttempt) || fallback;
  return seenEntry({
    firstSeen,
    lastAttempt: validInstant(entry?.lastAttempt),
    attempts: Number(entry?.attempts ?? 1) || 1,
    completed: completedEntry(entry),
    baseline: entry?.baseline === true || isBaselineEnrichment(entry?.lastEnrichment),
    postedAt: entry?.postedAt || null,
  });
}

export function isLegacySeenState(state) {
  return Number(state?.seenFormat) !== SEEN_FORMAT;
}

// Rewrites every seen entry in the format-2 shape and marks the state (state.seenFormat). Returns the entry
// count (unchanged: the keys stay).
export function slimSeenState(state, now = new Date()) {
  state.seen = normalizeState(state).seen;
  for (const [key, entry] of Object.entries(state.seen)) state.seen[key] = slimSeenEntry(entry && typeof entry === 'object' ? entry : {}, now);
  state.seenFormat = SEEN_FORMAT;
  return Object.keys(state.seen).length;
}

// One-time, idempotent repair for baselines recorded before postings inside the lookback window were
// exempt from them: baseline entries whose posting date (or, for entries written before the date was
// stored, whose baseline time) falls inside the last `hours` are forgotten so the next run treats them
// as new. Returns the number of entries released.
export function releaseRecentBaselines(state, now = new Date(), hours = 48) {
  const normalized = normalizeState(state);
  state.seen = normalized.seen;
  const cutoff = (now instanceof Date ? now : new Date(now)).getTime() - Number(hours) * 60 * 60 * 1000;
  let released = 0;
  for (const [key, entry] of Object.entries(state.seen)) {
    if (!entry || typeof entry !== 'object') continue;
    if (!(entry.baseline === true || isBaselineEnrichment(entry.lastEnrichment))) continue;
    const basis = entry.postedAt || entry.firstSeen;
    const stamp = basis ? new Date(basis).getTime() : Number.NaN;
    if (!Number.isFinite(stamp) || stamp < cutoff) continue;
    delete state.seen[key];
    released += 1;
  }
  return released;
}

// ---- deferrals: candidates that missed the per-run review budget wait for the next run without
// being marked seen; each miss raises deferredCount so a twice-deferred posting is reviewed first.

function deferredKey(job) {
  return sha256(canonicalUrl(job.finalUrl || job.url) || job.url);
}

export function deferredStatus(state, job) {
  const entry = state?.deferred?.[deferredKey(job)];
  return { deferred: Boolean(entry), deferredCount: Number(entry?.deferredCount || 0), reason: entry ? entry.reason || 'budget' : null, entry: entry || null };
}

// `reason` is 'budget' (the review limit), 'quota' (a refusal), or 'auth' (Claude was signed out); a budget
// deferral is what the report calls carried over, and Settings can switch it off. 'auth' sticks until the
// posting is reviewed: the first run after the login works again takes those first (applyReviewBudget). A posting new since the last board poll keeps that
// basis and its first-seen time, so it is still aged from the night it appeared.
export function markDeferred(state, job, deferredAt, reason = 'budget') {
  state.deferred = state.deferred && typeof state.deferred === 'object' ? state.deferred : {};
  const key = deferredKey(job);
  const previous = state.deferred[key];
  const fresh = isNewSinceLastPoll(job);
  state.deferred[key] = {
    url: canonicalUrl(job.finalUrl || job.url) || job.url, deferredCount: Number(previous?.deferredCount || 0) + 1, firstDeferredAt: previous?.firstDeferredAt || deferredAt, lastDeferredAt: deferredAt,
    postedAt: job.postedAt || previous?.postedAt || null, postedAtPrecision: job.postedAt ? postedAtPrecision(job) : previous?.postedAtPrecision || null, discoveredAt: job.discoveredAt || previous?.discoveredAt || null,
    reason: previous?.reason === 'auth' ? 'auth' : previous?.reason === 'quota' && reason === 'quota' ? 'quota' : reason,
    ...(fresh || previous?.freshnessBasis === NEW_SINCE_LAST_POLL ? { freshnessBasis: NEW_SINCE_LAST_POLL, firstSeenAt: (fresh ? job.firstSeenAt : null) || previous?.firstSeenAt || null } : {}),
  };
  return state.deferred[key];
}

// Drops every budget deferral (entries without a reason are budget deferrals from older versions); quota and
// auth deferrals stay, since the report promised them to the next run. Returns the URLs removed.
export function clearBudgetDeferrals(state) {
  const urls = [];
  for (const [key, entry] of Object.entries(state?.deferred || {})) {
    if (entry?.reason === 'quota' || entry?.reason === 'auth') continue;
    urls.push(entry?.url || key);
    delete state.deferred[key];
  }
  return urls;
}

// Deferral reasons that mean the engine was unavailable: those postings are caught up in a lane of their own
// after the run's new postings (applyReviewBudget in src/index.mjs), and only while they are at most 48 hours old.
export const CATCH_UP_REASONS = ['auth', 'quota'];
export const DEFAULT_CATCH_UP_BUDGET = 40;
export const CATCH_UP_MAX_AGE_HOURS = 48;

// semanticMatching.catchUpBudget: a whole number, 0 = no limit, default 40.
export function catchUpBudgetOf(value) {
  if (value == null || value === '') return DEFAULT_CATCH_UP_BUDGET;
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number >= 0 ? number : DEFAULT_CATCH_UP_BUDGET;
}

// When a posting was published, as far as the queue knows: the night it appeared for a posting new since
// the last board poll, its posting date (a date-only value counts as the end of that local day), else, only
// for a posting with no date at all, the moment it was first discovered, else the moment it was first deferred.
export function deferralAgeBasis(entry, timeZone) {
  if (entry?.freshnessBasis === NEW_SINCE_LAST_POLL && entry.firstSeenAt) return entry.firstSeenAt;
  if (entry?.postedAt) return entry.postedAtPrecision === 'date' ? freshnessInstant({ postedAt: entry.postedAt, postedAtPrecision: 'date' }, timeZone) || entry.postedAt : entry.postedAt;
  return entry?.discoveredAt || entry?.firstDeferredAt || null;
}

// Forgets every seen entry of a posting (original, final, and listed URL), so the next collection treats it as
// new. Returns the number of entries removed.
export function forgetSeen(state, job) {
  const seen = normalizeState(state).seen;
  let removed = 0;
  for (const url of seenUrls(job)) {
    const key = sha256(url);
    if (seen[key]) { delete seen[key]; removed += 1; }
  }
  return removed;
}

export function clearDeferred(state, job) {
  if (state?.deferred) delete state.deferred[deferredKey(job)];
}

// Freshness beats completeness: a deferred posting stays eligible only while its posting date (or first
// discovery) is at most `maxAgeHours` old. Older entries leave the queue without being scored or marked
// seen; the next collection simply filters them by the lookback window. Idempotent.
// Catch-up entries (CATCH_UP_REASONS) use `catchUpMaxAgeHours` when it is shorter.
export function expireDeferred(state, now = new Date(), maxAgeHours = 48, { timeZone = null, catchUpMaxAgeHours = null } = {}) {
  if (!state?.deferred || typeof state.deferred !== 'object') return { removed: 0, urls: [] };
  const at = (now instanceof Date ? now : new Date(now)).getTime();
  const cutoff = at - Number(maxAgeHours) * 60 * 60 * 1000;
  const catchUpCutoff = catchUpMaxAgeHours == null ? cutoff : Math.max(cutoff, at - Number(catchUpMaxAgeHours) * 60 * 60 * 1000);
  const urls = [];
  for (const [key, entry] of Object.entries(state.deferred)) {
    const basis = deferralAgeBasis(entry, timeZone);
    const stamp = basis ? new Date(basis).getTime() : Number.NaN;
    if (Number.isFinite(stamp) && stamp >= (CATCH_UP_REASONS.includes(entry?.reason) ? catchUpCutoff : cutoff)) continue;
    urls.push(entry?.url || key);
    delete state.deferred[key];
  }
  return { removed: urls.length, urls };
}

// The 90-day retention, applied on every run: an entry whose last attempt (or first sighting) is older goes.
export function pruneSeen(state, now = new Date(), retentionDays = SEEN_RETENTION_DAYS) {
  const normalized = normalizeState(state);
  state.seen = normalized.seen;
  const currentTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(currentTime)) throw new Error('pruneSeen now must be a valid date');
  const cutoff = currentTime - Number(retentionDays) * 24 * 60 * 60 * 1000;
  let removed = 0;

  for (const [key, entry] of Object.entries(state.seen)) {
    if (!entry || typeof entry !== 'object') continue;
    // Incomplete enrichment stays retryable for 90 days after its most recent attempt,
    // rather than being aged out from the much older first discovery date.
    const ageBasis = entry.lastAttempt || entry.firstSeen;
    const timestamp = ageBasis ? new Date(ageBasis).getTime() : Number.NaN;
    if (!Number.isFinite(timestamp) || timestamp >= cutoff) continue;
    delete state.seen[key];
    removed += 1;
  }
  return removed;
}
