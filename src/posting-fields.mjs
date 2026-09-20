// Display-level normalization of two posting fields that sources report inconsistently:
//   - the company name Workday tenants expose ("100000 Motorola Solutions, Inc.", "631 Booz Allen
//     Hamilton_United States", "31 MSI - (Marvell Semiconductor Inc.) US"), and
//   - how precise a posting date is: an API timestamp with a time of day, or a day-level value from a
//     list age ("1d"), a Workday "Posted Yesterday", or a date-only JSON-LD datePosted.
// Both are pure functions of the job so the pipeline, the Desktop report, the XLSX, and the hub agree.
import { cleanText } from './utils.mjs';

// Leading tenant codes: "100000 ", "1007 ", "US101 ", "CP1367 ", "6942-", and 3–4 letter codes such as
// "TMN " when a multi-word name follows (two-letter codes like "GD" or "GE" are part of real names).
const NUMERIC_CODE = /^(?:[A-Z]{0,3}\d{1,7}[A-Z]?)[\s\-–_:]+/;
const LETTER_CODE = /^([A-Z]{3,4})\s+(?=[A-Z][a-z][\w&.'-]*(?:\s+\S+)+$)/;
const LEGAL_SUFFIX = /(?:,\s*|\s+)(?:Inc\.?|LLC\.?|L\.L\.C\.|Ltd\.?|plc|PLC|LP|L\.P\.|Corp\.?|GmbH|S\.A\.|N\.V\.|Pty\.?|Co\.)$|,\s*(?:Incorporated|Limited|Corporation|Company)$/i;
const TRAILING_REGION = /\s+(?:USA?|U\.S\.A?\.?|United States|Legal Entity)$/i;
const PARENTHESIZED_NAME = /\(([^()]{4,})\)/;

// Cleans a Workday hiringOrganization / tenant entity name into something a card can show.
export function cleanWorkdayCompany(raw) {
  let name = cleanText(raw || '');
  if (!name) return '';
  // "31 MSI - (Marvell Semiconductor Inc.) US": the parenthesized part is the real name.
  const inParentheses = PARENTHESIZED_NAME.exec(name);
  if (inParentheses && /[a-z]/.test(inParentheses[1]) && inParentheses[1].trim().split(/\s+/).length >= 2) name = inParentheses[1].trim();
  name = name.replace(NUMERIC_CODE, '');
  name = name.replace(LETTER_CODE, '');
  // "_United States", "_Unit", "_Corporate": anything after the first underscore is an internal unit.
  name = name.replace(/_.*$/, '').trim();
  for (let pass = 0; pass < 3; pass += 1) {
    const next = name.replace(TRAILING_REGION, '').replace(LEGAL_SUFFIX, '').trim().replace(/[,\s]+$/, '');
    if (next === name || !next) break;
    name = next;
  }
  return name || cleanText(raw || '');
}

// ---------------------------------------------------------------------------------------------- validation

// Legal and structural words that carry no identity on their own.
const LEGAL_WORDS = /\b(?:inc|llc|ltd|corp|corporation|company|co|holdings|group|limited|incorporated|plc|lp|gmbh|pty)\b\.?/gi;
// Names that only say "some employer".
const GENERIC_NAMES = new Set(['company', 'companies', 'employer', 'hiring', 'careers', 'career', 'jobs', 'job', 'team', 'recruiting', 'unknown', 'n/a', 'na', 'none', 'tbd', 'various', 'confidential', 'client', 'our client', 'a company', 'the company', 'company not resolved', 'multiple', 'startup', 'stealth', 'external', 'internal', 'corporate', 'global', 'portal', 'board', 'site']);
// Tenant codes in front of a name ("1007 ", "US101 ", "CP1367-") mean the raw entity, not a name.
const LEADING_CODE = /^(?:[A-Z]{0,3}\d{1,7}[A-Z]?)[\s\-–_:]+\S/;

// A usable company name keeps at least two letters once legal words are gone, is not a bare code or
// number, and is not a generic placeholder. "Inc. Company", "LLC", "US101", "1007" all fail.
export function isValidCompanyName(raw) {
  const name = cleanText(raw || '');
  if (!name) return false;
  if (GENERIC_NAMES.has(name.toLowerCase())) return false;
  if (LEADING_CODE.test(name)) return false;
  const stripped = name.replace(LEGAL_WORDS, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (!stripped) return false;
  if (GENERIC_NAMES.has(stripped.toLowerCase())) return false;
  const letters = (stripped.match(/\p{L}/gu) || []).length;
  if (letters < 2) return false;
  // A code: a single token that mixes digits with at most three letters ("US101", "Us101", "R-123456").
  if (!/\s/.test(stripped) && /\d/.test(stripped) && letters <= 3) return false;
  return true;
}

// Splits a CamelCase site name into words, gluing a short leading segment to the next one so brand
// names such as "LexisNexis" survive ("LexisNexisLegal" → "LexisNexis Legal", "ExampleCareers" → "Example").
const SITE_SUFFIXES = /(?:ExternalCareerSite|CareerSite|ExternalCareers|External|Careers?|Jobs?|Site|Global|Corporate|Portal|Board|Openings)+$/;
function wordsFromSite(site) {
  const trimmed = String(site || '').replace(/[_-]+/g, ' ').trim().replace(SITE_SUFFIXES, '');
  if (!trimmed) return '';
  const segments = trimmed.split(/\s+/).flatMap(part => part.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) || [part]);
  const words = [];
  for (const segment of segments) {
    const previous = words[words.length - 1];
    if (previous && previous.length <= 5 && /^[A-Z][a-z]/.test(segment) && /^[A-Z][a-z]/.test(previous)) words[words.length - 1] = previous + segment;
    else words.push(segment);
  }
  return words.join(' ');
}

function titleCaseSlug(slug) {
  return String(slug || '').split(/[-_.]+/).filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

// The last-resort candidate: the Workday site name, or a Greenhouse / Lever / Ashby board slug.
export function companyFromUrl(raw) {
  let url;
  try { url = new URL(String(raw || '')); } catch { return ''; }
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);
  const workday = /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/.exec(host);
  if (workday) {
    const rest = [...segments];
    if (rest.length && /^[a-z]{2}-[A-Z]{2}$/.test(rest[0])) rest.shift();
    const site = rest[0] === 'wday' ? rest[3] : rest[0];
    const fromSite = site && site.toLowerCase() !== 'job' ? wordsFromSite(site) : '';
    return fromSite && isValidCompanyName(fromSite) ? fromSite : titleCaseSlug(workday[1]);
  }
  if (/^(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io$/.test(host)) return titleCaseSlug(segments[0] === 'embed' ? url.searchParams.get('for') : segments[0]);
  if (/^jobs(?:\.eu)?\.lever\.co$/.test(host) || host === 'jobs.ashbyhq.com') return titleCaseSlug(segments[0]);
  return '';
}

// The candidate chain, first valid wins: the name the list or source gave → the board registry label →
// the employer name the scorer read in the posting → the cleaned ATS entity name → the URL. When none
// is valid the most name-like candidate is kept and the job is marked companyUncertain.
export function resolveCompanyName(job, { boardCompany = null } = {}) {
  const raw = [
    // Older payloads carry only `company`; for a Workday job that is the raw entity, not a source name.
    ['source', job?.companyFromSource ?? (job?.atsCompany || job?.atsKind || isWorkdayJob(job) ? null : job?.company)],
    ['registry', boardCompany || job?.boardCompany || null],
    ['employerName', job?.employerNameFromJd || null],
    ['ats', job?.atsCompany ? cleanWorkdayCompany(job.atsCompany) : (isWorkdayJob(job) && job?.company ? cleanWorkdayCompany(job.company) : (job?.atsKind && job?.company ? job.company : null))],
    ['url', companyFromUrl(job?.finalUrl || job?.url)],
  ];
  const candidates = raw.map(([source, value]) => [source, cleanText(value || '')]).filter(([, value]) => value);
  const valid = candidates.find(([, value]) => isValidCompanyName(value));
  if (valid) return { name: valid[1], source: valid[0], uncertain: false, candidates: candidates.map(([source, value]) => ({ source, value })) };
  // Nothing passed: prefer the candidate with the most letters, then the earliest.
  const best = [...candidates].sort((a, b) => (b[1].match(/\p{L}/gu) || []).length - (a[1].match(/\p{L}/gu) || []).length)[0];
  return { name: best ? best[1] : '', source: best ? best[0] : null, uncertain: true, candidates: candidates.map(([source, value]) => ({ source, value })) };
}

export function isWorkdayJob(job) {
  return job?.atsKind === 'workday' || job?.enrichment === 'workday_cxs' || /\.myworkdayjobs\.com\//i.test(String(job?.finalUrl || job?.url || ''));
}

// The company name to show for a job: the pipeline's finalized name when it was validated, otherwise the
// candidate chain run over whatever the stored job carries (so older payloads read correctly too).
export function displayCompanyName(job) {
  if (job?.companySource && job.company && !job.companyUncertain) return cleanText(job.company);
  return resolveCompanyName(job).name;
}

export function companyIsUncertain(job) {
  if (typeof job?.companyUncertain === 'boolean' && job.companySource) return job.companyUncertain;
  return resolveCompanyName(job).uncertain;
}

// Freshness bases that carry a real time of day, straight from an API or a JSON-LD datePosted with a
// clock time. Day-level bases (list ages, Workday "Posted N Days Ago", date-only datePosted) are not here.
export const PRECISE_FRESHNESS_BASES = new Set([
  'greenhouse_updated_at', 'greenhouse_first_published', 'lever_created_at', 'ashby_published_at',
  'hn_comment_created_at', 'remoteok_date', 'email_received_at',
]);

// True when a raw date string names a time of day ("2026-09-18T10:00:00Z", "2026-09-18 10:00").
export function hasClockTime(raw) {
  return /\d{1,2}:\d{2}/.test(String(raw || ''));
}

// 'datetime' when the posting date is precise to the minute, 'date' when it is only a calendar day,
// null when the job has no posting date. An explicit job.postedAtPrecision wins; older payloads are
// judged by their freshness basis.
export function postedAtPrecision(job) {
  if (!job?.postedAt) return null;
  if (job.postedAtPrecision === 'datetime' || job.postedAtPrecision === 'date') return job.postedAtPrecision;
  const basis = String(job.freshnessBasis || '');
  if (PRECISE_FRESHNESS_BASES.has(basis)) return 'datetime';
  // Older payloads kept only the ISO value: a midnight instant came from a bare date.
  if (basis === 'jobposting_date_posted') return /T(?!00:00:00)\d{2}:\d{2}:\d{2}/.test(String(job.postedAt)) ? 'datetime' : 'date';
  return 'date';
}

export function hasPreciseTimestamp(job) {
  return postedAtPrecision(job) === 'datetime';
}

// An alert email's received time is precise but is not the posting's own time, so it stays lenient.
const RECHECK_EXEMPT_BASES = new Set(['email_received_at']);

// A posting whose own publish time is known to the minute can be held to the lookback window exactly;
// day-level sources keep the lenient rule because "Posted Yesterday" may mean 24 to 47 hours ago.
export function holdsToExactWindow(job) {
  return hasPreciseTimestamp(job) && !RECHECK_EXEMPT_BASES.has(String(job.freshnessBasis || ''));
}
