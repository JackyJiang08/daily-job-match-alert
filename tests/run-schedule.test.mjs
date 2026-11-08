// The 18:00 run (2026-11-08): everything that depends on the run time reads the installed LaunchAgent (Next
// Run, overdue, the auto catch-up deadline, the dormant-board probe time, the dispatcher's scheduled/catch-up
// split) and moves with it; the 18:00 default applies only without one. The report date is the run's local
// day, also when 18:00 Chicago is already the next day in UTC, and a second run that day merges into it.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { identifyBoard, normalizeRegistry, registerBoards } from '../src/collectors/ats-boards.mjs';
import { main } from '../src/index.mjs';
import { launchdTrigger } from '../src/launchd-dispatch.mjs';
import { DEFAULT_SCHEDULE, scheduleClock } from '../src/schedule.mjs';
import { createAutoCatchUp } from '../src/hub/auto-catchup.mjs';
import { installedSchedule, nextScheduledRun } from '../src/hub/services.mjs';
import { fixturePayload, prepareReportProject, selectedMatches, startReportHub, writePayload } from './helpers/report-hub.mjs';

const ZONE = 'America/Chicago';

async function installPlist(root, hour, minute) {
  const directory = path.join(root, 'Library', 'LaunchAgents');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'com.dailyjobmatchalert.daily.plist'), `<plist><dict><key>StartCalendarInterval</key><dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict></dict></plist>`);
}

test('the default schedule is 18:00, for the hub without a LaunchAgent and for the dispatcher without its variables', async () => {
  assert.deepEqual({ ...DEFAULT_SCHEDULE }, { hour: 18, minute: 0 });
  assert.equal(scheduleClock(DEFAULT_SCHEDULE), '18:00');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'run-schedule-'));
  try {
    assert.deepEqual(await installedSchedule({ homedir: root, io: fs }), { hour: 18, minute: 0, installed: false, path: path.join(root, 'Library', 'LaunchAgents', 'com.dailyjobmatchalert.daily.plist') });
    await installPlist(root, 7, 30);
    assert.equal((await installedSchedule({ homedir: root, io: fs })).hour, 7);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  // Local wall clock (launchd's): 18:05 after the 18:00 slot with no success since is the scheduled run;
  // 17:55 is a catch-up of yesterday's.
  const at = (hours, minutes) => new Date(2026, 10, 8, hours, minutes);
  assert.equal(launchdTrigger({ now: at(18, 5), lastSuccessfulRun: new Date(2026, 10, 7, 18, 3).toISOString() }), 'scheduled');
  assert.equal(launchdTrigger({ now: at(17, 55), lastSuccessfulRun: new Date(2026, 10, 7, 18, 3).toISOString() }), 'catchup');
  assert.equal(launchdTrigger({ now: at(18, 5), lastSuccessfulRun: at(18, 2).toISOString() }), 'catchup', 'already ran in this slot');
  assert.equal(launchdTrigger({ now: at(17, 55), hour: 7, minute: 30, lastSuccessfulRun: new Date(2026, 10, 7, 7, 31).toISOString() }), 'scheduled', 'the installed hour wins');
  assert.equal(nextScheduledRun(new Date('2026-11-08T20:00:00Z'), ZONE).toISOString(), '2026-11-09T00:00:00.000Z', 'Nov 8, 6:00 PM CST by default');
});

test('Next Run, overdue, and the dormant probe time follow the installed schedule', async () => {
  const root = await prepareReportProject();
  // A board dormant since Oct 1: due Oct 31 00:00Z, probed by the first run from 6 hours before that.
  const registry = normalizeRegistry(null);
  registerBoards(registry, [{ ...identifyBoard('https://jobs.lever.co/broken'), company: 'Broken Co' }], { now: new Date('2026-09-01T00:00:00Z') });
  Object.assign(registry.boards['lever:broken'], { dormant: true, dormantSince: '2026-10-01T00:00:00.000Z', consecutiveFailures: 7, lastError: 'HTTP 500' });
  await fs.writeFile(path.join(root, 'state', 'ats-boards.json'), JSON.stringify(registry));
  const hub = await startReportHub(root); // Oct 17, 10:00 AM CDT; the last run finished Oct 16, 8:00 PM
  try {
    const status = async () => (await hub.request('/status')).text;
    let page = await status();
    assert.match(page, /<dt>Next Run<\/dt><dd>Oct 17, 2026, 6:00 PM <span class="badge badge-warn" data-badge="not-installed">LaunchAgent Not Installed<\/span> <span class="muted">showing the 18:00 default<\/span><\/dd>/);
    assert.match(page, /data-next-probe="2026-10-30T23:00:00.000Z">Next probe Oct 30, 2026, 6:00 PM/);

    await installPlist(root, 18, 0);
    page = await status();
    assert.match(page, /<dt>Next Run<\/dt><dd>Oct 17, 2026, 6:00 PM<\/dd>/, 'yesterday\'s 18:00 slot was covered by the 8:00 PM run: not overdue');
    assert.match((await hub.request('/reports')).text, /<b>Next Run<\/b><span id="next-run" data-at="2026-10-17T23:00:00\.000Z"/);

    // Moved to 7:30: this morning's slot passed with no run since, so it is overdue; the probe moves too.
    await installPlist(root, 7, 30);
    page = await status();
    assert.match(page, /<dt>Next Run<\/dt><dd>Oct 18, 2026, 7:30 AM <span class="badge badge-bad" data-badge="overdue">Overdue<\/span><\/dd>/);
    assert.match((await hub.request('/reports')).text, /<b>Next Run<\/b><span id="next-run" data-at="2026-10-17T12:30:00\.000Z" data-overdue-suffix="">Oct 17, 7:30 AM · <span class="rel overdue">overdue<\/span>/);
    assert.match(page, /data-next-probe="2026-10-31T12:30:00.000Z">Next probe Oct 31, 2026, 7:30 AM/);
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the auto catch-up deadline is the next installed run after the outage', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'run-schedule-'));
  try {
    const record = { date: '2026-11-08', reason: 'network_outage', at: '2026-11-09T00:20:00.000Z', firstAt: '2026-11-09T00:20:00.000Z' }; // Nov 8, 6:20 PM
    const deadlineFor = async (now) => {
      const catchUp = createAutoCatchUp({
        io: fs, hubDirectory: path.join(root, 'hub'), now: () => new Date(now), readState: async () => ({ incompleteRun: record }), loadConfig: async () => ({ timeZone: ZONE, autoCatchUp: { enabled: true } }),
        schedule: () => installedSchedule({ homedir: root, io: fs }), nextScheduledRun, probe: async () => ({ ok: false, error: 'offline' }), newClock: () => ({ jumpMs: () => 0 }),
        runManager: { availability: async () => ({ available: true }), start: async () => assert.fail('the network is down') },
      });
      return catchUp.check();
    };
    let result = await deadlineFor('2026-11-09T12:00:00Z');
    assert.equal(result.deadline.toISOString(), '2026-11-10T00:00:00.000Z', 'Nov 9, 6:00 PM by default');
    assert.equal(result.outcome, 'waiting');
    assert.equal((await deadlineFor('2026-11-10T00:30:00Z')).outcome, 'expired', 'the next 18:00 run takes over');
    await installPlist(root, 21, 15);
    result = await deadlineFor('2026-11-09T12:00:00Z');
    assert.equal(result.deadline.toISOString(), '2026-11-09T03:15:00.000Z', 'with 21:15 installed the same evening\'s run takes over');
    assert.equal(result.outcome, 'expired');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------ end to end

const DESCRIPTION = 'Entry-level role for recent graduates (0-2 years). Build SQL and Python analyses, dashboards in Tableau, and statistics for product teams. Must be authorized to work in the United States. '.repeat(3);
function greenhouseJob(id, title, updatedAt) {
  return { id, absolute_url: `https://job-boards.greenhouse.io/examplecorp/jobs/${id}`, title, company_name: 'Example Corp', location: { name: 'Remote - United States' }, updated_at: updatedAt, first_published: updatedAt, content: DESCRIPTION };
}
const jsonResponse = payload => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });

async function prepareProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'run-schedule-e2e-'));
  await fs.copyFile(new URL('./fixtures/data-resume.md', import.meta.url), path.join(root, 'data-resume.md'));
  const config = {
    lookbackHours: 24, timeZone: ZONE, minimumMatchScore: 0,
    semanticMatching: { engine: 'local_only', acceptedMatchLevels: ['high', 'medium', 'low'] },
    prescreen: { enabled: false }, coverLetter: { autoGenerate: { enabled: false } }, reports: { xlsx: { enabled: false, required: false } },
    outputDirectory: './output',
    resumes: { tracks: [{ id: 'data', label: 'Data', profile: './data-resume.md' }] },
    preferences: { roleTypes: ['internship', 'new_grad', 'entry_level'], locations: ['Remote'], remoteOkay: true, maxYearsExperience: 3, graduationDate: '2027-05', excludeTitleTerms: [], titleFamilies: ['data analyst', 'data scientist', 'data engineer'] },
    sources: {
      githubLists: { enabled: false }, hackerNewsHiring: { enabled: false }, remoteOk: { enabled: false }, simplifyInternships: { enabled: false }, simplifyNewGrad: { enabled: false },
      emailFiles: { enabled: false }, himalaya: { enabled: false }, careerOps: { enabled: false }, searchDiscovery: { enabled: false },
      // A Run Now a few hours after the scheduled run polls the board again.
      atsBoards: { enabled: true, minimumPollIntervalHours: 0, boards: [{ key: 'greenhouse:examplecorp', company: 'Example Corp' }] },
    },
    network: { fetchDescriptions: false, concurrency: 2, timeoutMs: 1000 },
  };
  await fs.mkdir(path.join(root, 'state'), { recursive: true });
  const registry = normalizeRegistry(null);
  registerBoards(registry, [{ ...identifyBoard('https://job-boards.greenhouse.io/examplecorp'), company: 'Example Corp' }], { now: new Date('2026-09-01T00:00:00Z') });
  Object.assign(registry.boards['greenhouse:examplecorp'], { baselinedAt: '2026-09-01T00:00:00Z', lastNewAt: '2026-11-01T00:00:00Z' });
  await fs.writeFile(path.join(root, 'state', 'ats-boards.json'), JSON.stringify(registry));
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  return { root, configPath };
}

test('end to end: the 18:00 run (00:00 UTC the next day) and a later Run Now write the run\'s own day; the second merges and only adds; an older next-day folder of that date is merged, not duplicated', async () => {
  const { root, configPath } = await prepareProject();
  const silence = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {};
  try {
    // Last night's run under the old rule (Nov 7, 8:00 PM) wrote the Nov 8 folder.
    const legacy = fixturePayload('2026-11-08', [], { runDate: '2026-11-07', generatedAt: '2026-11-08T02:00:00.000Z', lastUpdatedAt: '2026-11-08T02:00:00.000Z', completedAt: '2026-11-08T02:00:00.000Z', runsToday: 1 });
    legacy.reviewed = [{ ...selectedMatches()[0], url: 'https://jobs.example.com/legacy', title: 'Legacy Analyst' }];
    await writePayload(root, legacy);

    const first = [greenhouseJob(1, 'Data Analyst, New Grad', '2026-11-08T21:00:00Z')];
    await main({ argv: ['node', 'index.mjs', '--config', configPath, '--now', '2026-11-08T18:00:00-06:00'], atsFetchImpl: async () => jsonResponse({ jobs: first }), autoLetters: false });
    const read = async date => JSON.parse(await fs.readFile(path.join(root, 'state', `report-payload-${date}.json`), 'utf8'));
    let payload = await read('2026-11-08');
    assert.deepEqual([payload.meta.date, payload.meta.applicationDate, payload.meta.runDate], ['2026-11-08', '2026-11-08', '2026-11-08']);
    assert.equal(payload.meta.runsToday, 2, 'merged into the existing Nov 8 payload');
    assert.deepEqual(payload.reviewed.map(job => job.title).sort(), ['Data Analyst, New Grad', 'Legacy Analyst']);
    await assert.rejects(fs.access(path.join(root, 'state', 'report-payload-2026-11-09.json')), 'no next-day payload');
    const html = await fs.readFile(path.join(root, 'output', '2026-11-08', 'Daily Job Match Alert - 2026-11-08.html'), 'utf8');
    assert.match(html, /<header class="masthead"><h1>November 8, 2026<\/h1><p class="sub">\d+ Match(?:es)? · Ran 6:0\d PM<\/p><\/header>/);

    // Run Now later that evening (21:30, 03:30 UTC Nov 9): the same day, merged; nothing is lost.
    const second = [...first, greenhouseJob(2, 'Junior Data Scientist', '2026-11-09T03:00:00Z')];
    await main({ argv: ['node', 'index.mjs', '--config', configPath, '--now', '2026-11-08T21:30:00-06:00'], atsFetchImpl: async () => jsonResponse({ jobs: second }), autoLetters: false });
    payload = await read('2026-11-08');
    assert.equal(payload.meta.runsToday, 3);
    assert.deepEqual(payload.reviewed.map(job => job.title).sort(), ['Data Analyst, New Grad', 'Junior Data Scientist', 'Legacy Analyst']);
    assert.deepEqual((await fs.readdir(path.join(root, 'output'))).filter(name => /^\d{4}-/.test(name)), ['2026-11-08']);
    assert.match(await fs.readFile(path.join(root, 'output', '2026-11-08', 'Daily Job Match Alert - 2026-11-08.html'), 'utf8'), /Ran 9:3\d PM/);

    // The hub's index and date list hold Nov 8 once, and no Nov 9.
    const index = JSON.parse(await fs.readFile(path.join(root, 'state', 'reports-index.json'), 'utf8'));
    assert.deepEqual(Object.keys(index.dates), ['2026-11-08']);
    assert.equal(index.dates['2026-11-08'].reviewedCount, 3);
  } finally {
    [console.log, console.warn, console.error] = silence;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the hub lists old next-day folders and new same-day folders side by side, each date once, today tagged by the local day', async () => {
  const root = await prepareReportProject(); // Oct 15–17 written by evening runs the day before (the old rule)
  // The first 18:00 run under the new rule (Oct 17, 6:00 PM) merged into the existing Oct 17 folder; Oct 18
  // comes from the next evening.
  await writePayload(root, fixturePayload('2026-10-17', selectedMatches(), { runDate: '2026-10-17', completedAt: '2026-10-17T23:02:00.000Z', lastUpdatedAt: '2026-10-17T23:02:00.000Z', runsToday: 2 }));
  await writePayload(root, fixturePayload('2026-10-18', selectedMatches().slice(0, 1), { runDate: '2026-10-18', generatedAt: '2026-10-18T23:00:00.000Z', completedAt: '2026-10-18T23:02:00.000Z', lastUpdatedAt: '2026-10-18T23:02:00.000Z' }));
  const hub = await startReportHub(root, { now: '2026-10-19T02:00:00Z' }); // Oct 18, 9:00 PM CDT
  try {
    const list = (await hub.request('/reports')).text;
    const dates = [...list.matchAll(/<a href="\/reports\/(\d{4}-\d{2}-\d{2})"[^>]*title=/g)].map(match => match[1]);
    assert.deepEqual(dates, ['2026-10-18', '2026-10-17', '2026-10-16', '2026-10-15'], 'newest first, no duplicate, no gap');
    assert.match(list, /<a href="\/reports\/2026-10-18" class="[^"]*" title="2026-10-18 \(today\)">[\s\S]*?data-tag="today"/);
    assert.doesNotMatch(list, /data-tag="tomorrow"/);
    const day = (await hub.request('/reports/2026-10-18')).text;
    assert.match(day, /<h1>October 18, 2026<\/h1><p class="sub">1 Match · Ran 6:02 PM<\/p>/);
    const old = (await hub.request('/reports/2026-10-16')).text;
    assert.match(old, /<p class="sub">No Matches · Ran Oct 15, 8:00 PM<\/p>/, 'an old next-day folder keeps the run\'s date');
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
