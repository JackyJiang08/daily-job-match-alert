// Public ATS boards: board identification from URLs, the four response parsers (fixtures recorded from
// live public tenants on 2026-09-18, trimmed and renamed to Example Corp), the registry, the baseline
// rule, per-board failure isolation, the dormant rule, and the pipeline-level wrapper. No network.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ATS_SOURCE_KIND, DORMANT_AFTER_FAILURES, applyConfigBoards, boardFromKey, boardLabel, collectAtsBoards, discoverBoards, identifyBoard,
  normalizeRegistry, parseAshbyJobs, parseGreenhouseJobs, parseLeverPostings, parseWorkdayPostings, pollBoard, readRegistry, registerBoards, resumeBoard, writeRegistry,
} from '../src/collectors/ats-boards.mjs';
import { collectAtsBoardSources } from '../src/index.mjs';
import { isJobSeen, jobSeenStatus } from '../src/state.mjs';
import { sourceLine } from '../src/report.mjs';

const fixtures = new URL('./fixtures/ats/', import.meta.url);
const NOW = new Date('2026-09-18T12:00:00Z');

async function fixture(name) {
  return JSON.parse(await fs.readFile(new URL(name, fixtures), 'utf8'));
}

function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return new Response(status === 304 ? null : JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function board(url, extra = {}) {
  return { ...identifyBoard(url), ...extra };
}

test('identifies Greenhouse, Lever, Ashby, and Workday boards from posting URLs, board front pages, and keys', () => {
  assert.deepEqual(identifyBoard('https://job-boards.greenhouse.io/examplecorp/jobs/8556658002?gh_src=abc'), {
    key: 'greenhouse:examplecorp', kind: 'greenhouse', token: 'examplecorp',
    boardUrl: 'https://job-boards.greenhouse.io/examplecorp', apiUrl: 'https://boards-api.greenhouse.io/v1/boards/examplecorp/jobs?content=true',
  });
  assert.equal(identifyBoard('https://boards.greenhouse.io/examplecorp').key, 'greenhouse:examplecorp');
  assert.equal(identifyBoard('https://boards.greenhouse.io/embed/job_app?for=examplecorp&token=123').key, 'greenhouse:examplecorp');
  assert.equal(identifyBoard('https://job-boards.eu.greenhouse.io/eucorp/jobs/1').apiUrl, 'https://boards-api.eu.greenhouse.io/v1/boards/eucorp/jobs?content=true');
  assert.equal(identifyBoard('https://boards.greenhouse.io/embed/job_app?token=123'), null, 'an embed link without the board token is not a board');

  assert.deepEqual(identifyBoard('https://jobs.lever.co/examplecorp/f4746da4-8eb8-43e2-b7ce-bf3c7cf9640d'), {
    key: 'lever:examplecorp', kind: 'lever', company: null, slug: 'examplecorp',
    boardUrl: 'https://jobs.lever.co/examplecorp', apiUrl: 'https://api.lever.co/v0/postings/examplecorp?mode=json',
  });
  assert.equal(identifyBoard('https://jobs.eu.lever.co/eucorp').apiUrl, 'https://api.eu.lever.co/v0/postings/eucorp?mode=json');

  assert.deepEqual(identifyBoard('https://jobs.ashbyhq.com/examplecorp/7458d4e9-da2e-47bd-98cb-adfda43d42b2'), {
    key: 'ashby:examplecorp', kind: 'ashby', slug: 'examplecorp',
    boardUrl: 'https://jobs.ashbyhq.com/examplecorp', apiUrl: 'https://api.ashbyhq.com/posting-api/job-board/examplecorp',
  });

  const workday = identifyBoard('https://examplecorp.wd5.myworkdayjobs.com/en-US/ExampleCareers/job/US-CA-Santa-Clara/Research-Scientist_JR2024900?q=data');
  assert.deepEqual(workday, {
    key: 'workday:examplecorp/ExampleCareers', kind: 'workday', tenant: 'examplecorp', site: 'ExampleCareers', host: 'examplecorp.wd5.myworkdayjobs.com',
    boardUrl: 'https://examplecorp.wd5.myworkdayjobs.com/ExampleCareers', apiUrl: 'https://examplecorp.wd5.myworkdayjobs.com/wday/cxs/examplecorp/ExampleCareers/jobs',
  });
  assert.equal(identifyBoard('https://examplecorp.wd5.myworkdayjobs.com/ExampleCareers').key, 'workday:examplecorp/ExampleCareers');
  assert.equal(identifyBoard('https://examplecorp.wd5.myworkdayjobs.com/wday/cxs/examplecorp/ExampleCareers/job/Analyst_1').key, 'workday:examplecorp/ExampleCareers');
  assert.equal(identifyBoard('https://examplecorp.wd5.myworkdayjobs.com/'), null);

  for (const url of ['https://www.example.com/careers/123', 'https://jobs.example.com/greenhouse.io/x', 'not a url', 'ftp://jobs.lever.co/x', '']) {
    assert.equal(identifyBoard(url), null, `${url} is not a board`);
  }
  assert.equal(boardFromKey('greenhouse:examplecorp').apiUrl, 'https://boards-api.greenhouse.io/v1/boards/examplecorp/jobs?content=true');
  assert.equal(boardFromKey('lever:examplecorp').key, 'lever:examplecorp');
  assert.equal(boardFromKey('ashby:examplecorp').key, 'ashby:examplecorp');
  assert.equal(boardFromKey('workday:examplecorp/ExampleCareers@examplecorp.wd1.myworkdayjobs.com').apiUrl, 'https://examplecorp.wd1.myworkdayjobs.com/wday/cxs/examplecorp/ExampleCareers/jobs');
  assert.equal(boardFromKey('workday:examplecorp/ExampleCareers').host, 'examplecorp.wd5.myworkdayjobs.com', 'wd5 is assumed when the key carries no host');
  assert.equal(boardFromKey('taleo:x'), null);
});

test('discovery collects each board once from a batch of postings and remembers the company and the revealing source', () => {
  const jobs = [
    { url: 'https://job-boards.greenhouse.io/examplecorp/jobs/1', company: 'Example Corp', source: 'SimplifyJobs New Grad' },
    { url: 'https://job-boards.greenhouse.io/examplecorp/jobs/2', company: 'Example Corp', source: 'SimplifyJobs New Grad' },
    { url: 'https://jobs.lever.co/othercorp/abc', company: 'Other Corp', source: 'Handshake email alert' },
    { url: 'https://www.example.com/careers/9', company: 'Nope', source: 'x' },
    { url: 'https://jobs.ashbyhq.com/already/abc', company: 'Already', source: 'Ashby · Already', sourceKind: ATS_SOURCE_KIND },
  ];
  const found = discoverBoards(jobs);
  assert.deepEqual(found.map(item => item.key), ['greenhouse:examplecorp', 'lever:othercorp'], 'postings that came from a board do not re-discover it');
  assert.equal(found[0].company, 'Example Corp');
  assert.equal(found[0].discoveredFrom, 'SimplifyJobs New Grad');
  assert.equal(found[0].discoveredUrl, 'https://job-boards.greenhouse.io/examplecorp/jobs/1');
  assert.equal(found[1].company, 'Other Corp');
});

test('parses the Greenhouse board payload: entity-escaped HTML content, updated_at freshness, company from the payload', async () => {
  const jobs = parseGreenhouseJobs(await fixture('greenhouse-jobs.json'), board('https://job-boards.greenhouse.io/examplecorp'));
  assert.equal(jobs.length, 2);
  const [job] = jobs;
  assert.equal(job.source, 'Greenhouse · Example Corp');
  assert.equal(job.sourceKind, ATS_SOURCE_KIND);
  assert.equal(job.board, 'greenhouse:examplecorp');
  assert.equal(job.company, 'Example Corp');
  assert.equal(job.title, 'AI Engineer');
  assert.equal(job.url, 'https://job-boards.greenhouse.io/examplecorp/jobs/8556658002');
  assert.equal(job.location, 'Remote, Bangalore');
  assert.equal(job.postedAt, '2026-09-14T20:01:39.000Z', 'updated_at with its offset becomes UTC');
  assert.equal(job.freshnessBasis, 'greenhouse_updated_at');
  assert.match(job.description, /^Example Corp is the intelligent orchestration platform/);
  assert.doesNotMatch(job.description, /<|&lt;|&quot;/, 'escaped HTML is decoded and stripped');
  assert.equal(job.enrichment, 'ats_api');
  assert.equal(job.finalUrl, job.url);
  assert.equal(job.externalId, '8556658002');
  assert.equal(job.roleType, undefined, 'the role type is left to classification');
  assert.deepEqual(parseGreenhouseJobs({ jobs: [{ title: 'no url' }, { absolute_url: 'https://x.y/z' }] }, board('https://job-boards.greenhouse.io/examplecorp')), []);
});

test('parses the Lever postings array: epoch createdAt, categories, lists folded into the description, salary range', async () => {
  const jobs = parseLeverPostings(await fixture('lever-postings.json'), board('https://jobs.lever.co/examplecorp', { company: 'Example Corp' }));
  assert.equal(jobs.length, 2);
  const [job] = jobs;
  assert.equal(job.source, 'Lever · Example Corp');
  assert.equal(job.title, 'Autonomy System Test Engineer');
  assert.equal(job.url, 'https://jobs.lever.co/examplecorp/f4746da4-8eb8-43e2-b7ce-bf3c7cf9640d');
  assert.equal(job.location, 'Foster City, CA');
  assert.equal(job.postedAt, new Date(1777936261125).toISOString());
  assert.equal(job.freshnessBasis, 'lever_created_at');
  assert.equal(job.employmentType, 'Full-time');
  assert.equal(job.salary, 'USD 144000–193000 per-year-salary');
  assert.match(job.description, /^Autonomous vehicles have some of the largest/);
  assert.match(job.description, /In this role, you will:/, 'list sections are part of the description');
  assert.match(job.description, /About Example Corp/, 'the additional block is part of the description');
  assert.equal(job.enrichment, 'ats_api');
  const unnamed = parseLeverPostings(await fixture('lever-postings.json'), board('https://jobs.lever.co/examplecorp'));
  assert.equal(unnamed[0].company, 'Examplecorp', 'without a known company the slug is title-cased');
  assert.deepEqual(parseLeverPostings({ ok: false, error: 'Document not found' }, board('https://jobs.lever.co/x')), [], 'an unknown company answers an object, not an array');
});

test('parses the Ashby job board: secondary locations, publishedAt, compensation summary, unlisted postings skipped', async () => {
  const payload = await fixture('ashby-job-board.json');
  const jobs = parseAshbyJobs(payload, board('https://jobs.ashbyhq.com/examplecorp', { company: 'Example Corp' }));
  assert.equal(jobs.length, 2);
  const [job] = jobs;
  assert.equal(job.source, 'Ashby · Example Corp');
  assert.equal(job.title, 'Engineering Manager - EU');
  assert.equal(job.url, 'https://jobs.ashbyhq.com/examplecorp/7458d4e9-da2e-47bd-98cb-adfda43d42b2');
  assert.match(job.location, /^Remote - European Union · Spain · Italy/);
  assert.equal(job.postedAt, '2024-03-04T14:29:08.532Z');
  assert.equal(job.freshnessBasis, 'ashby_published_at');
  assert.equal(job.employmentType, 'FullTime');
  assert.equal(job.salary, '€110K – €185K • Offers Equity • Offers Bonus');
  assert.match(job.description, /^Hi 👋 I’m Jane Doe/);
  assert.equal(job.enrichment, 'ats_api');
  payload.jobs[0].isListed = false;
  assert.equal(parseAshbyJobs(payload, board('https://jobs.ashbyhq.com/examplecorp')).length, 1);
});

test('parses a Workday CXS page: URL from externalPath, relative postedOn dates, no description so the CXS detail fetch still runs', async () => {
  const jobs = parseWorkdayPostings(await fixture('workday-jobs.json'), board('https://examplecorp.wd5.myworkdayjobs.com/ExampleCareers', { company: 'Example Corp' }), NOW);
  assert.equal(jobs.length, 4);
  assert.equal(jobs[0].source, 'Workday · Example Corp');
  assert.equal(jobs[0].url, 'https://examplecorp.wd5.myworkdayjobs.com/ExampleCareers/job/US-CA-Santa-Clara/Research-Scientist--Networking-Research---PhD-New-College-Grad-2026_JR2024900-1');
  assert.equal(jobs[0].location, 'US, CA, Santa Clara');
  assert.equal(jobs[0].postedAt, NOW.toISOString(), '"Posted Today" is the run time');
  assert.equal(jobs[1].postedAt, new Date(NOW.getTime() - 3 * 24 * 3600 * 1000).toISOString());
  assert.equal(jobs[0].freshnessBasis, 'workday_posted_on');
  assert.equal(jobs[0].externalId, 'JR2024900');
  assert.equal(jobs[0].description, '');
  assert.equal(jobs[0].enrichment, undefined, 'Workday rows are enriched through the existing CXS detail endpoint');
  assert.equal(jobs[3].postedAt, new Date(NOW.getTime() - 31 * 24 * 3600 * 1000).toISOString(), '"30+ Days Ago" counts as 31 days old');
});

test('pollBoard sends conditional headers, honours 304, and walks Workday pages until the window ends', async () => {
  const greenhouse = board('https://job-boards.greenhouse.io/examplecorp', { etag: 'W/"abc"', lastModified: 'Mon, 14 Sep 2026 20:01:39 GMT' });
  const calls = [];
  const notModified = await pollBoard(greenhouse, { now: NOW, fetchImpl: async (url, options) => { calls.push({ url, options }); return jsonResponse(null, { status: 304 }); } });
  assert.equal(calls[0].options.headers['if-none-match'], 'W/"abc"');
  assert.equal(calls[0].options.headers['if-modified-since'], 'Mon, 14 Sep 2026 20:01:39 GMT');
  assert.match(calls[0].options.headers['user-agent'], /DailyJobMatchAlert/);
  assert.deepEqual(notModified, { notModified: true, jobs: [], etag: 'W/"abc"', lastModified: greenhouse.lastModified, status: 304 });
  const fresh = await pollBoard(greenhouse, { now: NOW, fetchImpl: async () => jsonResponse(await fixture('greenhouse-jobs.json'), { headers: { etag: 'W/"def"' } }) });
  assert.equal(fresh.jobs.length, 2);
  assert.equal(fresh.etag, 'W/"def"');
  await assert.rejects(pollBoard(greenhouse, { now: NOW, fetchImpl: async () => jsonResponse({}, { status: 500 }) }), /HTTP 500/);

  const workday = board('https://examplecorp.wd5.myworkdayjobs.com/ExampleCareers');
  const page = (count, postedOn) => ({ total: 60, jobPostings: Array.from({ length: count }, (_, index) => ({ title: `Job ${postedOn} ${index}`, externalPath: `/job/US-TX-Austin/Job-${postedOn.replace(/\W/g, '')}-${index}_JR${index}`, locationsText: 'US, TX, Austin', postedOn, bulletFields: [`JR${index}`] })) });
  const bodies = [];
  const pages = [page(20, 'Posted Today'), page(20, 'Posted 5 Days Ago'), page(20, 'Posted 9 Days Ago')];
  const walked = await pollBoard(workday, { now: NOW, lookbackHours: 24, fetchImpl: async (url, options) => { bodies.push(JSON.parse(options.body)); assert.equal(options.method, 'POST'); return jsonResponse(pages[bodies.length - 1]); } });
  assert.deepEqual(bodies.map(body => body.offset), [0, 20], 'the walk stops at the first page that reaches postings older than the window');
  assert.equal(bodies[0].limit, 20);
  assert.equal(walked.jobs.length, 40);
});

async function temporaryRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ats-boards-test-'));
}

test('the first poll of a board is a baseline that is never scored; later polls return only new postings inside the window', async () => {
  const registry = normalizeRegistry(null);
  registerBoards(registry, discoverBoards([{ url: 'https://job-boards.greenhouse.io/examplecorp/jobs/1', company: 'Example Corp', source: 'SimplifyJobs New Grad' }]), { now: NOW });
  const record = registry.boards['greenhouse:examplecorp'];
  assert.equal(record.origin, 'discovered');
  assert.equal(record.discoveredAt, NOW.toISOString());
  assert.equal(record.company, 'Example Corp');
  const payload = await fixture('greenhouse-jobs.json');
  const warnings = [];
  const first = await collectAtsBoards({ registry, now: NOW, warnings, fetchImpl: async () => jsonResponse(payload, { headers: { etag: 'W/"v1"' } }) });
  assert.deepEqual(first.jobs, [], 'nothing is scored on the baseline run');
  assert.equal(first.baseline.length, 2);
  assert.equal(first.results[0].baseline, true);
  assert.equal(record.baselinedAt, NOW.toISOString());
  assert.equal(record.baselineCount, 2);
  assert.equal(record.lastJobCount, 2);
  assert.equal(record.lastSuccessAt, NOW.toISOString());
  assert.equal(record.etag, 'W/"v1"');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].level, 'info');
  assert.equal(warnings[0].source, 'Greenhouse · Example Corp');
  assert.match(warnings[0].message, /First poll recorded 2 existing posting\(s\) as already seen \(baseline\)/);

  // Next night: one posting updated inside the window, one old, one already seen.
  const later = new Date('2026-09-19T12:00:00Z');
  const seen = new Set(payload.jobs.map(job => job.absolute_url));
  const nextPayload = { jobs: [
    { ...payload.jobs[0], id: 1, absolute_url: 'https://job-boards.greenhouse.io/examplecorp/jobs/1', title: 'New Grad Analyst', updated_at: '2026-09-19T08:00:00Z' },
    { ...payload.jobs[0], id: 2, absolute_url: 'https://job-boards.greenhouse.io/examplecorp/jobs/2', title: 'Old Posting', updated_at: '2026-09-01T08:00:00Z' },
    { ...payload.jobs[0], title: 'Seen Yesterday', updated_at: '2026-09-19T09:00:00Z' },
  ] };
  const second = await collectAtsBoards({ registry, now: later, warnings, isSeen: job => seen.has(job.url), fetchImpl: async () => jsonResponse(nextPayload) });
  assert.deepEqual(second.jobs.map(job => job.title), ['New Grad Analyst'], 'only the unseen posting inside the lookback window is returned');
  assert.equal(second.baseline.length, 0);
  assert.equal(record.lastNewCount, 1);
  assert.equal(record.lastJobCount, 3);
  assert.equal(second.results[0].newCount, 1);
  assert.equal(warnings.length, 1, 'no baseline notice the second time');
  assert.equal(sourceLine({ name: 'Greenhouse · Example Corp', kind: 'ats', ok: true, count: 1, jobCount: 3 }), 'Greenhouse · Example Corp: 1 new, 3 listed');
  assert.equal(sourceLine({ name: 'Greenhouse · Example Corp', kind: 'ats', ok: true, baseline: true, jobCount: 2 }), 'Greenhouse · Example Corp: first poll, 2 existing posting(s) recorded as seen (baseline)');

  // A same-day rerun leaves the board alone.
  const rerun = await collectAtsBoards({ registry, now: new Date('2026-09-19T15:00:00Z'), warnings, fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.equal(rerun.results[0].skipped, 'polled recently');
  assert.equal(sourceLine({ name: 'Greenhouse · Example Corp', kind: 'ats', skipped: 'polled recently' }), 'Greenhouse · Example Corp: not polled (polled recently)');
});

test('one failing board only warns; the others still deliver, and the seventh consecutive failure makes a board dormant until resumed', async () => {
  const registry = normalizeRegistry(null);
  registerBoards(registry, [board('https://jobs.lever.co/broken', { company: 'Broken Co' }), board('https://jobs.ashbyhq.com/healthy', { company: 'Healthy Co' })], { now: NOW });
  const healthy = await fixture('ashby-job-board.json');
  const fetchImpl = async url => (url.includes('lever') ? jsonResponse({}, { status: 500 }) : jsonResponse(healthy));
  const warnings = [];
  const first = await collectAtsBoards({ registry, now: NOW, warnings, fetchImpl });
  assert.equal(first.baseline.length, 2, 'the healthy board baselined normally');
  const broken = registry.boards['lever:broken'];
  assert.equal(broken.consecutiveFailures, 1);
  assert.equal(broken.lastError, 'HTTP 500');
  assert.equal(broken.dormant, false);
  assert.equal(broken.baselinedAt, null);
  const failure = warnings.find(warning => warning.source === 'Lever · Broken Co');
  assert.match(failure.message, /HTTP 500 \(failure 1 in a row\); the other sources were not affected/);
  assert.equal(failure.level, 'warning');
  assert.equal(first.results.find(result => result.key === 'lever:broken').ok, false);

  let day = 1;
  while (broken.consecutiveFailures < DORMANT_AFTER_FAILURES) {
    day += 1;
    await collectAtsBoards({ registry, now: new Date(NOW.getTime() + day * 24 * 3600 * 1000), warnings, fetchImpl });
  }
  assert.equal(broken.consecutiveFailures, 7);
  assert.equal(broken.dormant, true);
  assert.equal(broken.dormantSince, new Date(NOW.getTime() + 7 * 24 * 3600 * 1000).toISOString());
  assert.match(warnings.at(-1).message, /marked dormant after 7 consecutive failures, resume it from the hub Status page/);
  const skipped = await collectAtsBoards({ registry, now: new Date(NOW.getTime() + 8 * 24 * 3600 * 1000), warnings, fetchImpl });
  assert.equal(skipped.results.find(result => result.key === 'lever:broken').skipped, 'dormant');
  assert.equal(broken.consecutiveFailures, 7, 'a dormant board is not even tried');

  assert.equal(resumeBoard(registry, 'lever:broken').dormant, false);
  assert.equal(broken.consecutiveFailures, 0);
  assert.equal(resumeBoard(registry, 'lever:nope'), null);
  const resumed = await collectAtsBoards({ registry, now: new Date(NOW.getTime() + 9 * 24 * 3600 * 1000), warnings, fetchImpl: async () => jsonResponse([]) });
  assert.equal(resumed.results.find(result => result.key === 'lever:broken').ok, true);
  assert.equal(broken.baselinedAt, new Date(NOW.getTime() + 9 * 24 * 3600 * 1000).toISOString());
});

test('config entries add boards by key or URL, switch boards off, and override the endpoint; the registry round-trips through disk', async () => {
  const root = await temporaryRoot();
  try {
    const registry = normalizeRegistry({ boards: { 'greenhouse:seen': { key: 'greenhouse:seen', kind: 'greenhouse', token: 'seen', enabled: true, apiUrl: 'https://boards-api.greenhouse.io/v1/boards/seen/jobs?content=true' } } });
    const applied = applyConfigBoards(registry, [
      { key: 'lever:manual', company: 'Manual Co' },
      { url: 'https://jobs.ashbyhq.com/byurl/123', enabled: false },
      { key: 'greenhouse:seen', enabled: false },
      { key: 'greenhouse:proxied', apiUrl: 'http://127.0.0.1:9/v1/boards/proxied/jobs' },
      { key: 'taleo:nope' },
      'garbage',
    ], { now: NOW });
    assert.deepEqual(applied, ['lever:manual', 'ashby:byurl', 'greenhouse:seen', 'greenhouse:proxied']);
    assert.equal(registry.boards['lever:manual'].origin, 'config');
    assert.equal(registry.boards['lever:manual'].company, 'Manual Co');
    assert.equal(registry.boards['ashby:byurl'].enabled, false);
    assert.equal(registry.boards['greenhouse:seen'].enabled, false);
    assert.equal(registry.boards['greenhouse:proxied'].apiUrl, 'http://127.0.0.1:9/v1/boards/proxied/jobs');
    assert.equal(boardLabel(registry.boards['ashby:byurl']), 'Ashby · Byurl');
    const disabled = await collectAtsBoards({ registry, now: NOW, fetchImpl: async () => { throw new Error('must not be called for disabled boards'); } });
    assert.equal(disabled.results.find(result => result.key === 'ashby:byurl').skipped, 'disabled');
    const file = path.join(root, 'state', 'ats-boards.json');
    await writeRegistry(file, registry);
    const reread = await readRegistry(file);
    assert.deepEqual(reread, { version: 1, boards: registry.boards });
    assert.deepEqual(await readRegistry(path.join(root, 'missing.json')), { version: 1, boards: {} });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the pipeline wrapper discovers boards from collected postings, marks the baseline as seen on disk, and reports one stat row per board', async () => {
  const root = await temporaryRoot();
  try {
    const config = { root, lookbackHours: 24, network: { concurrency: 2, userAgent: 'TestAgent/1.0' }, sources: { atsBoards: { boards: [{ key: 'lever:manual', company: 'Manual Co', enabled: false }] } } };
    const state = { seen: {} };
    const collected = [{ url: 'https://job-boards.greenhouse.io/examplecorp/jobs/1', company: 'Example Corp', source: 'SimplifyJobs New Grad', title: 'x' }];
    const payload = await fixture('greenhouse-jobs.json');
    const warnings = [];
    const sourceStats = [];
    const agents = [];
    const first = await collectAtsBoardSources(config, state, collected, { now: NOW, warnings, sourceStats, fetchImpl: async (url, options) => { agents.push(options.headers['user-agent']); return jsonResponse(payload); } });
    assert.deepEqual(first.jobs, []);
    assert.deepEqual(agents, ['TestAgent/1.0']);
    for (const job of payload.jobs) {
      assert.equal(isJobSeen(state, { url: job.absolute_url }), true, 'baseline postings are seen');
      assert.equal(state.seen[Object.keys(state.seen).find(key => state.seen[key].url === job.absolute_url)].lastEnrichment, 'ats_baseline');
    }
    assert.deepEqual(sourceStats.map(stat => [stat.name, stat.kind, stat.ok, stat.baseline, stat.skipped]), [['Greenhouse · Example Corp', 'ats', true, true, null], ['Lever · Manual Co', 'ats', true, false, 'disabled']]);
    const registry = JSON.parse(await fs.readFile(path.join(root, 'state', 'ats-boards.json'), 'utf8'));
    assert.equal(registry.boards['greenhouse:examplecorp'].baselineCount, 2);
    assert.equal(registry.boards['lever:manual'].enabled, false);

    const later = new Date('2026-09-19T12:00:00Z');
    const nextPayload = { jobs: [{ ...payload.jobs[0], id: 3, absolute_url: 'https://job-boards.greenhouse.io/examplecorp/jobs/3', title: 'Data Analyst, New Grad', updated_at: '2026-09-19T08:00:00Z' }, payload.jobs[1]] };
    const second = await collectAtsBoardSources(config, state, [], { now: later, warnings, sourceStats: [], fetchImpl: async () => jsonResponse(nextPayload) });
    assert.deepEqual(second.jobs.map(job => job.title), ['Data Analyst, New Grad']);
    assert.equal(jobSeenStatus(state, second.jobs[0]).completed, false, 'a new posting is left for the scoring path to mark');
    assert.deepEqual((await collectAtsBoardSources({ ...config, sources: { atsBoards: { enabled: false } } }, state, collected, { now: later })).jobs, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
