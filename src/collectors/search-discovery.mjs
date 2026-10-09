// Search discovery: a handful of web searches per night for full-time entry-level data and AI postings,
// through a search API the owner signs up for. Off by default; without a key it never runs.
//
//   config.sources.searchDiscovery { enabled false, provider "brave" | "tavily", monthlyQueryCap 400,
//     queriesPerRun 12, queries [pool], excludeHosts [] }
//   private/search.json (gitignored) { "brave": "<key>" } or { "tavily": { "apiKey": "<key>" } }
//
// The key goes into one request header and nowhere else: never into a URL, a log line, a warning, the
// state, or the report; provider error text is scrubbed of it before it is kept.
//
// Request shapes (from the providers' public API references; no live call was made while building this):
//   Brave   GET https://api.search.brave.com/res/v1/web/search?q=&country=US&freshness=pd&count=20
//           header X-Subscription-Token; { web: { results: [{ title, url, description (HTML),
//           page_age ("2026-10-08T14:03:11", optional), age }] } }
//   Tavily  POST https://api.tavily.com/search, header Authorization: Bearer <key>,
//           body { query, topic: "general", time_range: "day", country: "united states", max_results: 20 }
//           { results: [{ title, url, content, score, published_date (optional) }] }
//
// Every query sent counts against monthlyQueryCap (state/search-usage.json, by local month) before it
// is sent, so a crash cannot lose a count; at the cap the collector stops with a warning instead of
// running into paid usage. Results on a known ATS register that board in state/ats-boards.json (origin
// "search_discovery") and its postings arrive through the board API with full data; other pages become
// candidates that face the same prefilter, baseline, freshness, dedupe and enrichment as any source. A
// result without page_age has no posting date: it is an undated posting, never stamped with "now".
import fs from 'node:fs/promises';
import path from 'node:path';
import { identifyBoard } from './ats-boards.mjs';
import { SEARCH_SOURCE_NAME } from './catalog.mjs';
import { localDate } from '../time-format.mjs';
import { canonicalUrl, cleanText, isoDate } from '../utils.mjs';
import { createWarning, errorSummary } from '../warnings.mjs';

export const SEARCH_DISCOVERY_SOURCE = SEARCH_SOURCE_NAME;
export const SEARCH_SOURCE_KIND = 'search_discovery';
export const SEARCH_PROVIDERS = ['brave', 'tavily'];
export const DEFAULT_MONTHLY_QUERY_CAP = 400;
export const DEFAULT_QUERIES_PER_RUN = 12;
export const DEFAULT_SEARCH_QUERIES = [
  'new grad data analyst 2027',
  'entry level data scientist 2027',
  'new graduate machine learning engineer',
  'data analyst I hiring 2027',
  'junior data scientist remote',
  'new grad business analyst 2027',
  'associate data engineer new grad',
  '2027 graduate data science program',
  'entry level AI engineer 2027',
];
// Job boards whose result pages list many postings (or copy them from elsewhere) rather than being one.
export const DEFAULT_EXCLUDED_HOSTS = [
  'indeed.com', 'glassdoor.com', 'ziprecruiter.com', 'simplyhired.com', 'monster.com', 'careerbuilder.com',
  'linkedin.com', 'talent.com', 'jooble.org', 'adzuna.com', 'salary.com', 'reddit.com', 'youtube.com',
];
const RESULTS_PER_QUERY = 20;
const KNOWN_ATS_HOSTS = [
  ['greenhouse', /(?:^|\.)greenhouse\.io$/],
  ['lever', /(?:^|\.)lever\.co$/],
  ['ashby', /(?:^|\.)ashbyhq\.com$/],
  ['workday', /(?:^|\.)myworkdayjobs\.com$|(?:^|\.)myworkdaysite\.com$/],
  ['icims', /(?:^|\.)icims\.com$/],
  ['smartrecruiters', /(?:^|\.)smartrecruiters\.com$/],
];
// "Data Analyst Jobs in Chicago", "1,240 entry level data jobs": a page of postings, not a posting.
const LISTING_TITLE = /(?<![A-Za-z])jobs(?![A-Za-z])|\b\d[\d,]*\+?\s+(?:[A-Za-z-]+\s+){0,4}(?:openings|positions|vacancies)\b/i;
const LISTING_SNIPPET = /\b\d[\d,]*\+?\s+(?:[A-Za-z-]+\s+){0,4}(?:jobs|openings|positions|vacancies)\s+(?:available|in|near|found|open)\b/i;

export function searchKeyPath(config) {
  return path.join(config.root, 'private', 'search.json');
}

export function searchUsagePath(config) {
  return path.join(config.root, 'state', 'search-usage.json');
}

export function searchSettings(config) {
  const raw = config?.sources?.searchDiscovery && typeof config.sources.searchDiscovery === 'object' ? config.sources.searchDiscovery : {};
  const provider = String(raw.provider || 'brave').trim().toLowerCase();
  const cap = Number(raw.monthlyQueryCap ?? DEFAULT_MONTHLY_QUERY_CAP);
  const perRun = Number(raw.queriesPerRun ?? DEFAULT_QUERIES_PER_RUN);
  const queries = Array.isArray(raw.queries) ? raw.queries.map(item => cleanText(String(item || ''))).filter(Boolean) : DEFAULT_SEARCH_QUERIES;
  return {
    enabled: raw.enabled === true,
    provider,
    monthlyQueryCap: Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : DEFAULT_MONTHLY_QUERY_CAP,
    queriesPerRun: Number.isFinite(perRun) && perRun > 0 ? Math.floor(perRun) : DEFAULT_QUERIES_PER_RUN,
    queries: queries.length ? queries : DEFAULT_SEARCH_QUERIES,
    excludeHosts: Array.isArray(raw.excludeHosts) ? raw.excludeHosts.map(item => String(item).toLowerCase().trim()).filter(Boolean) : DEFAULT_EXCLUDED_HOSTS,
  };
}

// The provider's key from private/search.json, or null. A missing or unreadable file is "no key"; the
// reason never quotes the file's content.
export async function readSearchKey(config, provider, io = fs) {
  let raw;
  try {
    raw = JSON.parse(await io.readFile(searchKeyPath(config), 'utf8'));
  } catch (error) {
    return { apiKey: null, reason: error?.code === 'ENOENT' ? 'private/search.json does not exist' : 'private/search.json is not valid JSON' };
  }
  const entry = raw && typeof raw === 'object' ? raw[provider] : null;
  const apiKey = typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? entry.apiKey : null;
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  return key ? { apiKey: key, reason: null } : { apiKey: null, reason: `private/search.json holds no ${provider} key` };
}

function dayOfYear(now, timeZone) {
  const [year, month, day] = localDate(now, timeZone).split('-').map(Number);
  return Math.round((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / 86_400_000) + 1;
}

// N consecutive queries from the pool, starting at dayOfYear (mod the pool), wrapping around; never the
// same query twice in one run. The same date always yields the same list.
export function rotateQueries(pool, now, count, timeZone = null) {
  const list = Array.isArray(pool) ? pool.filter(Boolean) : [];
  if (!list.length) return [];
  const start = dayOfYear(now, timeZone) % list.length;
  const take = Math.min(Math.max(0, Math.floor(Number(count) || 0)), list.length);
  return Array.from({ length: take }, (_, index) => list[(start + index) % list.length]);
}

export function monthKey(now, timeZone = null) {
  return localDate(now, timeZone).slice(0, 7);
}

export async function readSearchUsage(file, io = fs) {
  try {
    const raw = JSON.parse(await io.readFile(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

async function writeSearchUsage(file, usage, io = fs) {
  await io.mkdir(path.dirname(file), { recursive: true });
  await io.writeFile(file, `${JSON.stringify(usage, null, 2)}\n`);
}

function scrub(text, apiKey) {
  const value = String(text || '');
  return apiKey ? value.split(apiKey).join('[redacted]') : value;
}

export function searchRequest(provider, query, apiKey, userAgent = 'DailyJobMatchAlert/0.1') {
  if (provider === 'tavily') {
    return {
      url: 'https://api.tavily.com/search',
      init: {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json', 'user-agent': userAgent },
        body: JSON.stringify({ query, topic: 'general', time_range: 'day', country: 'united states', max_results: RESULTS_PER_QUERY, search_depth: 'basic' }),
      },
    };
  }
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('country', 'US');
  url.searchParams.set('search_lang', 'en');
  url.searchParams.set('freshness', 'pd');
  url.searchParams.set('count', String(RESULTS_PER_QUERY));
  return { url: url.toString(), init: { method: 'GET', headers: { 'x-subscription-token': apiKey, accept: 'application/json', 'user-agent': userAgent } } };
}

// Both providers reduced to { title, url, snippet, pageAge }.
export function parseSearchResults(provider, payload) {
  const items = provider === 'tavily'
    ? (Array.isArray(payload?.results) ? payload.results : []).map(item => ({ title: item?.title, url: item?.url, snippet: item?.content, pageAge: item?.published_date }))
    : (Array.isArray(payload?.web?.results) ? payload.web.results : []).map(item => ({ title: item?.title, url: item?.url, snippet: item?.description, pageAge: item?.page_age }));
  return items.map(item => ({
    title: cleanText(item.title || ''),
    url: canonicalUrl(item.url),
    snippet: cleanText(item.snippet || ''),
    pageAge: item.pageAge ? isoDate(item.pageAge) : null,
  })).filter(item => item.url && item.title);
}

// 'greenhouse', 'lever', ... when the URL lives on a known applicant-tracking system, else null.
export function atsVendorOf(raw) {
  let host;
  try { host = new URL(String(raw || '')).hostname.toLowerCase(); } catch { return null; }
  return KNOWN_ATS_HOSTS.find(([, pattern]) => pattern.test(host))?.[0] || null;
}

function hostExcluded(raw, hosts) {
  let host;
  try { host = new URL(String(raw || '')).hostname.toLowerCase(); } catch { return true; }
  return hosts.some(item => host === item || host.endsWith(`.${item}`));
}

// Site suffixes search engines append: "Data Analyst I | Example Corp Careers" → "Data Analyst I".
function postingTitle(title) {
  const head = String(title || '').split(/\s+[|·]\s+/)[0].trim();
  return head.length >= 3 ? head : String(title || '').trim();
}

// What a search result becomes: an ATS board to poll, a candidate posting, or a page to drop.
export function classifySearchResult(result, settings = { excludeHosts: DEFAULT_EXCLUDED_HOSTS }) {
  const vendor = atsVendorOf(result.url);
  const board = vendor ? identifyBoard(result.url) : null;
  if (board) return { kind: 'board', vendor, board };
  if (hostExcluded(result.url, settings.excludeHosts || [])) return { kind: 'drop', reason: 'job board page' };
  if (LISTING_TITLE.test(result.title) || LISTING_SNIPPET.test(result.snippet)) return { kind: 'drop', reason: 'listing page' };
  return { kind: 'candidate', vendor };
}

export function searchResultToJob(result, { provider, query } = {}) {
  return {
    source: SEARCH_DISCOVERY_SOURCE,
    sourceKind: SEARCH_SOURCE_KIND,
    company: '',
    title: postingTitle(result.title),
    location: '',
    url: result.url,
    // page_age is the page's own date; without it the posting is undated (never "now").
    postedAt: result.pageAge || null,
    postedAtPrecision: result.pageAge ? 'date' : null,
    freshnessBasis: result.pageAge ? 'search_page_age' : null,
    description: result.snippet || '',
    searchSnippet: result.snippet || '',
    searchQuery: query || null,
    searchProvider: provider || null,
  };
}

// Runs tonight's slice of the query pool. Returns { jobs, boards, report }; `report` feeds the source
// line in Run Details (queries sent, month total against the cap, boards found, pages dropped).
export async function collectSearchDiscovery({ settings, apiKey, now = new Date(), timeZone = null, usageFile, io = fs, fetchImpl = fetch, warnings = [], userAgent } = {}) {
  const provider = settings.provider;
  const month = monthKey(now, timeZone);
  const stored = await readSearchUsage(usageFile, io);
  const usage = stored.month === month ? { ...stored } : { month, queries: 0 };
  const queries = rotateQueries(settings.queries, now, settings.queriesPerRun, timeZone);
  const report = { kind: 'search', provider, queries: 0, plannedQueries: queries.length, monthQueries: Number(usage.queries || 0), monthlyQueryCap: settings.monthlyQueryCap, results: 0, boards: 0, dropped: {}, capReached: false, failedQueries: 0 };
  const jobs = new Map();
  const boards = new Map();
  const failures = [];
  for (const [index, query] of queries.entries()) {
    if (Number(usage.queries || 0) >= settings.monthlyQueryCap) {
      report.capReached = true;
      warnings.push(createWarning('collector', SEARCH_DISCOVERY_SOURCE, `monthly query cap reached (${usage.queries}/${settings.monthlyQueryCap} in ${month}); stopped before query ${index + 1} of ${queries.length} so the ${provider} free tier is not exceeded. Raise sources.searchDiscovery.monthlyQueryCap only if the plan allows it`));
      break;
    }
    usage.queries = Number(usage.queries || 0) + 1;
    usage.provider = provider;
    usage.lastQueryAt = now.toISOString();
    await writeSearchUsage(usageFile, usage, io);
    report.queries += 1;
    report.monthQueries = usage.queries;
    let payload;
    try {
      const request = searchRequest(provider, query, apiKey, userAgent);
      const response = await fetchImpl(request.url, request.init);
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      payload = await response.json();
    } catch (error) {
      report.failedQueries += 1;
      failures.push(scrub(errorSummary(error), apiKey));
      // A refused key or a rate limit will refuse every remaining query too.
      if ([401, 403, 429].includes(error?.status)) break;
      continue;
    }
    for (const result of parseSearchResults(provider, payload)) {
      report.results += 1;
      const outcome = classifySearchResult(result, settings);
      if (outcome.kind === 'board') {
        if (!boards.has(outcome.board.key)) boards.set(outcome.board.key, { ...outcome.board, company: null, discoveredFrom: SEARCH_DISCOVERY_SOURCE, discoveredUrl: result.url });
      } else if (outcome.kind === 'drop') {
        report.dropped[outcome.reason] = (report.dropped[outcome.reason] || 0) + 1;
      } else if (!jobs.has(result.url)) {
        jobs.set(result.url, searchResultToJob(result, { provider, query }));
      }
    }
  }
  report.boards = boards.size;
  if (failures.length) {
    const reason = failures.slice(0, 2).join('; ');
    warnings.push(createWarning('collector', SEARCH_DISCOVERY_SOURCE, `${failures.length} of ${report.queries} ${provider} quer${report.queries === 1 ? 'y' : 'ies'} failed (${reason}); the other sources were not affected`));
  }
  return { jobs: [...jobs.values()], boards: [...boards.values()], report };
}
