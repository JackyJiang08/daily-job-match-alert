// The company's short name in a cover letter (2026-11-04): the salutation "Dear <short> Recruiting Team,",
// the file name <Prefix>_Cover_Letter_<short without spaces>.pdf, and every mention in the body after the
// first. Three sources, in order:
//   1. the owner's alias table (Settings → Cover Letters, full name → short name);
//   2. the model's shortName, returned with the draft: the name the company most often uses for itself in
//      the posting (PwC, HPE, P&G, Dow Jones, Toyota Material Handling). It must appear in the posting
//      text, or equal the cleaned company name, and be at most four words, so an abbreviation the posting
//      never uses (J&J for Johnson & Johnson) is refused;
//   3. the cleaned company name from the candidate chain (Inc., LLC, L.P., parentheses always removed; other
//      suffixes and "The" only when the posting writes the shorter name).
// Update Salutations also infers the name from the JD for letters written before (inferShortNameFromPosting).
// Pure functions; the hub supplies the aliases from private/cover-letter/profile.json.
import { cleanText } from '../utils.mjs';
import { isTrustedSourceName, resolveCompanyName } from '../posting-fields.mjs';

export const MAX_SHORT_NAME_WORDS = 4;
export const MAX_ALIASES = 300;

// Always removed where they end the name: Inc., LLC, L.P. (and their spellings), parentheses, and a trailing
// ", a … Company" description. Corporation, Corp., Company, Co., Group, Holdings, and a leading "The" are
// removed only when the posting itself writes the shorter name (2026-11-04, second pass): with only the full
// name in the posting, the full name stays ("The Aerospace Corporation", "Brain Co.").
const UNCONDITIONAL_SUFFIX = /(?:,\s*|\s+)(?:Inc\.?|Incorporated|L\.L\.C\.?|LLC\.?|L\.P\.|LP)$/i;
const EVIDENCE_SUFFIX = /(?:,\s*|\s+)(?:Corp\.?|Corporation|Company|Co\.|Group|Holdings)$/i;
const TRAILING_JOINERS = /(?:\s*[,&]\s*|\s+and\s*)+$/i;
const PARENTHESES = /\s*\([^()]*\)/g;
const APPOSITIVE = /,\s+(?:a|an)\s+[^,]+$/i;
// What follows a shorter form when the posting is really writing the longer name: "KLA Corporation",
// "Dow Jones & Company", "Example, Inc.".
const SUFFIX_AFTER = /^\s*(?:,|&|and)?\s*(?:Inc|Incorporated|LLC|L\.L\.C|L\.P|LP|Corp|Corporation|Company|Co|Group|Holdings)(?![\p{L}\p{N}])/iu;

function normalizeText(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Whitespace only: the form a name is shown and saved in.
function tidy(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The posting text a short name is checked against: the description (the JD itself).
export function postingText(job) {
  return normalizeText(job?.description || '');
}

// Every place `name` stands as a whole name in `text` (case-sensitive: "PwC" is not "PWC"): the index of
// each occurrence, with no letter or digit glued on either side.
function occurrences(text, name) {
  const target = normalizeText(name);
  if (!target || !text) return [];
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(target)}(?![\\p{L}\\p{N}])`, 'gu');
  return [...text.matchAll(pattern)].map(match => match.index);
}

export function appearsInPosting(name, text) {
  return occurrences(normalizeText(text), name).length > 0;
}


function stripUnconditional(name) {
  let value = name;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = value.replace(UNCONDITIONAL_SUFFIX, '').replace(TRAILING_JOINERS, '').trim();
    if (next === value || !next) break;
    value = next;
  }
  return value;
}

// The full name with only the unconditional parts removed: "Dow Jones & Company, Inc." → "Dow Jones & Company".
export function baseCompanyName(raw) {
  const original = cleanText(raw || '').replace(/\s+/g, ' ').trim();
  const base = stripUnconditional(original.replace(PARENTHESES, '').replace(APPOSITIVE, '').trim());
  return isTrustedSourceName(base) ? base : original;
}

// Shorter forms of the base name, most stripped first: each evidence suffix peeled in turn, each with and
// without a leading "The".
function shorterForms(base) {
  const chain = [base];
  for (let pass = 0; pass < 4; pass += 1) {
    const last = chain[chain.length - 1];
    const next = stripUnconditional(last.replace(EVIDENCE_SUFFIX, '').replace(TRAILING_JOINERS, '').trim());
    if (next === last || !next) break;
    chain.push(next);
  }
  const forms = [];
  for (const form of chain.reverse()) {
    const article = /^The\s+(.+)$/i.exec(form);
    if (article) forms.push(article[1]);
    forms.push(form);
  }
  return forms.filter(form => form !== base && isTrustedSourceName(form));
}

// Occurrences of `form` in the posting that stand for the company under that form: not followed by a suffix
// the form dropped, and not preceded by "The" when the form dropped it.
function attestedCount(form, base, text) {
  const length = normalizeText(form).length;
  const droppedThe = /^The\s/i.test(base) && !/^The\s/i.test(form);
  return occurrences(text, form).filter(index => {
    if (form !== base && SUFFIX_AFTER.test(text.slice(index + length))) return false;
    if (droppedThe && /The\s$/.test(text.slice(Math.max(0, index - 4), index))) return false;
    return true;
  }).length;
}

// The candidate chain's name cleaned for a letter (see the comment above the patterns):
//   "KLA Corporation" with "KLA" in the posting → "KLA"; with only "KLA Corporation" → "KLA Corporation";
//   "Dow Jones & Company, Inc." with "Dow Jones" in the posting → "Dow Jones"; "PricewaterhouseCoopers (PwC)"
//   → "PricewaterhouseCoopers"; "The Home Depot" written so in the posting → "The Home Depot".
export function cleanCompanyName(raw, { text = '' } = {}) {
  const jd = normalizeText(text);
  const base = baseCompanyName(raw);
  if (!jd) return base;
  return shorterForms(base).find(form => attestedCount(form, base, jd) > 0) || base;
}

function wordsIn(name) {
  return normalizeText(name).split(' ').filter(word => /[\p{L}\p{N}]/u.test(word));
}

// { ok, reason } for a short name the model returned.
export function validateShortName(value, { job, chainName }) {
  const name = normalizeText(value);
  if (!name) return { ok: false, reason: 'empty' };
  if (!isTrustedSourceName(name)) return { ok: false, reason: 'not a usable company name' };
  if (wordsIn(name).length > MAX_SHORT_NAME_WORDS) return { ok: false, reason: `more than ${MAX_SHORT_NAME_WORDS} words` };
  const text = postingText(job);
  if (appearsInPosting(name, text)) return { ok: true, reason: 'in the posting' };
  if (chainName && name.toLowerCase() === cleanCompanyName(chainName, { text }).toLowerCase()) return { ok: true, reason: 'the cleaned company name' };
  return { ok: false, reason: 'not in the posting' };
}

// ---------------------------------------------------------------------------------------------- inference

// Brands that neither initials nor a contraction of the name would give. Keys are base names in lower case.
const KNOWN_BRANDS = new Map([
  ['the walt disney company', ['Disney']],
  ['walt disney', ['Disney']],
  ['international business machines', ['IBM']],
  ['bank of america', ['BofA']],
  ['minnesota mining and manufacturing', ['3M']],
]);
const MINOR_WORDS = new Set(['of', 'and', 'the', 'for', 'de', 'a', 'an', 'at', 'in', 'on']);
const LEGAL_WORD = /^(?:Inc\.?|Incorporated|LLC|L\.L\.C\.|L\.P\.|LP|Corp\.?|Corporation|Company|Companies|Co\.?|Group|Holdings)$/i;

// The name's significant words ("Reinsurance Group of America" → Reinsurance, America; legal and minor words
// out) and the same words split at CamelCase humps ("PricewaterhouseCoopers" → Pricewaterhouse, Coopers).
function significantWords(base) {
  const words = normalizeText(base).split(/[\s&,/-]+/).filter(word => /\p{L}/u.test(word) && !MINOR_WORDS.has(word.toLowerCase()) && !LEGAL_WORD.test(word));
  const humps = words.flatMap(word => word.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) || [word]);
  return { words, humps, withGroup: normalizeText(base).split(/[\s&,/-]+/).filter(word => /\p{L}/u.test(word) && !MINOR_WORDS.has(word.toLowerCase()) && !/^(?:Inc\.?|Incorporated|LLC|L\.P\.|LP|Corp\.?|Corporation|Company|Co\.?)$/i.test(word)) };
}

// Does `token` (as the posting writes it) stand for the company? An acronym must spell the initials of the
// name's words (HPE, P&G, RGA; the capitals of PwC spell Pricewaterhouse Coopers); a contraction joins the
// start of each word (FedEx = Federal Express, AmEx); anything else must be a known brand.
function brandMatches(token, base) {
  const known = KNOWN_BRANDS.get(normalizeText(base).toLowerCase());
  if (known?.includes(token)) return true;
  const capitals = token.replace(/[^A-Z]/g, '');
  if (capitals.length < 2) return false;
  const { words, humps, withGroup } = significantWords(base);
  const initials = list => list.map(word => word[0].toUpperCase()).join('');
  if (/^[A-Z&]+$/.test(token) || /^[A-Z][a-z]?[A-Z]$/.test(token)) {
    return [words, humps, withGroup].some(list => list.length >= 2 && initials(list) === capitals);
  }
  const parts = token.match(/[A-Z][a-z]*/g) || [];
  if (parts.length < 2 || parts.join('') !== token) return false;
  return parts.length === words.length && parts.every((part, index) => part.length >= 2 && words[index].toLowerCase().startsWith(part.toLowerCase()));
}

// Abbreviations and brands of the company that the posting writes, each with its count.
function postingBrands(base, text) {
  const counts = new Map();
  for (const match of text.matchAll(/(?<![\p{L}\p{N}&])([A-Z][A-Za-z]*(?:&[A-Z][A-Za-z]*)?|\d[A-Z])(?![\p{L}\p{N}&])/gu)) {
    const token = match[1];
    if (token.length > 8 || normalizeText(base) === token) continue;
    if (!counts.has(token) && !brandMatches(token, base)) { counts.set(token, -1); continue; }
    if (counts.get(token) === -1) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return [...counts].filter(([, count]) => count > 0).map(([name, count]) => ({ name, count }));
}

// The short name an existing letter gets from its posting, without a model (Update Salutations): of the
// cleaned name, the full name, a stored model short name that still validates, and the company's
// abbreviations or brands the posting writes, the one the posting uses most often. Ties keep that order.
// null when the posting has no text.
export function inferShortNameFromPosting({ job, chainName, storedShortName = null }) {
  const text = postingText(job);
  if (!text) return null;
  const base = baseCompanyName(chainName || job?.company || '');
  const cleaned = cleanCompanyName(chainName || job?.company || '', { text });
  const options = [];
  const add = (name, count, kind) => {
    if (!name || options.some(option => option.name.toLowerCase() === name.toLowerCase())) return;
    options.push({ name, count, kind });
  };
  add(cleaned, attestedCount(cleaned, base, text), 'cleaned');
  add(base, attestedCount(base, base, text), 'full');
  const stored = tidy(storedShortName);
  if (stored && validateShortName(stored, { job, chainName }).ok) add(stored, occurrences(text, stored).length, 'stored');
  for (const brand of postingBrands(base, text)) add(brand.name, brand.count, 'brand');
  const best = options.reduce((top, option) => (option.count > top.count ? option : top), options[0]);
  return { name: best.name, kind: best.kind, options };
}

// ---------------------------------------------------------------------------------------------- aliases

function aliasKey(value) {
  return normalizeText(value).toLowerCase().replace(/[^\p{L}\p{N}&]+/gu, ' ').trim();
}

// The Settings textarea: one "Full Name = Short Name" per line ("=>" and "→" also work). Returns
// { aliases, errors }; blank lines and lines starting with # are ignored.
export function parseAliasText(input) {
  const aliases = [];
  const errors = [];
  const seen = new Set();
  String(input || '').split(/\r?\n/).forEach((line, index) => {
    const text = line.trim();
    if (!text || text.startsWith('#')) return;
    const match = /^(.+?)\s*(?:=>|→|=)\s*(.+)$/.exec(text);
    if (!match) { errors.push(`Line ${index + 1}: write "Full Name = Short Name"`); return; }
    const full = tidy(match[1]);
    const short = tidy(match[2]);
    if (!isTrustedSourceName(full) || !isTrustedSourceName(short)) { errors.push(`Line ${index + 1}: "${text}" needs a company name on both sides`); return; }
    if (wordsIn(short).length > MAX_SHORT_NAME_WORDS) { errors.push(`Line ${index + 1}: "${short}" is longer than ${MAX_SHORT_NAME_WORDS} words`); return; }
    const key = aliasKey(full);
    if (seen.has(key)) { errors.push(`Line ${index + 1}: "${full}" is listed twice`); return; }
    seen.add(key);
    aliases.push({ full, short });
  });
  if (aliases.length > MAX_ALIASES) errors.push(`At most ${MAX_ALIASES} aliases`);
  return { aliases, errors };
}

export function aliasText(aliases) {
  return (Array.isArray(aliases) ? aliases : []).map(item => `${item.full} = ${item.short}`).join('\n');
}

// The owner's short name for a posting: an alias whose full name matches any name the candidate chain
// holds for it (as written, or cleaned), or the chain's chosen name.
export function aliasFor(aliases, { job = null, chainName = '' } = {}) {
  const list = Array.isArray(aliases) ? aliases : [];
  if (!list.length) return null;
  const text = postingText(job);
  const names = new Set();
  for (const value of [chainName, job?.company, ...(job ? resolveCompanyName(job).candidates.map(item => item.value) : [])]) {
    if (!value) continue;
    names.add(aliasKey(value));
    names.add(aliasKey(cleanCompanyName(value, { text })));
  }
  const hit = list.find(item => names.has(aliasKey(item.full)));
  return hit ? tidy(hit.short) : null;
}

// ---------------------------------------------------------------------------------------------- resolution

// { name, source: 'owner' | 'alias' | 'model' | 'fallback', fallback, rejected: { value, reason } | null }.
// `fixed` is a name the owner typed in the letter panel; it wins over everything.
export function resolveShortName({ job, chainName, modelShortName = null, aliases = [], fixed = null }) {
  const text = postingText(job);
  const fallback = cleanCompanyName(chainName || job?.company || '', { text });
  const owner = tidy(fixed);
  if (owner) return { name: owner, source: 'owner', fallback, rejected: null };
  const alias = aliasFor(aliases, { job, chainName });
  if (alias) return { name: alias, source: 'alias', fallback, rejected: null };
  const proposed = tidy(modelShortName);
  if (proposed) {
    const check = validateShortName(proposed, { job, chainName });
    if (check.ok) return { name: proposed, source: 'model', fallback, rejected: null };
    return { name: fallback, source: 'fallback', fallback, rejected: { value: proposed, reason: check.reason } };
  }
  return { name: fallback, source: 'fallback', fallback, rejected: null };
}

// The name a letter would use before any model call (the panel's first value, Update Salutations): the
// alias, else a short name stored on the letter that still validates, else the cleaned chain name.
export function shortNameWithoutModel({ job, chainName, aliases = [], storedShortName = null }) {
  return resolveShortName({ job, chainName, aliases, modelShortName: storedShortName });
}
