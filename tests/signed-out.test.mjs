// A signed-out Claude (2026-10-29). On 10-28 and 10-29 `claude auth status` said loggedIn: false at the start of
// the run; the check's error did not read as an expired login, so 120 postings were scored locally, marked
// unreviewed, mixed into the matches, and queued for automatic letters. Now the run-start check and a session
// that expires mid-run are both auth_expired: Codex reviews when the fallback is on and signed in, otherwise
// the postings wait (never unreviewed); a posting no model reviewed is never a match; the hub watches the login;
// the first run after the login works reviews the held postings first. Every engine here is a fake.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applySubscriptionMatching } from '../src/subscription-match.mjs';
import { AUTH_EXPIRED_MESSAGE, AUTH_EXPIRED_NOTIFICATION, AuthExpiredError, classifyEngineError } from '../src/engines/engine-errors.mjs';
import { describeClaudeConnection, readClaudeAuthStatus, verifyClaudeSubscription } from '../src/engines/claude.mjs';
import { applyReviewBudget, main, requeueSignedOutPostings } from '../src/index.mjs';
import { deferredStatus, isJobSeen, markDeferred, markJobSeen, releaseAuthDeferrals } from '../src/state.mjs';
import { buildReportView } from '../src/report.mjs';
import { renderReportBody } from '../src/report-components.mjs';
import { splitReportJobs } from '../src/review-status.mjs';
import { AUTH_CHECK_INTERVAL_MS, createAuthWatch } from '../src/hub/auth-watch.mjs';
import { claudeAuthView } from '../src/hub/services.mjs';
import { syncReportsIndex } from '../src/reports-index.mjs';
import { identifyBoard, normalizeRegistry, repointGreenhouseEuBoards } from '../src/collectors/ats-boards.mjs';
import { fixtureJob, fixturePayload, prepareReportProject, startReportHub, writePayload } from './helpers/report-hub.mjs';

const fixtures = new URL('./fixtures/', import.meta.url);
const standIn = fileURLToPath(new URL('../scripts/chaos/fake-claude.sh', import.meta.url));
// What `claude auth status --json` printed on 2026-10-28 (exit 1), paths replaced.
const SIGNED_OUT_STATUS = { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty', analyticsDisabled: false, projectsDirectory: '/Users/jane/.claude/projects', configDirectory: '/Users/jane/.claude' };
const NOW = new Date('2026-10-28T01:00:00Z');

function failedExit(stdout, code = 1) {
  return Object.assign(new Error(`/Users/jane/.local/bin/claude exited ${code}: ${stdout}`), { stdout, stderr: '', exitCode: code });
}

function candidate(index, extra = {}) {
  return { url: `https://example.com/jobs/${index}`, title: `Data Analyst ${index}`, company: 'Example Corp', description: 'SQL and Python.', bestScore: 60 + index, scores: { data: 60 + index }, scoreDetails: { data: { roleRelevance: 25 } }, blockers: [], reasons: [], gaps: [], ...extra };
}

function fakeEngine(id, { verifyAuth = async () => ({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }), reviewBatch = null, calls = [] } = {}) {
  return {
    id, label: id, model: id === 'codex' ? 'gpt-5.6-sol' : 'claude-fable-5-1', verifyAuth,
    async reviewBatch(prompt) {
      calls.push(id);
      if (reviewBatch) return reviewBatch(prompt);
      const ids = [...prompt.matchAll(/"id": "([a-f0-9]{16})"/g)].map(match => match[1]);
      return { results: ids.map(item => ({ id: item, roleType: 'new_grad', scores: { data: 81 }, recommendedTrack: 'data', employerName: 'Example Corp', matchLevel: 'high', reasons: ['SQL'], gaps: [], blockers: [] })), scoringModel: id === 'codex' ? 'gpt-5.6-sol' : 'claude-fable-5-1' };
    },
    modelMatches: () => true,
    describeModel: () => ({ engine: id }),
  };
}

test('the run-start check: loggedIn false (exit 1 with the status printed), authMethod none, or a failing status command is an expired login; Console billing is not', async () => {
  const runner = stdout => async (command, args) => {
    if (args[0] === '--version') return { stdout: '2.1.300 (Claude Code)', stderr: '' };
    if (stdout instanceof Error) throw stdout;
    return { stdout, stderr: '' };
  };
  const resolveCommand = async () => ({ found: true, command: '/Users/jane/.local/bin/claude', source: 'config' });
  const signedOut = await verifyClaudeSubscription({ runner: runner(failedExit(JSON.stringify(SIGNED_OUT_STATUS, null, 2))), resolveCommand }).catch(error => error);
  assert.ok(signedOut instanceof AuthExpiredError);
  assert.equal(signedOut.notice, 'claude auth status: loggedIn=false, authMethod="none"');
  assert.equal(classifyEngineError(signedOut).kind, 'auth_expired');

  await assert.rejects(readClaudeAuthStatus('claude', runner(JSON.stringify({ loggedIn: true, authMethod: 'none' }))), error => error.code === 'SUBSCRIPTION_AUTH', 'authMethod none');
  await assert.rejects(readClaudeAuthStatus('claude', runner(new Error('claude timed out after 30000ms'))), error => error.code === 'SUBSCRIPTION_AUTH' && /claude auth status failed: claude timed out/.test(error.notice), 'the command failing without a status');
  await assert.rejects(readClaudeAuthStatus('claude', runner('not json')), error => error.code === 'SUBSCRIPTION_AUTH', 'unreadable output');
  await assert.rejects(readClaudeAuthStatus('claude', runner(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }))), error => error.code === 'ENOENT', 'a missing binary stays what it is');
  const console = await verifyClaudeSubscription({ runner: runner(JSON.stringify({ loggedIn: true, authMethod: 'console', apiProvider: 'firstParty' })), resolveCommand }).catch(error => error);
  assert.notEqual(console.code, 'SUBSCRIPTION_AUTH', 'a Console login is a configuration problem, not a sign-out');

  // The text the 10-28 warning carried classifies as an expired login on its own as well.
  assert.equal(classifyEngineError(failedExit(JSON.stringify(SIGNED_OUT_STATUS, null, 2))).kind, 'auth_expired');

  const connection = await describeClaudeConnection({ runner: runner(failedExit(JSON.stringify(SIGNED_OUT_STATUS))), resolveCommand });
  assert.equal(connection.connected, false);
  assert.equal(connection.signedOut, true);
  assert.equal(connection.hint, 'claude auth login --claudeai');
});

test('signed out at the run-start check: Codex reviews every posting when the fallback is on and signed in, else every posting waits; mid-run expiry hands the rest to Codex', async () => {
  const resumes = [{ id: 'data', label: 'Data', text: 'resume' }];
  const jobs = [1, 2, 3].map(index => candidate(index));
  const signedOut = async () => { throw new AuthExpiredError('claude auth status: loggedIn=false, authMethod="none"'); };

  const calls = [];
  const warnings = [];
  const quotaEvents = [];
  const takeover = await applySubscriptionMatching(jobs, resumes, {}, {
    engine: 'claude', model: 'fable', batchSize: 2, warnings, quotaEvents, now: () => NOW, sleep: async () => {}, retryDelayMs: 0,
    makeEngine: id => fakeEngine(id, { verifyAuth: id === 'claude' ? signedOut : undefined, calls }),
    fallbackConnected: async id => id === 'codex',
  });
  assert.deepEqual(takeover.map(job => [job.semanticReviewed, job.scoringEngine, job.matchLevel]), Array(3).fill([true, 'codex', 'high']), 'Codex reviewed every posting');
  assert.deepEqual(calls, ['codex', 'codex'], 'Claude was never asked to score');
  assert.deepEqual(quotaEvents.map(event => [event.kind, event.action, event.detail, event.notice]), [['auth_expired', 'fallback-engine', 'switched to codex', 'claude auth status: loggedIn=false, authMethod="none"']]);
  assert.deepEqual(warnings.map(warning => [warning.level, warning.message]), [['warning', `${AUTH_EXPIRED_MESSAGE} The codex engine reviewed the postings instead.`], ['info', 'scored by gpt-5.6-sol: Claude signed out']]);

  // Codex not signed in (or the fallback off): every candidate is held for the login, none is unreviewed.
  for (const options of [{ fallbackConnected: async () => false }, { quotaPolicy: { fallbackEngine: null }, fallbackConnected: async () => assert.fail('not asked when off') }]) {
    const events = [];
    const held = await applySubscriptionMatching(jobs, resumes, {}, { engine: 'claude', model: 'fable', warnings: [], quotaEvents: events, now: () => NOW, makeEngine: id => fakeEngine(id, { verifyAuth: signedOut }), ...options });
    assert.deepEqual(held.map(job => [job.quotaDeferred, job.authDeferred, job.matchLevel]), Array(3).fill([true, true, undefined]));
    assert.deepEqual(events.map(event => [event.kind, event.action]), [['auth_expired', 'deferred']]);
  }

  // The session expires after the first batch: Codex takes that batch and the rest.
  const midCalls = [];
  let claudeCalls = 0;
  const midEvents = [];
  const mid = await applySubscriptionMatching(jobs, resumes, {}, {
    engine: 'claude', model: 'fable', batchSize: 2, warnings: [], quotaEvents: midEvents, now: () => NOW, sleep: async () => {}, retryDelayMs: 0,
    makeEngine: id => fakeEngine(id, { calls: midCalls, reviewBatch: id === 'claude' ? prompt => { claudeCalls += 1; if (claudeCalls > 1) throw new AuthExpiredError('OAuth session expired and could not be refreshed'); return fakeEngine('claude').reviewBatch(prompt); } : null }),
    fallbackConnected: async id => id === 'codex',
  });
  assert.deepEqual(mid.map(job => job.scoringEngine), ['claude', 'claude', 'codex']);
  assert.deepEqual(midEvents.map(event => [event.kind, event.action]), [['auth_expired', 'fallback-engine']]);
});

async function signedOutProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'signed-out-'));
  await fs.mkdir(path.join(root, 'intake'), { recursive: true });
  for (const name of ['data-resume.md', 'ai-resume.md']) await fs.copyFile(new URL(name, fixtures), path.join(root, name));
  await fs.copyFile(new URL('demo-new-grad-alert.eml', fixtures), path.join(root, 'intake', 'demo-new-grad-alert.eml'));
  // Signed out the way the CLI really is: the version answers, `auth status --json` prints the status and exits 1.
  const signedOut = path.join(root, 'claude-signed-out.sh');
  await fs.writeFile(signedOut, `#!/bin/sh\ncase "$1" in\n  --version) echo "2.1.300 (Claude Code)"; exit 0 ;;\n  auth) echo '${JSON.stringify(SIGNED_OUT_STATUS)}'; exit 1 ;;\nesac\necho "unexpected call: $*" >> "${path.join(root, 'unexpected.log')}"\nexit 1\n`, { mode: 0o755 });
  const config = {
    lookbackHours: 24, timeZone: 'America/Chicago', minimumMatchScore: 20, requireFullDescription: true, minimumDescriptionCharacters: 200,
    // Never hand a test run to the real Codex CLI on this machine.
    semanticMatching: { engine: 'claude', claudeCommand: signedOut, batchSize: 6, acceptedMatchLevels: ['high'], timeoutMs: 30_000, quotaPolicy: { fallbackEngine: null } },
    prescreen: { enabled: false }, coverLetter: { autoGenerate: { enabled: false } }, reports: { xlsx: { enabled: false, required: false } },
    outputDirectory: './output',
    resumes: { tracks: [{ id: 'data', label: 'Data', profile: './data-resume.md' }, { id: 'ai', label: 'AI', profile: './ai-resume.md' }] },
    preferences: { roleTypes: ['internship', 'new_grad', 'entry_level'], locations: ['Remote'], remoteOkay: true, maxYearsExperience: 3, needsSponsorship: null, graduationDate: '2027-05', excludeTitleTerms: [] },
    sources: { githubLists: { enabled: false }, hackerNewsHiring: { enabled: false }, remoteOk: { enabled: false }, simplifyInternships: { enabled: false }, simplifyNewGrad: { enabled: false }, emailFiles: { enabled: true, directory: './intake' }, himalaya: { enabled: false }, careerOps: { enabled: false }, atsBoards: { enabled: false } },
    network: { fetchDescriptions: false, concurrency: 2, timeoutMs: 1000 },
  };
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  return { root, configPath, config };
}

test('end to end: a run that starts signed out holds every posting (no match, no unreviewed card), says "Claude signed out", notifies; the next run after login reviews them first', async () => {
  const { root, configPath, config } = await signedOutProject();
  const silence = [console.log, console.warn, console.error];
  const trigger = process.env.DAILY_JOB_MATCH_ALERT_TRIGGER;
  console.log = console.warn = console.error = () => {};
  const notices = [];
  try {
    delete process.env.DAILY_JOB_MATCH_ALERT_TRIGGER;
    const first = await main({ argv: ['node', 'index.mjs', '--config', configPath, '--now', '2026-08-27T12:00:00Z'], autoLetters: false, autoBackup: false, notify: async () => {}, notifier: async () => { notices.push(AUTH_EXPIRED_NOTIFICATION); return true; } });
    assert.equal(first.meta.matchCount, 0, 'nothing a model did not review is a match');
    assert.equal(first.meta.notReviewedCount, 0, 'and nothing was left unreviewed either: the postings wait');
    assert.ok(first.meta.authExpired.deferred >= 1);
    assert.equal(first.meta.authExpired.takenOverBy, null);
    assert.equal(first.meta.authExpired.notice, 'claude auth status: loggedIn=false, authMethod="none"');
    assert.deepEqual(notices, [AUTH_EXPIRED_NOTIFICATION]);
    assert.equal(AUTH_EXPIRED_NOTIFICATION, 'Claude is signed out. Run claude auth login --claudeai');
    const payload = JSON.parse(await fs.readFile(path.join(root, 'state', `report-payload-${first.meta.date}.json`), 'utf8'));
    assert.deepEqual(payload.matches, []);
    assert.ok(!payload.reviewed.some(job => job.matchLevel === 'unreviewed' || job.scoringEngine === 'local_fallback'));
    let state = JSON.parse(await fs.readFile(path.join(root, 'state', 'state.json'), 'utf8'));
    const held = Object.values(state.deferred);
    assert.equal(held.length, first.meta.authExpired.deferred);
    assert.ok(held.every(entry => entry.reason === 'auth'));
    const html = await fs.readFile(first.htmlPath, 'utf8');
    assert.match(html, /<div class="banner" data-banner="auth" style="[^"]+">Claude signed out\. \d+ posting\(s\) were deferred to the next run and are not lost\. Run `claude auth login --claudeai` in Terminal\.<\/div>/);
    assert.doesNotMatch(html, /<article class="job"/);
    assert.equal(await fs.stat(path.join(root, 'unexpected.log')).catch(() => null), null, 'no scoring call reached the signed-out CLI');

    // Signed in again the same evening: the held postings come back and are reviewed first.
    config.semanticMatching.claudeCommand = standIn;
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    process.env.DAILY_JOB_MATCH_ALERT_TRIGGER = 'manual';
    const second = await main({ argv: ['node', 'index.mjs', '--config', configPath, '--now', '2026-08-28T01:00:00Z'], autoLetters: false, autoBackup: false, notify: async () => {}, notifier: async () => assert.fail('signed in: no notification') });
    assert.equal(second.meta.authExpired, null);
    assert.ok(second.meta.matchCount >= 1, 'the held posting was reviewed and matched');
    assert.ok(second.debug.reviewBudget.kept.length >= 1 && second.debug.reviewBudget.kept.every(item => item.authHeld === true), 'reviewed as the held postings, first');
    state = JSON.parse(await fs.readFile(path.join(root, 'state', 'state.json'), 'utf8'));
    assert.deepEqual(state.deferred, {});
  } finally {
    [console.log, console.warn, console.error] = silence;
    if (trigger == null) delete process.env.DAILY_JOB_MATCH_ALERT_TRIGGER;
    else process.env.DAILY_JOB_MATCH_ALERT_TRIGGER = trigger;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('after the login works again, postings held for it go to the front of the review budget', () => {
  const now = new Date('2026-10-30T01:00:00Z');
  const state = { seen: {}, deferred: {} };
  const fresh = candidate(30, { postedAt: '2026-10-29T20:00:00Z', bestScore: 95 });
  const heldOld = candidate(1, { postedAt: '2026-10-28T15:00:00Z', bestScore: 40 });
  const budgetHeld = candidate(2, { postedAt: '2026-10-28T15:00:00Z', bestScore: 90 });
  markDeferred(state, heldOld, '2026-10-29T01:00:00Z', 'auth');
  markDeferred(state, budgetHeld, '2026-10-29T01:00:00Z', 'budget');
  const budget = applyReviewBudget([fresh, heldOld, budgetHeld], state, 1, now, { lookbackHours: 24, timeZone: 'America/Chicago' });
  assert.deepEqual(budget.jobs.map(job => job.url), [heldOld.url], 'the held posting beats tonight\'s higher-scored one');
  assert.equal(deferredStatus(state, heldOld).deferred, false, 'reviewed now, so it leaves the queue');
  assert.equal(deferredStatus(state, fresh).reason, 'budget');
  // A held posting the budget pushes back again keeps its reason while Claude is still signed out ...
  markDeferred(state, heldOld, '2026-10-30T01:00:00Z', 'auth');
  markDeferred(state, heldOld, '2026-10-30T02:00:00Z', 'budget');
  assert.equal(deferredStatus(state, heldOld).reason, 'auth');
  // ... and once a run with a working login is over, what it could not take returns to the usual order.
  assert.equal(releaseAuthDeferrals(state), 1);
  assert.equal(deferredStatus(state, heldOld).reason, 'budget');
});

test('the postings the 10-28 / 10-29 runs left unreviewed go back into the queue once, while still inside the window', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'requeue-'));
  try {
    await fs.mkdir(path.join(root, 'state'), { recursive: true });
    const config = { root, timeZone: 'America/Chicago' };
    const local = (index, postedAt) => ({ ...candidate(index), postedAt, matchLevel: 'unreviewed', semanticReviewed: false, scoringEngine: 'local_fallback' });
    const recent = local(1, '2026-10-28T15:00:00Z');
    const stale = local(2, '2026-10-20T15:00:00Z');
    const reviewed = { ...candidate(3), postedAt: '2026-10-28T15:00:00Z', matchLevel: 'high', semanticReviewed: true, scoringEngine: 'claude' };
    const warning = { stage: 'llm', source: 'claude', level: 'warning', message: `Subscription authentication check failed; 120 jobs used local fallback: /Users/jane/.local/bin/claude exited 1: ${JSON.stringify(SIGNED_OUT_STATUS, null, 2)}` };
    await fs.writeFile(path.join(root, 'state', 'report-payload-2026-10-29.json'), JSON.stringify({ meta: { date: '2026-10-29', warnings: [warning] }, matches: [recent], reviewed: [recent, stale, reviewed] }));
    // A day with an unrelated local fallback (the CLI crashed) is left alone.
    const crashed = local(4, '2026-10-28T15:00:00Z');
    await fs.writeFile(path.join(root, 'state', 'report-payload-2026-10-28.json'), JSON.stringify({ meta: { date: '2026-10-28', warnings: [{ stage: 'llm', source: 'claude', message: 'Batch 1 failed twice; 6 jobs used local fallback: boom' }] }, matches: [], reviewed: [crashed] }));
    const state = { seen: {} };
    for (const job of [recent, stale, reviewed, crashed]) markJobSeen(state, job, '2026-10-29T01:00:00Z');
    const now = new Date('2026-10-30T00:30:00Z');
    const requeued = await requeueSignedOutPostings(config, state, { now, maxAgeHours: 72, timeZone: 'America/Chicago' });
    assert.deepEqual(requeued, [recent.url]);
    assert.equal(isJobSeen(state, recent), false);
    assert.equal(deferredStatus(state, recent).reason, 'auth');
    assert.ok(isJobSeen(state, stale) && isJobSeen(state, reviewed) && isJobSeen(state, crashed));
    assert.deepEqual(state.authRequeue['2026-10-29'], { at: now.toISOString(), count: 1 });
    assert.deepEqual(await requeueSignedOutPostings(config, state, { now, maxAgeHours: 72 }), [], 'each day once');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the report: postings no model reviewed leave the matches for a folded "Not reviewed (engine unavailable)" group, with a header line', () => {
  const meta = { date: '2026-10-28', timeZone: 'America/Chicago', resumeTracks: [{ id: 'data', label: 'Data' }], warnings: [] };
  const reviewed = fixtureJob(1);
  const legacy = fixtureJob(2, { matchLevel: 'unreviewed', semanticReviewed: false, scoringEngine: 'local_fallback', url: 'https://jobs.example.com/legacy' });
  const notMatched = fixtureJob(3, { matchLevel: 'unreviewed', semanticReviewed: false, scoringEngine: 'local_fallback', url: 'https://jobs.example.com/other', bestScore: 41 });
  const excluded = fixtureJob(4, { matchLevel: 'unreviewed', scoringEngine: 'local_fallback', url: 'https://jobs.example.com/abroad', eligibility: { exclusion: 'location' } });
  const view = buildReportView([reviewed, legacy], meta, { reviewed: [reviewed, legacy, notMatched, excluded] });
  assert.equal(view.matchLabel, '1 match');
  assert.deepEqual(view.cards.map(card => card.url), [reviewed.url]);
  assert.deepEqual(view.notReviewed.cards.map(card => card.url), [legacy.url, notMatched.url], 'every unreviewed posting of the day the hard filters kept, best first');
  const html = renderReportBody(view);
  assert.match(html, /<div class="banner" data-banner="not-reviewed" style="background:var\(--bad-bg\);color:var\(--bad-ink\);font-weight:650">2 postings were not reviewed by a model: /);
  assert.match(html, /<details class="run" id="not-reviewed"><summary>Not reviewed \(engine unavailable\) <span class="group-count">\(2\)<\/span><\/summary>/);
  assert.doesNotMatch(html, /<details class="run" id="not-reviewed" open/, 'folded by default');
  const main = html.match(/<section class="jobs" id="jobs">([\s\S]*?)<\/section>/)[1];
  assert.equal((main.match(/<article class="job"/g) || []).length, 1);
  assert.doesNotMatch(html, /<section class="jobs[^"]*" id="jobs-not-reviewed"/, 'the group is no section.jobs, so the page script leaves it out of the count');
  assert.deepEqual(splitReportJobs({ matches: [reviewed], reviewed: [reviewed] }).notReviewed, []);
  // Nothing unreviewed: no banner, no group, the page reads as before.
  assert.doesNotMatch(renderReportBody(buildReportView([reviewed], meta, { reviewed: [reviewed] })), /not-reviewed/);
});

test('the hub shows an older day that mixed unreviewed postings into its matches the new way: reviewed count, folded group, no letters offered for them', async () => {
  const root = await prepareReportProject();
  const unreviewed = index => fixtureJob(index, { matchLevel: 'unreviewed', semanticReviewed: false, scoringEngine: 'local_fallback' });
  await writePayload(root, fixturePayload('2026-10-17', [fixtureJob(1), unreviewed(5), unreviewed(6)]));
  const hub = await startReportHub(root);
  try {
    const page = await hub.request('/reports/2026-10-17');
    assert.match(page.text, /<p class="sub">1 match · /);
    assert.match(page.text, /<span>Sat, Oct 17<\/span><span class="n">1 match<\/span>/, 'the date list too');
    assert.match(page.text, /<details class="run" id="not-reviewed"><summary>Not reviewed \(engine unavailable\) <span class="group-count">\(2\)<\/span>/);
    assert.match(page.text, /data-banner="not-reviewed"[^>]*>2 postings were not reviewed by a model/);
    // Example Corp 1 has its letter; the two unreviewed postings are not offered to Generate Missing Letters.
    assert.doesNotMatch(page.text, /id="missing-letters"/);
    const index = await syncReportsIndex(root);
    const entry = index.entries.find(item => item.date === '2026-10-17');
    assert.equal(entry.matchCount, 1, 'the list and the sidebar count reviewed matches only');
    assert.equal(entry.notReviewedCount, 2);
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the hub checks the login every 10 minutes: signed out marks Claude signed out and notifies at most once a day; signed in again clears it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-watch-'));
  try {
    const clock = { value: new Date('2026-10-28T14:00:00Z') };
    let claude = { installed: true, connected: false, signedOut: true, reason: 'Claude is signed out (claude auth status: loggedIn=false, authMethod="none")' };
    const notices = [];
    const authState = {
      claude: { expired: false, at: null, notice: null, clearedAt: null, source: null },
      expire(notice, source = 'hub') { this.claude = { expired: true, at: clock.value.toISOString(), notice, clearedAt: null, source }; },
      clear() { this.claude = { expired: false, at: null, notice: null, clearedAt: clock.value.toISOString(), source: null }; },
    };
    const watch = createAuthWatch({ io: fs, hubDirectory: root, now: () => clock.value, probe: async () => claude, authState, notify: async text => { notices.push(text); }, timeZone: () => 'America/Chicago' });
    assert.equal(AUTH_CHECK_INTERVAL_MS, 10 * 60 * 1000);
    assert.equal((await watch.check()).notified, true);
    assert.deepEqual(notices, ['Claude is signed out. Run claude auth login --claudeai']);
    assert.deepEqual(claudeAuthView({ authState }, null), { expired: true, at: '2026-10-28T14:00:00.000Z', notice: claude.reason, source: 'login check' });
    clock.value = new Date('2026-10-28T14:10:00Z');
    assert.equal((await watch.check()).notified, false, 'the same local day: no second notification');
    clock.value = new Date('2026-10-29T04:50:00Z'); // 11:50 PM in Chicago, still the 28th
    assert.equal((await watch.check()).notified, false);
    assert.equal(authState.claude.at, '2026-10-28T14:00:00.000Z', 'the first sighting keeps its time');
    clock.value = new Date('2026-10-29T05:10:00Z'); // 12:10 AM on the 29th
    assert.equal((await watch.check()).notified, true);
    assert.equal(notices.length, 2);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'auth-watch.json'), 'utf8')), { notifiedOn: '2026-10-29', at: '2026-10-29T05:10:00.000Z' });

    claude = { installed: true, connected: true, plan: 'max' };
    assert.equal((await watch.check()).outcome, 'signed-in');
    assert.equal(authState.claude.expired, false, 'signed in again: the watch clears what it set');
    // A failure a letter call reported is not the watch's to clear.
    authState.expire('Failed to authenticate', 'hub');
    await watch.check();
    assert.equal(authState.claude.expired, true);
    claude = { installed: false, connected: false };
    assert.equal((await watch.check()).outcome, 'skipped');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the hub Status page, sidebar, and Connections card say "Claude signed out" once the login check sees it', async () => {
  const root = await prepareReportProject();
  const notices = [];
  const hub = await startReportHub(root, { context: {
    describeConnections: async () => ({ claude: { installed: true, connected: false, signedOut: true, hint: 'claude auth login --claudeai', reason: 'Claude is signed out (claude auth status: loggedIn=false, authMethod="none")' }, codex: { installed: false, connected: false } }),
    notify: async text => { notices.push(text); },
  } });
  try {
    await hub.ctx.authWatch.check();
    assert.deepEqual(notices, ['Claude is signed out. Run claude auth login --claudeai']);
    const status = await hub.request('/status');
    assert.match(status.text, /<div class="flash error" data-banner="auth-expired">Claude signed out\. Run <code>claude auth login --claudeai<\/code> in Terminal, then Refresh\./);
    assert.match(status.text, /\(login check\)/);
    assert.match(status.text, /<b>Login<\/b><span class="bad" data-auth="expired">Claude signed out<\/span>/);
    const settings = await hub.request('/settings');
    assert.match(settings.text, /data-conn="expired">Signed out<\/span>/);
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Greenhouse EU boards use the global API host (boards-api.eu.greenhouse.io does not resolve); boards it left dormant wake up', () => {
  assert.equal(identifyBoard('https://job-boards.eu.greenhouse.io/examplecorp/jobs/123').apiUrl, 'https://boards-api.greenhouse.io/v1/boards/examplecorp/jobs?content=true');
  assert.equal(identifyBoard('https://job-boards.eu.greenhouse.io/examplecorp').boardUrl, 'https://job-boards.eu.greenhouse.io/examplecorp', 'the board page keeps its EU host');
  const registry = normalizeRegistry({ boards: {
    'greenhouse:dormanteu': { key: 'greenhouse:dormanteu', kind: 'greenhouse', apiUrl: 'https://boards-api.eu.greenhouse.io/v1/boards/dormanteu/jobs?content=true', consecutiveFailures: 7, dormant: true, dormantSince: '2026-09-25T01:00:00Z', lastError: 'fetch failed (ENOTFOUND: getaddrinfo ENOTFOUND boards-api.eu.greenhouse.io)', lastFailureAt: '2026-09-25T01:00:00Z', enabled: true },
    'greenhouse:failingeu': { key: 'greenhouse:failingeu', kind: 'greenhouse', apiUrl: 'https://boards-api.eu.greenhouse.io/v1/boards/failingeu/jobs?content=true', consecutiveFailures: 2, dormant: false, lastError: 'fetch failed (ENOTFOUND: getaddrinfo ENOTFOUND boards-api.eu.greenhouse.io)', enabled: true },
    'greenhouse:us': { key: 'greenhouse:us', kind: 'greenhouse', apiUrl: 'https://boards-api.greenhouse.io/v1/boards/us/jobs?content=true', consecutiveFailures: 1, lastError: 'HTTP 500', enabled: true },
  } });
  assert.deepEqual(repointGreenhouseEuBoards(registry), { repointed: ['greenhouse:dormanteu', 'greenhouse:failingeu'], woken: ['greenhouse:dormanteu'] });
  for (const key of ['greenhouse:dormanteu', 'greenhouse:failingeu']) {
    const board = registry.boards[key];
    assert.equal(board.apiUrl, `https://boards-api.greenhouse.io/v1/boards/${key.split(':')[1]}/jobs?content=true`);
    assert.deepEqual([board.dormant, board.consecutiveFailures, board.lastError], [false, 0, null]);
  }
  assert.deepEqual([registry.boards['greenhouse:us'].consecutiveFailures, registry.boards['greenhouse:us'].lastError], [1, 'HTTP 500'], 'other boards are untouched');
  assert.deepEqual(repointGreenhouseEuBoards(registry), { repointed: [], woken: [] }, 'idempotent');
});
