// Community-maintained posting lists on GitHub, read from the raw README of each repository (public
// repositories, no token). They use Markdown pipe tables rather than the HTML rows of the SimplifyJobs
// lists, with one shape per maintainer (verified 2026-09-18):
//   vansh     | Company | Role | Location | Application/Link | Date Posted |
//             company "↳" repeats the row above; link is <a href="…">; several locations split by </br>;
//             Date Posted is "Aug 21" (no year).
//   zapply    | Company | Role | Location | Posted | Visa | **Apply** |
//             company is **bold**; Posted is an age token: 23m (minutes), 1h, 2d, 3w, 1mo, or
//             "Date unknown"; Apply is [<img …>](https://zapply.jobs/l/d/…), a redirect to the employer.
//   jobright  | Company | Job Title | Location | Work Model | Date Posted |
//             company is **[Name](site)**, title is **[Title](https://jobright.ai/jobs/info/…)**;
//             Date Posted is "Sep 18" (no year); Work Model is On Site / Remote / Hybrid.
//   zshah     | Company | Role | Apply | Location | Skills | Posted |
//             Apply is [Apply](employer url); Posted is "Sep 18, 2026"; words may carry zero-width
//             spaces; two tables (Summer 2027 and Fall 2026) share the layout.
// Every format yields the same job shape as the SimplifyJobs collector so downstream code is unchanged.
import { canonicalUrl, cleanText, normalizeLocation } from '../utils.mjs';
import { createWarning } from '../warnings.mjs';

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const DECORATION = /[\u200B-\u200D\uFEFF\uFE0F]|[\u{1F100}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
const CONTINUATION = /^(↳|⤷|—|-|"|same)$/i;

function plain(cell) {
  return cleanText(String(cell || '').replace(DECORATION, '').replace(/\*\*/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')).trim();
}

function firstHref(cell) {
  const text = String(cell || '');
  const matches = [...text.matchAll(/href=["']([^"']+)["']/gi), ...text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g), ...text.matchAll(/(?<![("'>])(https?:\/\/[^\s|)]+)/g)].map(match => match[1]);
  return matches.find(url => !/imgur\.com|images\/|\.png$|\.svg$/i.test(url)) || '';
}

// "Aug 21" or "Sep 18, 2026" → ISO date at noon UTC; a month/day without a year is taken as the most
// recent occurrence not after `now` (a list never announces future postings).
export function listDateToIso(text, now = new Date()) {
  const match = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?$/.exec(plain(text));
  if (!match) return null;
  const month = MONTHS[match[1].slice(0, 4).toLowerCase()] ?? MONTHS[match[1].slice(0, 3).toLowerCase()];
  if (month == null) return null;
  const day = Number(match[2]);
  let year = match[3] ? Number(match[3]) : now.getUTCFullYear();
  let stamp = Date.UTC(year, month, day, 12);
  if (!match[3] && stamp > now.getTime() + 24 * 60 * 60 * 1000) stamp = Date.UTC(year - 1, month, day, 12);
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
}

// zapply age tokens: 23m = minutes, 1h, 2d, 3w, 1mo; anything else is unknown.
export function ageTokenToDays(text) {
  const match = /^(\d+)\s*(mo|m|h|d|w)$/i.exec(plain(text).toLowerCase());
  if (!match) return null;
  const amount = Number(match[1]);
  switch (match[2]) {
    case 'mo': return amount * 30;
    case 'w': return amount * 7;
    case 'd': return amount;
    case 'h': return amount / 24;
    default: return amount / (24 * 60);
  }
}

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map(cell => cell.trim());
}

function isSeparator(cells) {
  return cells.length > 0 && cells.every(cell => /^:?-{2,}:?$/.test(cell) || cell === '');
}

function columnIndex(header, pattern) {
  return header.findIndex(cell => pattern.test(plain(cell)));
}

// Splits a README into tables; each table is { columns, rows } with rows as cell arrays.
export function parsePipeTables(markdown) {
  const tables = [];
  let current = null;
  let pendingHeader = null;
  for (const line of String(markdown).split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) { current = null; pendingHeader = null; continue; }
    const cells = splitRow(line);
    if (isSeparator(cells)) {
      if (pendingHeader) { current = { columns: pendingHeader, rows: [] }; tables.push(current); pendingHeader = null; }
      continue;
    }
    if (!current && !pendingHeader) { pendingHeader = cells; continue; }
    if (pendingHeader) { pendingHeader = cells; continue; }
    current.rows.push(cells);
  }
  return tables;
}

function columns(header) {
  return {
    company: columnIndex(header, /^company$/i),
    title: columnIndex(header, /^(role|job title|position|title)$/i),
    location: columnIndex(header, /^location/i),
    link: columnIndex(header, /^(apply|application\/link|application|link)$/i),
    posted: columnIndex(header, /^(date posted|posted|added|date)$/i),
    workModel: columnIndex(header, /^work model$/i),
  };
}

function rowJob(cells, at, format, source, roleType, now, previousCompany) {
  const companyCell = plain(at.company >= 0 ? cells[at.company] : '');
  const company = CONTINUATION.test(companyCell) || !companyCell ? previousCompany : companyCell;
  const title = plain(at.title >= 0 ? cells[at.title] : '');
  const linkCell = at.link >= 0 ? cells[at.link] : '';
  const url = canonicalUrl(firstHref(linkCell) || (format === 'jobright' && at.title >= 0 ? firstHref(cells[at.title]) : ''));
  const locationCell = at.location >= 0 ? String(cells[at.location]) : '';
  const locations = normalizeLocation(locationCell.split(/<\s*\/?\s*br\s*\/?\s*>/i).map(part => plain(part).replace(/\s*\(([^)]*)\)\s*$/, ' · $1')));
  const workModel = at.workModel >= 0 ? plain(cells[at.workModel]) : '';
  const location = /remote/i.test(workModel) && !/remote/i.test(locations) ? normalizeLocation([locations, 'Remote'].filter(Boolean)) : locations;
  if (!company || !title || !url) return { company, job: null };
  const postedCell = at.posted >= 0 ? cells[at.posted] : '';
  const job = { source, sourceKind: 'public_github_list', company, title, location, url, roleType, description: '' };
  if (format === 'zapply') {
    const ageDays = ageTokenToDays(postedCell);
    if (ageDays == null) return { company, job: null };
    job.sourceAgeDays = ageDays;
    job.freshnessBasis = 'source_age_days_approximate';
  } else {
    const postedAt = listDateToIso(postedCell, now);
    if (!postedAt) return { company, job: null };
    job.postedAt = postedAt;
    job.freshnessBasis = 'source_list_date_posted';
    job.postedAtPrecision = 'date';
  }
  if (workModel) job.workModel = workModel;
  return { company, job };
}

export function parseListRows(markdown, { source, roleType, format, now = new Date() }) {
  const jobs = [];
  for (const table of parsePipeTables(markdown)) {
    const at = columns(table.columns);
    if (at.company < 0 || at.title < 0) continue;
    let previousCompany = '';
    for (const cells of table.rows) {
      if (cells.length < table.columns.length - 1) continue;
      const { company, job } = rowJob(cells, at, format, source, roleType, now, previousCompany);
      previousCompany = company || previousCompany;
      if (job) jobs.push(job);
    }
  }
  return jobs;
}

export async function collectGithubList({ url, source, roleType, format, fetchImpl = fetch, warnings = null, now = new Date(), userAgent = 'DailyJobMatchAlert/0.1' }) {
  const response = await fetchImpl(url, { headers: { accept: 'text/plain', 'user-agent': userAgent } });
  if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`);
  const jobs = parseListRows(await response.text(), { source, roleType, format, now });
  // These lists always carry rows; an empty parse after a successful fetch means the README layout changed.
  if (!jobs.length && Array.isArray(warnings)) {
    warnings.push(createWarning('collector', source, `HTTP ${response.status} but no job rows were parsed; the upstream README format may have changed, check the source and the parser`));
  }
  return jobs;
}
