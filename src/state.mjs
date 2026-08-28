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

export function isJobSeen(state, job) {
  const seen = normalizeState(state).seen;
  return seenUrls(job).some(url => Boolean(seen[sha256(url)]));
}

export function markJobSeen(state, job, seenAt) {
  const normalized = normalizeState(state);
  state.seen = normalized.seen;
  const originalUrl = canonicalUrl(job.originalUrl || job.url);
  const finalUrl = canonicalUrl(job.finalUrl || job.url);
  for (const url of unique([originalUrl, finalUrl])) {
    const key = sha256(url);
    state.seen[key] = {
      ...state.seen[key],
      url,
      originalUrl,
      finalUrl,
      firstSeen: state.seen[key]?.firstSeen || seenAt,
    };
  }
  return state;
}
