// Two changes of 2026-10-29. Catch-up: postings held while the engine was unavailable (deferral reason 'auth' or
// 'quota') are reviewed after the run's own postings, in a lane capped by semanticMatching.catchUpBudget (default
// 40) and only while their posting date is at most 48 hours old. Seen state: entries keep the URL key, the first
// sighting, and the retry/baseline fields only; the 90-day retention runs every run; the one-time migration
// makes a zip backup first and can be undone from it. Every engine is a fake.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CATCH_UP_MAX_AGE_HOURS, DEFAULT_CATCH_UP_BUDGET, applyReviewBudget, catchUpBudgetOf, main } from '../src/index.mjs';
import { SEEN_FORMAT, deferredStatus, expireDeferred, isJobSeen, jobSeenStatus, markDeferred, markJobSeen, pruneSeen, releaseRecentBaselines, slimSeenEntry, slimSeenState } from '../src/state.mjs';
import { prescreenStage } from '../src/prescreen.mjs';
import { runDetailsView } from '../src/report.mjs';
import { restoreBackup } from '../src/backup.mjs';
import { validateSettings } from '../src/hub/services.mjs';
import { canonicalUrl, sha256 } from '../src/utils.mjs';

const fixtures = new URL('./fixtures/', import.meta.url);
const standIn = fileURLToPath(new URL('../scripts/chaos/fake-claude.sh', import.meta.url));
const NOW = new Date('2026-10-30T01:00:00Z');
const hoursAgo = hours => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

function posting(id, extra = {}) {
  return { url: `https://jobs.example.com/${id}`, title: `Data Analyst ${id}`, company: 'Example Corp', location: 'Remote, US', roleType: 'new_grad', description: `Role ${id}. ${'Analyze data with SQL. '.repeat(20)}`, bestScore: 50, scoreDetails: { data: { roleRelevance: 25 } }, blockers: [], postedAt: hoursAgo(3), postedAtPrecision: 'datetime', ...extra };
}

// ------------------------------------------------------------------------------------------------- catch-up

test('catch-up postings are reviewed after the run\'s new postings, never in their place, up to the catch-up budget', () => {
  assert.equal(DEFAULT_CATCH_UP_BUDGET, 40);
  assert.equal(CATCH_UP_MAX_AGE_HOURS, 48);
  const state = { seen: {}, deferred: {} };
  const fresh = [1, 2, 3].map(index => posting(`new${index}`, { bestScore: 40 + index }));
  // Higher local scores than any new posting: they still come after.
  const held = [1, 2, 3, 4].map(index => posting(`held${index}`, { bestScore: 90 + index, postedAt: hoursAgo(30) }));
  held.forEach((job, index) => markDeferred(state, job, hoursAgo(24), index % 2 ? 'quota' : 'auth'));
  const budgetHeld = posting('budget1', { bestScore: 99, postedAt: hoursAgo(30) });
  markDeferred(state, budgetHeld, hoursAgo(24), 'budget');

  const budget = applyReviewBudget([...fresh, ...held, budgetHeld], state, 3, NOW, { lookbackHours: 24, timeZone: 'America/Chicago', catchUpLimit: 2 });
  assert.deepEqual(budget.jobs.map(job => job.url.split('/').pop()), ['new3', 'new2', 'new1', 'held4', 'held3'], 'the main budget takes the new postings (a budget deferral competes there as before), then the catch-up lane its best two');
  assert.equal(budget.newReviewedCount, 3);
  assert.deepEqual([budget.catchUp.candidates, budget.catchUp.reviewed, budget.catchUp.waiting, budget.catchUp.expired, budget.catchUp.limit], [4, 2, 2, 0, 2]);
  assert.deepEqual(budget.deferred.map(job => job.url.split('/').pop()), ['budget1'], 'the budget deferral stays in the main queue');
  assert.deepEqual(held.map(job => deferredStatus(state, job).reason), ['auth', 'quota', null, null], 'the two still waiting keep their reason; the two taken left the queue');

  // 0 is no limit; an unusable value falls back to the default.
  assert.equal(catchUpBudgetOf(0), 0);
  assert.equal(catchUpBudgetOf('25'), 25);
  assert.equal(catchUpBudgetOf(-3), 40);
  const unlimited = applyReviewBudget(held, { seen: {}, deferred: Object.fromEntries(held.map(job => [sha256(canonicalUrl(job.url)), { url: job.url, reason: 'auth', postedAt: job.postedAt }])) }, 1, NOW, { catchUpLimit: 0 });
  assert.equal(unlimited.catchUp.reviewed, 4, 'the main budget of one does not cap the catch-up lane');
});

test('a catch-up posting whose posting date is more than 48 hours old expires unreviewed and unseen, at startup and at the budget', () => {
  const state = { seen: {}, deferred: {} };
  const young = posting('young', { postedAt: hoursAgo(47) });
  const old = posting('old', { postedAt: hoursAgo(49) });
  const budgetOld = posting('budget-old', { postedAt: hoursAgo(49) });
  markDeferred(state, young, hoursAgo(20), 'auth');
  markDeferred(state, old, hoursAgo(20), 'quota');
  markDeferred(state, budgetOld, hoursAgo(20), 'budget');
  const budget = applyReviewBudget([young, old], state, 10, NOW, { timeZone: 'America/Chicago' });
  assert.deepEqual(budget.catchUp.jobs.map(job => job.url), [young.url]);
  assert.deepEqual(budget.catchUp.expiredJobs.map(job => job.url), [old.url]);
  assert.equal(deferredStatus(state, old).deferred, false);
  assert.equal(isJobSeen(state, old), false, 'expired, not seen: the lookback window drops it from now on');

  // The startup expiry: catch-up entries at 48 hours, the budget backlog at its own (longer) limit.
  markDeferred(state, old, hoursAgo(20), 'quota');
  const expired = expireDeferred(state, NOW, 72, { timeZone: 'America/Chicago', catchUpMaxAgeHours: 48 });
  assert.deepEqual(expired.urls, [canonicalUrl(old.url)]);
  assert.equal(deferredStatus(state, budgetOld).deferred, true, 'a budget deferral of 49 hours is still inside its 72');
});

test('with the prescreen on, catch-up postings are prescreened like the rest before the lane takes them', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'catch-up-prescreen-'));
  try {
    const state = { seen: {}, deferred: {}, prescreen: { shadowRunsDone: 3 } };
    const held = [posting('held-good', { postedAt: hoursAgo(30) }), posting('held-poor', { postedAt: hoursAgo(30) })];
    for (const job of held) markDeferred(state, job, hoursAgo(24), 'auth');
    const fresh = posting('fresh');
    const asked = [];
    const engine = {
      model: 'gpt-5.6-luna',
      async verifyAuth() {},
      async reviewBatch(prompt) {
        const { jobs } = JSON.parse(prompt.slice(prompt.lastIndexOf('Postings (JSON):') + 'Postings (JSON):'.length));
        asked.push(...jobs.map(item => item.title));
        return { results: jobs.map(item => ({ id: item.id, prescreenScore: /poor/.test(item.title) ? 20 : 80, bestTrack: 'data' })), scoringModel: 'gpt-5.6-luna', usage: { engine: 'codex', effort: 'low', models: [] } };
      },
    };
    const result = await prescreenStage([fresh, ...held], {
      config: { root, semanticMatching: { engine: 'claude' }, prescreen: { enabled: true, threshold: 55, shadowRuns: 3, enforce: true } },
      state, resumes: [{ id: 'data', label: 'Data', text: 'Skills: Python, SQL' }], tracks: [{ id: 'data', label: 'Data' }], date: '2026-10-29', now: NOW, warnings: [], makeEngine: () => engine,
    });
    assert.deepEqual(asked.sort(), ['Data Analyst fresh', 'Data Analyst held-good', 'Data Analyst held-poor'], 'the held postings went to the prescreen too');
    assert.deepEqual(result.dropped.map(job => job.url.split('/').pop()), ['held-poor']);
    assert.equal(isJobSeen(state, held[1]), true, 'below the threshold: marked seen like any other');
    const budget = applyReviewBudget(result.jobs, state, 5, NOW, { rankByPrescreen: true });
    assert.deepEqual(budget.jobs.map(job => job.url.split('/').pop()), ['fresh', 'held-good']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Run Details counts new and catch-up reviews apart; Settings → Pipeline saves the catch-up budget', () => {
  const meta = { date: '2026-10-30', timeZone: 'America/Chicago', resumeTracks: [{ id: 'data', label: 'Data' }], warnings: [], catchUp: { reviewedNew: 57, reviewedCatchUp: 40, candidates: 335, selected: 40, limit: 40, waiting: 180, expired: 115, maxAgeHours: 48 }, seen: { entries: 61000, pruned: 1200, retentionDays: 90 } };
  const rows = runDetailsView([], meta, [{ id: 'data', label: 'Data' }]).rows;
  assert.equal(rows.find(row => row.term === 'Reviewed').detail, '57 new posting(s) · 40 catch-up posting(s) · catch-up: 335 held, 40 taken after the new postings (catch-up budget 40), 180 waiting, 115 past 48 hours expired');
  assert.equal(rows.find(row => row.term === 'Seen state').detail, '61000 entries · 1200 past 90 days removed this run');
  const base = { minimumMatchScore: '70', acceptedMatchLevels: 'high', model: 'fable', hubPort: '4747' };
  assert.equal(validateSettings({ ...base, catchUpBudget: '25' }).catchUpBudget, 25);
  assert.equal(validateSettings(base).catchUpBudget, null, 'absent: config untouched');
  assert.throws(() => validateSettings({ ...base, catchUpBudget: '-1' }), /Catch-up budget/);
});

// --------------------------------------------------------------------------------------------- seen state

// An entry as the pipeline wrote it before format 2.
function legacyEntry(url, extra = {}) {
  return { url, originalUrl: url, finalUrl: url, firstSeen: '2026-10-20T01:00:00.000Z', lastAttempt: '2026-10-20T01:00:00.000Z', attempts: 1, completed: true, lastEnrichment: 'greenhouse_api', lastError: null, postedAt: '2026-10-19T15:00:00.000Z', ...extra };
}

test('slimmed seen entries keep every dedupe and retry verdict: both URLs seen, an open retry still open, a baseline still releasable', () => {
  const original = 'https://www.example.com/careers/analyst?utm_source=list';
  const final = 'https://boards.greenhouse.io/examplecorp/jobs/1';
  const job = { url: original, originalUrl: original, finalUrl: final };
  const retry = { url: 'https://jobs.example.com/retry' };
  const baseline = { url: 'https://jobs.example.com/baseline' };
  const state = { seen: {
    [sha256(canonicalUrl(original))]: legacyEntry(canonicalUrl(original), { finalUrl: final }),
    [sha256(canonicalUrl(final))]: legacyEntry(final, { originalUrl: canonicalUrl(original) }),
    [sha256(retry.url)]: legacyEntry(retry.url, { attempts: 2, completed: false, lastEnrichment: 'failed', lastError: 'timeout', lastAttempt: '2026-10-28T01:00:00.000Z' }),
    [sha256(baseline.url)]: legacyEntry(baseline.url, { lastEnrichment: 'ats_baseline', baseline: true, postedAt: '2026-10-29T12:00:00.000Z', firstSeen: '2026-10-29T13:00:00.000Z', lastAttempt: '2026-10-29T13:00:00.000Z' }),
  } };
  const verdicts = () => [isJobSeen(state, job), isJobSeen(state, { url: final }), isJobSeen(state, { url: original }), jobSeenStatus(state, retry), isJobSeen(state, baseline)];
  const before = verdicts();
  assert.equal(slimSeenState(state, NOW), 4, 'same keys');
  assert.equal(state.seenFormat, SEEN_FORMAT);
  assert.deepEqual(verdicts(), before);
  assert.deepEqual(state.seen[sha256(canonicalUrl(final))], { firstSeen: '2026-10-20T01:00:00.000Z' }, 'no URL, title, enrichment, or error fields left');
  assert.deepEqual(state.seen[sha256(retry.url)], { firstSeen: '2026-10-20T01:00:00.000Z', lastAttempt: '2026-10-28T01:00:00.000Z', attempts: 2, completed: false });
  assert.deepEqual(state.seen[sha256(baseline.url)], { firstSeen: '2026-10-29T13:00:00.000Z', baseline: true, postedAt: '2026-10-29T12:00:00.000Z' });
  // The retry goes on to its third attempt and closes, exactly as before.
  assert.deepEqual(markJobSeen(state, { ...retry, enrichment: 'failed' }, '2026-10-30T01:00:00.000Z'), { attempts: 3, completed: true });
  assert.equal(isJobSeen(state, retry), true);
  // A baseline from yesterday is still released for review.
  assert.equal(releaseRecentBaselines(state, NOW, 48), 1);
  assert.equal(isJobSeen(state, baseline), false);
  // New marks are written slim.
  markJobSeen(state, { url: 'https://jobs.example.com/new', enrichment: 'greenhouse_api', postedAt: hoursAgo(2) }, NOW.toISOString());
  assert.deepEqual(state.seen[sha256('https://jobs.example.com/new')], { firstSeen: NOW.toISOString() });
  assert.deepEqual(slimSeenEntry({ url: 'x' }, NOW), { firstSeen: NOW.toISOString() }, 'an entry with no readable time starts its 90 days now');
});

test('the 90-day retention removes entries whose last attempt (or first sighting) is older, on every run', () => {
  const state = { seen: {
    a: { firstSeen: '2026-07-30T00:00:00.000Z' },
    b: { firstSeen: '2026-07-30T00:00:00.000Z', lastAttempt: '2026-10-01T00:00:00.000Z', attempts: 2, completed: false },
    c: { firstSeen: '2026-08-02T00:00:00.000Z' },
  } };
  assert.equal(pruneSeen(state, NOW), 1);
  assert.deepEqual(Object.keys(state.seen), ['b', 'c'], 'a retry is kept 90 days after its last attempt');
});

async function legacyProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'seen-slim-'));
  await fs.mkdir(path.join(root, 'intake'), { recursive: true });
  await fs.mkdir(path.join(root, 'state'), { recursive: true });
  for (const name of ['data-resume.md', 'ai-resume.md']) await fs.copyFile(new URL(name, fixtures), path.join(root, name));
  const source = await fs.readFile(new URL('demo-new-grad-alert.eml', fixtures), 'utf8');
  await fs.writeFile(path.join(root, 'intake', 'demo-new-grad-alert.eml'), source);
  // A second alert whose posting the old state already marked seen.
  await fs.writeFile(path.join(root, 'intake', 'seen-alert.eml'), source
    .replace('Subject: New Grad Data Analyst - Example Analytics', 'Subject: New Grad BI Analyst - Example Analytics')
    .replace('https://www.example.com/careers/new-grad-data-analyst?utm_source=handshake', 'https://www.example.com/careers/new-grad-bi-analyst?utm_source=handshake'));
  const config = {
    lookbackHours: 24, timeZone: 'America/Chicago', minimumMatchScore: 20, requireFullDescription: true, minimumDescriptionCharacters: 200,
    semanticMatching: { engine: 'claude', claudeCommand: standIn, batchSize: 6, acceptedMatchLevels: ['high'], timeoutMs: 30_000, quotaPolicy: { fallbackEngine: null } },
    prescreen: { enabled: false }, coverLetter: { autoGenerate: { enabled: false } }, reports: { xlsx: { enabled: false, required: false } },
    outputDirectory: './output',
    resumes: { tracks: [{ id: 'data', label: 'Data', profile: './data-resume.md' }, { id: 'ai', label: 'AI', profile: './ai-resume.md' }] },
    preferences: { roleTypes: ['internship', 'new_grad', 'entry_level'], locations: ['Remote'], remoteOkay: true, maxYearsExperience: 3, needsSponsorship: null, graduationDate: '2027-05', excludeTitleTerms: [] },
    sources: { githubLists: { enabled: false }, hackerNewsHiring: { enabled: false }, remoteOk: { enabled: false }, simplifyInternships: { enabled: false }, simplifyNewGrad: { enabled: false }, emailFiles: { enabled: true, directory: './intake' }, himalaya: { enabled: false }, careerOps: { enabled: false }, atsBoards: { enabled: false } },
    network: { fetchDescriptions: false, concurrency: 2, timeoutMs: 1000 },
    backup: { directory: './backups' },
  };
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  const seenUrl = canonicalUrl('https://www.example.com/careers/new-grad-bi-analyst?utm_source=handshake');
  const seen = { [sha256(seenUrl)]: legacyEntry(seenUrl, { firstSeen: '2026-08-26T01:00:00.000Z', lastAttempt: '2026-08-26T01:00:00.000Z' }) };
  for (let index = 0; index < 50; index += 1) {
    const url = `https://jobs.example.com/legacy/${index}`;
    // Ten of them are past the 90 days.
    const at = index < 10 ? '2026-05-01T01:00:00.000Z' : '2026-08-20T01:00:00.000Z';
    seen[sha256(url)] = legacyEntry(url, { firstSeen: at, lastAttempt: at });
  }
  // As the old code wrote it: indented.
  await fs.writeFile(path.join(root, 'state', 'state.json'), `${JSON.stringify({ seen, lastSuccessfulRun: '2026-08-26T01:00:00.000Z' }, null, 2)}\n`);
  return { root, configPath, config, seenUrl };
}

test('end to end: the first run backs the state up, slims it, prunes past 90 days, dedupes as before, and the backup restores the old file', async () => {
  const { root, configPath, config, seenUrl } = await legacyProject();
  const statePath = path.join(root, 'state', 'state.json');
  const before = await fs.readFile(statePath);
  const silence = [console.log, console.warn, console.error];
  const trigger = process.env.DAILY_JOB_MATCH_ALERT_TRIGGER;
  console.log = console.warn = console.error = () => {};
  try {
    process.env.DAILY_JOB_MATCH_ALERT_TRIGGER = 'manual';
    const run = await main({ argv: ['node', 'index.mjs', '--config', configPath, '--now', '2026-08-27T12:00:00Z'], autoLetters: false, autoBackup: false, notify: async () => {} });
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert.equal(state.seenFormat, SEEN_FORMAT);
    const migration = state.seenMigration;
    assert.deepEqual([migration.entriesBefore, migration.pruned, migration.entriesAfter, migration.bytesBefore], [51, 10, 41, before.length]);
    assert.match(path.basename(migration.backup), /^daily-job-match-alert-backup-2026-08-27-\d{6}-pre-seen-slim\.zip$/);
    assert.equal(path.dirname(migration.backup), path.join(root, 'backups'));
    assert.ok(run.meta.warnings.some(warning => /^slimmed 51 seen entries/.test(warning.message)));
    // Dedupe is unchanged: the posting the old state had seen is not collected again; the other one is new.
    assert.equal(run.meta.newThisRun, 1);
    assert.ok(state.seen[sha256(seenUrl)], 'its key is still there');
    assert.ok(Object.values(state.seen).every(entry => !('url' in entry) && !('lastEnrichment' in entry) && !('lastError' in entry)));
    assert.deepEqual(run.meta.seen, { entries: Object.keys(state.seen).length, pruned: 0, retentionDays: 90 }, 'the run\'s own prune found nothing more');
    const after = await fs.stat(statePath);
    assert.ok(after.size < before.length / 2, `state.json shrank (${before.length} → ${after.size} bytes)`);
    assert.doesNotMatch(await fs.readFile(statePath, 'utf8'), /\n {2}/, 'written compact');

    // A second run does not migrate again.
    const second = await main({ argv: ['node', 'index.mjs', '--config', configPath, '--now', '2026-08-27T13:00:00Z'], autoLetters: false, autoBackup: false, notify: async () => {} });
    assert.ok(!second.meta.warnings.some(warning => /^slimmed/.test(warning.message) && warning.message !== run.meta.warnings.find(item => /^slimmed/.test(item.message)).message), 'no second migration');
    assert.equal((await fs.readdir(path.join(root, 'backups'))).filter(name => name.endsWith('-pre-seen-slim.zip')).length, 1);

    // Undo: restore the backup made before the migration; state.json is the old file again, byte for byte.
    await restoreBackup({ ...config, root }, migration.backup, { now: new Date('2026-08-27T14:00:00Z') });
    assert.deepEqual(await fs.readFile(statePath), before);
  } finally {
    [console.log, console.warn, console.error] = silence;
    if (trigger == null) delete process.env.DAILY_JOB_MATCH_ALERT_TRIGGER;
    else process.env.DAILY_JOB_MATCH_ALERT_TRIGGER = trigger;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('without a backup the migration waits: the old format stays for that run and a warning says why', async () => {
  const { root, configPath, config } = await legacyProject();
  const silence = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {};
  try {
    // A file where the backup directory should be: the zip cannot be written.
    await fs.writeFile(path.join(root, 'backups'), 'not a directory');
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    const run = await main({ argv: ['node', 'index.mjs', '--config', configPath, '--now', '2026-08-27T12:00:00Z'], autoLetters: false, autoBackup: false, notify: async () => {} });
    assert.ok(run.meta.warnings.some(warning => warning.level === 'warning' && /^kept the old seen format for now: the backup before slimming it failed/.test(warning.message)));
    const state = JSON.parse(await fs.readFile(path.join(root, 'state', 'state.json'), 'utf8'));
    assert.notEqual(state.seenFormat, SEEN_FORMAT);
    assert.ok(Object.values(state.seen).some(entry => entry.url), 'the old entries are untouched');
  } finally {
    [console.log, console.warn, console.error] = silence;
    await fs.rm(root, { recursive: true, force: true });
  }
});
