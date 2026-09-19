// Subscription quota handling: classification of the CLI's refusal texts (recorded fixture), the
// five-hour wait with an injected clock, the model ladder with its audit line and next-run recovery,
// account-wide deferral, the Codex fallback switch, and the report banner. No CLI, no network.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { QuotaError, classifyQuotaError, describeQuota, nextLadderModel, normalizeQuotaPolicy, parseResetTime } from '../src/engines/quota.mjs';
import { applySubscriptionMatching } from '../src/subscription-match.mjs';
import { summarizeQuota } from '../src/index.mjs';
import { buildReportView } from '../src/report.mjs';
import { renderReportBody } from '../src/report-components.mjs';

const RESUMES = [{ id: 'data', label: 'Data', text: 'resume' }];
function candidate(index) {
  return { url: `https://example.com/jobs/${index}`, title: `Analyst ${index}`, company: 'Acme', description: 'x', bestScore: 50, scores: { data: 50 }, scoreDetails: { data: { roleRelevance: 25 } }, blockers: [], reasons: [], gaps: [] };
}
function okResponse(batch, model = 'claude-fable-5') {
  return { results: batch.map(job => ({ id: job.semanticId, roleType: 'new_grad', scores: { data: 80 }, recommendedTrack: 'data', matchLevel: 'high', reasons: ['fit'], gaps: [], blockers: [] })), scoringModel: model };
}
function fakeEngine(id, model, behaviour) {
  const calls = [];
  return {
    calls,
    engine: {
      id, label: `${id} engine`, model,
      async verifyAuth() {},
      async reviewBatch(prompt, schema) { const batch = JSON.parse(prompt).batch; calls.push({ model, ids: batch.map(job => job.semanticId) }); return behaviour(batch, model, calls.length); },
      modelMatches(actual) { return String(actual).includes(model); },
      describeModel() { return { engine: id, model }; },
    },
  };
}
// The orchestrator builds its own prompt; the fake engines parse the batch back out of the prompt text.
function withBatchPrompt(engineFactory) {
  return engineFactory;
}

test('refusal texts classify into the three limit classes from the recorded fixture, transient notices are not quotas', async () => {
  const { cases, testClock } = JSON.parse(await fs.readFile(new URL('./fixtures/quota-errors.json', import.meta.url), 'utf8'));
  const now = new Date(testClock);
  for (const item of cases) {
    const verdict = classifyQuotaError(new Error(item.text), { now });
    assert.equal(verdict?.kind ?? null, item.kind, item.text);
    if (item.model) assert.equal(verdict.model, item.model, item.text);
    if (item.resetsAt) assert.equal(verdict.resetsAt, item.resetsAt, item.text);
  }
  assert.equal(classifyQuotaError(null), null);
  assert.equal(parseResetTime('resets in 45 minutes', now), '2026-09-19T10:45:00.000Z');
  assert.equal(parseResetTime('nothing here', now), null);
  const custom = normalizeQuotaPolicy({ patterns: { accountWeeklyLimit: ['tenant budget exhausted'] }, modelLadder: 'fable, opus, sonnet', fallbackEngine: 'codex', fiveHourLimit: { retryIntervalMs: 1000, maxWaitMs: 5000 } });
  assert.equal(classifyQuotaError(new Error('tenant budget exhausted'), { policy: custom }).kind, 'accountWeeklyLimit');
  assert.deepEqual(custom.modelLadder, ['fable', 'opus', 'sonnet']);
  assert.equal(custom.fallbackEngine, 'codex');
  assert.deepEqual(custom.fiveHourLimit, { retryIntervalMs: 1000, maxWaitMs: 5000 });
  assert.equal(nextLadderModel(custom, 'opus'), 'sonnet');
  assert.equal(nextLadderModel(custom, 'sonnet'), null);
  assert.equal(nextLadderModel(custom, 'haiku'), null, 'a model off the ladder has no next step');
  assert.equal(describeQuota({ kind: 'modelWeeklyLimit', model: 'fable', resetsAt: '2026-09-22T14:00:00Z' }, { timeZone: 'America/Chicago' }), 'Claude subscription Fable weekly limit reached; expected to reset Sep 22, 2026, 9:00 AM');
  assert.equal(describeQuota({ kind: 'accountWeeklyLimit' }), 'Claude subscription weekly account limit reached');
  assert.equal(new QuotaError({ kind: 'fiveHourLimit' }).code, 'SUBSCRIPTION_QUOTA');
});

// Runs the orchestrator with a scripted engine: `script(batchIndex, model)` returns a response or throws.
async function runWithScript({ jobs, script, policy = {}, clockStart = '2026-09-19T01:00:00Z', fallbackConnected = null, makeEngineSpy = [] }) {
  const clock = { now: new Date(clockStart).getTime() };
  const sleeps = [];
  const warnings = [];
  const quotaEvents = [];
  const makeEngine = (id, model) => {
    makeEngineSpy.push({ id, model });
    return {
      id, label: `${id} engine`, model,
      async verifyAuth() {},
      async reviewBatch(prompt) {
        const ids = [...prompt.matchAll(/"id": "([a-f0-9]{16})"/g)].map(match => match[1]);
        const batch = ids.map(id => ({ semanticId: id }));
        return script({ batch, model, id, clock });
      },
      modelMatches(actual) { return String(actual).includes(model); },
      describeModel() { return { engine: id, model }; },
    };
  };
  const evaluated = await applySubscriptionMatching(jobs, RESUMES, {}, {
    engine: 'claude', model: 'fable', models: { claude: 'fable', codex: 'gpt-5.6-sol' }, batchSize: 2, warnings, quotaEvents, quotaPolicy: policy,
    makeEngine, now: () => new Date(clock.now), sleep: async ms => { sleeps.push(ms); clock.now += ms; }, retryDelayMs: 0,
    fallbackConnected: fallbackConnected || (async () => false),
  });
  return { evaluated, warnings, quotaEvents, sleeps, clock };
}

test('a five-hour limit is waited out every 10 minutes and the batch resumes once the CLI answers again', async () => {
  const jobs = [candidate(1), candidate(2), candidate(3)];
  let refusals = 0;
  const run = await runWithScript({ jobs, script: ({ batch, clock }) => {
    if (clock.now < new Date('2026-09-19T01:25:00Z').getTime()) { refusals += 1; throw new Error(`claude exited 1: Usage limit reached|${Math.floor(new Date('2026-09-19T01:25:00Z').getTime() / 1000)}`); }
    return okResponse(batch);
  } });
  assert.equal(refusals, 3, 'the first call, then two ten-minute retries, were refused');
  assert.deepEqual(run.sleeps, [600000, 600000, 600000], 'ten-minute intervals');
  assert.equal(run.evaluated.filter(job => job.semanticReviewed).length, 3, 'every posting was scored once the limit cleared');
  assert.equal(run.evaluated.some(job => job.quotaDeferred), false);
  assert.equal(run.quotaEvents.length, 1);
  assert.deepEqual([run.quotaEvents[0].kind, run.quotaEvents[0].action, run.quotaEvents[0].detail], ['fiveHourLimit', 'waited', 'retried 3 time(s) at 10-minute intervals']);
  assert.ok(!run.warnings.some(warning => /MODEL MISMATCH|local fallback/.test(warning.message)));
});

test('after 90 minutes of waiting the unreviewed postings are deferred, never marked unreviewed', async () => {
  const jobs = [candidate(1), candidate(2), candidate(3), candidate(4)];
  let calls = 0;
  const run = await runWithScript({ jobs, script: () => { calls += 1; throw new Error('claude exited 1: five_hour limit reached, resets in 4 hours'); } });
  assert.equal(run.sleeps.length, 9, 'nine ten-minute waits fit in 90 minutes');
  assert.equal(calls, 10, 'the first call plus nine retries');
  assert.deepEqual(run.evaluated.map(job => job.quotaDeferred), [true, true, true, true]);
  assert.equal(run.evaluated.some(job => job.matchLevel === 'unreviewed' || job.scoringEngine === 'local_fallback'), false);
  assert.equal(run.quotaEvents[0].action, 'deferred');
  assert.match(run.warnings.find(warning => /deferred/.test(warning.message)).message, /five-hour usage limit reached; expected to reset .*; 4 postings were deferred to the next run \(waited 90 minutes without the limit clearing\)/);
  assert.equal(run.warnings.find(warning => /deferred/.test(warning.message)).level, 'info');
});

test('a model weekly limit steps down the ladder, audits the switch as an info line instead of a mismatch, and the next run starts on the preferred model again', async () => {
  const jobs = [candidate(1), candidate(2), candidate(3)];
  const spy = [];
  const run = await runWithScript({ jobs, makeEngineSpy: spy, script: ({ batch, model }) => {
    if (model === 'fable') throw new Error("claude exited 1: You've reached your Fable limit. Your Fable limit resets at 9am (America/Chicago).");
    return okResponse(batch, 'claude-opus-5');
  } });
  assert.deepEqual(spy.map(item => item.model), ['fable', 'opus'], 'one downgrade for the whole run');
  assert.equal(run.evaluated.filter(job => job.semanticReviewed).length, 3);
  assert.deepEqual([...new Set(run.evaluated.map(job => job.scoringModel))], ['claude-opus-5']);
  assert.equal(run.warnings.some(warning => /MODEL MISMATCH/.test(warning.message)), false, 'a strategic downgrade is not a mismatch');
  const audit = run.warnings.find(warning => /scored by opus/.test(warning.message));
  assert.equal(audit.level, 'info');
  assert.equal(audit.message, 'scored by opus: fable weekly limit');
  assert.deepEqual([run.quotaEvents[0].kind, run.quotaEvents[0].action, run.quotaEvents[0].detail, run.quotaEvents[0].model], ['modelWeeklyLimit', 'downgraded', 'switched to opus', 'fable']);

  const nextSpy = [];
  const next = await runWithScript({ jobs, makeEngineSpy: nextSpy, script: ({ batch }) => okResponse(batch) });
  assert.deepEqual(nextSpy.map(item => item.model), ['fable'], 'nothing is persisted: the next run tries the preferred model first');
  assert.equal(next.quotaEvents.length, 0);
  assert.deepEqual([...new Set(next.evaluated.map(job => job.scoringModel))], ['claude-fable-5']);

  const bottom = await runWithScript({ jobs, policy: { modelLadder: ['fable'] }, script: () => { throw new Error('claude exited 1: Fable limit reached'); } });
  assert.deepEqual(bottom.evaluated.map(job => job.quotaDeferred), [true, true, true], 'no model left: deferred');
  assert.equal(bottom.quotaEvents[0].detail, 'no model left on the ladder');
});

test('an account weekly limit defers every remaining posting, or hands the run to Codex when the fallback is on and Codex is signed in', async () => {
  const jobs = [candidate(1), candidate(2), candidate(3), candidate(4)];
  const deferredRun = await runWithScript({ jobs, script: ({ batch, id, clock }) => {
    if (clock.calls == null) clock.calls = 0;
    clock.calls += 1;
    if (clock.calls === 1) return okResponse(batch);
    throw new Error('claude exited 1: you have reached your weekly usage limit|1790200000');
  } });
  assert.deepEqual(deferredRun.evaluated.map(job => Boolean(job.quotaDeferred)), [false, false, true, true], 'the batch scored before the refusal is kept; the rest wait');
  assert.equal(deferredRun.evaluated[0].semanticReviewed, true);
  assert.deepEqual([deferredRun.quotaEvents[0].kind, deferredRun.quotaEvents[0].action, deferredRun.quotaEvents[0].detail], ['accountWeeklyLimit', 'deferred', 'no fallback engine configured']);

  const offButNotConnected = await runWithScript({ jobs, policy: { fallbackEngine: 'codex' }, fallbackConnected: async () => false, script: () => { throw new Error('claude exited 1: you have reached your weekly usage limit'); } });
  assert.equal(offButNotConnected.evaluated.every(job => job.quotaDeferred), true);
  assert.equal(offButNotConnected.quotaEvents[0].detail, 'codex fallback is not connected');

  const spy = [];
  const codexRun = await runWithScript({ jobs, makeEngineSpy: spy, policy: { fallbackEngine: 'codex' }, fallbackConnected: async engine => engine === 'codex', script: ({ batch, id }) => {
    if (id === 'claude') throw new Error('claude exited 1: you have reached your weekly usage limit');
    return okResponse(batch, 'gpt-5.6-sol');
  } });
  assert.deepEqual(spy.map(item => [item.id, item.model]), [['claude', 'fable'], ['codex', 'gpt-5.6-sol']]);
  assert.equal(codexRun.evaluated.every(job => job.semanticReviewed && job.scoringEngine === 'codex' && job.scoringModel === 'gpt-5.6-sol'), true);
  assert.equal(codexRun.evaluated.some(job => job.quotaDeferred), false);
  assert.deepEqual([codexRun.quotaEvents[0].action, codexRun.quotaEvents[0].detail], ['fallback-engine', 'switched to codex']);
  assert.equal(codexRun.warnings.some(warning => /MODEL MISMATCH/.test(warning.message)), false);
  assert.match(codexRun.warnings.find(warning => /continuing with the codex engine/.test(warning.message)).message, /weekly account limit reached; continuing with the codex engine/);
});

test('the run summary and the report banner describe an account-wide refusal and the deferral count; a successful wait gets no banner', () => {
  const config = { timeZone: 'America/Chicago', semanticMatching: { engine: 'claude', models: { claude: 'fable' }, quotaPolicy: { fallbackEngine: 'codex' } } };
  const policy = normalizeQuotaPolicy(config.semanticMatching.quotaPolicy);
  const halted = summarizeQuota([{ kind: 'accountWeeklyLimit', model: null, resetsAt: '2026-09-22T14:00:00Z', at: '2026-09-19T01:05:00Z', action: 'deferred', detail: 'codex fallback is not connected', engine: 'claude' }], policy, config, 37);
  assert.equal(halted.banner, 'Claude subscription weekly account limit reached; expected to reset Sep 22, 2026, 9:00 AM; 37 posting(s) were deferred to the next run and are not lost');
  assert.deepEqual([halted.effectiveEngine, halted.effectiveModel, halted.deferredByQuota], ['claude', 'fable', 37]);
  const downgraded = summarizeQuota([{ kind: 'modelWeeklyLimit', model: 'fable', at: '2026-09-19T01:05:00Z', action: 'downgraded', detail: 'switched to opus', engine: 'claude' }], policy, config, 0);
  assert.equal(downgraded.banner, null, 'a downgrade is explained in Run Details, not shouted in a banner');
  assert.equal(downgraded.effectiveModel, 'opus');
  const waited = summarizeQuota([{ kind: 'fiveHourLimit', at: '2026-09-19T01:05:00Z', action: 'waited', detail: 'retried 2 time(s)', engine: 'claude' }], policy, config, 0);
  assert.equal(waited.banner, null);
  const codex = summarizeQuota([{ kind: 'accountWeeklyLimit', at: '2026-09-19T01:05:00Z', action: 'fallback-engine', detail: 'switched to codex', engine: 'claude' }], policy, config, 0);
  assert.equal(codex.banner, 'Claude subscription weekly account limit reached; the rest of the run was scored by codex');
  assert.deepEqual([codex.effectiveEngine, codex.effectiveModel], ['codex', null]);

  const meta = { date: '2026-09-19', timeZone: 'America/Chicago', resumeTracks: [{ id: 'data', label: 'Data' }], warnings: [], quota: halted };
  const html = renderReportBody(buildReportView([], meta));
  assert.match(html, /<div class="banner" data-banner="quota">Claude subscription weekly account limit reached; expected to reset Sep 22, 2026, 9:00 AM; 37 posting\(s\) were deferred to the next run and are not lost<\/div>/);
  assert.match(html, /<dt>Subscription quota<\/dt><dd>1 event\(s\) · scored by claude · fable · 37 deferred<ul><li>Claude subscription weekly account limit reached; expected to reset Sep 22, 2026, 9:00 AM: deferred \(codex fallback is not connected\)<\/li><\/ul><\/dd>/);
  assert.doesNotMatch(renderReportBody(buildReportView([], { ...meta, quota: waited })), /data-banner="quota"/);
});
