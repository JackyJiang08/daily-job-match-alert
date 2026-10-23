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
//   SmartRecruiters GET https://api.smartrecruiters.com/v1/companies/{company}/postings?limit=100&country=us
//               (public Posting API, no key; verified 2026-10-09) { offset, limit, totalFound, content: [{ id,
//                 name (title), company: { identifier, name }, releasedDate (ISO, newest first), location:
//                 { city, region, country, remote, fullLocation }, typeOfEmployment: { label },
//                 experienceLevel: { label } }] }; no description: the posting page
//               (jobs.smartrecruiters.com/{company}/{id}) carries it and is fetched by enrich.mjs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { workdayPostedOn } from '../enrich.mjs';
import { canonicalUrl, cleanText, isoDate, mapLimit, normalizeLocation, sha256 } from '../utils.mjs';
import { localDate } from '../time-format.mjs';
import { createWarning, errorCause, errorSummary, isNetworkError } from '../warnings.mjs';
import { NEW_SINCE_LAST_POLL, freshnessInstant } from '../posting-fields.mjs';
import { STATE_BACKUP_GENERATIONS, readJsonWithBackups, writeJsonAtomic } from '../json-file.mjs';

export const ATS_KINDS = { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', workday: 'Workday', smartrecruiters: 'SmartRecruiters' };
export const ATS_SOURCE_KIND = 'public_ats_board';
// A board that fails this many nights in a row stops being polled (dormant) until it answers a probe or
// someone resumes it.
export const DORMANT_AFTER_FAILURES = 7;
// A dormant board (still enabled) is probed with one light request every DORMANT_PROBE_DAYS, counted from
// when it went dormant or its last probe; one that answers resumes polling on its own. The grace lets the
// nightly run on the 30th day probe a board that went dormant a few seconds later in the evening.
export const DORMANT_PROBE_DAYS = 30;
export const DORMANT_PROBE_GRACE_HOURS = 6;
// One poll per board per night: a same-day rerun leaves a board alone if it was polled this recently.
export const DEFAULT_MINIMUM_POLL_HOURS = 20;
// A board with no new posting for this long is "quiet" and polled weekly instead of nightly.
export const QUIET_AFTER_DAYS = 30;
export const QUIET_POLL_DAYS = 7;
export const REGISTRY_VERSION = 1;
// More than this share of the boards polled in one run failing without an HTTP answer means this Mac
// lost its network, not that the boards broke: nothing is counted against them and they are retried once
// after OUTAGE_RETRY_DELAY_MS. At least OUTAGE_MINIMUM_FAILURES such failures are needed to call it.
export const OUTAGE_SHARE = 0.5;
export const OUTAGE_MINIMUM_FAILURES = 3;
export const OUTAGE_RETRY_DELAY_MS = 60_000;
// The wall clock running ahead of the monotonic clock by this much means the Mac slept during the run.
export const CLOCK_JUMP_MS = 5 * 60_000;
const WORKDAY_PAGE_SIZE = 20;
const DEFAULT_MAXIMUM_WORKDAY_PAGES = 10;
const SMARTRECRUITERS_PAGE_SIZE = 100;
const DEFAULT_MAXIMUM_SMARTRECRUITERS_PAGES = 5;
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

// ---------------------------------------------------------------------------------------------- poll snapshots

// What each board listed at its last successful poll, kept apart from the registry (the hub reads that
// one and it stays small): { version, boards: { key: { at, complete, count, ids: [16-hex hashes] } } }.
// A posting missing from a snapshot taken at most SNAPSHOT_MAX_AGE_HOURS ago appeared since that poll;
// one present in it was already on the board, whatever "Posted Yesterday" says now.
export const SNAPSHOT_MAX_AGE_HOURS = 30;
export const SNAPSHOT_VERSION = 1;

export function snapshotPath(config) {
  return path.join(config.root, 'state', 'ats-snapshots.json');
}

export function normalizeSnapshots(raw) {
  const boards = raw && typeof raw === 'object' && raw.boards && typeof raw.boards === 'object' && !Array.isArray(raw.boards) ? raw.boards : {};
  return { version: SNAPSHOT_VERSION, boards: { ...boards } };
}

export async function readSnapshots(file, io = fs) {
  try {
    return normalizeSnapshots(JSON.parse(await io.readFile(file, 'utf8')));
  } catch (error) {
    // A missing or unreadable file only means no board has a usable snapshot tonight.
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return normalizeSnapshots(null);
    throw error;
  }
}

export async function writeSnapshots(file, snapshots, registry = null, io = fs) {
  const normalized = normalizeSnapshots(snapshots);
  // Boards that left the registry leave the snapshot file too.
  if (registry) for (const key of Object.keys(normalized.boards)) if (!registry.boards[key]) delete normalized.boards[key];
  await writeJsonAtomic(file, normalized, { io, indent: 0 });
}

// A posting is identified by its canonical URL and, when the board gives one, its own id; either match
// counts, so a retitled Workday posting (new URL slug, same requisition) is still the same posting.
export function postingSnapshotIds(job) {
  const keys = [canonicalUrl(job?.url)].filter(Boolean);
  if (job?.externalId) keys.push(`id:${job.externalId}`);
  return keys.map(key => sha256(key).slice(0, 16));
}

export function buildSnapshot(jobs, { now, complete }) {
  const ids = new Set();
  for (const job of jobs || []) for (const id of postingSnapshotIds(job)) ids.add(id);
  return { at: now.toISOString(), complete: Boolean(complete), count: (jobs || []).length, ids: [...ids] };
}

// The previous snapshot when it can tell new from old: taken by a successful poll at most `maxAgeHours`
// ago, with no failed poll after it. Otherwise null, and the board falls back to the posting dates.
export function usableSnapshot(entry, board, now, maxAgeHours = SNAPSHOT_MAX_AGE_HOURS) {
  if (!entry || !Array.isArray(entry.ids) || !entry.at) return { snapshot: null, reason: 'no snapshot' };
  const at = new Date(entry.at).getTime();
  if (!Number.isFinite(at)) return { snapshot: null, reason: 'no snapshot' };
  if (board?.lastFailureAt && new Date(board.lastFailureAt).getTime() > at) return { snapshot: null, reason: 'last poll failed' };
  if (now.getTime() - at > Number(maxAgeHours) * 60 * 60 * 1000) return { snapshot: null, reason: `snapshot older than ${maxAgeHours} h` };
  return { snapshot: { ...entry, idSet: new Set(entry.ids) }, reason: null };
}

export function snapshotHas(snapshot, job) {
  return postingSnapshotIds(job).some(id => snapshot.idSet.has(id));
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

  if (host === 'jobs.smartrecruiters.com' || host === 'careers.smartrecruiters.com') {
    const company = slug(segments[0]);
    if (!company || /^(?:oneclick-ui|sr-jobs)$/i.test(company)) return null;
    return {
      key: `smartrecruiters:${company.toLowerCase()}`, kind: 'smartrecruiters', slug: company,
      boardUrl: `https://jobs.smartrecruiters.com/${company}`,
      apiUrl: `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings`,
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
  const migrations = raw && typeof raw === 'object' && raw.migrations && typeof raw.migrations === 'object' && !Array.isArray(raw.migrations) ? raw.migrations : null;
  return { version: REGISTRY_VERSION, boards: { ...boards }, ...(migrations ? { migrations: { ...migrations } } : {}) };
}

// One-time repair for runs before outage detection existed: a run in which more than OUTAGE_SHARE of the
// boards it polled failed without an HTTP answer at the same instant (10-11: the Mac was in a dark wake
// with no network and 841 boards said "fetch failed") counted a failure against every one of them. Those
// failures are taken back: the count drops by one, the error and failure time are cleared, a dormancy
// that started then is lifted, and lastPolledAt returns to the last success so the next run polls them.
// HTTP failures in the same run stay counted. Recorded in registry.migrations so it runs once.
export const OUTAGE_REPAIR_MIGRATION = 'undo-network-outage-failures';
const LEGACY_NETWORK_ERROR = /^fetch failed\b|^timeout after\b/i;

export function undoOutageFailures(registry, now = new Date()) {
  registry.migrations = registry.migrations && typeof registry.migrations === 'object' ? registry.migrations : {};
  if (registry.migrations[OUTAGE_REPAIR_MIGRATION]) return { applied: false, runs: [], boards: 0 };
  const boards = Object.values(registry.boards);
  const failedAt = new Map();
  for (const board of boards) {
    if (!board.lastFailureAt || !LEGACY_NETWORK_ERROR.test(String(board.lastError || ''))) continue;
    if (!failedAt.has(board.lastFailureAt)) failedAt.set(board.lastFailureAt, []);
    failedAt.get(board.lastFailureAt).push(board);
  }
  const runs = [];
  let repaired = 0;
  for (const [at, failed] of failedAt) {
    const polled = boards.filter(board => board.lastPolledAt === at || board.lastSuccessAt === at || board.lastFailureAt === at).length;
    if (failed.length < OUTAGE_MINIMUM_FAILURES || failed.length <= polled * OUTAGE_SHARE) continue;
    for (const board of failed) {
      board.consecutiveFailures = Math.max(0, Number(board.consecutiveFailures || 0) - 1);
      board.lastError = null;
      board.lastErrorCode = null;
      board.lastFailureAt = null;
      if (board.lastPolledAt === at) board.lastPolledAt = board.lastSuccessAt || null;
      if (board.dormant && board.dormantSince === at) { board.dormant = false; board.dormantSince = null; }
    }
    repaired += failed.length;
    runs.push({ at, boards: failed.length });
  }
  registry.migrations[OUTAGE_REPAIR_MIGRATION] = { at: now.toISOString(), runs };
  return { applied: true, runs, boards: repaired };
}

// A registry that does not parse falls back to the newest backup that does (ats-boards.json.1 … .3, kept by
// writeRegistry); onRestore(restored) lets the run warn and notify. restore: true (the pipeline) also puts
// that backup back in place; the hub only reads it.
export async function readRegistry(file, io = fs, { restore = false, onRestore = null, now = new Date() } = {}) {
  const read = await readJsonWithBackups(file, { io, restore, now });
  if (read.restored && onRestore) await onRestore(read.restored);
  return normalizeRegistry(read.value);
}

// Atomic, keeping the three previous generations.
export async function writeRegistry(file, registry, io = fs) {
  await writeJsonAtomic(file, normalizeRegistry(registry), { io, backups: STATE_BACKUP_GENERATIONS });
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

// "greenhouse:acme", "lever:acme", "ashby:acme", "smartrecruiters:Acme", "workday:acme/External" (Workday
// also needs the host: "workday:acme/External@acme.wd5.myworkdayjobs.com").
export function boardFromKey(key) {
  const match = /^(greenhouse|lever|ashby|smartrecruiters|workday):(.+)$/.exec(String(key || '').trim());
  if (!match) return null;
  const [, kind, rest] = match;
  if (kind === 'greenhouse') return identifyBoard(`https://job-boards.greenhouse.io/${rest}`);
  if (kind === 'lever') return identifyBoard(`https://jobs.lever.co/${rest}`);
  if (kind === 'ashby') return identifyBoard(`https://jobs.ashbyhq.com/${rest}`);
  if (kind === 'smartrecruiters') return identifyBoard(`https://jobs.smartrecruiters.com/${rest}`);
  const [tenantSite, host] = rest.split('@');
  const [tenant, site] = tenantSite.split('/');
  if (!tenant || !site) return null;
  return identifyBoard(`https://${host || `${tenant}.wd5.myworkdayjobs.com`}/${site}`);
}

// config.sources.atsBoards.seeds: company boards the owner adds by hand. Each entry is a key string
// ("greenhouse:acme", "workday:acme/External@acme.wd1.myworkdayjobs.com"), a board or posting URL, or an
// object naming one vendor: { greenhouse: "<token>" }, { lever: "<company>" }, { ashby: "<org>" },
// { smartrecruiters: "<company>" }, { workday: "<tenant>/<site>", host: "<tenant>.wdN.myworkdayjobs.com" },
// with an optional company label. A seed is registered once (origin "seed") and then lives like a
// discovered board: first-poll baseline, quiet after 30 days, dormant after 7 failures. Unlike `boards`,
// a seed never switches a board on again or overrides its endpoint.
export function seedBoard(entry) {
  if (typeof entry === 'string') return /^https?:/i.test(entry.trim()) ? identifyBoard(entry.trim()) : boardFromKey(entry);
  if (!entry || typeof entry !== 'object') return null;
  if (entry.url) return identifyBoard(entry.url);
  if (entry.key) return boardFromKey(entry.key);
  for (const kind of ['greenhouse', 'lever', 'ashby', 'smartrecruiters']) {
    if (entry[kind]) return boardFromKey(`${kind}:${entry[kind]}`);
  }
  if (entry.workday) {
    const [tenantSite, inlineHost] = String(entry.workday).split('@');
    const host = String(entry.host || inlineHost || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    // The data-center number (wd1, wd5, ...) cannot be guessed; without the host the seed is refused.
    if (!WORKDAY_HOST.test(host)) return null;
    return boardFromKey(`workday:${tenantSite}@${host}`);
  }
  return null;
}

export function applySeedBoards(registry, seeds, { now = new Date(), warnings = null } = {}) {
  const added = [];
  const invalid = [];
  for (const entry of Array.isArray(seeds) ? seeds : []) {
    const board = seedBoard(entry);
    if (!board) { invalid.push(entry); continue; }
    const company = entry && typeof entry === 'object' ? cleanText(entry.company || entry.name || '') || null : null;
    added.push(...registerBoards(registry, [{ ...board, company, discoveredFrom: 'seed' }], { now, origin: 'seed' }));
  }
  if (invalid.length && Array.isArray(warnings)) {
    const shown = invalid.slice(0, 3).map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('; ');
    warnings.push(createWarning('collector', 'ATS board seeds', `ignored ${invalid.length} seed(s) that name no Greenhouse token, Lever company, Ashby organization, SmartRecruiters company, or Workday tenant/site with its host (${shown}${invalid.length > 3 ? '; …' : ''})`));
  }
  return { added, invalid };
}

export function boardLabel(board) {
  const vendor = ATS_KINDS[board.kind] || titleCase(board.kind);
  const company = board.company || titleCase(board.token || board.slug || board.tenant || board.key.split(':')[1]);
  return `${vendor} · ${company}`;
}

// When a dormant board is next probed (ISO), or null for a board that is not dormant or was disabled.
export function nextDormantProbeAt(board, { days = DORMANT_PROBE_DAYS } = {}) {
  if (!board?.dormant || board.enabled === false) return null;
  const basis = [board.lastProbeAt, board.dormantSince].map(value => Date.parse(value || '')).filter(Number.isFinite);
  const from = basis.length ? Math.max(...basis) : 0;
  return new Date(from + Number(days) * 24 * 60 * 60 * 1000).toISOString();
}

export function dormantProbeDue(board, now = new Date(), options = {}) {
  const next = nextDormantProbeAt(board, options);
  return Boolean(next) && now.getTime() >= Date.parse(next) - DORMANT_PROBE_GRACE_HOURS * 60 * 60 * 1000;
}

// The light request: the list endpoint without descriptions (Greenhouse), one posting (Lever,
// SmartRecruiters, Workday), or the board endpoint (Ashby has no smaller one). Only the HTTP status is
// read. { ok, status, error, network }.
export async function probeBoard(board, { fetchImpl = fetch, headers = {}, timeoutMs = 15000 } = {}) {
  const request = { headers: { 'user-agent': 'DailyJobMatchAlert/0.1', ...headers, accept: 'application/json' } };
  let url = board.apiUrl;
  try {
    const parsed = new URL(board.apiUrl);
    if (board.kind === 'greenhouse') parsed.searchParams.delete('content');
    if (board.kind === 'lever' || board.kind === 'smartrecruiters') parsed.searchParams.set('limit', '1');
    url = parsed.toString();
  } catch {}
  if (board.kind === 'workday') Object.assign(request, { method: 'POST', headers: { ...request.headers, 'content-type': 'application/json' }, body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: '' }) });
  try {
    const response = await fetchWithTimeout(url, request, Number(timeoutMs) || 15000, fetchImpl);
    await response.body?.cancel?.().catch(() => {});
    return response.ok ? { ok: true, status: response.status, error: null, network: false } : { ok: false, status: response.status, error: `HTTP ${response.status}`, network: false };
  } catch (error) {
    return { ok: false, status: null, error: errorSummary(error), network: isNetworkError(error) };
  }
}

// Probes every enabled dormant board whose probe is due. One that answers resumes (dormant cleared, failures
// reset, an info line); the rest stay dormant until the next probe. Returns { probed, resumed, failed }.
export async function probeDormantBoards(registry, { now = new Date(), fetchImpl = fetch, headers = {}, timeoutMs, concurrency = 3, warnings = [], days = DORMANT_PROBE_DAYS, timeZone = null } = {}) {
  const due = Object.values(registry.boards).filter(board => dormantProbeDue(board, now, { days }));
  const resumed = [];
  const failed = [];
  await mapLimit(due, concurrency, async board => {
    const probe = await probeBoard(board, { fetchImpl, headers, timeoutMs });
    const since = board.dormantSince;
    board.lastProbeAt = now.toISOString();
    board.lastProbeResult = probe.ok ? `HTTP ${probe.status}` : probe.error;
    if (probe.ok) {
      Object.assign(board, { dormant: false, dormantSince: null, consecutiveFailures: 0, lastError: null, lastErrorCode: null, etag: null, lastModified: null, resumedAt: now.toISOString(), resumedBy: 'probe' });
      resumed.push(board.key);
      const days = since ? Math.round((now.getTime() - Date.parse(since)) / 86_400_000) : null;
      warnings.push(createWarning('collector', boardLabel(board), `answered the ${DORMANT_PROBE_DAYS}-day probe of a dormant board (HTTP ${probe.status}${days != null ? `, dormant for ${days} days` : ''}); polling resumes from the next run`, 'info'));
    } else {
      failed.push({ key: board.key, label: boardLabel(board), error: probe.error });
    }
  });
  if (failed.length) {
    failed.sort((a, b) => a.label.localeCompare(b.label));
    const next = nextDormantProbeAt(registry.boards[failed[0].key], { days });
    warnings.push(createWarning('collector', 'ATS boards', `probed ${due.length} dormant board(s); ${failed.length} still failing and stay dormant until the next probe${next ? ` (${localDate(new Date(next), timeZone)})` : ''}: ${failed.slice(0, 8).map(item => `${item.label} (${item.error})`).join(', ')}${failed.length > 8 ? ', …' : ''}`, 'info'));
  }
  return { probed: due.length, resumed, failed };
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
    company: board.company || fields.company || titleCase(board.token || board.slug || board.tenant || ''),
    boardCompany: board.company || null,
    atsCompany: fields.company || null,
    title: fields.title,
    location: fields.location || '',
    url: fields.url,
    postedAt: fields.postedAt || null,
    freshnessBasis: fields.postedAt ? fields.freshnessBasis : null,
    postedAtPrecision: fields.postedAt ? (board.kind === 'workday' ? 'date' : 'datetime') : null,
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

export function parseSmartRecruitersPostings(payload, board) {
  const postings = Array.isArray(payload?.content) ? payload.content : [];
  return postings.map(job => {
    const id = job?.id != null ? String(job.id) : '';
    const title = cleanText(job?.name || '');
    const identifier = slug(job?.company?.identifier) || board.slug;
    if (!/^[A-Za-z0-9-]+$/.test(id) || !title || !identifier) return null;
    const url = canonicalUrl(`https://jobs.smartrecruiters.com/${identifier}/${id}`);
    const place = job.location && typeof job.location === 'object' ? job.location : {};
    const named = cleanText(String(place.fullLocation || '').replace(/(?:,\s*)+/g, ', ').replace(/^,\s*|,\s*$/g, ''))
      || [place.city, place.region, String(place.country || '').toUpperCase()].filter(Boolean).join(', ');
    const locations = [named];
    if (place.remote === true && !/remote/i.test(named)) locations.unshift('Remote');
    return atsJob(board, {
      title,
      company: cleanText(job.company?.name || '') || null,
      location: normalizeLocation(locations.filter(Boolean)),
      url,
      postedAt: isoDate(job.releasedDate),
      freshnessBasis: 'smartrecruiters_released_date',
      employmentType: cleanText(job.typeOfEmployment?.label || ''),
      externalId: id,
      description: '',
    });
  }).filter(Boolean);
}

const PARSERS = { greenhouse: parseGreenhouseJobs, lever: parseLeverPostings, ashby: parseAshbyJobs, workday: parseWorkdayPostings, smartrecruiters: parseSmartRecruitersPostings };

// ---------------------------------------------------------------------------------------------- polling

async function fetchWithTimeout(url, options, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal, redirect: 'follow' });
  } catch (error) {
    throw error?.name === 'AbortError' ? Object.assign(new Error(`timeout after ${timeoutMs} ms`), { code: 'ETIMEDOUT' }) : error;
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
  // Complete only when the walk reached the end of the list; a walk stopped at the window's edge or at
  // the page limit leaves older postings out of the snapshot.
  let complete = false;
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
    const reachedEnd = rawCount < WORKDAY_PAGE_SIZE || (Number.isFinite(total) && (page + 1) * WORKDAY_PAGE_SIZE >= total);
    if (reachedEnd) complete = true;
    if (reachedEnd || reachedOld) break;
  }
  return { notModified: false, jobs, etag: null, lastModified: null, status: 200, complete };
}

// Newest first, 100 per page, US postings only; the walk stops at the first page that reaches the window's edge.
async function pollSmartRecruiters(board, { fetchImpl, headers, timeoutMs, now, cutoff, maximumPages }) {
  const jobs = [];
  let complete = false;
  for (let page = 0; page < maximumPages; page += 1) {
    const url = new URL(board.apiUrl);
    url.searchParams.set('limit', String(SMARTRECRUITERS_PAGE_SIZE));
    url.searchParams.set('offset', String(page * SMARTRECRUITERS_PAGE_SIZE));
    if (!url.searchParams.has('country')) url.searchParams.set('country', 'us');
    const response = await fetchWithTimeout(url.toString(), { headers: { ...headers, accept: 'application/json' } }, timeoutMs, fetchImpl);
    if (!response.ok) throw httpError(response);
    const payload = await response.json();
    const parsed = parseSmartRecruitersPostings(payload, board, now);
    jobs.push(...parsed);
    const total = Number(payload?.totalFound);
    const rawCount = Array.isArray(payload?.content) ? payload.content.length : 0;
    const reachedOld = parsed.some(job => job.postedAt && new Date(job.postedAt) < cutoff);
    const reachedEnd = rawCount < SMARTRECRUITERS_PAGE_SIZE || (Number.isFinite(total) && (page + 1) * SMARTRECRUITERS_PAGE_SIZE >= total);
    if (reachedEnd) complete = true;
    if (reachedEnd || reachedOld) break;
  }
  return { notModified: false, jobs, etag: null, lastModified: null, status: 200, complete };
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
  if (board.kind === 'smartrecruiters') return pollSmartRecruiters(board, { fetchImpl, headers, timeoutMs, now, cutoff, maximumPages: Number(options.maximumSmartRecruitersPages || DEFAULT_MAXIMUM_SMARTRECRUITERS_PAGES) });
  const parse = PARSERS[board.kind];
  if (!parse) throw new Error(`Unsupported ATS kind "${board.kind}"`);
  // Without a snapshot to carry forward, a 304 would leave nothing to compare against next night, so the
  // conditional headers are left off (options.conditional false) and the full list is fetched.
  const conditional = {};
  if (options.conditional !== false) {
    if (board.etag) conditional['if-none-match'] = board.etag;
    if (board.lastModified) conditional['if-modified-since'] = board.lastModified;
  }
  const response = await fetchWithTimeout(board.apiUrl, { headers: { ...headers, accept: 'application/json', ...conditional } }, timeoutMs, fetchImpl);
  if (response.status === 304) return { notModified: true, jobs: [], etag: board.etag, lastModified: board.lastModified, status: 304, complete: true };
  if (!response.ok) throw httpError(response);
  const payload = await response.json();
  return { notModified: false, jobs: parse(payload, board, now), etag: response.headers.get('etag') || null, lastModified: response.headers.get('last-modified') || null, status: response.status, complete: true };
}

// Inside the lookback window means posted or updated at or after the cutoff. A posting whose date the
// source could not supply counts as old, never as new.
export function withinWindow(job, cutoff, timeZone = null) {
  const instant = freshnessInstant(job, timeZone);
  return Boolean(instant) && new Date(instant) >= cutoff;
}

// A board is quiet once nothing new has appeared for QUIET_AFTER_DAYS (counted from its last new
// posting, or from its discovery when it never had one); quiet boards are polled weekly.
export function isQuietBoard(board, now = new Date()) {
  const basis = board.lastNewAt || board.baselinedAt || board.discoveredAt;
  if (!basis) return false;
  return now.getTime() - new Date(basis).getTime() >= QUIET_AFTER_DAYS * 24 * 60 * 60 * 1000;
}

// Measures how far the wall clock ran ahead of the monotonic clock since `start` (the monotonic clock
// stops while the Mac sleeps): a gap of CLOCK_JUMP_MS or more is a sleep, or a clock reset, mid-run.
export function createRunClock({ wall = () => Date.now(), monotonic = () => performance.now() } = {}) {
  const wall0 = wall();
  const monotonic0 = monotonic();
  return { jumpMs: () => Math.abs((wall() - wall0) - (monotonic() - monotonic0)) };
}

// "ENOTFOUND ×812, ECONNRESET ×3": the commonest reasons among failed polls, most frequent first.
export function causeTally(errors, limit = 3) {
  const counts = new Map();
  for (const error of errors) {
    const cause = errorCause(error);
    const code = cause?.code || cause?.message || error?.message || 'unknown';
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([code, count]) => ({ code, count }));
}

export function causeTallyText(tally) {
  return tally.map(item => `${item.code} ×${item.count}`).join(', ');
}

// Polls every enabled, non-dormant board once per night (weekly when quiet). Freshness by snapshot: with a
// usable snapshot of the previous poll (`snapshots`, see usableSnapshot), a posting absent from it is new
// since that poll (freshnessBasis "new since last poll", firstSeenAt = now; on a partial snapshot it must
// also pass the posting-date rule) and a posting present in it is old even when its date says yesterday,
// unless it is deferred (carried over). Without one (a new board, a failed last poll, a quiet board's week
// gap) the posting dates decide, as before. Every successful poll replaces the board's snapshot; a 304
// renews it. The first poll of a board
// records the postings older than the lookback window as already seen (`baseline`) so a newly discovered
// board does not flood one report with its backlog, while postings inside the window go through the
// normal flow at once. Baseline marks skip URLs in `excludeUrls` (postings another source collected this
// run) so a listing elsewhere is never swallowed. Failures are isolated per board; the seventh
// consecutive failure marks the board dormant. A board in `wakeKeys` (a search result pointed at one of
// its postings tonight) skips the quiet board's weekly wait; disabled, dormant, and recently polled
// boards stay as they are.
//
// Local outages: when more than OUTAGE_SHARE of the polled boards fail without an HTTP answer (or the
// clock jumped by CLOCK_JUMP_MS during the run, see createRunClock), the failures are this Mac's, not the
// boards'. Those boards are polled once more after `retryDelayMs`; any still failing then are left exactly
// as they were (no failure counted, no dormancy, no snapshot, no lastSuccessAt, lastPolledAt restored so
// the next run polls them) and the result's `outage` describes it. HTTP errors are always the board's own.
export async function collectAtsBoards({ registry, snapshots = null, settings = {}, network = {}, now = new Date(), lookbackHours = 24, timeZone = null, warnings = [], isSeen = () => false, isDeferred = () => false, excludeUrls = new Set(), wakeKeys = new Set(), fetchImpl = fetch, clock = null, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), retryDelayMs = OUTAGE_RETRY_DELAY_MS }) {
  const runClock = clock || createRunClock();
  const store = snapshots || normalizeSnapshots(null);
  const snapshotMaxAgeHours = Number(settings.snapshotMaxAgeHours ?? SNAPSHOT_MAX_AGE_HOURS);
  const cutoff = new Date(now.getTime() - Number(lookbackHours) * 60 * 60 * 1000);
  const minimumHours = Number(settings.minimumPollIntervalHours ?? DEFAULT_MINIMUM_POLL_HOURS);
  const headers = { 'user-agent': network.userAgent || 'DailyJobMatchAlert/0.1' };
  const concurrency = Number(network.concurrency || 3);
  const jobs = [];
  const baseline = [];
  const results = [];
  const failures = [];
  const boards = Object.values(registry.boards);
  const wanted = job => (withinWindow(job, cutoff, timeZone) || isDeferred(job)) && !isSeen(job);

  function applySuccess(board, result, polled, previous) {
    board.consecutiveFailures = 0;
    board.lastError = null;
    board.lastErrorCode = null;
    board.lastSuccessAt = now.toISOString();
    board.etag = polled.etag;
    board.lastModified = polled.lastModified;
    Object.assign(result, { ok: true, error: null, errorCode: null, outage: false, notModified: polled.notModified });
    if (!polled.notModified) board.lastJobCount = polled.jobs.length;
    result.jobCount = board.lastJobCount;
    if (!board.company) {
      const named = polled.jobs.find(job => job.company && job.company !== titleCase(board.token || board.slug || board.tenant || ''));
      if (named) board.company = named.company;
    }
    let fresh;
    const snapshot = previous.snapshot;
    if (snapshot) {
      result.freshnessRule = 'snapshot';
      fresh = [];
      for (const job of polled.jobs) {
        if (isSeen(job)) continue;
        const present = snapshotHas(snapshot, job);
        if (present || (!snapshot.complete && !withinWindow(job, cutoff, timeZone))) {
          // Already on the board last night: only a posting the review budget deferred comes back.
          if (isDeferred(job)) fresh.push(job);
          else if (present && withinWindow(job, cutoff, timeZone)) result.snapshotExcluded += 1;
          continue;
        }
        fresh.push({ ...job, freshnessBasis: NEW_SINCE_LAST_POLL, sourceFreshnessBasis: job.freshnessBasis || null, firstSeenAt: now.toISOString(), previousPollAt: snapshot.at });
        result.newSinceLastPoll += 1;
      }
    } else {
      result.freshnessRule = 'date';
      result.snapshotReason = previous.reason;
      fresh = polled.jobs.filter(wanted);
    }
    if (polled.notModified) {
      if (store.boards[board.key]) store.boards[board.key] = { ...store.boards[board.key], at: now.toISOString() };
    } else {
      store.boards[board.key] = buildSnapshot(polled.jobs, { now, complete: polled.complete !== false });
    }
    if (!board.baselinedAt) {
      const old = polled.jobs.filter(job => !withinWindow(job, cutoff, timeZone) && !excludeUrls.has(job.url) && !isDeferred(job));
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
  }

  async function attempt(entry) {
    try {
      const polled = await pollBoard(entry.board, { fetchImpl, headers, timeoutMs: network.timeoutMs, now, cutoff, lookbackHours, maximumWorkdayPages: settings.maximumWorkdayPages, maximumSmartRecruitersPages: settings.maximumSmartRecruitersPages, conditional: Boolean(store.boards[entry.board.key]) });
      applySuccess(entry.board, entry.result, polled, entry.previous);
      return true;
    } catch (error) {
      entry.error = error;
      entry.network = isNetworkError(error);
      entry.result.ok = false;
      entry.result.error = errorSummary(error);
      entry.result.errorCode = errorCause(error)?.code || null;
      return false;
    }
  }

  function recordFailure({ board, result, error }) {
    board.consecutiveFailures = Number(board.consecutiveFailures || 0) + 1;
    board.lastError = errorSummary(error);
    board.lastErrorCode = errorCause(error)?.code || null;
    board.lastFailureAt = now.toISOString();
    result.ok = false;
    result.error = board.lastError;
    let note = `failure ${board.consecutiveFailures} in a row`;
    if (board.consecutiveFailures >= DORMANT_AFTER_FAILURES) {
      board.dormant = true;
      board.dormantSince = now.toISOString();
      result.dormant = true;
      note += `; marked dormant after ${DORMANT_AFTER_FAILURES} consecutive failures, probed again in ${DORMANT_PROBE_DAYS} days, or resume it from the hub Status page`;
    }
    warnings.push(createWarning('collector', result.label, `${board.lastError} (${note}); the other sources were not affected`));
  }

  // A failure the outage explains leaves the board as it was before this run touched it.
  function excuse({ board, result, previousPolledAt }) {
    if (previousPolledAt) board.lastPolledAt = previousPolledAt;
    else board.lastPolledAt = null;
    board.lastOutageAt = now.toISOString();
    board.lastOutageError = result.error;
    result.outage = true;
  }

  let attempted = 0;
  await mapLimit(boards, concurrency, async board => {
    const label = boardLabel(board);
    board.quiet = board.enabled !== false && !board.dormant && isQuietBoard(board, now);
    const result = { key: board.key, label, kind: board.kind, ok: true, skipped: null, baseline: false, jobCount: null, newCount: 0, baselineCount: 0, notModified: false, error: null, errorCode: null, outage: false, dormant: board.dormant === true, quiet: board.quiet, freshnessRule: null, snapshotReason: null, newSinceLastPoll: 0, snapshotExcluded: 0 };
    results.push(result);
    if (board.enabled === false) { result.skipped = 'disabled'; return; }
    if (board.dormant) { result.skipped = 'dormant'; return; }
    const sinceLastPoll = board.lastPolledAt ? now.getTime() - new Date(board.lastPolledAt).getTime() : Infinity;
    if (sinceLastPoll < minimumHours * 60 * 60 * 1000) { result.skipped = 'polled recently'; return; }
    if (board.quiet && !wakeKeys.has(board.key) && sinceLastPoll < QUIET_POLL_DAYS * 24 * 60 * 60 * 1000) { result.skipped = 'quiet (weekly poll)'; return; }
    attempted += 1;
    // Read before this poll changes lastFailureAt: a failure after the snapshot makes it unusable.
    const entry = { board, result, previous: usableSnapshot(store.boards[board.key], board, now, snapshotMaxAgeHours), previousPolledAt: board.lastPolledAt || null, error: null, network: false };
    board.lastPolledAt = now.toISOString();
    if (!(await attempt(entry))) failures.push(entry);
  });

  let outage = null;
  const networkFailures = () => failures.filter(entry => entry.result.ok === false && entry.network);
  const looksSystemic = (failed, polled, jumped) => failed.length > 0 && (jumped || (failed.length >= OUTAGE_MINIMUM_FAILURES && failed.length > polled * OUTAGE_SHARE));
  const firstJump = runClock.jumpMs();
  const firstFailed = networkFailures();
  if (looksSystemic(firstFailed, attempted, firstJump >= CLOCK_JUMP_MS)) {
    const reason = firstFailed.length > attempted * OUTAGE_SHARE && firstFailed.length >= OUTAGE_MINIMUM_FAILURES ? 'network' : 'clock_jump';
    const firstCauses = causeTally(firstFailed.map(entry => entry.error));
    await sleep(retryDelayMs);
    const retryClock = createRunClock();
    await mapLimit(firstFailed, concurrency, entry => attempt(entry));
    const stillFailed = networkFailures();
    const recovered = firstFailed.length - stillFailed.length;
    // The retry decides: if most boards still cannot be reached (or the Mac slept again), the remaining
    // failures are the outage's; if most came back, the ones still failing are failing on their own.
    const persisting = stillFailed.length > 0 && (stillFailed.length * 2 > firstFailed.length || retryClock.jumpMs() >= CLOCK_JUMP_MS);
    outage = {
      detected: true, reason, attempted, failed: firstFailed.length, retried: firstFailed.length, recovered,
      missing: persisting ? stillFailed.length : 0, clockJumpMs: firstJump >= CLOCK_JUMP_MS ? Math.round(firstJump) : 0,
      retryDelayMs, causes: firstCauses, persisting,
    };
    if (persisting) for (const entry of stillFailed) excuse(entry);
  }
  for (const entry of failures) if (entry.result.ok === false && !entry.result.outage) recordFailure(entry);
  // Dormant boards due for their 30-day probe; skipped while this Mac's network is down (a probe then would
  // only push the next one a month out).
  const probes = outage?.persisting
    ? { probed: 0, resumed: [], failed: [], skipped: 'network outage' }
    : await probeDormantBoards(registry, { now, fetchImpl, headers, timeoutMs: network.timeoutMs, concurrency, warnings, timeZone, ...(Number(settings.dormantProbeDays) > 0 ? { days: Number(settings.dormantProbeDays) } : {}) });
  for (const key of probes.resumed) {
    const result = results.find(item => item.key === key);
    if (result) Object.assign(result, { dormant: false, resumed: true });
  }
  results.sort((a, b) => a.label.localeCompare(b.label));
  return { jobs, baseline, results, snapshots: store, outage, probes };
}
