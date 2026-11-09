// Automatic checks of a v2 letter body (2026-11-08, part D of the outside review). Each check has an id and a
// pass/fail result; a failure becomes a needs-review editor note "check failed (<id>): …", which keeps the
// "Check N details" badge on the card until the owner marks the details checked. A few things are fixed in
// place before rendering and noted as info ("auto-fix: …"): symbols that stand for words ("8.2%" → "8.2
// percent", "≥85" → "at least 85", "500K+" → "more than 500,000"), title separators (" - " → ", "), and a
// thank-you sentence other than the one assigned to the letter (recent.mjs pickClosing).
// Nothing here calls a model.
import { availabilityConflicts, mentionsMasters } from './availability.mjs';
import { experiencesIn, numberWhitelist, numbersOutside, repeatedMetrics, resumeExperiences } from './evidence.mjs';
import { MAX_CANDID_GAPS } from './rules-v2.mjs';
import { closingKey, closingOf, openingShape } from './recent.mjs';

export const CHECK_IDS = [
  'opening', 'banned-phrases', 'principle-openers', 'symbols', 'title-separators', 'graduation-once', 'availability', 'masters',
  'numbers', 'metric-repeat', 'scenario', 'jd-echo', 'candid', 'scoring-evidence', 'one-page', 'opening-variety', 'closing',
];
export const CHECK_LABELS = {
  'opening': 'Opening', 'banned-phrases': 'Banned Phrases', 'principle-openers': 'Principle Openers', 'symbols': 'Symbols',
  'title-separators': 'Title Separators', 'graduation-once': 'Graduation Once', 'availability': 'Availability', 'masters': "Master's Mention",
  'numbers': 'Number Whitelist', 'metric-repeat': 'Metric Once', 'scenario': 'Scenario', 'jd-echo': 'JD Echo', 'candid': 'Candid Paragraph',
  'scoring-evidence': 'Scoring Evidence', 'one-page': 'One Page', 'opening-variety': 'Opening Variety', 'closing': 'Closing Rotation',
};
export const SCORING_EVIDENCE_NOTE = 'scoring evidence not on selected resume';
const BANNED_PHRASES = ['Thank you for considering my application', 'translates directly', 'translate directly'];
// Descriptors the review found attached to resume facts that the resume never states.
const SCENARIO_PHRASES = ['translates directly', 'translate directly', 'production-grade', 'production grade', 'previously inaccessible', 'searchable', 'responsive'];
const PRINCIPLE_OPENER = /^\s*I (?:work from|work by|believe)\b/i;
const OPENING = /^\s*I am (?:writing to|applying for)\b/i;
const WRITING_TO = /^\s*I am writing to\b/i;

function sentences(text) {
  return String(text || '').match(/[^.!?]+(?:[.!?]+|$)/g)?.map(item => item.trim()).filter(Boolean) || [];
}

function words(text) {
  return String(text || '').toLowerCase().replace(/[“”"’']/g, '').match(/[a-z0-9]+(?:[-'][a-z0-9]+)*/g) || [];
}

export function wordCount(paragraphs) {
  return (paragraphs || []).join(' ').split(/\s+/).filter(Boolean).length;
}

// The longest run of consecutive words a sentence shares with the posting.
export function sharedRun(sentence, postingText) {
  const posting = ` ${words(postingText).join(' ')} `;
  const list = words(sentence);
  let best = 0;
  for (let start = 0; start < list.length; start += 1) {
    for (let end = start + best + 1; end <= list.length; end += 1) {
      if (posting.includes(` ${list.slice(start, end).join(' ')} `)) best = end - start;
      else break;
    }
  }
  return best;
}

function formatThousands(value) {
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: 3 });
}

// Symbols that stand for words, rewritten; returns { text, fixed: [kinds] }. "×" stays (no safe rewrite) and
// fails the symbols check.
export function fixSymbols(text) {
  const fixed = new Set();
  let out = String(text);
  out = out.replace(/(more than |over )?(\$?)(\d+(?:\.\d+)?)\s?([KkMm])\+/g, (all, lead, dollar, number, unit) => {
    fixed.add('K+');
    const value = Number(number) * (/[Kk]/.test(unit) ? 1000 : 1_000_000);
    return `${lead || 'more than '}${dollar}${formatThousands(value)}`;
  });
  out = out.replace(/≥\s?/g, () => { fixed.add('≥'); return 'at least '; });
  out = out.replace(/≤\s?/g, () => { fixed.add('≤'); return 'at most '; });
  out = out.replace(/(\d)\s?%/g, (all, digit) => { fixed.add('%'); return `${digit} percent`; });
  out = out.replace(/τ/g, () => { fixed.add('τ'); return 'tau'; }).replace(/ρ/g, () => { fixed.add('ρ'); return 'rho'; });
  return { text: out, fixed: [...fixed] };
}

// " - " between words (title separators) → ", ".
export function fixSeparators(text) {
  const out = String(text).replace(/\s+-\s+/g, ', ').replace(/,\s*,/g, ',');
  return { text: out, fixed: out !== text };
}

// The company name with the casing the posting uses most, when the posting writes it differently ("Examplecorp" for
// "ExampleCorp"); otherwise the name as given.
export function postingCasing(name, postingText) {
  const value = String(name || '').trim();
  if (!value) return value;
  const pattern = new RegExp(`(?<![A-Za-z0-9])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'gi');
  const counts = new Map();
  for (const match of String(postingText || '').matchAll(pattern)) counts.set(match[0], (counts.get(match[0]) || 0) + 1);
  if (!counts.size || counts.has(value) && counts.get(value) >= Math.max(...counts.values())) return value;
  return [...counts].sort((a, b) => b[1] - a[1])[0][0];
}

function postingText(job) {
  return [job?.title, job?.company, job?.location, job?.description].filter(Boolean).join('\n');
}

function quotedSegments(issue) {
  return [...String(issue).matchAll(/"([^"]{3,})"|“([^”]{3,})”/g)].map(match => (match[1] || match[2]).trim());
}

function normalizeQuote(text) {
  return String(text).toLowerCase().replace(/[“”"’']/g, "'").replace(/\s+/g, ' ').trim();
}

// Editor issues worth keeping (review D): an issue whose quoted text is not in the draft is dropped, and so is a
// "salutation says X, body says Y" whose names differ only in capitalization. Returns { kept, dropped }.
export function filterEditorIssues(issues, paragraphs) {
  const draft = normalizeQuote((paragraphs || []).join(' '));
  const kept = [];
  const dropped = [];
  for (const issue of issues || []) {
    const text = String(issue || '').trim();
    if (!text) continue;
    const names = /salutation says\s+(.+?),\s*body says\s+(.+?)\.?$/i.exec(text);
    if (names && names[1].trim().toLowerCase() === names[2].trim().replace(/[.”"]+$/, '').toLowerCase()) { dropped.push(text); continue; }
    const quotes = quotedSegments(text);
    if (quotes.length && !quotes.some(quote => draft.includes(normalizeQuote(quote).replace(/[.,;:]+$/, '')))) { dropped.push(text); continue; }
    kept.push(text);
  }
  return { kept, dropped };
}

// An editor rewrite may not add numbers outside the sources or scenario phrases the draft did not have. Per
// paragraph (when the counts match): a rewritten paragraph that does keeps the draft's paragraph. Returns
// { paragraphs, rejected: [{ index, reason }] }.
export function guardEditorRewrite({ draft, revised, whitelist, job, resumeText = '', playbook = '' }) {
  const sources = `${resumeText}\n${playbook}`.toLowerCase();
  const posting = postingText(job);
  const introduced = (before, after) => {
    const reasons = [];
    const newNumbers = numbersOutside(after, whitelist, posting).filter(raw => !numbersOutside(before, whitelist, posting).includes(raw));
    if (newNumbers.length) reasons.push(`numbers not in the sources (${newNumbers.join(', ')})`);
    const phrases = SCENARIO_PHRASES.filter(phrase => after.toLowerCase().includes(phrase) && !before.toLowerCase().includes(phrase) && !sources.includes(phrase));
    if (phrases.length) reasons.push(`scenario wording (${phrases.join(', ')})`);
    return reasons;
  };
  if (!Array.isArray(revised) || revised.length !== draft.length) {
    const reasons = introduced(draft.join(' '), (revised || []).join(' '));
    return reasons.length ? { paragraphs: draft, rejected: [{ index: -1, reason: reasons.join('; ') }] } : { paragraphs: revised, rejected: [] };
  }
  const rejected = [];
  const paragraphs = revised.map((paragraph, index) => {
    const reasons = introduced(draft[index], paragraph);
    if (!reasons.length) return paragraph;
    rejected.push({ index, reason: reasons.join('; ') });
    return draft[index];
  });
  return { paragraphs, rejected };
}

// Fixes applied before rendering: { paragraphs, info: [notes] }.
const THANKS = /\b(?:thank|thanks|appreciate|grateful)\b/i;

// The closing paragraph starts with the assigned thank-you sentence: a different thank-you sentence there is
// replaced; a closing that does not start with a thank-you is left for the closing check.
export function fixClosing(paragraphs, sentence) {
  const list = [...(paragraphs || [])];
  if (!sentence || !list.length) return { paragraphs: list, fixed: false };
  const last = String(list.at(-1) || '');
  const current = sentences(last)[0] || '';
  if (!current || closingKey(current) === closingKey(sentence) || !THANKS.test(current)) return { paragraphs: list, fixed: false };
  list[list.length - 1] = `${sentence}${last.slice(last.indexOf(current) + current.length)}`.replace(/\s+/g, ' ').trim();
  return { paragraphs: list, fixed: true, from: current };
}

// options: closing (the assigned thank-you sentence).
export function autoFix(paragraphs, { closing = null } = {}) {
  const info = [];
  const symbols = new Set();
  let separators = false;
  const fixedParagraphs = (paragraphs || []).map(paragraph => {
    const a = fixSymbols(paragraph);
    a.fixed.forEach(kind => symbols.add(kind));
    const b = fixSeparators(a.text);
    separators ||= b.fixed;
    return b.text;
  });
  if (symbols.size) info.push(`auto-fix: wrote ${[...symbols].join(', ')} out in words`);
  if (separators) info.push('auto-fix: rewrote " - " separators as commas');
  const thanks = fixClosing(fixedParagraphs, closing);
  if (thanks.fixed) info.push(`auto-fix: the closing starts with this letter's thank-you sentence "${closing}" (it said "${thanks.from}")`);
  return { paragraphs: thanks.paragraphs, info };
}

// The checks. context: { job, resumeText, playbook, graduation, availability, mastersAllowed, opening
// ({ forbidden }), openingStyle, candidParagraphIndex, candidGaps, coreGaps, otherResumes: [text], pages,
// company (the short name), batch (recent.mjs batchAvoid), closing (the assigned thank-you sentence) }.
// Returns { results: { id: true|false|null }, failures: [{ id, message }], notes: ['check failed (id): …'] }.
export function runChecks(paragraphs, context) {
  const body = (paragraphs || []).join('\n');
  const first = paragraphs[0] || '';
  const middle = paragraphs.slice(1, -1).filter((paragraph, index) => index + 1 !== context.candidParagraphIndex);
  const job = context.job || {};
  const posting = postingText(job);
  const failures = [];
  const results = {};
  const check = (id, ok, message) => { results[id] = ok; if (!ok) failures.push({ id, message }); };

  const opener = sentences(first)[0] || '';
  const forbidden = context.openingStyle === 'ban-writing-to' || context.opening?.forbidden;
  check('opening', !(/^\s*I am applying for\b/i.test(opener) || (forbidden && WRITING_TO.test(opener))), `the first sentence begins "${opener.split(' ').slice(0, 5).join(' ')}"`);
  const banned = BANNED_PHRASES.filter(phrase => body.toLowerCase().includes(phrase.toLowerCase()));
  check('banned-phrases', !banned.length, `the body says ${banned.map(phrase => `"${phrase}"`).join(', ')}`);
  const principles = middle.map(paragraph => sentences(paragraph).at(-1) || '').filter(sentence => PRINCIPLE_OPENER.test(sentence));
  check('principle-openers', !principles.length, `a middle paragraph ends with "${(principles[0] || '').split(' ').slice(0, 6).join(' ')}…"`);
  const symbols = ['%', '≥', '≤', '×', 'τ', 'ρ'].filter(symbol => body.includes(symbol)).concat(/\d\s?[Kk]\+/.test(body) ? ['K+'] : []);
  check('symbols', !symbols.length, `the body uses ${symbols.join(', ')}`);
  check('title-separators', !/\s-\s/.test(body), 'the body still has " - " separators');
  const graduation = String(context.graduation?.month || '');
  const mentions = graduation ? first.split(graduation).length - 1 : 1;
  check('graduation-once', mentions === 1, `paragraph 1 states "${graduation}" ${mentions} times`);
  const conflicts = availabilityConflicts(body, { availability: context.availability, graduation: context.graduation, graduationDate: context.graduationDate });
  check('availability', !conflicts.length, `availability conflict: ${conflicts.join(', ')}`);
  check('masters', context.mastersAllowed || !mentionsMasters(body), 'the letter mentions a master\'s program, which this role type should not');

  const whitelist = numberWhitelist(context.resumeText, context.playbook);
  const outside = numbersOutside(body, whitelist, posting);
  check('numbers', !outside.length, `numbers not on the selected resume or the playbook: ${outside.join(', ')}`);
  const repeated = repeatedMetrics(body, posting);
  check('metric-repeat', !repeated.length, `metrics stated more than once: ${repeated.map(entry => `${entry.raw} (${entry.count} times)`).join(', ')}`);
  const sources = `${context.resumeText || ''}\n${context.playbook || ''}`.toLowerCase();
  const scenario = SCENARIO_PHRASES.filter(phrase => body.toLowerCase().includes(phrase) && !sources.includes(phrase));
  check('scenario', !scenario.length, `wording the resume does not support: ${scenario.map(phrase => `"${phrase}"`).join(', ')}`);
  const echoes = middle.map(paragraph => sentences(paragraph)[0] || '').filter(sentence => sharedRun(sentence, job.description || '') >= 6);
  check('jd-echo', !echoes.length, `a middle paragraph opens with six or more words copied from the posting: "${(echoes[0] || '').split(' ').slice(0, 10).join(' ')}…"`);

  const gaps = context.coreGaps || [];
  const index = Number.isInteger(context.candidParagraphIndex) ? context.candidParagraphIndex : -1;
  const named = Array.isArray(context.candidGaps) ? context.candidGaps : [];
  const hasCandid = index >= 0 && index < paragraphs.length;
  check('candid', !(gaps.length && !hasCandid) && named.length <= MAX_CANDID_GAPS,
    gaps.length && !hasCandid ? `the posting has core gaps (${gaps.slice(0, 3).join('; ')}) but the letter has no candid paragraph` : `the candid paragraph names ${named.length} gaps; at most ${MAX_CANDID_GAPS}`);

  const own = resumeExperiences(context.resumeText);
  const others = (context.otherResumes || []).flatMap(text => resumeExperiences(text)).filter(experience => !own.some(item => item.name.toLowerCase() === experience.name.toLowerCase()));
  const cited = [...new Set(experiencesIn((job.reasons || []).join('\n'), others))];
  check('scoring-evidence', !cited.length, `${SCORING_EVIDENCE_NOTE} (${cited.join(', ')})`);
  if (context.pages != null) check('one-page', context.pages <= 1, `the PDF runs to ${context.pages} pages`);
  else results['one-page'] = null;
  // Tonight's letters: the first sentence's construction (posting words masked) differs from each earlier one.
  const batchOpenings = context.batch?.openings || [];
  if (batchOpenings.length) {
    const shape = openingShape(paragraphs, { title: job.title || '', company: [job.company, context.company].filter(Boolean).join(' ') });
    const twin = batchOpenings.find(entry => entry.shape && entry.shape === shape);
    check('opening-variety', !twin, `the first sentence has the same construction ("${shape}") as tonight's ${twin?.company || 'earlier'} letter`);
  } else results['opening-variety'] = null;
  if (context.closing) check('closing', closingOf(paragraphs).key === closingKey(context.closing), `the closing paragraph does not start with this letter's thank-you sentence "${context.closing}"`);
  else results.closing = null;

  return { results, failures, notes: failures.map(failure => `check failed (${failure.id}): ${failure.message}`) };
}

export function isCheckNote(note) {
  return /^\s*(?:check failed|auto-fix)\b/i.test(String(note || ''));
}

export function withoutCheckNotes(notes) {
  return (notes || []).filter(note => !isCheckNote(note));
}

export { wordCount as checkedWordCount, OPENING };
