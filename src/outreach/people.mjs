// People for the Message to Recruiters panel (2026-11-16): a few named people at the company, each with the
// message for them. Four sources, most reliable first: In Posting (contacts the JD names, contacts.mjs),
// Recruiter, Team and Alumni (one web-search call each, site:linkedin.com/in, through the search-discovery
// provider and key in private/search.json). Only the search API's own titles, snippets and links are read:
// nothing on linkedin.com is ever requested (every request passes assertNotLinkedIn), nothing is signed in to,
// and nothing is sent.
//
// Searches run only when the owner opens the panel (never in the nightly run), at most three per posting, and
// their parsed results are cached for 30 days in private/outreach/people-cache.json (Recruiter and Alumni by
// company, Team by company + function word), so a second posting at the same company costs nothing. The calls
// count against their own monthly cap (outreach.peopleSearch.monthlyCap, default 300) in
// private/outreach/people-usage.json, apart from Search Discovery's. The key never leaves readSearchKey's
// result: it is not in the cache, the usage file, a reason, or a log line.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseSearchResults, readSearchKey, searchRequest, searchSettings, monthKey } from '../collectors/search-discovery.mjs';
import { writeJsonAtomic } from '../json-file.mjs';
import { errorSummary } from '../warnings.mjs';
import { assertNotLinkedIn, googleSearchUrl, isLinkedInUrl } from './links.mjs';

export const PEOPLE_LIMIT = 5;
export const DEFAULT_PEOPLE_CAP = 300;
export const PEOPLE_CACHE_DAYS = 30;
export const PEOPLE_TIMEOUT_MS = 8000;
export const BIG_COMPANY_JOBS = 200;
export const MIN_PERSON_SCORE = 2;
export const KIND_LABELS = { posting: 'In Posting', recruiter: 'Recruiter', team: 'Team', alumni: 'Alumni' };
// How many rows each searched kind may take before the others fill the rest; In Posting has no cap.
export const KIND_CAPS = { recruiter: 2, team: 2, alumni: 1 };
const SEARCHED_KINDS = ['recruiter', 'team', 'alumni'];

// ---------------------------------------------------------------------------------------------- settings

// outreach.peopleSearch { enabled (default true), monthlyCap (default 300) }. The older
// outreach.searchCandidates: true reads as enabled.
export function peopleSearchSettings(config) {
  const raw = config?.outreach?.peopleSearch && typeof config.outreach.peopleSearch === 'object' ? config.outreach.peopleSearch : {};
  const cap = Number(raw.monthlyCap ?? DEFAULT_PEOPLE_CAP);
  return {
    enabled: config?.outreach?.searchCandidates === true || raw.enabled !== false,
    monthlyCap: Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : DEFAULT_PEOPLE_CAP,
    provider: searchSettings(config).provider,
  };
}

export function peopleCachePath(root) {
  return path.join(root, 'private', 'outreach', 'people-cache.json');
}

export function peopleUsagePath(root) {
  return path.join(root, 'private', 'outreach', 'people-usage.json');
}

async function readJson(file, io) {
  try {
    const raw = JSON.parse(await io.readFile(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

async function writeJson(file, value, io) {
  await io.mkdir(path.dirname(file), { recursive: true });
  await writeJsonAtomic(file, value, { io, mode: 0o600 });
}

// { month, queries, cap, provider } for this month (queries 0 when the file is from another month).
export async function readPeopleUsage(root, config, { io = fs, now = new Date() } = {}) {
  const settings = peopleSearchSettings(config);
  const month = monthKey(now, config?.timeZone || null);
  const stored = await readJson(peopleUsagePath(root), io);
  return { month, queries: stored?.month === month ? Number(stored.queries || 0) : 0, cap: settings.monthlyCap, provider: settings.provider };
}

// What the panel may do: { available, reason: 'off' | 'no-key' | 'cap' | null, provider }.
export async function peopleSearchStatus(root, config, { io = fs, now = new Date() } = {}) {
  const settings = peopleSearchSettings(config);
  if (!settings.enabled) return { available: false, reason: 'off', provider: settings.provider };
  const key = await readSearchKey(config, settings.provider, io);
  if (!key.apiKey) return { available: false, reason: 'no-key', provider: settings.provider };
  const usage = await readPeopleUsage(root, config, { io, now });
  if (usage.queries >= usage.cap) return { available: false, reason: 'cap', provider: settings.provider };
  return { available: true, reason: null, provider: settings.provider };
}

// ---------------------------------------------------------------------------------------------- profile

// "University of Example North Town" → "UENT": the capitals of each word and hyphenated part, "of",
// "the", "at" and "and" left out; a name with fewer than three such letters keeps its own name.
export function schoolShortName(name) {
  const initials = String(name || '').split(/[\s-]+/).filter(word => /^[A-Z]/.test(word) && !/^(?:Of|The|At|And)$/i.test(word)).map(word => word[0]).join('');
  return initials.length >= 3 ? initials : String(name || '').trim();
}

// The ways a school is written on a profile: the full name, the name without " at " ("University of Example at
// North Town" → "University of Example North Town"), and the short name.
export function schoolSpellings(school) {
  const name = String(school?.name || '').replace(/\s+/g, ' ').trim();
  const spellings = [name, name.replace(/\s+at\s+/i, ' '), String(school?.short || '').trim()];
  return [...new Set(spellings.filter(Boolean))];
}

const SCHOOL_WORDS = /\b(?:University|College|Institute of|Institute|School of|Polytechnic|Universidad|Universit[éeä]t?)\b/;
const DATE_RANGE = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}|\b(?:19|20)\d{2}\s*[–—-]\s*(?:(?:19|20)\d{2}|Present|Current)\b/i;
const DATES_TAIL = /\s+(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+)?(?:19|20)\d{2}.*$/i;

// Schools and past employers read from resume digests (or any resume text): a school is a line that names a
// university or college and carries a date; an employer is the first part of a "Company | Role | Place  Dates"
// line. Nothing is hard-coded. (Past employers are read but no query or score uses them yet.)
export function profileFromText(text) {
  const schools = [];
  const pastEmployers = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line || /^(?:<!--|Skills:|Publication)/i.test(line) || !DATE_RANGE.test(line)) continue;
    const first = line.split(/\s+[|·•]\s+/)[0];
    const head = first.replace(DATES_TAIL, '').trim();
    if (SCHOOL_WORDS.test(first)) {
      const name = head.replace(/,?\s*(?:Bachelor|Master|B\.?S\.?|M\.?S\.?|Ph\.?D\.?|BA|MA|MBA)\b.*$/i, '').trim();
      if (name && !schools.includes(name)) schools.push(name);
    } else if (/\s[|·•]\s/.test(line) && head && head.length <= 80 && !pastEmployers.includes(head)) {
      pastEmployers.push(head);
    }
  }
  return { schools, pastEmployers };
}

// { schools: [{ name, short }], pastEmployers: [] } from the digests, else from config.outreach.profile; an
// empty schools list means no Alumni search. config.outreach.profile.schools may hold "Name" or
// { name, short }; a short written there wins over the initials.
export function outreachProfile({ digests = [], config = {} } = {}) {
  const fromDigests = { schools: [], pastEmployers: [] };
  for (const text of digests) {
    const found = profileFromText(text);
    for (const name of found.schools) if (!fromDigests.schools.includes(name)) fromDigests.schools.push(name);
    for (const name of found.pastEmployers) if (!fromDigests.pastEmployers.includes(name)) fromDigests.pastEmployers.push(name);
  }
  const configured = config?.outreach?.profile && typeof config.outreach.profile === 'object' ? config.outreach.profile : {};
  const configSchools = (Array.isArray(configured.schools) ? configured.schools : []).map(item => (typeof item === 'string' ? { name: item.trim(), short: '' } : { name: String(item?.name || '').trim(), short: String(item?.short || '').trim() })).filter(item => item.name);
  const same = (a, b) => a.toLowerCase().replace(/\s+at\s+/, ' ') === b.toLowerCase().replace(/\s+at\s+/, ' ');
  const schools = fromDigests.schools.length ? fromDigests.schools.map(name => ({ name, short: configSchools.find(item => same(item.name, name))?.short || '' })) : configSchools;
  const pastEmployers = fromDigests.pastEmployers.length ? fromDigests.pastEmployers : (Array.isArray(configured.pastEmployers) ? configured.pastEmployers.map(String).map(item => item.trim()).filter(Boolean) : []);
  return { schools: schools.map(item => ({ name: item.name, short: item.short || schoolShortName(item.name) })), pastEmployers };
}

// ---------------------------------------------------------------------------------------------- the posting

export function isEarlyCareer(job) {
  return job?.roleType === 'internship' || job?.roleType === 'new_grad' || /\b(?:intern(?:ship)?|new grad(?:uate)?|university grad(?:uate)?|campus|early career)\b/i.test(String(job?.title || ''));
}

// The function the team works in, most specific first; the title is read before the JD.
const FUNCTIONS = [
  ['machine learning', /\bmachine learning\b|\bml\b/i],
  ['data science', /\bdata scien/i],
  ['data engineering', /\bdata engineer/i],
  ['analytics', /\banalytic|\banalyst\b|\bbusiness intelligence\b/i],
  ['artificial intelligence', /\bartificial intelligence\b|\bai\b|\bgenai\b/i],
  ['product', /\bproduct\b/i],
  ['consulting', /\bconsult/i],
  ['research', /\bresearch/i],
  ['quantitative', /\bquant/i],
  ['software engineering', /\bsoftware\b|\bdeveloper\b|\bengineer/i],
  ['data', /\bdata\b/i],
];
const TEAM_NAME = /\b(?:join|joining|on|part of|within)\s+(?:our|the)\s+((?:[A-Z][A-Za-z&]+|AI|ML)(?:\s+(?:[A-Z][A-Za-z&]+|AI|ML|&)){0,3})\s+[Tt]eam\b/;
const GENERIC_TEAM = /^(?:Our|The|This|Global|Growing|Great|Amazing|Talented|Hiring|Recruiting|Talent|People|Team)$/;
const STOP = new Set(['and', 'of', 'the', 'for', '&', 'team']);

export function termWords(term) {
  return String(term || '').toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length >= 2 && !STOP.has(word));
}

// { term, words, fromTeam }: a team the JD names ("join our Payments Analytics team") wins over the function
// read from the title, then from the JD.
export function functionTerm(job, company = '') {
  const description = String(job?.description || '');
  const team = TEAM_NAME.exec(description);
  if (team) {
    const name = team[1].trim();
    if (!GENERIC_TEAM.test(name) && name.toLowerCase() !== String(company || '').toLowerCase()) return { term: name, words: termWords(name), fromTeam: true };
  }
  for (const text of [String(job?.title || ''), description]) {
    const hit = FUNCTIONS.find(([, pattern]) => pattern.test(text));
    if (hit) return { term: hit[0], words: termWords(hit[0]), fromTeam: false };
  }
  return { term: 'data', words: ['data'], fromTeam: false };
}

const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };

// The posting's first place: { city, state, stateName }, or nulls for Remote or an empty location.
export function jobPlace(job) {
  const first = String(Array.isArray(job?.location) ? job.location[0] || '' : job?.location || '').split(/\s*[;/]\s*|\s+or\s+/i)[0];
  const parts = first.split(',').map(part => part.trim()).filter(Boolean);
  const city = parts[0] && !/remote|hybrid|anywhere|united states|^usa?$/i.test(parts[0]) ? parts[0] : null;
  const code = parts.slice(1).map(part => part.toUpperCase()).find(part => STATES[part]) || null;
  const named = !code ? Object.entries(STATES).find(([, name]) => parts.slice(1).some(part => part.toLowerCase() === name.toLowerCase())) : null;
  return { city, state: code || named?.[0] || null, stateName: code ? STATES[code] : named?.[1] || null };
}

function quoted(text) {
  return `"${String(text || '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim()}"`;
}

// The three queries (Recruiter, Team, Alumni), each with its cache key; Alumni only when a school is known,
// with every spelling of the school OR-ed.
export function peopleQueries({ company, job, profile = { schools: [] } }) {
  const name = quoted(company);
  const companyKey = String(company || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const recruiterTerms = isEarlyCareer(job)
    ? '("university recruiter" OR "campus recruiter" OR "early career" OR "talent acquisition" OR recruiter)'
    : '("technical recruiter" OR "talent acquisition" OR recruiter)';
  const fn = functionTerm(job, company);
  const { city } = jobPlace(job);
  const queries = [
    { kind: 'recruiter', query: `site:linkedin.com/in ${name} ${recruiterTerms}`, cacheKey: `recruiter:${companyKey}:${isEarlyCareer(job) ? 'early' : 'experienced'}` },
    { kind: 'team', query: `site:linkedin.com/in ${name} ${quoted(fn.term)} (manager OR director OR lead OR head)${city ? ` ${quoted(city)}` : ''}`, cacheKey: `team:${companyKey}:${fn.term.toLowerCase()}` },
  ];
  const school = profile?.schools?.[0];
  if (school) {
    const spellings = schoolSpellings(school);
    const terms = spellings.length > 1 ? `(${spellings.map(quoted).join(' OR ')})` : quoted(spellings[0]);
    queries.push({ kind: 'alumni', query: `site:linkedin.com/in ${name} ${terms}`, cacheKey: `alumni:${companyKey}:${spellings.join('|').toLowerCase()}` });
  }
  return queries;
}

// The three Google searches the panel offers when there is no key, the cap is reached, or nothing was found:
// the same queries, opened by the owner in a new tab. Without a school, Find Alumni searches the company's
// people with "alumni".
export function fallbackSearches({ company, job, profile }) {
  const byKind = Object.fromEntries(peopleQueries({ company, job, profile }).map(item => [item.kind, item.query]));
  return [
    { kind: 'recruiter', label: 'Find Recruiters', url: googleSearchUrl(byKind.recruiter) },
    { kind: 'team', label: 'Find Team', url: googleSearchUrl(byKind.team) },
    { kind: 'alumni', label: 'Find Alumni', url: googleSearchUrl(byKind.alumni || `site:linkedin.com/in ${quoted(company)} alumni`) },
  ];
}

// ---------------------------------------------------------------------------------------------- results

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu;
const HONORIFIC = /^(?:Dr|Mr|Mrs|Ms|Mx|Prof)\.?$/i;

// linkedin.com/in/<slug> (any subdomain), else null: company pages, posts and directories are not people.
export function profileSlug(raw) {
  if (!isLinkedInUrl(raw)) return null;
  const match = /^\/in\/([^/?#]+)\/?$/.exec(new URL(String(raw)).pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]).toLowerCase();
  } catch {
    return null;
  }
}

// "Jane A. Doe, MBA 🚀 - University Recruiter - Example Corp | LinkedIn" → { name: 'Jane A. Doe', firstName:
// 'Jane', headline: 'University Recruiter · Example Corp' }. Also "Name - Company | LinkedIn" and
// "Name – Title at Company - LinkedIn".
export function parseProfileResult(result) {
  const slug = profileSlug(result?.url);
  if (!slug) return null;
  const title = String(result.title || '').replace(EMOJI, ' ').replace(/\s*(?:[|·–—-]\s*)?LinkedIn\s*$/i, '').replace(/\s+/g, ' ').trim();
  const [rawName, ...rest] = title.split(/\s+[-–—|·]\s+/);
  const name = String(rawName || '').replace(/\([^)]*\)/g, ' ').replace(/,.*$/, '').replace(/\s+/g, ' ').trim();
  if (!name || !/\p{L}/u.test(name) || name.split(' ').length > 5) return null;
  const firstName = name.split(' ').find(word => !HONORIFIC.test(word)) || name.split(' ')[0];
  const snippet = String(result.snippet || '').replace(EMOJI, ' ').replace(/\s+/g, ' ').trim();
  const headline = rest.map(part => part.trim()).filter(Boolean).join(' · ');
  return { name, firstName: firstName.replace(/[^\p{L}'’-]/gu, '') || firstName, headline, snippet: snippet.length > 300 ? `${snippet.slice(0, 299).trimEnd()}…` : snippet, url: `https://www.linkedin.com/in/${encodeURIComponent(slug)}`, slug };
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const FORMER = /(?:\bformer(?:ly)?|\bex-|\bex|\bpreviously|\bretired)\s*(?:(?:at|with|from|of|@)\s*)?$/i;

// 'current' when the text names the company and no mention is "former …", "ex-…", "previously …" or
// "retired …"; 'former' when one is; null when the company is not named at all.
export function companyMention(text, names) {
  const value = String(text || '');
  let found = false;
  for (const name of names) {
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegExp(name)})(?![\\p{L}\\p{N}])`, 'giu');
    for (const match of value.matchAll(pattern)) {
      found = true;
      const start = match.index + match[1].length;
      if (FORMER.test(value.slice(Math.max(0, start - 24), start))) return 'former';
    }
  }
  return found ? 'current' : null;
}

// The company's names to look for in a result: the short name and every name the candidate chain and the
// alias table hold for it, with legal suffixes dropped; at least two characters each, longest first.
export function companyNamesFor(names) {
  const out = new Set();
  for (const raw of names || []) {
    const name = String(raw || '').replace(/\s+/g, ' ').trim();
    if (name.length < 2) continue;
    out.add(name);
    const bare = name.replace(/,?\s+(?:Inc\.?|LLC|L\.P\.|LP|Ltd\.?|Corp\.?|Corporation|Co\.|Company|plc|PLC|Holdings?|Group)$/i, '').trim();
    if (bare.length >= 2) out.add(bare);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

// The search results reduced to people at the company: /in/ links only, the company named in the title or
// snippet and not as a former employer, one per slug.
export function peopleFromResults(results, companyNames) {
  const seen = new Set();
  const people = [];
  for (const result of results || []) {
    const person = parseProfileResult(result);
    if (!person || seen.has(person.slug)) continue;
    if (companyMention(`${result.title || ''} \n ${result.snippet || ''}`, companyNames) !== 'current') continue;
    seen.add(person.slug);
    people.push(person);
  }
  return people;
}

// ---------------------------------------------------------------------------------------------- ranking

const EARLY_TALENT = /\b(?:university|campus|early[- ]career|emerging talent)\b/i;
const RECRUITING = /\brecruit(?:er|ing)\b|\btalent acquisition\b/i;
const LEADER = /\b(?:manager|lead|director)\b/i;
const EXECUTIVE = /\b(?:vp|svp|evp|vice president|president|chief|ceo|cto|cfo|coo|cdo|cio)\b/i;

function mentionsPlace(text, place) {
  const value = String(text || '');
  if (place.city && new RegExp(`\\b${escapeRegExp(place.city)}\\b`, 'i').test(value)) return true;
  if (place.stateName && new RegExp(`\\b${escapeRegExp(place.stateName)}\\b`, 'i').test(value)) return true;
  return Boolean(place.state && new RegExp(`(?:,\\s*|\\b)${place.state}\\b`).test(value));
}

// The role words of a person: the title's middle part, or the snippet as well when the title gave only the
// company.
function roleText(person, companyNames) {
  const headline = String(person.headline || '');
  const onlyCompany = !headline || companyNames.some(name => headline.toLowerCase() === name.toLowerCase());
  return onlyCompany ? `${headline} ${person.snippet || ''}` : headline;
}

// A person's score for this posting; below MIN_PERSON_SCORE the person is not shown.
//   Recruiter: early-talent words on an internship or new-grad posting +3; recruiter / talent acquisition +2.
//   Team: each function word in the headline +2; manager / lead / director +1; VP and above at a company whose
//   board lists more than 200 postings −3.
//   Alumni: the school (any spelling) in the snippet +2; a function word as well +2.
//   Any kind: the posting's city or state in the headline or snippet +2.
export function scorePerson(person, { kind, job, fn, place, schools = [], bigCompany = false, companyNames = [] }) {
  const role = roleText(person, companyNames);
  let score = 0;
  if (kind === 'recruiter') {
    if (EARLY_TALENT.test(role) && isEarlyCareer(job)) score += 3;
    if (RECRUITING.test(role)) score += 2;
  }
  if (kind === 'team') {
    score += 2 * fn.words.filter(word => new RegExp(`\\b${escapeRegExp(word)}`, 'i').test(role)).length;
    if (LEADER.test(role)) score += 1;
    if (bigCompany && EXECUTIVE.test(role)) score -= 3;
  }
  if (kind === 'alumni') {
    const snippet = String(person.snippet || '');
    if (schools.some(school => schoolSpellings(school).some(spelling => new RegExp(`\\b${escapeRegExp(spelling)}\\b`, spelling === school.short ? '' : 'i').test(snippet)))) score += 2;
    if (fn.words.some(word => new RegExp(`\\b${escapeRegExp(word)}`, 'i').test(`${person.headline} ${snippet}`))) score += 2;
  }
  if (mentionsPlace(`${person.headline} ${person.snippet}`, place)) score += 2;
  return score;
}

// In Posting first (no cap), then the best of the searched people within each kind's cap; when a kind runs
// short the others fill the free rows. One row per slug (the higher score wins).
export function pickPeople(posting, scored, limit = PEOPLE_LIMIT) {
  // A searched person the JD already names stays one In Posting row and lends it the profile link.
  const nameKey = name => String(name || '').toLowerCase().replace(/[^\p{L}]+/gu, ' ').trim();
  const named = new Map(posting.map(person => [nameKey(person.name), person]));
  posting = posting.map(person => ({ ...person }));
  const bySlug = new Map();
  for (const person of scored) {
    const same = named.get(nameKey(person.name));
    if (same) {
      const row = posting.find(item => item.key === same.key);
      row.url = row.url || person.url;
      continue;
    }
    if (person.score < MIN_PERSON_SCORE) continue;
    const held = bySlug.get(person.slug);
    if (!held || person.score > held.score) bySlug.set(person.slug, person);
  }
  const ranked = [...bySlug.values()].sort((a, b) => b.score - a.score || SEARCHED_KINDS.indexOf(a.kind) - SEARCHED_KINDS.indexOf(b.kind));
  const rows = posting.slice(0, limit);
  const taken = { recruiter: 0, team: 0, alumni: 0 };
  const leftover = [];
  for (const person of ranked) {
    if (taken[person.kind] < KIND_CAPS[person.kind]) { taken[person.kind] += 1; rows.push(person); } else leftover.push(person);
  }
  const chosen = [...rows.slice(0, limit), ...leftover].slice(0, limit);
  return chosen.sort((a, b) => (a.kind === 'posting' ? 0 : 1) - (b.kind === 'posting' ? 0 : 1) || b.score - a.score);
}

// JD contacts as rows: a name or, failing that, the address.
export function postingPeople(contacts) {
  return (contacts || []).map(contact => {
    const name = contact.name || contact.email;
    const key = `posting-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}`;
    return { kind: 'posting', key, slug: key, name, firstName: contact.name ? contact.name.split(' ')[0] : '', headline: [contact.title, contact.email && contact.name ? contact.email : null].filter(Boolean).join(' · '), email: contact.email || null, url: null, score: 100 };
  });
}

// ---------------------------------------------------------------------------------------------- searching

function fresh(entry, now) {
  return Boolean(entry && Array.isArray(entry.people) && now.getTime() - Date.parse(entry.at || 0) < PEOPLE_CACHE_DAYS * 86_400_000);
}

function withTimeout(promise, ms) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`The search did not answer within ${Math.round(ms / 1000)} seconds`), { code: 'ETIMEDOUT' })), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

// True when every query of the posting is in the cache (the panel can show people with no wait).
export async function peopleCached({ root, company, job, profile, io = fs, now = new Date() }) {
  const cache = (await readJson(peopleCachePath(root), io)) || {};
  return peopleQueries({ company, job, profile }).every(item => fresh(cache.entries?.[item.cacheKey], now));
}

// Runs the posting's queries (cached ones cost nothing) and ranks the people. Returns
// { status: 'ok' | 'off' | 'no-key' | 'cap' | 'error', people, calls, reason }. people holds the In Posting rows
// even when nothing could be searched. A failure or the cap stops the remaining queries; what was found stays.
export async function findPeople({ root, config, company, companyNames = [], job, profile, contacts = [], bigCompany = false, io = fs, fetchImpl = fetch, now = new Date(), timeoutMs = PEOPLE_TIMEOUT_MS, userAgent } = {}) {
  const posting = postingPeople(contacts);
  const names = companyNamesFor([company, ...companyNames]);
  const fn = functionTerm(job, company);
  const place = jobPlace(job);
  const queries = peopleQueries({ company, job, profile });
  const settings = peopleSearchSettings(config);
  const cacheFile = peopleCachePath(root);
  const cache = (await readJson(cacheFile, io)) || {};
  const entries = cache.entries && typeof cache.entries === 'object' ? cache.entries : {};
  let calls = 0;
  let status = 'ok';
  let reason = null;
  const found = [];
  for (const item of queries) if (fresh(entries[item.cacheKey], now)) found.push(...entries[item.cacheKey].people.map(person => ({ ...person, kind: item.kind })));
  let pending = queries.filter(item => !fresh(entries[item.cacheKey], now));
  if (pending.length) {
    const gate = await peopleSearchStatus(root, config, { io, now });
    if (!gate.available) { status = gate.reason; pending = []; }
  }
  const apiKey = pending.length ? (await readSearchKey(config, settings.provider, io)).apiKey : null;
  let cacheChanged = false;
  for (const item of pending) {
    const usage = await readPeopleUsage(root, config, { io, now });
    if (usage.queries >= usage.cap) { status = 'cap'; reason = `The monthly people-search cap is reached (${usage.queries}/${usage.cap})`; break; }
    await writeJson(peopleUsagePath(root), { month: usage.month, queries: usage.queries + 1, provider: settings.provider, lastQueryAt: now.toISOString() }, io);
    calls += 1;
    const request = searchRequest(settings.provider, item.query, apiKey, userAgent || config.network?.userAgent, { recent: false, count: 10 });
    try {
      const response = await withTimeout(fetchImpl(assertNotLinkedIn(request.url), request.init), timeoutMs);
      if (!response.ok) { status = 'error'; reason = `The search answered HTTP ${response.status}`; break; }
      const people = peopleFromResults(parseSearchResults(settings.provider, await withTimeout(response.json(), timeoutMs)), names);
      entries[item.cacheKey] = { at: now.toISOString(), kind: item.kind, people: people.map(({ name, firstName, headline, snippet, url, slug }) => ({ name, firstName, headline, snippet, url, slug })) };
      cacheChanged = true;
      found.push(...people.map(person => ({ ...person, kind: item.kind })));
    } catch (error) {
      status = 'error';
      reason = errorSummary(error).split(apiKey || '\u0000').join('[redacted]');
      break;
    }
  }
  if (cacheChanged) {
    // Expired entries leave the file whenever it is written.
    for (const [key, entry] of Object.entries(entries)) if (!fresh(entry, now)) delete entries[key];
    await writeJson(cacheFile, { version: 1, updatedAt: now.toISOString(), entries }, io);
  }
  const scored = found.map(person => ({ ...person, key: person.slug, score: scorePerson(person, { kind: person.kind, job, fn, place, schools: profile?.schools || [], bigCompany, companyNames: names }) }));
  return { status, people: pickPeople(posting, scored), calls, reason };
}
