// Public applicant-tracking-system job boards, read through the JSON endpoints each vendor publishes
// for its hosted career pages. Every endpoint is unauthenticated and documented or openly used by the
// vendor's own board pages; nothing here signs in, scrapes HTML, or submits anything.
//
// Response shapes, verified against live public tenants on 2026-09-18:
//   Greenhouse  GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
//               { jobs: [{ id, absolute_url, title, company_name, location: { name }, offices: [{ name }],
//                 updated_at (ISO with offset), first_published (ISO), content (HTML, entity-escaped) }],
//                 meta: { total } }; supports ETag / If-None-Match (304).
//   Lever       GET https://api.lever.co/v0/postings/{company}?mode=json
//               a bare array: [{ id, text (title), hostedUrl, applyUrl, createdAt (epoch ms),
//                 categories: { commitment, department, location, team, allLocations: [] },
//                 workplaceType, country, descriptionPlain, lists: [{ text, content (HTML) }],
//                 additionalPlain, salaryRange: { currency, interval, min, max } }]; no company name in
//               the payload; supports ETag (304). An unknown company answers 404 { ok: false }.
//   Ashby       GET https://api.ashbyhq.com/posting-api/job-board/{org}
//               { apiVersion, jobs: [{ id, title, department, team, employmentType, location,
//                 secondaryLocations: [{ location }], isListed, isRemote, workplaceType, publishedAt (ISO),
//                 jobUrl, applyUrl, descriptionHtml, descriptionPlain,
//                 compensation: { compensationTierSummary, scrapeableCompensationSalarySummary } }];
//               no company name; sends an ETag but answers a conditional GET with a fresh 200.
//   Workday     POST https://{tenant}.{wdN}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
//               body { appliedFacets: {}, limit: 20, offset, searchText: "" } (20 per page, newest first)
//               { total, jobPostings: [{ title, externalPath ("/job/<location>/<slug>_<req>"),
//                 locationsText ("US, CA, Santa Clara" or "2 Locations"), postedOn ("Posted Today",
//                 "Posted 3 Days Ago", "Posted 30+ Days Ago"), bulletFields: [req id] }], facets }.
//               No description and no caching headers; the description comes from the existing
//               per-posting CXS detail endpoint in enrich.mjs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { workdayPostedOn } from '../enrich.mjs';
import { canonicalUrl, cleanText, isoDate, mapLimit, normalizeLocation } from '../utils.mjs';
import { createWarning, errorSummary } from '../warnings.mjs';

export const ATS_KINDS = { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', workday: 'Workday' };
export const ATS_SOURCE_KIND = 'public_ats_board';
// A board that fails this many nights in a row stops being polled until someone resumes it.
export const DORMANT_AFTER_FAILURES = 7;
// One poll per board per night: a same-day rerun leaves a board alone if it was polled this recently.
export const DEFAULT_MINIMUM_POLL_HOURS = 20;
// A board with no new posting for this long is "quiet" and polled weekly instead of nightly.
export const QUIET_AFTER_DAYS = 30;
export const QUIET_POLL_DAYS = 7;
export const REGISTRY_VERSION = 1;
const WORKDAY_PAGE_SIZE = 20;
const DEFAULT_MAXIMUM_WORKDAY_PAGES = 10;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const WORKDAY_HOST = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/i;
const WORKDAY_LOCALE = /^[a-z]{2}-[A-Z]{2}$/;

function slug(value) {
  const text = decodeURIComponent(String(value || '')).trim();
  return SLUG.test(text) ? text : null;
}

function titleCase(value) {
  return String(value || '').split(/[-_.]+/).filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

export function registryPath(config) {
  return path.join(config.root, 'state', 'ats-boards.json');
}

// ---------------------------------------------------------------------------------------------- identification

// Recognizes a posting URL or a board's front page and returns the board it belongs to, with the
// public API endpoint that lists its postings. Anything else returns null.
export function identifyBoard(raw) {
  let url;
  try { url = new URL(String(raw || '')); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);

  const greenhouse = /^(?:job-boards|boards)(\.eu)?\.greenhouse\.io$/.exec(host);
  if (greenhouse) {
    // Embedded boards link as boards.greenhouse.io/embed/job_app?for=<token>&token=<job id>.
    const token = slug(segments[0] === 'embed' ? url.searchParams.get('for') : segments[0]);
    if (!token || token === 'embed') return null;
    const region = greenhouse[1] ? '.eu' : '';
    return {
      key: `greenhouse:${token.toLowerCase()}`, kind: 'greenhouse', token,
      boardUrl: `https://job-boards${region}.greenhouse.io/${token}`,
      apiUrl: `https://boards-api${region}.greenhouse.io/v1/boards/${token}/jobs?content=true`,
    };
  }

  const lever = /^jobs(\.eu)?\.lever\.co$/.exec(host);
  if (lever) {
    const company = slug(segments[0]);
    if (!company) return null;
    const region = lever[1] ? '.eu' : '';
    return {
      key: `lever:${company.toLowerCase()}`, kind: 'lever', company: null, slug: company,
      boardUrl: `https://jobs${region}.lever.co/${company}`,
      apiUrl: `https://api${region}.lever.co/v0/postings/${company}?mode=json`,
    };
  }

  if (host === 'jobs.ashbyhq.com') {
    const org = slug(segments[0]);
    if (!org) return null;
    return {
      key: `ashby:${org.toLowerCase()}`, kind: 'ashby', slug: org,
      boardUrl: `https://jobs.ashbyhq.com/${org}`,
      apiUrl: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}`,
    };
  }

  const workday = WORKDAY_HOST.exec(host);
  if (workday) {
    const tenant = workday[1].toLowerCase();
    const rest = [...segments];
    if (rest.length && WORKDAY_LOCALE.test(rest[0])) rest.shift();
    // Both the career page (/{site}/job/...) and the CXS endpoints (/wday/cxs/{tenant}/{site}/...) name the site.
    const site = slug(rest[0] === 'wday' && rest[1] === 'cxs' ? rest[3] : rest[0]);
    if (!site || site.toLowerCase() === 'job' || site.toLowerCase() === 'wday') return null;
    return {
      key: `workday:${tenant}/${site}`, kind: 'workday', tenant, site, host,
      boardUrl: `https://${host}/${site}`,
      apiUrl: `https://${host}/wday/cxs/${tenant}/${site}/jobs`,
    };
  }
  return null;
}

// Every distinct board reachable from a batch of collected postings, remembering which posting revealed it.
export function discoverBoards(jobs) {
  const found = new Map();
  for (const job of jobs || []) {
    if (!job?.url || job.sourceKind === ATS_SOURCE_KIND) continue;
    const board = identifyBoard(job.url);
    if (!board || found.has(board.key)) continue;
    found.set(board.key, { ...board, company: cleanText(job.company || '') || null, discoveredFrom: job.source || null, discoveredUrl: job.url });
  }
  return [...found.values()];
}

// ---------------------------------------------------------------------------------------------- registry

export function normalizeRegistry(raw) {
  const boards = raw && typeof raw === 'object' && raw.boards && typeof raw.boards === 'object' && !Array.isArray(raw.boards) ? raw.boards : {};
  return { version: REGISTRY_VERSION, boards: { ...boards } };
}

export async function readRegistry(file, io = fs) {
  try {
    return normalizeRegistry(JSON.parse(await io.readFile(file, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return normalizeRegistry(null);
    throw error;
  }
}

export async function writeRegistry(file, registry, io = fs) {
  await io.mkdir(path.dirname(file), { recursive: true });
  await io.writeFile(file, `${JSON.stringify(normalizeRegistry(registry), null, 2)}\n`);
}

function newBoardRecord(board, now, origin) {
  return {
    key: board.key, kind: board.kind,
    token: board.token || null, slug: board.slug || null, tenant: board.tenant || null, site: board.site || null, host: board.host || null,
    company: board.company || null, boardUrl: board.boardUrl, apiUrl: board.apiUrl,
    origin, discoveredAt: now.toISOString(), discoveredFrom: board.discoveredFrom || null, discoveredUrl: board.discoveredUrl || null,
    enabled: true,
    lastPolledAt: null, lastSuccessAt: null, lastJobCount: null, lastNewCount: null, lastNewAt: null, quiet: false,
    baselinedAt: null, baselineCount: null,
    consecutiveFailures: 0, lastError: null, lastFailureAt: null, dormant: false, dormantSince: null,
    etag: null, lastModified: null,
  };
}

// Adds boards that are not yet known; known boards only pick up a company name they were missing.
export function registerBoards(registry, boards, { now = new Date(), origin = 'discovered' } = {}) {
  const added = [];
  for (const board of boards || []) {
    const existing = registry.boards[board.key];
    if (existing) {
      if (!existing.company && board.company) existing.company = board.company;
      continue;
    }
    registry.boards[board.key] = newBoardRecord(board, now, origin);
    added.push(board.key);
  }
  return added;
}

// config.sources.atsBoards.boards: [{ key | url, enabled, company, apiUrl }]. Entries add boards that
// discovery never saw and switch known ones on or off; `apiUrl` overrides the endpoint (proxies, tests).
export function applyConfigBoards(registry, entries, { now = new Date() } = {}) {
  const applied = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    const board = entry.url ? identifyBoard(entry.url) : boardFromKey(entry.key);
    if (!board) continue;
    registerBoards(registry, [{ ...board, company: cleanText(entry.company || '') || board.company || null }], { now, origin: 'config' });
    const record = registry.boards[board.key];
    if (entry.company) record.company = cleanText(entry.company);
    if (entry.apiUrl) record.apiUrl = String(entry.apiUrl);
    record.enabled = entry.enabled !== false;
    record.configured = true;
    applied.push(board.key);
  }
  return applied;
}

// "greenhouse:acme", "lever:acme", "ashby:acme", "workday:acme/External" (Workday also needs the host:
// "workday:acme/External@acme.wd5.myworkdayjobs.com").
export function boardFromKey(key) {
  const match = /^(greenhouse|lever|ashby|workday):(.+)$/.exec(String(key || '').trim());
  if (!match) return null;
  const [, kind, rest] = match;
  if (kind === 'greenhouse') return identifyBoard(`https://job-boards.greenhouse.io/${rest}`);
  if (kind === 'lever') return identifyBoard(`https://jobs.lever.co/${rest}`);
  if (kind === 'ashby') return identifyBoard(`https://jobs.ashbyhq.com/${rest}`);
  const [tenantSite, host] = rest.split('@');
  const [tenant, site] = tenantSite.split('/');
  if (!tenant || !site) return null;
  return identifyBoard(`https://${host || `${tenant}.wd5.myworkdayjobs.com`}/${site}`);
}

export function boardLabel(board) {
  const vendor = ATS_KINDS[board.kind] || titleCase(board.kind);
  const company = board.company || titleCase(board.token || board.slug || board.tenant || board.key.split(':')[1]);
  return `${vendor} · ${company}`;
}

export function resumeBoard(registry, key) {
  const board = registry.boards[String(key || '')];
  if (!board) return null;
  board.dormant = false;
  board.dormantSince = null;
  board.consecutiveFailures = 0;
  board.lastError = null;
  board.enabled = true;
  return board;
}

// ---------------------------------------------------------------------------------------------- parsers

function atsJob(board, fields) {
  const description = cleanText(fields.description || '');
  return {
    source: boardLabel({ ...board, company: fields.company || board.company }),
    sourceKind: ATS_SOURCE_KIND,
    board: board.key,
    atsKind: board.kind,
    company: fields.company || board.company || titleCase(board.token || board.slug || board.tenant || ''),
    title: fields.title,
    location: fields.location || '',
    url: fields.url,
    postedAt: fields.postedAt || null,
    freshnessBasis: fields.postedAt ? fields.freshnessBasis : null,
    employmentType: fields.employmentType || '',
    salary: fields.salary || '',
    externalId: fields.externalId || null,
    description: description.slice(0, 50000),
    // A description straight from the API needs no page fetch; Workday rows get theirs from the CXS detail call.
    ...(description ? { enrichment: 'ats_api', finalUrl: fields.url } : {}),
  };
}

export function parseGreenhouseJobs(payload, board) {
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  return jobs.map(job => {
    const url = canonicalUrl(job?.absolute_url);
    const title = cleanText(job?.title || '');
    if (!url || !title) return null;
    const updatedAt = isoDate(job.updated_at);
    const published = isoDate(job.first_published);
    const offices = (Array.isArray(job.offices) ? job.offices : []).map(office => office?.name).filter(Boolean);
    return atsJob(board, {
      title,
      company: cleanText(job.company_name || '') || null,
      location: normalizeLocation(job.location?.name || '') || normalizeLocation(offices),
      url,
      postedAt: updatedAt || published,
      firstPublishedAt: published,
      freshnessBasis: updatedAt ? 'greenhouse_updated_at' : 'greenhouse_first_published',
      description: job.content || '',
      externalId: job.id != null ? String(job.id) : null,
    });
  }).filter(Boolean);
}

function leverSalary(range) {
  if (!range || typeof range !== 'object') return '';
  const amount = range.min != null && range.max != null && range.min !== range.max ? `${range.min}–${range.max}` : `${range.min ?? range.max ?? ''}`;
  return amount ? [range.currency, amount, range.interval].filter(Boolean).join(' ') : '';
}

export function parseLeverPostings(payload, board) {
  const postings = Array.isArray(payload) ? payload : [];
  return postings.map(job => {
    const url = canonicalUrl(job?.hostedUrl);
    const title = cleanText(job?.text || '');
    if (!url || !title) return null;
    const categories = job.categories && typeof job.categories === 'object' ? job.categories : {};
    const locations = Array.isArray(categories.allLocations) && categories.allLocations.length ? categories.allLocations : [categories.location];
    const sections = (Array.isArray(job.lists) ? job.lists : []).map(list => `${cleanText(list?.text || '')} ${cleanText(list?.content || '')}`);
    const createdAt = Number(job.createdAt);
    return atsJob(board, {
      title,
      location: normalizeLocation(locations.filter(Boolean)),
      url,
      postedAt: Number.isFinite(createdAt) ? isoDate(new Date(createdAt)) : null,
      freshnessBasis: 'lever_created_at',
      employmentType: cleanText(categories.commitment || ''),
      salary: leverSalary(job.salaryRange),
      description: [job.descriptionPlain || cleanText(job.description || ''), ...sections, job.additionalPlain || ''].filter(Boolean).join('\n'),
      externalId: job.id ? String(job.id) : null,
    });
  }).filter(Boolean);
}

export function parseAshbyJobs(payload, board) {
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  return jobs.map(job => {
    if (job?.isListed === false) return null;
    const url = canonicalUrl(job?.jobUrl);
    const title = cleanText(job?.title || '');
    if (!url || !title) return null;
    const secondary = (Array.isArray(job.secondaryLocations) ? job.secondaryLocations : []).map(item => item?.location).filter(Boolean);
    const locations = [job.location, ...secondary].filter(Boolean);
    if (job.isRemote === true && !locations.some(item => /remote/i.test(item))) locations.push('Remote');
    const compensation = job.compensation && typeof job.compensation === 'object' ? job.compensation : {};
    return atsJob(board, {
      title,
      location: normalizeLocation(locations),
      url,
      postedAt: isoDate(job.publishedAt),
      freshnessBasis: 'ashby_published_at',
      employmentType: cleanText(job.employmentType || ''),
      salary: cleanText(compensation.compensationTierSummary || compensation.scrapeableCompensationSalarySummary || ''),
      description: job.descriptionPlain || job.descriptionHtml || '',
      externalId: job.id ? String(job.id) : null,
    });
  }).filter(Boolean);
}

// "Posted 30+ Days Ago" carries no date; it is treated as 31 days old so the lookback filter drops it.
function workdayPostedAt(text, now) {
  const parsed = workdayPostedOn(text, now);
  if (parsed) return parsed;
  return /30\+/.test(String(text || '')) ? new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString() : null;
}

export function parseWorkdayPostings(payload, board, now = new Date()) {
  const postings = Array.isArray(payload?.jobPostings) ? payload.jobPostings : [];
  return postings.map(job => {
    const externalPath = String(job?.externalPath || '');
    const title = cleanText(job?.title || '');
    if (!externalPath.startsWith('/') || !title) return null;
    const url = canonicalUrl(`https://${board.host}/${board.site}${externalPath}`);
    if (!url) return null;
    const locationText = cleanText(job.locationsText || '');
    return atsJob(board, {
      title,
      location: /^\d+\s+locations?$/i.test(locationText) ? '' : normalizeLocation(locationText),
      url,
      postedAt: workdayPostedAt(job.postedOn, now),
      freshnessBasis: 'workday_posted_on',
      externalId: Array.isArray(job.bulletFields) && job.bulletFields[0] ? String(job.bulletFields[0]) : null,
      description: '',
    });
  }).filter(Boolean);
}

const PARSERS = { greenhouse: parseGreenhouseJobs, lever: parseLeverPostings, ashby: parseAshbyJobs, workday: parseWorkdayPostings };

// ---------------------------------------------------------------------------------------------- polling

async function fetchWithTimeout(url, options, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal, redirect: 'follow' });
  } catch (error) {
    throw error?.name === 'AbortError' ? new Error(`timeout after ${timeoutMs} ms`) : error;
  } finally {
    clearTimeout(timer);
  }
}

function httpError(response) {
  const error = new Error(`HTTP ${response.status}`);
  error.status = response.status;
  return error;
}

async function pollWorkday(board, { fetchImpl, headers, timeoutMs, now, cutoff, maximumPages }) {
  const jobs = [];
  for (let page = 0; page < maximumPages; page += 1) {
    const body = JSON.stringify({ appliedFacets: {}, limit: WORKDAY_PAGE_SIZE, offset: page * WORKDAY_PAGE_SIZE, searchText: '' });
    const response = await fetchWithTimeout(board.apiUrl, { method: 'POST', headers: { ...headers, accept: 'application/json', 'content-type': 'application/json' }, body }, timeoutMs, fetchImpl);
    if (!response.ok) throw httpError(response);
    const payload = await response.json();
    const parsed = parseWorkdayPostings(payload, board, now);
    jobs.push(...parsed);
    const total = Number(payload?.total);
    const rawCount = Array.isArray(payload?.jobPostings) ? payload.jobPostings.length : 0;
    // Newest first: once a page reaches postings older than the window there is nothing newer behind it.
    const reachedOld = parsed.some(job => job.postedAt && new Date(job.postedAt) < cutoff);
    if (rawCount < WORKDAY_PAGE_SIZE || reachedOld || (Number.isFinite(total) && (page + 1) * WORKDAY_PAGE_SIZE >= total)) break;
  }
  return { notModified: false, jobs, etag: null, lastModified: null, status: 200 };
}

// One request (or one page walk for Workday) against a board's public endpoint. Conditional headers
// come from the board record; a 304 means nothing changed since the last successful poll.
export async function pollBoard(board, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number(options.timeoutMs || 15000);
  const now = options.now || new Date();
  const lookbackHours = Number(options.lookbackHours || 24);
  const cutoff = options.cutoff || new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
  const headers = { 'user-agent': 'DailyJobMatchAlert/0.1', ...(options.headers || {}) };
  if (board.kind === 'workday') return pollWorkday(board, { fetchImpl, headers, timeoutMs, now, cutoff, maximumPages: Number(options.maximumWorkdayPages || DEFAULT_MAXIMUM_WORKDAY_PAGES) });
  const parse = PARSERS[board.kind];
  if (!parse) throw new Error(`Unsupported ATS kind "${board.kind}"`);
  const conditional = {};
  if (board.etag) conditional['if-none-match'] = board.etag;
  if (board.lastModified) conditional['if-modified-since'] = board.lastModified;
  const response = await fetchWithTimeout(board.apiUrl, { headers: { ...headers, accept: 'application/json', ...conditional } }, timeoutMs, fetchImpl);
  if (response.status === 304) return { notModified: true, jobs: [], etag: board.etag, lastModified: board.lastModified, status: 304 };
  if (!response.ok) throw httpError(response);
  const payload = await response.json();
  return { notModified: false, jobs: parse(payload, board, now), etag: response.headers.get('etag') || null, lastModified: response.headers.get('last-modified') || null, status: response.status };
}

// Inside the lookback window means posted or updated at or after the cutoff. A posting whose date the
// source could not supply counts as old, never as new.
export function withinWindow(job, cutoff) {
  return Boolean(job.postedAt) && new Date(job.postedAt) >= cutoff;
}

// A board is quiet once nothing new has appeared for QUIET_AFTER_DAYS (counted from its last new
// posting, or from its discovery when it never had one); quiet boards are polled weekly.
export function isQuietBoard(board, now = new Date()) {
  const basis = board.lastNewAt || board.baselinedAt || board.discoveredAt;
  if (!basis) return false;
  return now.getTime() - new Date(basis).getTime() >= QUIET_AFTER_DAYS * 24 * 60 * 60 * 1000;
}

// Polls every enabled, non-dormant board once per night (weekly when quiet). The first poll of a board
// records the postings older than the lookback window as already seen (`baseline`) so a newly discovered
// board does not flood one report with its backlog, while postings inside the window go through the
// normal flow at once. Baseline marks skip URLs in `excludeUrls` (postings another source collected this
// run) so a listing elsewhere is never swallowed. Failures are isolated per board; the seventh
// consecutive failure marks the board dormant.
export async function collectAtsBoards({ registry, settings = {}, network = {}, now = new Date(), lookbackHours = 24, warnings = [], isSeen = () => false, isDeferred = () => false, excludeUrls = new Set(), fetchImpl = fetch }) {
  const cutoff = new Date(now.getTime() - Number(lookbackHours) * 60 * 60 * 1000);
  const minimumHours = Number(settings.minimumPollIntervalHours ?? DEFAULT_MINIMUM_POLL_HOURS);
  const headers = { 'user-agent': network.userAgent || 'DailyJobMatchAlert/0.1' };
  const jobs = [];
  const baseline = [];
  const results = [];
  const boards = Object.values(registry.boards);
  const wanted = job => (withinWindow(job, cutoff) || isDeferred(job)) && !isSeen(job);
  await mapLimit(boards, Number(network.concurrency || 3), async board => {
    const label = boardLabel(board);
    board.quiet = board.enabled !== false && !board.dormant && isQuietBoard(board, now);
    const result = { key: board.key, label, kind: board.kind, ok: true, skipped: null, baseline: false, jobCount: null, newCount: 0, baselineCount: 0, notModified: false, error: null, dormant: board.dormant === true, quiet: board.quiet };
    results.push(result);
    if (board.enabled === false) { result.skipped = 'disabled'; return; }
    if (board.dormant) { result.skipped = 'dormant'; return; }
    const sinceLastPoll = board.lastPolledAt ? now.getTime() - new Date(board.lastPolledAt).getTime() : Infinity;
    if (sinceLastPoll < minimumHours * 60 * 60 * 1000) { result.skipped = 'polled recently'; return; }
    if (board.quiet && sinceLastPoll < QUIET_POLL_DAYS * 24 * 60 * 60 * 1000) { result.skipped = 'quiet (weekly poll)'; return; }
    board.lastPolledAt = now.toISOString();
    try {
      const polled = await pollBoard(board, { fetchImpl, headers, timeoutMs: network.timeoutMs, now, cutoff, lookbackHours, maximumWorkdayPages: settings.maximumWorkdayPages });
      board.consecutiveFailures = 0;
      board.lastError = null;
      board.lastSuccessAt = now.toISOString();
      board.etag = polled.etag;
      board.lastModified = polled.lastModified;
      result.notModified = polled.notModified;
      if (!polled.notModified) board.lastJobCount = polled.jobs.length;
      result.jobCount = board.lastJobCount;
      if (!board.company) {
        const named = polled.jobs.find(job => job.company && job.company !== titleCase(board.token || board.slug || board.tenant || ''));
        if (named) board.company = named.company;
      }
      const fresh = polled.jobs.filter(wanted);
      if (!board.baselinedAt) {
        const old = polled.jobs.filter(job => !withinWindow(job, cutoff) && !excludeUrls.has(job.url) && !isDeferred(job));
        board.baselinedAt = now.toISOString();
        board.baselineCount = old.length;
        baseline.push(...old);
        result.baseline = true;
        result.baselineCount = old.length;
        warnings.push(createWarning('collector', boardLabel(board), `First poll recorded ${old.length} posting(s) older than the ${lookbackHours}-hour window as already seen (baseline); ${fresh.length} inside the window go through the normal flow`, 'info'));
      }
      board.lastNewCount = fresh.length;
      if (fresh.length) { board.lastNewAt = now.toISOString(); board.quiet = false; result.quiet = false; }
      result.newCount = fresh.length;
      jobs.push(...fresh);
    } catch (error) {
      board.consecutiveFailures = Number(board.consecutiveFailures || 0) + 1;
      board.lastError = errorSummary(error);
      board.lastFailureAt = now.toISOString();
      result.ok = false;
      result.error = board.lastError;
      let note = `failure ${board.consecutiveFailures} in a row`;
      if (board.consecutiveFailures >= DORMANT_AFTER_FAILURES) {
        board.dormant = true;
        board.dormantSince = now.toISOString();
        result.dormant = true;
        note += `; marked dormant after ${DORMANT_AFTER_FAILURES} consecutive failures, resume it from the hub Status page`;
      }
      warnings.push(createWarning('collector', label, `${board.lastError} (${note}); the other sources were not affected`));
    }
  });
  results.sort((a, b) => a.label.localeCompare(b.label));
  return { jobs, baseline, results };
}
