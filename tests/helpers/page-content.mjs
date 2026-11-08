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
// drop on purpose (the filter bar, Mark as Applied, the renamed Download Letter action).
export function compareContent(beforeHtml, afterHtml, allowances = {}) {
  const before = pageContent(beforeHtml);
  const after = pageContent(afterHtml);
  const addedWords = new Set(allowances.addedWords || []);
  const missingWords = new Set(allowances.missingWords || []);
  const fieldPrefixes = allowances.addedFields || [];
  return {
    missingWords: difference(before.words, after.words, word => missingWords.has(word)),
    addedWords: difference(after.words, before.words, word => addedWords.has(word)),
    missingLinks: difference(before.links, after.links),
    addedLinks: difference(after.links, before.links, link => (allowances.addedLinks || []).includes(link)),
    missingFields: difference(before.fields, after.fields),
    addedFields: difference(after.fields, before.fields, field => fieldPrefixes.some(prefix => field.startsWith(prefix))),
  };
}

// The redesign's own additions: the filter bar (Role Type, Freshness, Score, Hide Contacted, Hide Applied,
// Clear Filters), the Freshness tags, the "Source:" line, and Mark as Applied.
export const REDESIGN_ALLOWANCES = {
  addedWords: ['role', 'type', 'freshness', 'any', 'score', '–', 'hide', 'contacted', 'applied', 'clear', 'filters', 'source', 'mark', 'as',
    'posted', 'today', 'date', 'only', 'new', 'since', 'last', 'poll', 'carried', 'over', 'undated', 'letter'],
  missingWords: ['pdf'],
  addedFields: ['select#fresh', 'input#score-min', 'input#score-max', 'input#hide-contacted', 'input#hide-applied', 'button#clear-filters',
    'data-freshness=', 'data-badge=freshness', 'data-contacted=', 'data-applied=', 'data-apply-mark=', 'data-job=', 'button#[](button)='],
};

export function assertSameContent(assert, beforeHtml, afterHtml, label, allowances = REDESIGN_ALLOWANCES) {
  const diff = compareContent(beforeHtml, afterHtml, allowances);
  const problems = Object.entries(diff).filter(([, items]) => items.length);
  assert.deepEqual(Object.fromEntries(problems), {}, `${label}: only styles and structure may change`);
}
