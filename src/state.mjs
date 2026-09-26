import { canonicalUrl, sha256, unique } from './utils.mjs';

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
  const baseline = isBaselineEnrichment(job.enrichment);
  for (const url of unique([originalUrl, finalUrl])) {
    const key = sha256(url);
    state.seen[key] = {
      ...state.seen[key],
      url,
      originalUrl,
      finalUrl,
      firstSeen: state.seen[key]?.firstSeen || seenAt,
      lastAttempt: seenAt,
      attempts,
      completed,
      lastEnrichment: job.enrichment || state.seen[key]?.lastEnrichment || 'not_requested',
      lastError: job.enrichmentError || null,
      ...(job.postedAt ? { postedAt: job.postedAt } : {}),
      ...(baseline ? { baseline: true } : {}),
    };
  }
  return { attempts, completed };
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
  return { deferred: Boolean(entry), deferredCount: Number(entry?.deferredCount || 0) };
}

export function markDeferred(state, job, deferredAt) {
  state.deferred = state.deferred && typeof state.deferred === 'object' ? state.deferred : {};
  const key = deferredKey(job);
  const previous = state.deferred[key];
  state.deferred[key] = { url: canonicalUrl(job.finalUrl || job.url) || job.url, deferredCount: Number(previous?.deferredCount || 0) + 1, firstDeferredAt: previous?.firstDeferredAt || deferredAt, lastDeferredAt: deferredAt, postedAt: job.postedAt || previous?.postedAt || null, discoveredAt: job.discoveredAt || previous?.discoveredAt || null };
  return state.deferred[key];
}

// When a posting was published, as far as the queue knows: its posting date, else the moment it was
// first discovered (day-level sources), else the moment it was first deferred.
export function deferralAgeBasis(entry) {
  return entry?.postedAt || entry?.discoveredAt || entry?.firstDeferredAt || null;
}

export function clearDeferred(state, job) {
  if (state?.deferred) delete state.deferred[deferredKey(job)];
}

// Freshness beats completeness: a deferred posting stays eligible only while its posting date (or first
// discovery) is at most `maxAgeHours` old. Older entries leave the queue without being scored or marked
// seen; the next collection simply filters them by the lookback window. Idempotent.
export function expireDeferred(state, now = new Date(), maxAgeHours = 48) {
  if (!state?.deferred || typeof state.deferred !== 'object') return { removed: 0, urls: [] };
  const cutoff = (now instanceof Date ? now : new Date(now)).getTime() - Number(maxAgeHours) * 60 * 60 * 1000;
  const urls = [];
  for (const [key, entry] of Object.entries(state.deferred)) {
    const basis = deferralAgeBasis(entry);
    const stamp = basis ? new Date(basis).getTime() : Number.NaN;
    if (Number.isFinite(stamp) && stamp >= cutoff) continue;
    urls.push(entry?.url || key);
    delete state.deferred[key];
  }
  return { removed: urls.length, urls };
}

export function pruneSeen(state, now = new Date(), retentionDays = 90) {
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
