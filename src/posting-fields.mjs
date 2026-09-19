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

export function isWorkdayJob(job) {
  return job?.atsKind === 'workday' || job?.enrichment === 'workday_cxs' || /\.myworkdayjobs\.com\//i.test(String(job?.finalUrl || job?.url || ''));
}

// The company name to show for a job: a board's registry label (or a list's own company cell) wins;
// a raw Workday entity name is cleaned; anything else is shown as stored.
export function displayCompanyName(job) {
  const company = cleanText(job?.company || '');
  if (!company) return '';
  return isWorkdayJob(job) ? cleanWorkdayCompany(company) : company;
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
