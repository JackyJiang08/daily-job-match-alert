// The company's short name in a cover letter (2026-11-04): the salutation "Dear <short> Recruiting Team,",
// the file name <Prefix>_Cover_Letter_<short without spaces>.pdf, and every mention in the body after the
// first. Three sources, in order:
//   1. the owner's alias table (Settings → Cover Letters, full name → short name);
//   2. the model's shortName, returned with the draft: the name the company most often uses for itself in
//      the posting (PwC, HPE, P&G, Dow Jones, Toyota Material Handling). It must appear in the posting
//      text, or equal the cleaned company name, and be at most four words, so an abbreviation the posting
//      never uses (J&J for Johnson & Johnson) is refused;
//   3. the cleaned company name from the candidate chain (legal suffixes and parentheses removed).
// Pure functions; the hub supplies the aliases from private/cover-letter/profile.json.
import { cleanText } from '../utils.mjs';
import { isTrustedSourceName, resolveCompanyName } from '../posting-fields.mjs';

export const MAX_SHORT_NAME_WORDS = 4;
export const MAX_ALIASES = 300;

// Removed wherever they end the name. "Group" is not here: it goes only when the posting itself uses the
// name without it.
const LEGAL_SUFFIX = /(?:,\s*|\s+)(?:Inc\.?|Incorporated|L\.?L\.?C\.?|L\.P\.|LP|Corp\.?|Corporation|Company|Co\.|Holdings)$/i;
const TRAILING_JOINERS = /(?:\s*[,&]\s*|\s+and\s*)+$/i;
const GROUP_SUFFIX = /(?:,\s*|\s+)Group$/i;
const PARENTHESES = /\s*\([^()]*\)/g;
// A trailing description of the owner: "Revantage, A Blackstone Portfolio Company".
const APPOSITIVE = /,\s+(?:a|an)\s+[^,]+$/i;
// The words a stripped suffix starts with, so "The Walt Disney Company" in the posting does not count as the
// posting writing "The Walt Disney".
const SUFFIX_AFTER = /^,?\s+(?:Inc\b|Incorporated\b|L\.?L\.?C\b|L\.P\.|LP\b|Corp\b|Corporation\b|Company\b|Co\.|Holdings\b|Group\b)/i;

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

// "The": kept when the posting writes it as part of the name in mid-sentence ("at The Home Depot"), or
// never names the company without it; dropped otherwise ("The Procter & Gamble Company" → "Procter & Gamble").
function keepsThe(rest, text) {
  const length = normalizeText(rest).length;
  const all = occurrences(text, rest).filter(index => !SUFFIX_AFTER.test(text.slice(index + length)));
  if (!all.length) return false;
  let midSentence = 0;
  let withArticle = 0;
  for (const index of all) {
    const before = text.slice(Math.max(0, index - 4), index);
    if (/^[Tt]he $/.test(before)) {
      withArticle += 1;
      const lead = text.slice(0, index - 4).trimEnd();
      if (before.startsWith('T') && lead && !/[.!?:;"\n]$/.test(lead)) midSentence += 1;
    }
  }
  return midSentence > 0 || withArticle === all.length;
}

// The candidate chain's name without legal suffixes and parentheses (see the module comment).
//   "PricewaterhouseCoopers (PwC)" → "PricewaterhouseCoopers"; "Dow Jones & Company, Inc." → "Dow Jones";
//   "The Procter & Gamble Company" → "Procter & Gamble"; "Example Group" → "Example" only when the posting
//   says "Example" on its own.
export function cleanCompanyName(raw, { text = '' } = {}) {
  const jd = normalizeText(text);
  // The returned name keeps its own typography (curly apostrophes); only matching is normalized.
  const original = cleanText(raw || '').replace(/\s+/g, ' ').trim();
  let name = original.replace(PARENTHESES, '').replace(APPOSITIVE, '').trim();
  for (let pass = 0; pass < 4; pass += 1) {
    const next = name.replace(LEGAL_SUFFIX, '').replace(TRAILING_JOINERS, '').trim();
    if (next === name || !next) break;
    name = next;
  }
  if (GROUP_SUFFIX.test(name)) {
    const withoutGroup = name.replace(GROUP_SUFFIX, '').replace(TRAILING_JOINERS, '').trim();
    // The posting must call the company by the bare name somewhere, not only as part of "<name> Group".
    const bare = occurrences(jd, withoutGroup).some(index => !/^,?\s+Group(?![\p{L}\p{N}])/u.test(jd.slice(index + normalizeText(withoutGroup).length)));
    if (withoutGroup && bare) name = withoutGroup;
  }
  const article = /^The\s+(.+)$/i.exec(name);
  if (article && !keepsThe(article[1], jd)) name = article[1];
  return isTrustedSourceName(name) ? name : original;
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
