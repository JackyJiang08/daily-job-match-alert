// Editor notes come in two kinds. needs-review: something only the owner can settle before sending (a
// detail the resume and playbook do not support, a salutation that names another company than the body,
// a number the evidence does not carry, a letter still too long). info: how the letter was made (engines,
// models, effort, fallbacks, condensing, layout) and fixes the editor already applied (dashes, bullets,
// wording). Cards show only the needs-review count; info stays in the Open Letter footer. The notes are
// stored as plain strings, so older letters classify the same way.
const NEEDS_REVIEW = [
  /^\s*unverified detail\b/i,
  /\bsalutation says\b.*\bbody says\b/i,
  /\b(?:not|never) (?:appear|appears|found|present|supported|traceable)\b.*\b(?:resume|playbook|evidence)\b/i,
  /\b(?:resume|playbook|evidence)\b.*\b(?:does not|doesn't|do not) (?:contain|mention|support|include|show)\b/i,
  /\bcannot (?:find|verify|be (?:found|verified|traced))\b/i,
  /\bmix(?:es|ing)? (?:two|numbers from|metrics from)\b/i,
  /\bstill runs to \d+ pages\b/i,
  /\bfabricat|\binvented\b|\bnot verifiable\b/i,
];
const INFO = [
  /\b(?:dash|dashes|em dash|en dash|bullet)\b/i,
];

export function noteLevel(note) {
  const text = String(note || '');
  if (INFO.some(pattern => pattern.test(text)) && !/^\s*unverified detail\b/i.test(text)) return 'info';
  return NEEDS_REVIEW.some(pattern => pattern.test(text)) ? 'needs-review' : 'info';
}

// { needsReview: string[], info: string[] }
export function classifyEditorNotes(notes) {
  const out = { needsReview: [], info: [] };
  for (const note of Array.isArray(notes) ? notes : []) {
    const text = String(note || '').trim();
    if (!text) continue;
    (noteLevel(text) === 'needs-review' ? out.needsReview : out.info).push(text);
  }
  return out;
}

// The card badge: "Check N details" with the items on hover, or null when nothing needs review.
export function reviewBadge(notes) {
  const { needsReview } = classifyEditorNotes(notes);
  if (!needsReview.length) return null;
  return { key: 'letter-check', label: `Check ${needsReview.length} detail${needsReview.length === 1 ? '' : 's'}`, tone: 'warn', title: needsReview.join('\n') };
}
