// Board polling when this Mac's network is the problem: error causes, the outage rule and its retry,
// the one-time repair of the 10-11 counts, caffeinate, and the read-only probe. Local servers and fakes
// only; nothing here reaches a real board or search API.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CLOCK_JUMP_MS, OUTAGE_REPAIR_MIGRATION, OUTAGE_RETRY_DELAY_MS, collectAtsBoards, identifyBoard, normalizeRegistry, normalizeSnapshots, registerBoards, undoOutageFailures,
} from '../src/collectors/ats-boards.mjs';
import { formatProbe, pickProbeBoards, probeBoards, probeSummary, runProbe } from '../src/boards-probe.mjs';
import { CAFFEINATE, caffeinated } from '../src/caffeinate.mjs';
import { createRunManager } from '../src/hub/run.mjs';
import { sourcesView } from '../src/hub/services.mjs';
import { NETWORK_OUTAGE_MESSAGE, main } from '../src/index.mjs';
import { runNode } from '../src/launchd-dispatch.mjs';
import { buildHtml } from '../src/report.mjs';
import { errorCause, errorSummary, isNetworkError } from '../src/warnings.mjs';

const NOW = new Date('2026-10-12T01:00:00Z');
const LONG_AGO = '2026-09-01T00:00:00Z';

function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } });
}

// What Node's fetch throws when no HTTP answer arrives: "fetch failed" with the reason on error.cause.
function fetchFailed(code, message) {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(message || code), { code }) });
}

function httpError(status) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

// `count` Greenhouse boards with long-established baselines that were new yesterday (so none is quiet).
function greenhouseRegistry(count, extra = {}) {
  const registry = normalizeRegistry(null);
  const boards = Array.from({ length: count }, (_, index) => identifyBoard(`https://job-boards.greenhouse.io/examplecorp${index}`));
  registerBoards(registry, boards, { now: new Date(LONG_AGO) });
  for (const board of Object.values(registry.boards)) {
    Object.assign(board, { baselinedAt: LONG_AGO, lastNewAt: '2026-10-11T01:00:00Z', lastSuccessAt: '2026-10-11T01:00:00Z', lastPolledAt: '2026-10-11T01:00:00Z', consecutiveFailures: 0, ...extra });
  }
  return registry;
}

function boardKey(url) {
  return String(url).match(/boards\/(examplecorp\d+)/)?.[1] || String(url);
}

function greenhouseJobs(token) {
  return { jobs: [{ id: 1, absolute_url: `https://job-boards.greenhouse.io/${token}/jobs/1`, title: 'Data Analyst, New Grad', company_name: 'Example Corp', location: { name: 'Remote' }, updated_at: '2026-10-11T20:00:00Z', first_published: '2026-10-11T20:00:00Z', content: 'x' }] };
}

// A clock with no jump unless told otherwise.
const steadyClock = { jumpMs: () => 0 };

function recorder() {
  const delays = [];
  return { delays, sleep: async ms => { delays.push(ms); } };
}

// ------------------------------------------------------------------------------------------ error causes

test('a failed fetch is summarized with its cause code and message, not just "fetch failed"', () => {
  const cases = [
    [fetchFailed('ENOTFOUND', 'getaddrinfo ENOTFOUND boards-api.greenhouse.io'), 'ENOTFOUND', /fetch failed \(ENOTFOUND: getaddrinfo ENOTFOUND boards-api\.greenhouse\.io\)/],
    [fetchFailed('ECONNRESET', 'read ECONNRESET'), 'ECONNRESET', /ECONNRESET: read ECONNRESET/],
    [fetchFailed('UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error (attempted address: example.com:443, timeout: 10000ms)'), 'UND_ERR_CONNECT_TIMEOUT', /UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error/],
    [fetchFailed('CERT_HAS_EXPIRED', 'certificate has expired'), 'CERT_HAS_EXPIRED', /CERT_HAS_EXPIRED: certificate has expired/],
  ];
  for (const [error, code, summary] of cases) {
    assert.equal(errorCause(error).code, code);
    assert.match(errorSummary(error), summary);
    assert.equal(isNetworkError(error), true, `${code} is a network failure`);
  }
  // Several addresses refused: the AggregateError's first error names it.
  const refused = new TypeError('fetch failed', { cause: Object.assign(new AggregateError([Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' })], ''), { code: 'ECONNREFUSED' }) });
  assert.equal(errorCause(refused).code, 'ECONNREFUSED');
  assert.match(errorSummary(refused), /ECONNREFUSED: connect ECONNREFUSED 127\.0\.0\.1:443/);
  // The board's own answers are not network failures.
  assert.deepEqual(errorCause(httpError(404)), { code: 'HTTP 404', message: 'HTTP 404' });
  assert.equal(isNetworkError(httpError(404)), false);
  assert.equal(isNetworkError(httpError(503)), false);
  assert.equal(isNetworkError(new SyntaxError('Unexpected token < in JSON')), false);
  assert.equal(errorSummary(new Error('plain')), 'plain', 'no cause, unchanged');
});

test('a board failure records the cause on the result and the registry, and the warning names it', async () => {
  const registry = greenhouseRegistry(4);
  const warnings = [];
  const { results } = await collectAtsBoards({
    registry, now: NOW, warnings, clock: steadyClock, sleep: async () => assert.fail('one failure in four is not an outage'),
    fetchImpl: async url => (boardKey(url) === 'examplecorp1' ? Promise.reject(fetchFailed('ECONNRESET', 'read ECONNRESET')) : jsonResponse(greenhouseJobs(boardKey(url)))),
  });
  const failed = results.find(result => result.key === 'greenhouse:examplecorp1');
  assert.equal(failed.ok, false);
  assert.equal(failed.errorCode, 'ECONNRESET');
  assert.match(failed.error, /fetch failed \(ECONNRESET: read ECONNRESET\)/);
  assert.equal(registry.boards['greenhouse:examplecorp1'].lastErrorCode, 'ECONNRESET');
  assert.equal(registry.boards['greenhouse:examplecorp1'].consecutiveFailures, 1, 'an isolated network failure still counts');
  assert.ok(warnings.some(warning => /ECONNRESET: read ECONNRESET\) \(failure 1 in a row\)/.test(warning.message)));
});

// ------------------------------------------------------------------------------------------ outage rule

test('most boards failing without an answer: nothing counted, no snapshot, no last success, one retry after 60 s; a 404 still counts', async () => {
  const registry = greenhouseRegistry(10);
  registry.boards['greenhouse:examplecorp9'].consecutiveFailures = 2;
  const before = structuredClone(registry);
  const snapshots = normalizeSnapshots(null);
  snapshots.boards['greenhouse:examplecorp0'] = { at: '2026-10-11T01:00:00.000Z', complete: true, count: 1, ids: ['0000000000000000'] };
  const { delays, sleep } = recorder();
  const calls = [];
  const warnings = [];
  const polled = await collectAtsBoards({
    registry, snapshots, now: NOW, warnings, clock: steadyClock, sleep,
    fetchImpl: async url => {
      calls.push(boardKey(url));
      if (boardKey(url) === 'examplecorp9') return jsonResponse({}, { status: 404 });
      throw fetchFailed('ENOTFOUND', `getaddrinfo ENOTFOUND boards-api.greenhouse.io`);
    },
  });
  assert.deepEqual(delays, [OUTAGE_RETRY_DELAY_MS], 'waited once, 60 s');
  assert.equal(calls.length, 10 + 9, 'the nine unreachable boards were retried once; the 404 was not');
  assert.equal(polled.outage.persisting, true);
  assert.equal(polled.outage.reason, 'network');
  assert.equal(polled.outage.missing, 9);
  assert.deepEqual(polled.outage.causes, [{ code: 'ENOTFOUND', count: 9 }]);
  for (let index = 0; index < 9; index += 1) {
    const key = `greenhouse:examplecorp${index}`;
    const board = registry.boards[key];
    assert.equal(board.consecutiveFailures, 0, `${key}: not counted`);
    assert.equal(board.lastFailureAt, before.boards[key].lastFailureAt, `${key}: no failure time`);
    assert.equal(board.lastSuccessAt, before.boards[key].lastSuccessAt, `${key}: last success unchanged`);
    assert.equal(board.lastPolledAt, before.boards[key].lastPolledAt, `${key}: the next run polls it again`);
    assert.equal(board.dormant, false);
    const result = polled.results.find(item => item.key === key);
    assert.equal(result.outage, true);
    assert.match(result.error, /ENOTFOUND/);
  }
  assert.deepEqual(Object.keys(polled.snapshots.boards), ['greenhouse:examplecorp0'], 'no snapshot written for an unreachable board');
  assert.equal(polled.snapshots.boards['greenhouse:examplecorp0'].at, '2026-10-11T01:00:00.000Z', 'the old snapshot is left as it was');
  const notFound = registry.boards['greenhouse:examplecorp9'];
  assert.equal(notFound.consecutiveFailures, 3, 'the 404 counts as usual');
  assert.equal(notFound.lastError, 'HTTP 404');
  assert.equal(warnings.filter(warning => /in a row/.test(warning.message)).length, 1, 'only the 404 gets a per-board failure warning');
});

test('an outage the retry recovers from: the boards poll normally and the ones still failing are counted', async () => {
  const registry = greenhouseRegistry(10);
  const { delays, sleep } = recorder();
  let retrying = false;
  const polled = await collectAtsBoards({
    registry, now: NOW, clock: steadyClock,
    sleep: async ms => { await sleep(ms); retrying = true; },
    fetchImpl: async url => {
      const token = boardKey(url);
      if (!retrying || token === 'examplecorp3') throw fetchFailed('EAI_AGAIN', 'getaddrinfo EAI_AGAIN boards-api.greenhouse.io');
      return jsonResponse(greenhouseJobs(token));
    },
  });
  assert.deepEqual(delays, [OUTAGE_RETRY_DELAY_MS]);
  assert.equal(polled.outage.persisting, false);
  assert.equal(polled.outage.recovered, 9);
  assert.equal(polled.outage.missing, 0);
  assert.equal(Object.keys(polled.snapshots.boards).length, 9, 'recovered boards get tonight\'s snapshot');
  assert.equal(registry.boards['greenhouse:examplecorp0'].lastSuccessAt, NOW.toISOString());
  assert.equal(polled.jobs.length, 9);
  assert.equal(registry.boards['greenhouse:examplecorp3'].consecutiveFailures, 1, 'the network came back; this board failing alone counts');
  assert.equal(registry.boards['greenhouse:examplecorp3'].lastErrorCode, 'EAI_AGAIN');
});

test('a few failures are not an outage: no wait, counted as usual', async () => {
  const registry = greenhouseRegistry(10);
  const polled = await collectAtsBoards({
    registry, now: NOW, clock: steadyClock, sleep: async () => assert.fail('no retry for 3 of 10'),
    fetchImpl: async url => (['examplecorp1', 'examplecorp2', 'examplecorp3'].includes(boardKey(url)) ? Promise.reject(fetchFailed('ETIMEDOUT', 'connect ETIMEDOUT')) : jsonResponse(greenhouseJobs(boardKey(url)))),
  });
  assert.equal(polled.outage, null);
  assert.equal(registry.boards['greenhouse:examplecorp1'].consecutiveFailures, 1);
  // Mostly HTTP failures are the boards' own, however many.
  const many = greenhouseRegistry(6);
  const answered = await collectAtsBoards({ registry: many, now: NOW, clock: steadyClock, sleep: async () => assert.fail('HTTP errors never trigger the outage rule'), fetchImpl: async () => jsonResponse({}, { status: 503 }) });
  assert.equal(answered.outage, null);
  assert.equal(many.boards['greenhouse:examplecorp0'].consecutiveFailures, 1);
});

test('a clock jump of more than 5 minutes during the run (the Mac slept) is handled like an outage, even for one failure', async () => {
  const registry = greenhouseRegistry(10);
  const { delays, sleep } = recorder();
  let jump = CLOCK_JUMP_MS + 60_000;
  const polled = await collectAtsBoards({
    registry, now: NOW, sleep, clock: { jumpMs: () => jump },
    fetchImpl: async url => (boardKey(url) === 'examplecorp4' ? Promise.reject(fetchFailed('ENETUNREACH', 'connect ENETUNREACH')) : jsonResponse(greenhouseJobs(boardKey(url)))),
  });
  assert.deepEqual(delays, [OUTAGE_RETRY_DELAY_MS]);
  assert.equal(polled.outage.reason, 'clock_jump');
  assert.equal(polled.outage.clockJumpMs, CLOCK_JUMP_MS + 60_000);
  assert.equal(polled.outage.persisting, true, 'one board, still failing after the retry');
  assert.equal(registry.boards['greenhouse:examplecorp4'].consecutiveFailures, 0);
  jump = 0;
  assert.equal(registry.boards['greenhouse:examplecorp0'].consecutiveFailures, 0);
});

// ------------------------------------------------------------------------------------------ local HTTP server

// Stand-ins for the three request shapes on 127.0.0.1: Greenhouse GET with ETag and 304, Workday POST paging,
// SmartRecruiters GET paging. Polled through the real fetch, as the nightly run does.
async function startBoardServer() {
  const seen = [];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    seen.push({ method: request.method, url: request.url, headers: request.headers, body });
    const send = (status, payload, headers = {}) => { response.writeHead(status, { 'content-type': 'application/json', ...headers }); response.end(payload == null ? '' : JSON.stringify(payload)); };
    if (request.url.startsWith('/greenhouse')) {
      if (request.headers['if-none-match'] === '"v1"') return send(304, null, { etag: '"v1"' });
      return send(200, greenhouseJobs('examplecorp'), { etag: '"v1"' });
    }
    if (request.url.startsWith('/workday')) {
      const { offset } = JSON.parse(body);
      const rows = offset === 0 ? Array.from({ length: 20 }, (_, index) => ({ title: `Data Analyst ${index}`, externalPath: `/job/US-IL/Data-Analyst_R${index}`, locationsText: 'US, IL, Chicago', postedOn: 'Posted Today', bulletFields: [`R${index}`] })) : [{ title: 'Data Engineer', externalPath: '/job/US-IL/Data-Engineer_R99', locationsText: 'US, IL, Chicago', postedOn: 'Posted Today', bulletFields: ['R99'] }];
      return send(200, { total: 21, jobPostings: rows });
    }
    if (request.url.startsWith('/smartrecruiters')) {
      return send(200, { offset: 0, limit: 100, totalFound: 1, content: [{ id: '744000000000001', name: 'Junior Data Scientist', company: { identifier: 'ExampleCorp', name: 'Example Corp' }, releasedDate: '2026-10-11T20:00:00.000Z', location: { city: 'Chicago', region: 'IL', country: 'us' } }] });
    }
    return send(404, { ok: false });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, seen, base: `http://127.0.0.1:${server.address().port}` };
}

test('the board requests work end to end against local Greenhouse, Workday, and SmartRecruiters stand-ins, conditional headers only once a snapshot exists', async () => {
  const { server, seen, base } = await startBoardServer();
  try {
    const registry = normalizeRegistry(null);
    registerBoards(registry, [
      identifyBoard('https://job-boards.greenhouse.io/examplecorp'),
      identifyBoard('https://examplecorp.wd5.myworkdayjobs.com/External'),
      identifyBoard('https://jobs.smartrecruiters.com/ExampleCorp'),
    ].filter(Boolean), { now: new Date(LONG_AGO) });
    const keys = Object.keys(registry.boards).sort();
    assert.equal(keys.length, 3, keys.join(', '));
    for (const board of Object.values(registry.boards)) {
      Object.assign(board, { baselinedAt: LONG_AGO, lastNewAt: '2026-10-11T01:00:00Z', apiUrl: `${base}/${board.kind}/postings` });
    }
    registry.boards['greenhouse:examplecorp'].etag = '"v1"';
    const snapshots = normalizeSnapshots(null);
    const options = { registry, snapshots, network: { timeoutMs: 5000 }, clock: steadyClock, sleep: async () => assert.fail('no outage') };
    const first = await collectAtsBoards({ ...options, now: NOW });
    assert.deepEqual(first.results.map(result => [result.kind, result.ok, result.jobCount]).sort(), [['greenhouse', true, 1], ['smartrecruiters', true, 1], ['workday', true, 21]]);
    const greenhouseFirst = seen.find(request => request.url.startsWith('/greenhouse'));
    assert.equal(greenhouseFirst.headers['if-none-match'], undefined, 'no snapshot yet: no conditional header, the full list comes back');
    assert.equal(seen.filter(request => request.url.startsWith('/workday')).length, 2, 'Workday walked both pages');
    assert.equal(JSON.parse(seen.find(request => request.url.startsWith('/workday')).body).limit, 20);
    assert.match(seen.find(request => request.url.startsWith('/smartrecruiters')).url, /limit=100&offset=0&country=us/);
    assert.equal(Object.keys(snapshots.boards).length, 3);

    seen.length = 0;
    const second = await collectAtsBoards({ ...options, now: new Date(NOW.getTime() + 24 * 60 * 60 * 1000) });
    assert.equal(seen.find(request => request.url.startsWith('/greenhouse')).headers['if-none-match'], '"v1"', 'with a snapshot the ETag goes along');
    assert.equal(second.results.find(result => result.kind === 'greenhouse').notModified, true);
    assert.ok(second.results.every(result => result.ok));
  } finally {
    server.close();
  }
});

test('a closed local port fails with a network cause through the real fetch', async () => {
  const { server, base } = await startBoardServer();
  server.close();
  await new Promise(resolve => server.on('close', resolve));
  const registry = greenhouseRegistry(1);
  registry.boards['greenhouse:examplecorp0'].apiUrl = `${base}/greenhouse`;
  const { results } = await collectAtsBoards({ registry, now: NOW, network: { timeoutMs: 5000 }, clock: steadyClock, sleep: async () => {} });
  assert.equal(results[0].ok, false);
  assert.equal(results[0].errorCode, 'ECONNREFUSED');
  assert.match(results[0].error, /fetch failed \(ECONNREFUSED: connect ECONNREFUSED 127\.0\.0\.1:\d+\)/);
});

// ------------------------------------------------------------------------------------------ 10-11 repair

test('the one-time repair takes back the failures of a run where most boards said "fetch failed", and only those', () => {
  const at = '2026-10-12T01:06:08.473Z';
  const registry = greenhouseRegistry(6);
  const boards = Object.values(registry.boards);
  // Five failed at the outage; one of them was failing before (count 3 → 4); one answered 404 that night.
  boards.slice(0, 5).forEach((board, index) => Object.assign(board, { lastPolledAt: at, lastFailureAt: at, lastError: 'fetch failed', consecutiveFailures: index === 0 ? 4 : 1, lastSuccessAt: '2026-10-11T01:00:05.602Z' }));
  Object.assign(boards[4], { consecutiveFailures: 7, dormant: true, dormantSince: at });
  Object.assign(boards[5], { lastPolledAt: at, lastFailureAt: at, lastError: 'HTTP 404', consecutiveFailures: 2 });
  // An old, genuine, isolated network failure on another night is left alone.
  const lone = greenhouseRegistry(1).boards['greenhouse:examplecorp0'];
  registry.boards['greenhouse:lonely'] = { ...lone, key: 'greenhouse:lonely', lastPolledAt: '2026-09-25T01:00:00Z', lastFailureAt: '2026-09-25T01:00:00Z', lastError: 'fetch failed', consecutiveFailures: 1 };
  const result = undoOutageFailures(registry, NOW);
  assert.equal(result.applied, true);
  assert.deepEqual(result.runs, [{ at, boards: 5 }]);
  assert.equal(boards[0].consecutiveFailures, 3);
  assert.equal(boards[1].consecutiveFailures, 0);
  assert.equal(boards[1].lastError, null);
  assert.equal(boards[1].lastFailureAt, null);
  assert.equal(boards[1].lastPolledAt, '2026-10-11T01:00:05.602Z', 'back to the last success so the next run polls it');
  assert.equal(boards[4].dormant, false, 'the dormancy that outage caused is lifted');
  assert.equal(boards[4].consecutiveFailures, 6);
  assert.equal(boards[5].consecutiveFailures, 2, 'the 404 that night stays counted');
  assert.equal(registry.boards['greenhouse:lonely'].consecutiveFailures, 1);
  assert.equal(registry.migrations[OUTAGE_REPAIR_MIGRATION].runs.length, 1);
  // Kept across a write and read, and never applied twice.
  const reread = normalizeRegistry(JSON.parse(JSON.stringify(registry)));
  assert.ok(reread.migrations[OUTAGE_REPAIR_MIGRATION]);
  Object.assign(reread.boards['greenhouse:examplecorp1'], { lastFailureAt: at, lastError: 'fetch failed', consecutiveFailures: 1 });
  assert.equal(undoOutageFailures(reread, NOW).applied, false);
  assert.equal(reread.boards['greenhouse:examplecorp1'].consecutiveFailures, 1);
});

// ------------------------------------------------------------------------------------------ end to end

async function prepareProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'network-outage-'));
  await fs.copyFile(new URL('./fixtures/data-resume.md', import.meta.url), path.join(root, 'data-resume.md'));
  const config = {
    lookbackHours: 24, timeZone: 'America/Chicago', minimumMatchScore: 0, reportDateOffsetDays: 0,
    semanticMatching: { engine: 'local_only', acceptedMatchLevels: ['high', 'medium', 'low'], maxReviewedPerRun: 5 },
    prescreen: { enabled: false },
    coverLetter: { autoGenerate: { enabled: false } },
    reports: { xlsx: { enabled: false, required: false } },
    outputDirectory: './output',
    resumes: { tracks: [{ id: 'data', label: 'Data', profile: './data-resume.md' }] },
    preferences: { roleTypes: ['internship', 'new_grad', 'entry_level'], locations: ['Remote'], remoteOkay: true, maxYearsExperience: 3, graduationDate: '2027-05', excludeTitleTerms: [], titleFamilies: ['data analyst'] },
    sources: {
      githubLists: { enabled: false }, hackerNewsHiring: { enabled: false }, remoteOk: { enabled: false }, simplifyInternships: { enabled: false }, simplifyNewGrad: { enabled: false },
      emailFiles: { enabled: false }, himalaya: { enabled: false }, careerOps: { enabled: false }, searchDiscovery: { enabled: false },
      atsBoards: { enabled: true },
    },
    network: { fetchDescriptions: false, concurrency: 2, timeoutMs: 1000 },
  };
  await fs.mkdir(path.join(root, 'state'), { recursive: true });
  const registry = greenhouseRegistry(4);
  registry.migrations = { [OUTAGE_REPAIR_MIGRATION]: { at: LONG_AGO, runs: [] } };
  await fs.writeFile(path.join(root, 'state', 'ats-boards.json'), JSON.stringify(registry));
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  return { root, configPath, registry };
}

test('end to end: an outage the retry cannot fix puts a notice in the report header and warnings, sends a notification, and leaves the registry untouched', async () => {
  const { root, configPath, registry: before } = await prepareProject();
  const silence = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {};
  const notes = [];
  const { delays, sleep } = recorder();
  try {
    await main({
      argv: ['node', 'index.mjs', '--config', configPath, '--now', NOW.toISOString()], autoLetters: false,
      atsFetchImpl: async () => { throw fetchFailed('ENOTFOUND', 'getaddrinfo ENOTFOUND boards-api.greenhouse.io'); },
      atsSleep: sleep, runClock: steadyClock, notify: async text => { notes.push(text); },
    });
  } finally {
    [console.log, console.warn, console.error] = silence;
  }
  assert.deepEqual(delays, [OUTAGE_RETRY_DELAY_MS]);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /network dropped while the job boards were being polled/);
  const payload = JSON.parse(await fs.readFile(path.join(root, 'state', 'report-payload-2026-10-11.json'), 'utf8'));
  assert.equal(payload.meta.networkOutage.missing, 4);
  assert.deepEqual(payload.meta.networkOutage.causes, [{ code: 'ENOTFOUND', count: 4 }]);
  const warning = payload.meta.warnings.find(item => item.source === 'ATS boards' && item.level === 'warning');
  assert.ok(warning.message.startsWith(NETWORK_OUTAGE_MESSAGE));
  assert.match(warning.message, /ENOTFOUND ×4/);
  assert.equal(payload.meta.warnings.filter(item => /in a row/.test(item.message)).length, 0, 'no per-board failure warnings');
  const stat = payload.meta.sourceCounts.find(item => item.key === 'greenhouse:examplecorp0');
  assert.equal(stat.outage, true);
  assert.equal(stat.errorCode, 'ENOTFOUND');
  const html = await fs.readFile(path.join(root, 'output', '2026-10-11', 'Daily Job Match Alert - 2026-10-11.html'), 'utf8');
  assert.match(html, /<div class="banner" data-banner="network">This Mac&#39;s network dropped while the job boards were being polled, so ATS sources are missing from this run\./);
  assert.match(html, /<dt>Network<\/dt>/);
  const after = JSON.parse(await fs.readFile(path.join(root, 'state', 'ats-boards.json'), 'utf8'));
  for (const [key, board] of Object.entries(after.boards)) {
    assert.equal(board.consecutiveFailures, 0, key);
    assert.equal(board.lastPolledAt, before.boards[key].lastPolledAt, key);
    assert.equal(board.lastSuccessAt, before.boards[key].lastSuccessAt, key);
    assert.equal(board.lastFailureAt ?? null, null, key);
  }
  const snapshots = JSON.parse(await fs.readFile(path.join(root, 'state', 'ats-snapshots.json'), 'utf8'));
  assert.deepEqual(snapshots.boards, {});

  // The Sources page shows the reason, marked as the network's, not the board's.
  const rows = await sourcesView({ root, io: fs }, { sources: {} }, payload);
  const row = rows.find(item => item.key === 'greenhouse:examplecorp0');
  assert.match(row.outage, /ENOTFOUND: getaddrinfo ENOTFOUND/);
});

test('the report header shows no network notice on a normal run', () => {
  const html = buildHtml([], { date: '2026-10-11', warnings: [], sourceCounts: [] });
  assert.doesNotMatch(html, /data-banner="network"/);
  const outage = buildHtml([], { date: '2026-10-11', warnings: [], sourceCounts: [], networkOutage: { message: NETWORK_OUTAGE_MESSAGE, detail: `${NETWORK_OUTAGE_MESSAGE} 4 board(s) could not be reached.` } });
  assert.match(outage, /data-banner="network">This Mac&#39;s network dropped[^<]*4 board\(s\) could not be reached\./);
});

// ------------------------------------------------------------------------------------------ caffeinate

test('caffeinate -i wraps the run only on macOS, for the launchd dispatcher and for Run Now', async () => {
  assert.deepEqual(caffeinated('/usr/local/bin/node', ['index.mjs'], { platform: 'darwin' }), { command: CAFFEINATE, args: ['-i', '/usr/local/bin/node', 'index.mjs'], caffeinated: true });
  assert.deepEqual(caffeinated('/usr/bin/node', ['index.mjs'], { platform: 'linux' }), { command: '/usr/bin/node', args: ['index.mjs'], caffeinated: false });

  for (const [platform, command, first] of [['darwin', CAFFEINATE, '-i'], ['linux', '/fake/node', 'index.mjs']]) {
    const spawned = [];
    const spawn = (cmd, args) => {
      spawned.push({ cmd, args });
      return { on(event, handler) { if (event === 'close') setImmediate(() => handler(0)); } };
    };
    await runNode(['index.mjs', '--config', 'config.json'], { spawn, platform, nodeBinary: '/fake/node', trigger: 'scheduled' });
    assert.equal(spawned[0].cmd, command, `launchd on ${platform}`);
    assert.equal(spawned[0].args[0], first);

    const hubSpawned = [];
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caffeinate-'));
    const manager = createRunManager({
      root, configPath: path.join(root, 'config.json'), hubDirectory: path.join(root, 'state', 'hub'), platform,
      nodeBinary: '/fake/node', entrypoint: '/fake/index.mjs',
      spawn: (cmd, args) => { hubSpawned.push({ cmd, args }); return { pid: 42, on() {}, stdout: null, stderr: null }; },
    });
    await manager.start();
    assert.equal(hubSpawned[0].cmd, command, `Run Now on ${platform}`);
    assert.deepEqual(hubSpawned[0].args.slice(-3), ['/fake/index.mjs', '--config', path.join(root, 'config.json')]);
  }
});

// ------------------------------------------------------------------------------------------ probe

test('boards:probe picks boards across kinds, prints each result with its cause, and writes nothing', async () => {
  const registry = normalizeRegistry(null);
  registerBoards(registry, [
    ...['examplecorp', 'acme', 'initech'].map(token => identifyBoard(`https://job-boards.greenhouse.io/${token}`)),
    identifyBoard('https://jobs.lever.co/examplecorp'),
    identifyBoard('https://jobs.ashbyhq.com/examplecorp'),
    identifyBoard('https://examplecorp.wd5.myworkdayjobs.com/External'),
  ].filter(Boolean), { now: new Date(LONG_AGO) });
  registry.boards['greenhouse:initech'].dormant = true;
  const picked = pickProbeBoards(registry, { limit: 4 });
  assert.deepEqual(picked.map(board => board.kind), ['greenhouse', 'lever', 'ashby', 'workday'], 'one of each kind first');
  assert.equal(pickProbeBoards(registry, { limit: 20 }).length, 5, 'the dormant board is left out by default');
  assert.equal(pickProbeBoards(registry, { limit: 20, all: true }).length, 6);
  assert.deepEqual(pickProbeBoards(registry, { kinds: ['greenhouse'] }).map(board => board.key), ['greenhouse:acme', 'greenhouse:examplecorp']);

  const before = JSON.stringify(registry);
  const results = await probeBoards(picked, {
    clock: () => 0,
    fetchImpl: async url => {
      if (String(url).includes('lever')) throw fetchFailed('ENOTFOUND', 'getaddrinfo ENOTFOUND api.lever.co');
      if (String(url).includes('ashby')) return jsonResponse({}, { status: 404 });
      if (String(url).includes('workday')) return jsonResponse({ total: 0, jobPostings: [] });
      return jsonResponse(greenhouseJobs('acme'));
    },
  });
  assert.equal(JSON.stringify(registry), before, 'the registry is not touched');
  const summary = probeSummary(results);
  assert.deepEqual({ probed: summary.probed, ok: summary.ok, failed: summary.failed, unreachable: summary.unreachable, localNetwork: summary.localNetwork }, { probed: 4, ok: 2, failed: 2, unreachable: 1, localNetwork: false });
  const text = formatProbe(results, summary);
  assert.match(text, /OK {4}Greenhouse · Acme \[greenhouse:acme\] HTTP 200, 1 posting\(s\)/);
  assert.match(text, /FAIL {2}Lever · Examplecorp \[lever:examplecorp\] fetch failed \(ENOTFOUND: getaddrinfo ENOTFOUND api\.lever\.co\) \[cause ENOTFOUND\] \(no answer: network\)/);
  assert.match(text, /FAIL {2}Ashby · Examplecorp \[ashby:examplecorp\] HTTP 404 \[cause HTTP 404\]/);
  assert.match(text, /Nothing was scored or saved/);

  // Every board unreachable: the summary points at this Mac.
  const down = probeSummary(await probeBoards(picked, { clock: () => 0, fetchImpl: async () => { throw fetchFailed('ENOTFOUND', 'getaddrinfo ENOTFOUND'); } }));
  assert.equal(down.localNetwork, true);
  assert.match(formatProbe([], down), /looks like this Mac's network/);

  // The command reads the registry and config only; state/ is unchanged afterwards.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'probe-'));
  await fs.mkdir(path.join(root, 'state'), { recursive: true });
  const registryFile = path.join(root, 'state', 'ats-boards.json');
  await fs.writeFile(registryFile, before);
  const lines = [];
  const run = await runProbe(['--config', 'config.json', '--limit', '2'], {
    log: line => lines.push(line), load: async () => ({ root, network: { concurrency: 1 }, lookbackHours: 24 }),
    fetchImpl: async () => jsonResponse(greenhouseJobs('acme')),
  });
  assert.equal(run.results.length, 2);
  assert.match(lines.join('\n'), /Probing 2 board\(s\)/);
  assert.equal(await fs.readFile(registryFile, 'utf8'), before);
  assert.deepEqual(await fs.readdir(path.join(root, 'state')), ['ats-boards.json'], 'no other state file appears');
  await assert.rejects(runProbe(['--limit', '0'], { log: () => {}, load: async () => ({ root }) }), /--limit must be a positive whole number/);
});
