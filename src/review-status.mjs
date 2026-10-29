// Whether a model reviewed a posting, and the split every report view makes from it (2026-10-29).
//
// A posting that only got the local triage score because the engine was unavailable (matchLevel
// 'unreviewed', scoringEngine 'local_fallback') never counts as a match: it is not in the match list, the
// xlsx Matches sheet, or the match count, and no automatic letter is written for it. It goes into the
// report's folded "Not reviewed (engine unavailable)" group and the xlsx "Not Reviewed" sheet instead.
// A local_only configuration (no engine at all, on purpose) is not "unavailable" and is left alone.
// Payloads written before this rule may still hold such postings in `matches`; every view splits them out
// at render time, so those days read the same way.
import { canonicalUrl } from './utils.mjs';

export const NOT_REVIEWED_TITLE = 'Not reviewed (engine unavailable)';

export function isNotReviewed(job) {
  return job?.matchLevel === 'unreviewed' || job?.scoringEngine === 'local_fallback';
}

export function isModelReviewed(job) {
  return job?.semanticReviewed === true && !isNotReviewed(job);
}

// What the automatic letters (nightly pass and Generate Missing Letters) may write for: model-reviewed high matches.
export function isLetterCandidate(job) {
  return isModelReviewed(job) && job.matchLevel === 'high';
}

export function notReviewedHeadline(count) {
  return `${count} ${count === 1 ? 'posting was' : 'postings were'} not reviewed by a model`;
}

// { matches, notReviewed } from a payload's `matches` and `reviewed`: the matches without any posting the model
// did not review, and every such posting of the day (from either list, once per URL) that the deterministic
// eligibility rules did not exclude, best local score first.
export function splitReportJobs({ matches = [], reviewed = [] } = {}) {
  const kept = (matches || []).filter(job => !isNotReviewed(job));
  const notReviewed = [];
  const urls = new Set();
  for (const job of [...(matches || []), ...(reviewed || [])]) {
    if (!isNotReviewed(job) || job.eligibility?.exclusion) continue;
    const key = canonicalUrl(job.url) || job.url;
    if (urls.has(key)) continue;
    urls.add(key);
    notReviewed.push(job);
  }
  notReviewed.sort((a, b) => (Number(b.bestScore) || 0) - (Number(a.bestScore) || 0));
  return { matches: kept, notReviewed };
}

// The match count a day shows: meta.matchCount, unless the stored matches still hold postings no model reviewed.
export function reviewedMatchCount(payload) {
  const matches = Array.isArray(payload?.matches) ? payload.matches : [];
  if (matches.some(isNotReviewed)) return matches.filter(job => !isNotReviewed(job)).length;
  return payload?.meta?.matchCount ?? matches.length;
}
