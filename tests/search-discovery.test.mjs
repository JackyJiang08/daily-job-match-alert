// New full-time sources: board seeds, the SmartRecruiters board kind (fixtures recorded from the public
// Posting API on 2026-10-09, trimmed and renamed to Example Corp), and search discovery (Brave/Tavily
// shapes from the providers' API references; every request goes to an injected fake, never the network).
// Also the uppercase US / U.S. / USA location evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applySeedBoards, collectAtsBoards, identifyBoard, normalizeRegistry, parseSmartRecruitersPostings, pollBoard, readRegistry, registerBoards, seedBoard,
} from '../src/collectors/ats-boards.mjs';
import {
  DEFAULT_SEARCH_QUERIES, SEARCH_DISCOVERY_SOURCE, SEARCH_SOURCE_KIND, classifySearchResult, collectSearchDiscovery, parseSearchResults, readSearchKey,
  rotateQueries, searchRequest, searchResultToJob, searchSettings,
} from '../src/collectors/search-discovery.mjs';
import { smartRecruitersApiUrl, enrichJob } from '../src/enrich.mjs';
import { assessEligibility, usEvidenceInDescription } from '../src/eligibility.mjs';
import { collectAtsBoardSources, collectEnabledSources, dedupeByFinalUrl, dedupeByUrl } from '../src/index.mjs';
import { prefilterJobs } from '../src/prefilter.mjs';
import { freshnessInstant, isUndated } from '../src/posting-fields.mjs';
import { sourceLine } from '../src/report.mjs';
import { isJobSeen } from '../src/state.mjs';
import { warningText } from '../src/warnings.mjs';

const fixtures = new URL('./fixtures/ats/', import.meta.url);
const NOW = new Date('2026-10-09T01:00:00Z'); // Oct 8, 8:00 PM in Chicago
const KEY = 'BSA-test-secret-0123456789';

async function fixture(name) {
  return JSON.parse(await fs.readFile(new URL(name, fixtures), 'utf8'));
}

function jsonResponse(payload, { status = 200 } = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

async function temporaryRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'search-discovery-'));
}

function braveResults(results) {
  return { type: 'search', web: { type: 'search', results: results.map(item => ({ type: 'search_result', ...item })) } };
}

// Only search discovery is on; every built-in list stays off so nothing reaches the network.
function searchConfig(root, overrides = {}) {
  return {
    root, timeZone: 'America/Chicago', lookbackHours: 24, network: { userAgent: 'TestAgent/1.0' },
    sources: {
      githubLists: { enabled: false }, hackerNewsHiring: { enabled: false }, remoteOk: { enabled: false },
      searchDiscovery: { enabled: true, provider: 'brave', ...overrides },
      atsBoards: { enabled: true },
    },
  };
}

async function writeKey(root, content) {
  await fs.mkdir(path.join(root, 'private'), { recursive: true });
  await fs.writeFile(path.join(root, 'private', 'search.json'), JSON.stringify(content));
}

// ------------------------------------------------------------------------------------------ SmartRecruiters

test('SmartRecruiters boards: URLs and keys identify the board, the recorded list parses, and the poll stops at the window', async () => {
  const board = identifyBoard('https://jobs.smartrecruiters.com/ExampleCorp/744000154523570-data-analyst-i?trid=x');
  assert.deepEqual(board, {
    key: 'smartrecruiters:examplecorp', kind: 'smartrecruiters', slug: 'ExampleCorp',
    boardUrl: 'https://jobs.smartrecruiters.com/ExampleCorp', apiUrl: 'https://api.smartrecruiters.com/v1/companies/ExampleCorp/postings',
  });
  assert.equal(identifyBoard('https://jobs.smartrecruiters.com/oneclick-ui/company/x'), null);
  const jobs = parseSmartRecruitersPostings(await fixture('smartrecruiters-postings.json'), board);
  assert.deepEqual(jobs.map(job => [job.title, job.company, job.location, job.url, job.postedAtPrecision, job.atsKind]), [
    ['Data Analyst I', 'Example Corp', 'Oklahoma City, OK, United States', 'https://jobs.smartrecruiters.com/ExampleCorp/744000154523570', 'datetime', 'smartrecruiters'],
    ['Senior Manufacturing Engineer', 'Example Corp', 'Remote · Londonderry, NH, United States', 'https://jobs.smartrecruiters.com/ExampleCorp/744000154521839', 'datetime', 'smartrecruiters'],
    ['Machine Learning Engineer, New Grad', 'Example Corp', 'Remote, United States', 'https://jobs.smartrecruiters.com/ExampleCorp/744000154519875', 'datetime', 'smartrecruiters'],
  ]);
  assert.equal(jobs[0].postedAt, '2026-10-08T20:40:57.699Z');
  assert.equal(jobs[0].enrichment, undefined, 'the list has no description: the posting is enriched from its detail endpoint');

  const requested = [];
  const polled = await pollBoard(board, { now: NOW, fetchImpl: async url => { requested.push(url); return jsonResponse(await fixture('smartrecruiters-postings.json')); } });
  assert.equal(polled.jobs.length, 3);
  assert.deepEqual(requested, ['https://api.smartrecruiters.com/v1/companies/ExampleCorp/postings?limit=100&offset=0&country=us'], 'one page: fewer than 100 rows came back');
});

test('SmartRecruiters postings are enriched from the public detail endpoint', async () => {
  const url = 'https://jobs.smartrecruiters.com/ExampleCorp/744000154523570-data-analyst-i';
  assert.equal(smartRecruitersApiUrl(url), 'https://api.smartrecruiters.com/v1/companies/ExampleCorp/postings/744000154523570');
  assert.equal(smartRecruitersApiUrl('https://example.com/ExampleCorp/1'), null);
  const detail = await fixture('smartrecruiters-posting.json');
  const requested = [];
  const enriched = await enrichJob({ url, title: 'Data Analyst I', company: '', source: SEARCH_DISCOVERY_SOURCE }, {}, async target => { requested.push(target); return jsonResponse(detail); });
  assert.deepEqual(requested, ['https://api.smartrecruiters.com/v1/companies/ExampleCorp/postings/744000154523570']);
  assert.equal(enriched.enrichment, 'smartrecruiters_api');
  assert.equal(enriched.company, 'Example Corp');
  assert.match(enriched.description, /SQL and Python/);
  assert.match(enriched.description, /authorized to work in the United States/);
  assert.equal(enriched.postedAtPrecision, 'datetime');
});

// ------------------------------------------------------------------------------------------ seeds

test('board seeds accept keys, URLs, and vendor objects; a Workday seed needs its host; bad seeds warn once', () => {
  assert.equal(seedBoard({ greenhouse: 'examplecorp' }).key, 'greenhouse:examplecorp');
  assert.equal(seedBoard({ lever: 'examplecorp' }).key, 'lever:examplecorp');
  assert.equal(seedBoard({ ashby: 'ExampleCorp' }).key, 'ashby:examplecorp');
  assert.equal(seedBoard({ smartrecruiters: 'ExampleCorp' }).key, 'smartrecruiters:examplecorp');
  assert.equal(seedBoard({ workday: 'examplecorp/Careers', host: 'examplecorp.wd1.myworkdayjobs.com' }).apiUrl, 'https://examplecorp.wd1.myworkdayjobs.com/wday/cxs/examplecorp/Careers/jobs');
  assert.equal(seedBoard('workday:examplecorp/Careers@examplecorp.wd3.myworkdayjobs.com').host, 'examplecorp.wd3.myworkdayjobs.com');
  assert.equal(seedBoard('https://jobs.lever.co/examplecorp').key, 'lever:examplecorp');
  assert.equal(seedBoard({ workday: 'examplecorp/Careers' }), null, 'the data-center number is never guessed');
  assert.equal(seedBoard({ taleo: 'x' }), null);

  const registry = normalizeRegistry(null);
  const warnings = [];
  const result = applySeedBoards(registry, [{ greenhouse: 'examplecorp', company: 'Example Corp' }, 'lever:examplecorp', { workday: 'nohost/Site' }, 42], { now: NOW, warnings });
  assert.deepEqual(result.added, ['greenhouse:examplecorp', 'lever:examplecorp']);
  assert.equal(result.invalid.length, 2);
  assert.equal(registry.boards['greenhouse:examplecorp'].origin, 'seed');
  assert.equal(registry.boards['greenhouse:examplecorp'].company, 'Example Corp');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /ignored 2 seed/);
});

test('a seeded board takes the baseline on its first poll, then follows the quiet and dormant rules like any board', async () => {
  const root = await temporaryRoot();
  try {
    const config = { root, timeZone: 'America/Chicago', lookbackHours: 24, network: {}, sources: { atsBoards: { seeds: [{ smartrecruiters: 'ExampleCorp' }] } } };
    const state = { seen: {} };
    const payload = await fixture('smartrecruiters-postings.json');
    const first = await collectAtsBoardSources(config, state, [], { now: NOW, warnings: [], sourceStats: [], fetchImpl: async () => jsonResponse(payload) });
    assert.deepEqual(first.jobs.map(job => job.title).sort(), ['Data Analyst I', 'Machine Learning Engineer, New Grad', 'Senior Manufacturing Engineer'], 'postings inside the window go through');
    const stored = JSON.parse(await fs.readFile(path.join(root, 'state', 'ats-boards.json'), 'utf8')).boards['smartrecruiters:examplecorp'];
    assert.equal(stored.origin, 'seed');
    assert.ok(stored.baselinedAt, 'the first poll is recorded as the baseline');

    const old = { ...payload, content: payload.content.map(item => ({ ...item, releasedDate: '2026-09-01T00:00:00Z' })) };
    const freshRoot = await temporaryRoot();
    try {
      const freshState = { seen: {} };
      const baseline = await collectAtsBoardSources({ ...config, root: freshRoot }, freshState, [], { now: NOW, warnings: [], sourceStats: [], fetchImpl: async () => jsonResponse(old) });
      assert.deepEqual(baseline.jobs, []);
      assert.equal(isJobSeen(freshState, { url: 'https://jobs.smartrecruiters.com/ExampleCorp/744000154523570' }), true, 'older seed postings are baselined as seen');
    } finally {
      await fs.rm(freshRoot, { recursive: true, force: true });
    }

    // A dormant seed is not switched back on by the seed list.
    const registry = await readRegistry(path.join(root, 'state', 'ats-boards.json'));
    registry.boards['smartrecruiters:examplecorp'].dormant = true;
    applySeedBoards(registry, [{ smartrecruiters: 'ExampleCorp' }], { now: NOW });
    assert.equal(registry.boards['smartrecruiters:examplecorp'].dormant, true);
    const polled = await collectAtsBoards({ registry, now: NOW, fetchImpl: async () => { throw new Error('a dormant board is not polled'); } });
    assert.equal(polled.results[0].skipped, 'dormant');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------ search discovery

test('the query pool rotates by day of year: stable for a date, shifted by one the next day, never repeating inside a run', () => {
  const today = rotateQueries(DEFAULT_SEARCH_QUERIES, NOW, 12, 'America/Chicago');
  assert.deepEqual(today, rotateQueries(DEFAULT_SEARCH_QUERIES, new Date('2026-10-08T15:00:00Z'), 12, 'America/Chicago'), 'same local date, same list');
  assert.equal(today.length, DEFAULT_SEARCH_QUERIES.length, '12 asked, the pool holds 9: each query once');
  assert.equal(new Set(today).size, today.length);
  // Oct 8 is day 281; 281 % 9 = 2.
  assert.equal(today[0], DEFAULT_SEARCH_QUERIES[2]);
  const tomorrow = rotateQueries(DEFAULT_SEARCH_QUERIES, new Date('2026-10-10T01:00:00Z'), 12, 'America/Chicago');
  assert.equal(tomorrow[0], DEFAULT_SEARCH_QUERIES[3]);
  const four = rotateQueries(DEFAULT_SEARCH_QUERIES, NOW, 4, 'America/Chicago');
  assert.deepEqual(four, DEFAULT_SEARCH_QUERIES.slice(2, 6));
  const wrap = rotateQueries(['a', 'b', 'c'], new Date('2026-01-02T18:00:00Z'), 2, 'America/Chicago');
  assert.deepEqual(wrap, ['c', 'a'], 'day 2 starts at index 2 and wraps');
  assert.deepEqual(rotateQueries([], NOW, 5), []);
  const settings = searchSettings({ sources: {} });
  assert.deepEqual([settings.enabled, settings.provider, settings.monthlyQueryCap, settings.queriesPerRun], [false, 'brave', 400, 12]);
});

test('Brave and Tavily requests restrict to the US and the past day and carry the key only in a header', () => {
  const brave = searchRequest('brave', 'new grad data analyst 2027', KEY);
  const url = new URL(brave.url);
  assert.equal(url.origin + url.pathname, 'https://api.search.brave.com/res/v1/web/search');
  assert.deepEqual([url.searchParams.get('q'), url.searchParams.get('country'), url.searchParams.get('freshness')], ['new grad data analyst 2027', 'US', 'pd']);
  assert.equal(brave.init.headers['x-subscription-token'], KEY);
  assert.ok(!brave.url.includes(KEY));
  const tavily = searchRequest('tavily', 'entry level AI engineer 2027', KEY);
  assert.equal(tavily.url, 'https://api.tavily.com/search');
  assert.equal(tavily.init.headers.authorization, `Bearer ${KEY}`);
  const body = JSON.parse(tavily.init.body);
  assert.deepEqual([body.time_range, body.country, body.topic], ['day', 'united states', 'general']);
  assert.ok(!tavily.init.body.includes(KEY));
});

test('results: ATS links become boards, job-board and listing pages are dropped, other pages are candidates; no page_age means undated', () => {
  const results = parseSearchResults('brave', braveResults([
    { title: 'Data Analyst I - Example Corp', url: 'https://job-boards.greenhouse.io/examplecorp/jobs/123', description: '<strong>Data</strong> analyst', page_age: '2026-10-08T10:00:00' },
    { title: 'Junior Data Scientist | Example Labs', url: 'https://careers.example.com/jobs/junior-ds', description: 'Join our team' },
    { title: '1,200 Entry Level Data Analyst Jobs', url: 'https://www.indeed.com/q-data-analyst-jobs.html', description: 'Browse jobs' },
    { title: 'Data Analyst Jobs in Chicago', url: 'https://www.example-board.com/chicago', description: 'Find listings' },
    { title: 'Associate Data Engineer', url: 'https://careers-example.icims.com/jobs/4567/associate-data-engineer/job', description: 'New grad role', page_age: '2026-10-08T00:00:00' },
  ]));
  assert.equal(results[0].snippet, 'Data analyst', 'HTML is stripped from the snippet');
  const outcomes = results.map(result => classifySearchResult(result, searchSettings({ sources: {} })));
  assert.deepEqual(outcomes.map(item => item.kind), ['board', 'candidate', 'drop', 'drop', 'candidate']);
  assert.equal(outcomes[0].board.key, 'greenhouse:examplecorp');
  assert.equal(outcomes[2].reason, 'job board page');
  assert.equal(outcomes[3].reason, 'listing page');
  assert.equal(outcomes[4].vendor, 'icims', 'iCIMS has no public API: its page stays a candidate');

  const undated = searchResultToJob(results[1], { provider: 'brave', query: 'q' });
  assert.equal(undated.postedAt, null, 'never filled with the current time');
  assert.equal(undated.postedAtPrecision, null);
  assert.equal(isUndated(undated), true);
  assert.equal(freshnessInstant(undated, 'America/Chicago'), null);
  assert.equal(undated.title, 'Junior Data Scientist');
  assert.equal(undated.sourceKind, SEARCH_SOURCE_KIND);
  const dated = searchResultToJob(results[4], { provider: 'brave', query: 'q' });
  assert.equal(dated.postedAtPrecision, 'date');
  assert.ok(dated.postedAt.startsWith('2026-10-08'));

  const tavily = parseSearchResults('tavily', { results: [{ title: 'Entry Level AI Engineer', url: 'https://example.ai/careers/ai-engineer', content: 'Remote US', score: 0.8 }] });
  assert.deepEqual(tavily, [{ title: 'Entry Level AI Engineer', url: 'https://example.ai/careers/ai-engineer', snippet: 'Remote US', pageAge: null }]);

  // Candidates face the uncurated-source prefilter: a title family is required and exclusions apply.
  const filtered = prefilterJobs([undated, { ...undated, url: 'https://x.example/1', title: 'Careers at Example' }, { ...undated, url: 'https://x.example/2', title: 'Senior Data Scientist' }], {});
  assert.deepEqual(filtered.jobs.map(job => job.title), ['Junior Data Scientist']);
  assert.deepEqual(filtered.titleExcluded.map(item => item.rule), ['no title family', 'exclude: senior']);
});

test('without a key the collector does not run: one info line, no request, no stat row', async () => {
  const root = await temporaryRoot();
  try {
    const warnings = [];
    const sourceStats = [];
    let calls = 0;
    const jobs = await collectEnabledSources(searchConfig(root), new Date(NOW.getTime() - 86_400_000), { warnings, sourceStats, searchFetchImpl: async () => { calls += 1; return jsonResponse({}); } });
    assert.deepEqual(jobs, []);
    assert.equal(calls, 0);
    assert.deepEqual(sourceStats, []);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].level, 'info');
    assert.match(warnings[0].message, /enabled but not run: private\/search\.json does not exist/);

    await writeKey(root, { tavily: 'other-provider-key' });
    const second = [];
    await collectEnabledSources(searchConfig(root), NOW, { warnings: second, searchFetchImpl: async () => { calls += 1; return jsonResponse({}); } });
    assert.equal(calls, 0);
    assert.match(second[0].message, /holds no brave key/);
    assert.ok(!JSON.stringify(second).includes('other-provider-key'));

    // Off by default: nothing at all, not even the info line.
    const off = [];
    await collectEnabledSources({ ...searchConfig(root), sources: { ...searchConfig(root).sources, searchDiscovery: {} } }, NOW, { warnings: off });
    assert.deepEqual(off, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the monthly cap is counted before each query, survives across runs, stops at the cap with a warning, and resets next month', async () => {
  const root = await temporaryRoot();
  try {
    const usageFile = path.join(root, 'state', 'search-usage.json');
    await fs.mkdir(path.dirname(usageFile), { recursive: true });
    await fs.writeFile(usageFile, JSON.stringify({ month: '2026-10', queries: 397 }));
    const settings = searchSettings(searchConfig(root));
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return jsonResponse(braveResults([])); };
    const warnings = [];
    const run = await collectSearchDiscovery({ settings, apiKey: KEY, now: NOW, timeZone: 'America/Chicago', usageFile, fetchImpl, warnings });
    assert.equal(calls, 3, '397 + 3 = 400');
    assert.equal(run.report.capReached, true);
    assert.equal(JSON.parse(await fs.readFile(usageFile, 'utf8')).queries, 400);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].level, 'warning');
    assert.match(warnings[0].message, /monthly query cap reached \(400\/400 in 2026-10\); stopped before query 4 of 9/);
    assert.match(sourceLine({ name: SEARCH_DISCOVERY_SOURCE, ok: true, count: 0, ...run.report }), /3 brave queries \(400\/400 this month, cap reached\)/);

    const again = await collectSearchDiscovery({ settings, apiKey: KEY, now: new Date('2026-10-20T01:00:00Z'), timeZone: 'America/Chicago', usageFile, fetchImpl, warnings: [] });
    assert.equal(again.report.queries, 0, 'still capped later in the month');
    assert.equal(calls, 3);

    const november = await collectSearchDiscovery({ settings: { ...settings, queriesPerRun: 2 }, apiKey: KEY, now: new Date('2026-11-02T02:00:00Z'), timeZone: 'America/Chicago', usageFile, fetchImpl, warnings: [] });
    assert.equal(november.report.queries, 2);
    assert.deepEqual(JSON.parse(await fs.readFile(usageFile, 'utf8')).month, '2026-11');
    assert.equal(JSON.parse(await fs.readFile(usageFile, 'utf8')).queries, 2);

    // A failed query still counts: the provider may bill it.
    const failing = await collectSearchDiscovery({ settings: { ...settings, queriesPerRun: 3 }, apiKey: KEY, now: new Date('2026-11-03T02:00:00Z'), timeZone: 'America/Chicago', usageFile, fetchImpl: async () => jsonResponse({}, { status: 500 }), warnings: [] });
    assert.equal(failing.report.failedQueries, 3);
    assert.equal(JSON.parse(await fs.readFile(usageFile, 'utf8')).queries, 5);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('search hits on ATS links register the board (origin search_discovery) and its postings arrive through the board API; a quiet board wakes', async () => {
  const root = await temporaryRoot();
  try {
    await writeKey(root, { brave: { apiKey: KEY } });
    const config = searchConfig(root, { queriesPerRun: 1 });
    const state = { seen: {} };
    const warnings = [];
    const sourceStats = [];
    const searchBoards = [];
    const requests = [];
    const searchFetchImpl = async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(braveResults([
        { title: 'Data Analyst I', url: 'https://jobs.smartrecruiters.com/ExampleCorp/744000154523570-data-analyst-i', description: 'Entry level', page_age: '2026-10-08T12:00:00' },
        { title: 'Junior Data Scientist', url: 'https://careers.example.com/jobs/junior-ds', description: 'Join us' },
      ]));
    };
    const collected = await collectEnabledSources(config, new Date(NOW.getTime() - 86_400_000), { warnings, sourceStats, searchBoards, searchFetchImpl, baseline: { state: { seen: {}, sourceBaselines: { [SEARCH_DISCOVERY_SOURCE]: { baselinedAt: '2026-10-01T00:00:00Z' } } }, now: NOW, lookbackHours: 24 } });
    assert.deepEqual(collected.map(job => job.url), ['https://careers.example.com/jobs/junior-ds'], 'only the non-ATS page is a candidate');
    assert.deepEqual(searchBoards.map(board => [board.key, board.discoveredFrom]), [['smartrecruiters:examplecorp', SEARCH_DISCOVERY_SOURCE]]);
    assert.equal(sourceStats[0].kind, 'search');
    assert.match(sourceLine(sourceStats[0]), /^Search discovery: 1 brave query \(1\/400 this month\), 1 candidate page\(s\), 1 ATS board\(s\) found$/);

    const atsWarnings = [];
    const payload = await fixture('smartrecruiters-postings.json');
    const ats = await collectAtsBoardSources(config, state, collected, { now: NOW, warnings: atsWarnings, sourceStats: [], searchBoards, fetchImpl: async () => jsonResponse(payload) });
    const registry = JSON.parse(await fs.readFile(path.join(root, 'state', 'ats-boards.json'), 'utf8'));
    assert.equal(registry.boards['smartrecruiters:examplecorp'].origin, 'search_discovery');
    assert.equal(registry.boards['smartrecruiters:examplecorp'].discoveredFrom, SEARCH_DISCOVERY_SOURCE);
    assert.ok(ats.jobs.some(job => job.title === 'Data Analyst I' && job.sourceKind === 'public_ats_board'), 'the posting comes from the board API');
    assert.match(atsWarnings.find(item => item.source === SEARCH_DISCOVERY_SOURCE).message, /registered 1 new ATS board/);

    // Later: the board has gone quiet, and a new search hit lets it be polled before its weekly turn.
    const quietRegistry = normalizeRegistry(registry);
    const record = quietRegistry.boards['smartrecruiters:examplecorp'];
    record.lastNewAt = '2026-08-01T00:00:00Z';
    record.lastPolledAt = '2026-10-07T01:00:00Z';
    const quiet = await collectAtsBoards({ registry: quietRegistry, now: NOW, fetchImpl: async () => jsonResponse(payload) });
    assert.equal(quiet.results[0].skipped, 'quiet (weekly poll)');
    record.lastPolledAt = '2026-10-07T01:00:00Z';
    const woken = await collectAtsBoards({ registry: quietRegistry, now: NOW, wakeKeys: new Set(['smartrecruiters:examplecorp']), fetchImpl: async () => jsonResponse(payload) });
    assert.equal(woken.results[0].skipped, null);
    assert.equal(woken.jobs.length, 3);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the first search run takes a baseline: undated and older pages are recorded as seen, dated pages inside the window go through', async () => {
  const root = await temporaryRoot();
  try {
    await writeKey(root, { brave: KEY });
    const state = { seen: {} };
    const searchFetchImpl = async () => jsonResponse(braveResults([
      { title: 'Junior Data Scientist', url: 'https://careers.example.com/jobs/1', description: 'x', page_age: '2026-10-08T09:00:00' },
      { title: 'Data Analyst, New Grad', url: 'https://careers.example.com/jobs/2', description: 'x' },
      { title: 'Machine Learning Engineer, New Grad', url: 'https://careers.example.com/jobs/3', description: 'x', page_age: '2026-10-01T09:00:00' },
    ]));
    const jobs = await collectEnabledSources(searchConfig(root, { queriesPerRun: 1 }), new Date(NOW.getTime() - 86_400_000), { warnings: [], sourceStats: [], searchFetchImpl, baseline: { state, now: NOW, lookbackHours: 24 } });
    assert.deepEqual(jobs.map(job => job.url), ['https://careers.example.com/jobs/1']);
    assert.equal(isJobSeen(state, { url: 'https://careers.example.com/jobs/2' }), true, 'an undated page counts as old for the baseline');
    assert.equal(isJobSeen(state, { url: 'https://careers.example.com/jobs/3' }), true);
    assert.ok(state.sourceBaselines[SEARCH_DISCOVERY_SOURCE]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('dedupe keeps the list or ATS copy and drops the search copy, recording it for debug', () => {
  const dropped = [];
  const listCopy = { url: 'https://careers.example.com/jobs/1', source: 'Zapply New Grad Jobs 2027', sourceKind: 'public_github_list', company: 'Example Corp', title: 'Data Analyst' };
  const searchCopy = { url: 'https://careers.example.com/jobs/1', source: SEARCH_DISCOVERY_SOURCE, sourceKind: SEARCH_SOURCE_KIND, company: '', title: 'Data Analyst | Example', description: 'snippet that is longer than nothing' };
  for (const order of [[searchCopy, listCopy], [listCopy, searchCopy]]) {
    const kept = dedupeByUrl(order, dropped);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].source, 'Zapply New Grad Jobs 2027', 'the search label is not merged in');
    assert.equal(kept[0].company, 'Example Corp');
  }
  assert.deepEqual(dropped.map(item => [item.source, item.keptSource]), [[SEARCH_DISCOVERY_SOURCE, 'Zapply New Grad Jobs 2027'], [SEARCH_DISCOVERY_SOURCE, 'Zapply New Grad Jobs 2027']]);

  const byFinal = dedupeByFinalUrl([
    { ...searchCopy, url: 'https://search.example/redirect', finalUrl: 'https://job-boards.greenhouse.io/examplecorp/jobs/9' },
    { url: 'https://job-boards.greenhouse.io/examplecorp/jobs/9', source: 'Greenhouse · Example Corp', sourceKind: 'public_ats_board', title: 'Data Analyst' },
  ]);
  assert.equal(byFinal.jobs.length, 1);
  assert.equal(byFinal.jobs[0].source, 'Greenhouse · Example Corp');
  assert.equal(byFinal.dropped[0].search, true);
});

test('the key never reaches warnings, stats, jobs, the usage file, or the board registry, even when a provider error quotes it', async () => {
  const root = await temporaryRoot();
  try {
    await writeKey(root, { brave: KEY });
    const warnings = [];
    const sourceStats = [];
    const searchBoards = [];
    let call = 0;
    const searchFetchImpl = async (url, init) => {
      call += 1;
      assert.ok(!String(url).includes(KEY));
      if (call === 1) throw new Error(`connect failed for token ${KEY}`);
      return jsonResponse(braveResults([{ title: 'Data Analyst I', url: 'https://jobs.lever.co/examplecorp/abc', description: 'x' }, { title: 'AI Engineer, New Grad', url: 'https://careers.example.com/ai', description: 'x' }]));
    };
    const logged = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...args) => logged.push(args.join(' '));
    console.warn = (...args) => logged.push(args.join(' '));
    console.error = (...args) => logged.push(args.join(' '));
    let jobs;
    try {
      jobs = await collectEnabledSources(searchConfig(root, { queriesPerRun: 3 }), NOW, { warnings, sourceStats, searchBoards, searchFetchImpl, baseline: { state: { seen: {}, sourceBaselines: { [SEARCH_DISCOVERY_SOURCE]: {} } }, now: NOW, lookbackHours: 24 } });
      await collectAtsBoardSources(searchConfig(root), { seen: {} }, jobs, { now: NOW, warnings, sourceStats, searchBoards, fetchImpl: async () => jsonResponse([]) });
    } finally {
      Object.assign(console, original);
    }
    const failure = warnings.find(item => /failed/.test(item.message));
    assert.match(failure.message, /connect failed for token \[redacted\]/);
    const files = await Promise.all(['state/search-usage.json', 'state/ats-boards.json'].map(file => fs.readFile(path.join(root, file), 'utf8')));
    const everything = [JSON.stringify(warnings), warnings.map(warningText).join('\n'), JSON.stringify(sourceStats), JSON.stringify(jobs), JSON.stringify(searchBoards), ...files, logged.join('\n')].join('\n');
    assert.ok(!everything.includes(KEY), 'the key appears nowhere');
    assert.ok(everything.includes('[redacted]'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a refused key stops the remaining queries; an invalid provider is an info line, not a run', async () => {
  const root = await temporaryRoot();
  try {
    let calls = 0;
    const warnings = [];
    const run = await collectSearchDiscovery({ settings: { ...searchSettings(searchConfig(root)), queriesPerRun: 5 }, apiKey: KEY, now: NOW, usageFile: path.join(root, 'state', 'search-usage.json'), fetchImpl: async () => { calls += 1; return jsonResponse({ error: 'bad key' }, { status: 401 }); }, warnings });
    assert.equal(calls, 1);
    assert.equal(run.report.failedQueries, 1);
    assert.match(warnings[0].message, /1 of 1 brave query failed \(HTTP 401\)/);

    await writeKey(root, { bing: KEY });
    const info = [];
    await collectEnabledSources(searchConfig(root, { provider: 'bing' }), NOW, { warnings: info });
    assert.equal(info[0].level, 'info');
    assert.match(info[0].message, /provider "bing" is not one of brave, tavily/);
    assert.deepEqual(await readSearchKey({ root }, 'brave'), { apiKey: null, reason: 'private/search.json holds no brave key' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------ US evidence

test('uppercase US, U.S., and USA as standalone words count as US evidence; lowercase "us" and all-caps phrases do not', () => {
  for (const text of ['Remote within the US.', 'This role is US only.', 'U.S. remote, any time zone', 'Open to candidates anywhere in the USA', 'Hybrid in our U.S.A. offices', '(US)']) {
    assert.equal(usEvidenceInDescription(text), 'US', text);
  }
  for (const text of ['Contact us to learn more.', 'Tell us about yourself', 'JOIN US TODAY', 'ABOUT US', 'We use AWS and USB devices', 'bonus programs', 'Status: open']) {
    assert.equal(usEvidenceInDescription(text), null, text);
  }
  const verdict = assessEligibility({ location: '', description: 'Remote role, open to applicants within the US only.', title: 'Data Analyst' }, {});
  assert.equal(verdict.location.verdict, 'us');
  assert.equal(verdict.location.source, 'description');
});
