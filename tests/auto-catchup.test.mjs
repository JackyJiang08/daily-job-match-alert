// Auto catch-up after a network outage: the incomplete record the pipeline leaves, and the hub's
// 10-minute check (probe, lock, sleep, daily cap, deadline, switch). Fakes only; no real probe or run.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CLOCK_JUMP_MS, OUTAGE_REPAIR_MIGRATION, identifyBoard, normalizeRegistry, registerBoards } from '../src/collectors/ats-boards.mjs';
import { CATCH_UP_NOTIFICATION, CHECK_INTERVAL_MS, MAXIMUM_ATTEMPTS, PROBE_URLS, createAutoCatchUp, probeNetwork } from '../src/hub/auto-catchup.mjs';
import { nextScheduledRun } from '../src/hub/services.mjs';
import { incompleteRunReason, main, recordIncompleteRun } from '../src/index.mjs';

const OUTAGE_AT = '2026-10-12T01:06:08.000Z'; // Oct 11, 8:06 PM in Chicago
const RECORD = { date: '2026-10-11', reason: 'network_outage', detail: 'network dropped', at: OUTAGE_AT, firstAt: OUTAGE_AT, trigger: 'scheduled' };

// ------------------------------------------------------------------------------------------ the record

test('an outage or every network source failing records the run as incomplete; a run that collects clears it', () => {
  assert.deepEqual(incompleteRunReason({ networkOutage: { detail: 'network dropped' } }), { reason: 'network_outage', detail: 'network dropped' });
  const allFailed = incompleteRunReason({ sourceStats: [
    { name: 'SimplifyJobs New Grad', ok: false, error: 'fetch failed (ENOTFOUND: getaddrinfo ENOTFOUND raw.githubusercontent.com)' },
    { name: 'Email files', ok: true, count: 0 },
    { name: 'Greenhouse · Example Corp', kind: 'ats', ok: true, skipped: 'polled recently' },
    { name: 'Lever · Example Corp', kind: 'ats', ok: false, errorCode: 'ENOTFOUND' },
  ] });
  assert.equal(allFailed.reason, 'all_sources_failed', 'local files and skipped boards do not count');
  assert.match(allFailed.detail, /All 2 network source\(s\) failed/);
  assert.equal(incompleteRunReason({ sourceStats: [{ name: 'SimplifyJobs New Grad', ok: false }, { name: 'RemoteOK', ok: true }] }), null, 'one source answered');
  assert.equal(incompleteRunReason({ sourceStats: [{ name: 'Email files', ok: true }] }), null, 'nothing over the network was attempted');

  const state = {};
  recordIncompleteRun(state, allFailed, { now: new Date(OUTAGE_AT), runDate: '2026-10-11', trigger: 'scheduled' });
  assert.deepEqual(state.incompleteRun, { date: '2026-10-11', reason: 'all_sources_failed', detail: allFailed.detail, at: OUTAGE_AT, firstAt: OUTAGE_AT, trigger: 'scheduled' });
  // A catch-up that fails again keeps the first failure time, which the deadline counts from.
  recordIncompleteRun(state, { reason: 'network_outage', detail: 'again' }, { now: new Date('2026-10-12T02:00:00Z'), runDate: '2026-10-11', trigger: 'auto_catchup' });
  assert.equal(state.incompleteRun.firstAt, OUTAGE_AT);
  assert.equal(state.incompleteRun.at, '2026-10-12T02:00:00.000Z');
  recordIncompleteRun(state, null, { now: new Date('2026-10-12T02:30:00Z'), runDate: '2026-10-11', trigger: 'auto_catchup' });
  assert.equal(state.incompleteRun, undefined, 'cleared after the catch-up collected');
  assert.equal(state.lastIncompleteRun.resolvedAt, '2026-10-12T02:30:00.000Z');
  assert.equal(state.lastIncompleteRun.resolvedBy, 'auto_catchup');
});

async function prepareProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-catchup-'));
  await fs.copyFile(new URL('./fixtures/data-resume.md', import.meta.url), path.join(root, 'data-resume.md'));
  const config = {
    lookbackHours: 24, timeZone: 'America/Chicago', minimumMatchScore: 0, reportDateOffsetDays: 0,
    semanticMatching: { engine: 'local_only', acceptedMatchLevels: ['high', 'medium', 'low'], maxReviewedPerRun: 5 },
    prescreen: { enabled: false }, coverLetter: { autoGenerate: { enabled: false } }, reports: { xlsx: { enabled: false, required: false } },
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
  const registry = normalizeRegistry(null);
  registerBoards(registry, [0, 1, 2, 3].map(index => identifyBoard(`https://job-boards.greenhouse.io/examplecorp${index}`)), { now: new Date('2026-09-01T00:00:00Z') });
  for (const board of Object.values(registry.boards)) Object.assign(board, { baselinedAt: '2026-09-01T00:00:00Z', lastNewAt: '2026-10-11T01:00:00Z', lastSuccessAt: '2026-10-11T01:00:00Z', lastPolledAt: '2026-10-11T01:00:00Z' });
  registry.migrations = { [OUTAGE_REPAIR_MIGRATION]: { at: '2026-09-01T00:00:00Z', runs: [] } };
  await fs.writeFile(path.join(root, 'state', 'ats-boards.json'), JSON.stringify(registry));
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  return { root, configPath };
}

test('end to end: the outage run leaves state.incompleteRun; the catch-up run that collects clears it', async () => {
  const { root, configPath } = await prepareProject();
  const silence = [console.log, console.warn, console.error];
  const trigger = process.env.DAILY_JOB_MATCH_ALERT_TRIGGER;
  console.log = console.warn = console.error = () => {};
  try {
    delete process.env.DAILY_JOB_MATCH_ALERT_TRIGGER;
    await main({
      argv: ['node', 'index.mjs', '--config', configPath, '--now', OUTAGE_AT], autoLetters: false, notify: async () => {}, atsSleep: async () => {}, runClock: { jumpMs: () => 0 },
      atsFetchImpl: async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND boards-api.greenhouse.io'), { code: 'ENOTFOUND' }) }); },
    });
    let state = JSON.parse(await fs.readFile(path.join(root, 'state', 'state.json'), 'utf8'));
    assert.equal(state.incompleteRun.date, '2026-10-11');
    assert.equal(state.incompleteRun.reason, 'network_outage');
    assert.match(state.incompleteRun.detail, /network dropped/);

    process.env.DAILY_JOB_MATCH_ALERT_TRIGGER = 'auto_catchup';
    await main({
      argv: ['node', 'index.mjs', '--config', configPath, '--now', '2026-10-12T01:40:00.000Z'], autoLetters: false, notify: async () => {}, atsSleep: async () => assert.fail('no outage now'), runClock: { jumpMs: () => 0 },
      // A catch-up run counts as the night's run, so the backup follows it (src/backup.mjs); kept in the test root.
      backupDirectory: path.join(root, 'backups'), backupNow: new Date('2026-10-12T01:41:00.000Z'),
      atsFetchImpl: async () => new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    state = JSON.parse(await fs.readFile(path.join(root, 'state', 'state.json'), 'utf8'));
    assert.equal(state.incompleteRun, undefined);
    assert.equal(state.lastIncompleteRun.resolvedBy, 'auto_catchup');
    const payload = JSON.parse(await fs.readFile(path.join(root, 'state', 'report-payload-2026-10-11.json'), 'utf8'));
    assert.equal(payload.meta.trigger, 'auto_catchup');
    assert.equal(payload.meta.sourceCounts.filter(stat => stat.kind === 'ats' && stat.ok).length, 4, 'the boards were polled again, not skipped as polled recently');
    assert.deepEqual(await fs.readdir(path.join(root, 'backups')), ['daily-job-match-alert-backup-2026-10-11-204100.zip'], 'the catch-up run made the night\'s backup');
  } finally {
    [console.log, console.warn, console.error] = silence;
    if (trigger == null) delete process.env.DAILY_JOB_MATCH_ALERT_TRIGGER;
    else process.env.DAILY_JOB_MATCH_ALERT_TRIGGER = trigger;
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------ the hub check

async function harness(overrides = {}) {
  const hubDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-catchup-hub-'));
  const calls = { probe: 0, start: [], notify: [] };
  const world = {
    now: new Date('2026-10-12T02:00:00Z'),
    state: { incompleteRun: { ...RECORD } },
    config: { timeZone: 'America/Chicago' },
    probe: { ok: true, results: [], error: null },
    lock: { available: true, reason: null },
    jump: 0,
    ...overrides,
  };
  const catchUp = createAutoCatchUp({
    io: fs, hubDirectory,
    now: () => world.now,
    readState: async () => world.state,
    loadConfig: async () => world.config,
    schedule: async () => ({ hour: 20, minute: 0 }),
    nextScheduledRun,
    probe: async () => { calls.probe += 1; return world.probe; },
    notify: async text => { calls.notify.push(text); },
    newClock: () => ({ jumpMs: () => world.jump }),
    runManager: {
      availability: async () => world.lock,
      start: async options => { calls.start.push(options); world.lock = { available: false, reason: 'running' }; return {}; },
    },
  });
  // A finished run releases the lock; a successful one clears the record (the pipeline does that).
  const finishRun = ({ cleared }) => { world.lock = { available: true, reason: null }; if (cleared) world.state = { lastIncompleteRun: { ...RECORD, resolvedAt: world.now.toISOString() } }; };
  return { catchUp, calls, world, finishRun, hubDirectory };
}

test('a failed probe does not start a run', async () => {
  const { catchUp, calls, world } = await harness();
  world.probe = { ok: false, error: 'GitHub: fetch failed (ENOTFOUND: getaddrinfo ENOTFOUND api.github.com)' };
  const result = await catchUp.check();
  assert.equal(result.outcome, 'waiting');
  assert.match(result.reason, /Network still down: GitHub: fetch failed \(ENOTFOUND/);
  assert.equal(calls.probe, 1);
  assert.deepEqual(calls.start, []);
  assert.deepEqual(calls.notify, []);
});

test('a held run lock does not start a run', async () => {
  const { catchUp, calls, world } = await harness();
  world.lock = { available: false, reason: 'The pipeline is already running (PID 777); the lock file is held' };
  const result = await catchUp.check();
  assert.equal(result.outcome, 'waiting');
  assert.match(result.reason, /PID 777/);
  assert.deepEqual(calls.start, []);
});

test('a sleep since the last check (clock jump) waits for the next check without probing', async () => {
  const { catchUp, calls, world } = await harness();
  world.jump = CLOCK_JUMP_MS + 1000;
  const result = await catchUp.check();
  assert.equal(result.outcome, 'waiting');
  assert.match(result.reason, /asleep since the last check/);
  assert.equal(calls.probe, 0);
  assert.deepEqual(calls.start, []);
});

test('network back: starts the same run as Run Now (trigger auto_catchup), notifies, and stops at two a day', async () => {
  const { catchUp, calls, world, finishRun, hubDirectory } = await harness();
  const first = await catchUp.check();
  assert.equal(first.outcome, 'started');
  assert.deepEqual(calls.start, [{ trigger: 'auto_catchup' }]);
  assert.deepEqual(calls.notify, [CATCH_UP_NOTIFICATION]);
  assert.equal(CATCH_UP_NOTIFICATION, "Network back, catching up tonight's run");
  assert.equal((await catchUp.check()).outcome, 'waiting', 'the first catch-up still holds the lock');
  finishRun({ cleared: false });
  world.now = new Date('2026-10-12T02:10:00Z');
  assert.equal((await catchUp.check()).outcome, 'started');
  finishRun({ cleared: false });
  world.now = new Date('2026-10-12T02:20:00Z');
  const third = await catchUp.check();
  assert.equal(third.outcome, 'limit');
  assert.equal(calls.start.length, MAXIMUM_ATTEMPTS);
  const log = JSON.parse(await fs.readFile(path.join(hubDirectory, 'auto-catchup.json'), 'utf8'));
  assert.equal(log.attempts['2026-10-11'].length, 2, 'the cap survives a hub restart');
  // A new hub process reads the same log.
  const again = createAutoCatchUp({ io: fs, hubDirectory, now: () => world.now, readState: async () => world.state, loadConfig: async () => world.config, schedule: async () => ({ hour: 20, minute: 0 }), nextScheduledRun, probe: async () => ({ ok: true }), newClock: () => ({ jumpMs: () => 0 }), runManager: { availability: async () => ({ available: true }), start: async () => assert.fail('cap reached') } });
  assert.equal((await again.check()).outcome, 'limit');
});

test('after a catch-up that collected, the cleared record means nothing more runs', async () => {
  const { catchUp, calls, finishRun, world } = await harness();
  assert.equal((await catchUp.check()).outcome, 'started');
  finishRun({ cleared: true });
  world.now = new Date('2026-10-12T02:10:00Z');
  const next = await catchUp.check();
  assert.equal(next.outcome, 'idle');
  assert.equal(calls.start.length, 1);
  assert.equal(calls.probe, 1);
});

test('past the next nightly run the record is left to that run', async () => {
  const { catchUp, calls, world } = await harness();
  world.now = new Date('2026-10-13T01:00:00Z'); // Oct 12, 8:00 PM: the next nightly run's time
  const result = await catchUp.check();
  assert.equal(result.outcome, 'expired');
  assert.equal(result.deadline.toISOString(), '2026-10-13T01:00:00.000Z');
  world.now = new Date('2026-10-13T00:50:00Z');
  assert.equal((await catchUp.check()).outcome, 'started', 'ten minutes before it, still caught up');
  assert.equal(calls.start.length, 1);
});

test('with the switch off nothing is probed or run', async () => {
  const { catchUp, calls, world } = await harness();
  world.config = { timeZone: 'America/Chicago', autoCatchUp: { enabled: false } };
  const result = await catchUp.check();
  assert.equal(result.outcome, 'off');
  assert.equal(calls.probe, 0);
  assert.deepEqual(calls.start, []);
});

test('the timer runs every 10 minutes and the status reports the next check', async () => {
  const { catchUp, world } = await harness();
  assert.equal(CHECK_INTERVAL_MS, 10 * 60 * 1000);
  assert.equal((await catchUp.status(world.state)).nextCheckAt, null, 'not started');
  catchUp.start();
  try {
    const status = await catchUp.status(world.state);
    assert.equal(status.nextCheckAt, '2026-10-12T02:10:00.000Z');
    assert.equal(status.attempts, 0);
    assert.equal(status.maximumAttempts, 2);
    await catchUp.check();
    const after = await catchUp.status(world.state);
    assert.equal(after.attempts, 1);
    assert.equal(after.lastCheck.outcome, 'started');
  } finally {
    catchUp.stop();
  }
});

test('the probe needs both GitHub and Greenhouse to answer', async () => {
  assert.deepEqual(PROBE_URLS.map(item => item.name), ['GitHub', 'Greenhouse']);
  const ok = await probeNetwork({ fetchImpl: async () => new Response('{}', { status: 200 }) });
  assert.equal(ok.ok, true);
  const half = await probeNetwork({ fetchImpl: async url => (String(url).includes('github') ? new Response('{}', { status: 200 }) : Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }))) });
  assert.equal(half.ok, false);
  assert.match(half.error, /^Greenhouse: fetch failed \(ECONNRESET: read ECONNRESET\)$/);
  const status = await probeNetwork({ fetchImpl: async () => new Response('', { status: 503 }) });
  assert.match(status.error, /GitHub: HTTP 503; Greenhouse: HTTP 503/);
});
