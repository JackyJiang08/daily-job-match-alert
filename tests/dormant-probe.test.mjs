// Dormant ATS boards are probed every 30 days; one that answers resumes polling (2026-10-23).
import assert from 'node:assert/strict';
import test from 'node:test';
import { DORMANT_PROBE_DAYS, collectAtsBoards, dormantProbeDue, nextDormantProbeAt, normalizeRegistry, probeBoard } from '../src/collectors/ats-boards.mjs';

const SINCE = '2026-09-25T01:00:05.559Z';
const DAY = 24 * 60 * 60 * 1000;
// The nightly run on the 30th day, a few seconds before the time of day the boards went dormant.
const PROBE_NIGHT = new Date(Date.parse('2026-10-25T01:00:00.000Z'));

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function dormant(key, kind, apiUrl, extra = {}) {
  return { key, kind, company: key.split(':')[1], apiUrl, origin: 'discovered', discoveredAt: '2026-09-01T01:00:00.000Z', enabled: true, lastPolledAt: SINCE, lastSuccessAt: null, consecutiveFailures: 7, lastError: extra.lastError || 'HTTP 404', lastFailureAt: SINCE, dormant: true, dormantSince: SINCE, baselinedAt: null, ...extra };
}

function registryOf(...boards) {
  return normalizeRegistry({ boards: Object.fromEntries(boards.map(board => [board.key, board])) });
}

test('the probe falls due 30 days after the board went dormant or after its last probe; disabled and active boards are never probed', () => {
  const board = dormant('ashby:evenup', 'ashby', 'https://api.ashbyhq.com/posting-api/job-board/evenup');
  assert.equal(DORMANT_PROBE_DAYS, 30);
  assert.equal(nextDormantProbeAt(board), '2026-10-25T01:00:05.559Z');
  assert.equal(dormantProbeDue(board, new Date('2026-10-24T01:00:00Z')), false, 'the night before');
  assert.equal(dormantProbeDue(board, PROBE_NIGHT), true, 'the 30th night, a few seconds early');
  assert.equal(nextDormantProbeAt({ ...board, lastProbeAt: '2026-10-25T01:00:10.000Z' }), '2026-11-24T01:00:10.000Z');
  assert.equal(nextDormantProbeAt({ ...board, enabled: false }), null);
  assert.equal(nextDormantProbeAt({ ...board, dormant: false }), null);
});

test('each kind is probed with one light request and only the status is read', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => { calls.push({ url, method: options.method || 'GET', body: options.body || null }); return jsonResponse({ jobs: [] }); };
  const boards = [
    dormant('greenhouse:example', 'greenhouse', 'https://boards-api.greenhouse.io/v1/boards/example/jobs?content=true'),
    dormant('lever:example', 'lever', 'https://api.lever.co/v0/postings/example?mode=json'),
    dormant('smartrecruiters:Example', 'smartrecruiters', 'https://api.smartrecruiters.com/v1/companies/Example/postings'),
    dormant('workday:example/Careers', 'workday', 'https://example.wd5.myworkdayjobs.com/wday/cxs/example/Careers/jobs'),
    dormant('ashby:example', 'ashby', 'https://api.ashbyhq.com/posting-api/job-board/example'),
  ];
  for (const board of boards) assert.equal((await probeBoard(board, { fetchImpl })).ok, true);
  assert.deepEqual(calls.map(call => [call.method, call.url]), [
    ['GET', 'https://boards-api.greenhouse.io/v1/boards/example/jobs'],
    ['GET', 'https://api.lever.co/v0/postings/example?mode=json&limit=1'],
    ['GET', 'https://api.smartrecruiters.com/v1/companies/Example/postings?limit=1'],
    ['POST', 'https://example.wd5.myworkdayjobs.com/wday/cxs/example/Careers/jobs'],
    ['GET', 'https://api.ashbyhq.com/posting-api/job-board/example'],
  ]);
  assert.equal(JSON.parse(calls[3].body).limit, 1);
  assert.deepEqual(await probeBoard(boards[0], { fetchImpl: async () => jsonResponse({}, 422) }), { ok: false, status: 422, error: 'HTTP 422', network: false });
  const offline = await probeBoard(boards[0], { fetchImpl: async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) }); } });
  assert.equal(offline.ok, false);
  assert.equal(offline.network, true);
});

test('the nightly run probes due dormant boards: one that answers resumes polling with an info line, one still failing stays dormant until the next probe', async () => {
  const registry = registryOf(
    dormant('greenhouse:back', 'greenhouse', 'http://boards.test/greenhouse/back?content=true'),
    dormant('workday:gone/Careers', 'workday', 'http://boards.test/workday/gone', { lastError: 'HTTP 422' }),
    dormant('ashby:recent', 'ashby', 'http://boards.test/ashby/recent', { dormantSince: '2026-10-14T01:00:05.676Z' }),
    dormant('ashby:off', 'ashby', 'http://boards.test/ashby/off', { enabled: false }),
    { key: 'lever:active', kind: 'lever', company: 'Active', apiUrl: 'http://boards.test/lever/active', origin: 'discovered', discoveredAt: '2026-09-01T01:00:00.000Z', enabled: true, lastPolledAt: '2026-10-24T01:00:00.000Z', lastSuccessAt: '2026-10-24T01:00:00.000Z', consecutiveFailures: 0, dormant: false, baselinedAt: '2026-09-01T01:00:00.000Z', lastNewAt: '2026-10-24T01:00:00.000Z' },
  );
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push(`${options.method || 'GET'} ${url}`);
    if (url.includes('/workday/gone')) return jsonResponse({}, 422);
    if (url.includes('/greenhouse/back')) return jsonResponse({ jobs: [] });
    return jsonResponse([]);
  };
  const warnings = [];
  const night = await collectAtsBoards({ registry, now: PROBE_NIGHT, warnings, fetchImpl, timeZone: 'America/Chicago' });
  assert.deepEqual(night.probes.resumed, ['greenhouse:back']);
  assert.deepEqual(night.probes.failed.map(item => [item.key, item.error]), [['workday:gone/Careers', 'HTTP 422']]);
  assert.equal(night.probes.probed, 2, 'only the boards due tonight: not the recent one, not the disabled one');
  assert.ok(!requests.some(request => /ashby\/(recent|off)/.test(request)));
  assert.ok(requests.includes('GET http://boards.test/greenhouse/back'), 'the probe skips the descriptions');

  const back = registry.boards['greenhouse:back'];
  assert.equal(back.dormant, false);
  assert.equal(back.dormantSince, null);
  assert.equal(back.consecutiveFailures, 0);
  assert.equal(back.lastError, null);
  assert.equal(back.resumedBy, 'probe');
  assert.equal(back.lastProbeResult, 'HTTP 200');
  const info = warnings.find(warning => warning.source === 'Greenhouse · back');
  assert.equal(info.level, 'info');
  assert.match(info.message, /^answered the 30-day probe of a dormant board \(HTTP 200, dormant for 30 days\); polling resumes from the next run$/);
  assert.equal(night.results.find(result => result.key === 'greenhouse:back').resumed, true);
  assert.equal(night.results.find(result => result.key === 'greenhouse:back').skipped, 'dormant', 'probed, not polled, tonight');

  const gone = registry.boards['workday:gone/Careers'];
  assert.equal(gone.dormant, true);
  assert.equal(gone.dormantSince, SINCE);
  assert.equal(gone.consecutiveFailures, 7, 'a failed probe is not one more failure');
  assert.equal(gone.lastProbeAt, PROBE_NIGHT.toISOString());
  assert.equal(nextDormantProbeAt(gone), '2026-11-24T01:00:00.000Z');
  const summary = warnings.find(warning => warning.source === 'ATS boards');
  assert.equal(summary.level, 'info');
  assert.equal(summary.message, 'probed 2 dormant board(s); 1 still failing and stay dormant until the next probe (2026-11-23): Workday · gone/Careers (HTTP 422)');

  // The next night polls the resumed board normally (its first successful poll is a baseline) and leaves
  // the failing one alone.
  requests.length = 0;
  const next = await collectAtsBoards({ registry, now: new Date(PROBE_NIGHT.getTime() + DAY), warnings: [], fetchImpl, timeZone: 'America/Chicago' });
  const polled = next.results.find(result => result.key === 'greenhouse:back');
  assert.equal(polled.ok, true);
  assert.equal(polled.skipped, null);
  assert.equal(polled.baseline, true);
  assert.ok(requests.includes('GET http://boards.test/greenhouse/back?content=true'));
  assert.ok(!requests.some(request => request.includes('/workday/gone')));
  assert.equal(next.probes.probed, 0);
});

test('no probe while this Mac is offline: the boards stay due for the next run', async () => {
  const live = Array.from({ length: 4 }, (_, index) => ({ key: `greenhouse:live${index}`, kind: 'greenhouse', company: `Live ${index}`, apiUrl: `http://boards.test/live${index}`, origin: 'discovered', discoveredAt: '2026-09-01T01:00:00.000Z', enabled: true, lastPolledAt: '2026-10-24T01:00:00.000Z', consecutiveFailures: 0, dormant: false, baselinedAt: '2026-09-01T01:00:00.000Z', lastNewAt: '2026-10-24T01:00:00.000Z' }));
  const registry = registryOf(dormant('greenhouse:back', 'greenhouse', 'http://boards.test/back'), ...live);
  const fetchImpl = async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) }); };
  const night = await collectAtsBoards({ registry, now: PROBE_NIGHT, warnings: [], fetchImpl, sleep: async () => {}, clock: { jumpMs: () => 0 } });
  assert.equal(night.outage.persisting, true);
  assert.equal(night.probes.skipped, 'network outage');
  assert.equal(registry.boards['greenhouse:back'].lastProbeAt, undefined);
  assert.equal(dormantProbeDue(registry.boards['greenhouse:back'], new Date(PROBE_NIGHT.getTime() + DAY)), true);
});
