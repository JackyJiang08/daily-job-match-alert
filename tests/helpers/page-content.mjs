// Content equivalence for the page snapshots (2026-11-08 redesign): a page may change its styles, its markup
// structure and the order of its parts, but not what it says or does. pageContent(html) reduces a page to
// multisets of
//   words  – the visible text (and option labels), lower case, punctuation dropped;
//   links  – every href and form action;
//   fields – every form field (id, name, type, value) and every data-* attribute with its value;
// and compareContent(before, after, allowances) returns what went missing and what was added beyond the named
// allowances. The CSS and the page scripts are left out: they are what a restyling changes.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ', middot: '·', rarr: '→', hellip: '…' };

function decode(text) {
  return String(text).replace(/&(#?\w+);/g, (all, name) => ENTITIES[name] ?? (name.startsWith('#') ? String.fromCodePoint(Number(name.slice(1))) : all));
}

function bag(items) {
  const counts = new Map();
  for (const item of items) counts.set(item, (counts.get(item) || 0) + 1);
  return counts;
}

export function pageContent(html) {
  const source = String(html)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<link\b[^>]*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const text = decode(source.replace(/<[^>]+>/g, ' '));
  const words = (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’.@/_+-]*/gu) || []).map(word => word.replace(/[.'’-]+$/, ''));
  const links = [];
  const fields = [];
  for (const [, tag, attributes] of source.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
    const attrs = {};
    for (const [, name, value] of attributes.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) attrs[name.toLowerCase()] = decode(value ?? '');
    if (attrs.href != null) links.push(attrs.href);
    if (attrs.action != null) links.push(`action:${attrs.action}`);
    if (attrs.formaction != null) links.push(`formaction:${attrs.formaction}`);
    if (/^(input|select|textarea|button)$/i.test(tag)) fields.push(`${tag.toLowerCase()}#${attrs.id || ''}[${attrs.name || ''}](${attrs.type || ''})=${attrs.value ?? ''}`);
    for (const [name, value] of Object.entries(attrs)) if (name.startsWith('data-')) fields.push(`${name}=${value}`);
  }
  return { words: bag(words), links: bag(links), fields: bag(fields) };
}

function difference(left, right, allowed = () => false) {
  const out = [];
  for (const [item, count] of left) {
    const extra = count - (right.get(item) || 0);
    if (extra > 0 && !allowed(item)) out.push(extra > 1 ? `${item} ×${extra}` : item);
  }
  return out.sort();
}

// allowances: { addedWords, missingWords, addedFields (prefixes), addedLinks } – what the redesign may add or
// drop on purpose (the filter bar, the renamed letter actions, the compact top row).
export function compareContent(beforeHtml, afterHtml, allowances = {}) {
  const before = pageContent(beforeHtml);
  const after = pageContent(afterHtml);
  const addedWords = new Set([...(allowances.addedWords || []), ...(allowances.addedWordsSidebar || [])]);
  const missingWords = new Set(allowances.missingWords || []);
  const missingPatterns = allowances.missingWordPatterns || [];
  const linkPrefixes = allowances.addedLinkPrefixes || [];
  const fieldPrefixes = allowances.addedFields || [];
  const missingPrefixes = allowances.missingFields || [];
  return {
    missingWords: difference(before.words, after.words, word => missingWords.has(word) || missingPatterns.some(pattern => pattern.test(word))),
    addedWords: difference(after.words, before.words, word => addedWords.has(word)),
    missingLinks: difference(before.links, after.links),
    addedLinks: difference(after.links, before.links, link => (allowances.addedLinks || []).includes(link) || linkPrefixes.some(prefix => link.startsWith(prefix))),
    missingFields: difference(before.fields, after.fields, field => missingPrefixes.some(prefix => field.startsWith(prefix))),
    addedFields: difference(after.fields, before.fields, field => fieldPrefixes.some(prefix => field.startsWith(prefix))),
  };
}

// The redesign's own additions (2026-11-08) and the compact page (2026-11-15): the filter bar (Track, Role
// Type, Freshness, Score, Hide Contacted, Clear Filters, the Filters popover and the "⋯" menu), the "Source:"
// line, the one-row top bar ("Sat, Nov 14 · 4 Jobs"), the History fold, the CoverLetter and Message to
// Recruiters actions. Gone since then: the masthead's long date and "Matches · Ran …" line, the Freshness tags,
// the Freshness Date Only value, "Apply with … Resume", Mark as Applied / Hide Applied, the group note under
// From Yesterday, the "N matches" words in the date column, the Desktop copy row's own wording.
// The date controls in the top row (2026-11-18) in place of the date column: ‹ › and the month picker add the
// day numbers, the month and year, the two-letter weekdays, more links to report dates (‹, ›, the picker's days,
// Today) and their buttons and data-*; the column's short dates ("Sat, Oct 17"), its Today tag, the Only Days
// With Matches box, and the old tab title ("Report 2026-10-17") are gone.
const DATE_NAV = {
  addedWords: [...Array.from({ length: 31 }, (_, index) => String(index + 1)), '2026', 'january', 'february', 'march', 'april', 'may', 'june', 'july',
    'august', 'september', 'october', 'november', 'december', 'su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'],
  missingWords: ['report', 'days', 'today', 'thu', 'fri', 'sat', 'sun', 'mon', 'tue', 'wed', 'oct', 'nov', 'sep', 'aug'],
  missingWordPatterns: [/^\d{4}-\d{2}-\d{2}$/],
  missingFields: ['data-empty=', 'data-tag=today', 'data-tag=tomorrow', 'input#only-matches'],
  addedFields: ['button#cal-', 'button#date-', 'data-current=', 'data-date=', 'data-keep-query=', 'data-label=', 'data-next=', 'data-prev='],
  addedLinkPrefixes: ['/reports/'],
};

export const REDESIGN_ALLOWANCES = {
  addedWords: ['role', 'type', 'freshness', 'any', 'score', '–', 'hide', 'contacted', 'clear', 'filters', 'source', 'as', 'all', 'tracks', 'track',
    'posted', 'today', 'new', 'since', 'last', 'poll', 'carried', 'over', 'undated', 'letter', 'coverletter', 'message', 'to', 'recruiters',
    'jobs', 'job', 'history', '⋯', 'thu', 'fri', 'sat', 'sun', 'mon', 'tue', 'wed', 'oct', 'nov', 'sep', 'aug', 'more', 'actions'],
  missingWords: ['pdf', 'matches', 'match', 'ran', 'pm', 'am', 'october', 'september', 'august', 'november', '2026', 'apply', 'with', 'resume', 'resumes', 'data',
    'date', 'only', 'sort', 'by', 'reach', 'out', 'deferred', 'the', 'review', 'budget', 'on', 'an', 'earlier', 'run', 'and', 'reviewed', 'now', 'each',
    'card', 'says', 'when', 'it', 'was', 'first', 'found', 'strict', '24-hour', 'window', 'main', 'list', 'off', 'from', 'yesterday', 'not', 'engine',
    'unavailable', '1', '0', '2', '3', '4', '12', 'in', 'shown', 'llm', 'mark', 'applied', '00', '16', '8', '15', '17', 'cover', 'letter', '14'],
  // The sidebar's Models lines (2026-11-15): words and data-model fields the old snapshots never had.
  addedWordsSidebar: ['models', 'review', 'prescreen', 'local', 'only', 'coverletter', 'fable', '5.1', 'gpt-5.6', 'sol', 'luna', 'opus', '5.5', 'off', 'unavailable'],
  missingFields: ['data-current=', 'data-month=', 'data-applied=', 'data-apply-mark=', 'input#hide-applied', 'button#[](button)='],
  addedFields: ['select#fresh', 'input#score-min', 'input#score-max', 'input#hide-contacted', 'button#clear-filters',
    'data-freshness=', 'data-contacted=', 'data-job=', 'button#[](button)=', 'data-badge=letter-check', 'button#filters-button', 'details#', 'data-model=',
    ...DATE_NAV.addedFields],
  missingWordPatterns: DATE_NAV.missingWordPatterns,
  addedLinkPrefixes: DATE_NAV.addedLinkPrefixes,
};
REDESIGN_ALLOWANCES.addedWords.push(...DATE_NAV.addedWords);
REDESIGN_ALLOWANCES.missingWords.push(...DATE_NAV.missingWords);
REDESIGN_ALLOWANCES.missingFields.push(...DATE_NAV.missingFields);

export function assertSameContent(assert, beforeHtml, afterHtml, label, allowances = REDESIGN_ALLOWANCES) {
  const diff = compareContent(beforeHtml, afterHtml, allowances);
  const problems = Object.entries(diff).filter(([, items]) => items.length);
  assert.deepEqual(Object.fromEntries(problems), {}, `${label}: only styles and structure may change`);
}
