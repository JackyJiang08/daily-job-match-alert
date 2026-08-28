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
    };
  }
  return { attempts, completed };
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
