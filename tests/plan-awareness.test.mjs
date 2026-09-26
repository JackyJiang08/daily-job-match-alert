// Subscription-plan awareness: the plan each CLI reports, a plan change turned into a notification, and
// model availability learned from refusals (classified from the recorded fixture) instead of a
// plan-to-model table: the ladder steps down at once, the mark is kept for a week or until the plan
// changes, and marked models are skipped before the first call. Fakes only; no CLI, no network.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyEngineError, humanizeEngineError } from '../src/engines/engine-errors.mjs';
import { unwrapCliFailure } from '../src/engines/claude.mjs';
import { RETRY_AFTER_DAYS, availabilityPath, firstAvailableModel, markModelUnavailable, nextAvailableModel, normalizeAvailability, pruneAvailability, readAvailability, unavailableModelNames, writeAvailability } from '../src/engines/model-availability.mjs';
import { planLabel } from '../src/engines/quota.mjs';
import { applySubscriptionMatching } from '../src/subscription-match.mjs';
import { notifyMessage, recordObservedPlan } from '../src/index.mjs';

const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/engine-errors.json', import.meta.url), 'utf8'));
const NOW = new Date('2026-09-26T01:00:00Z');
const RESUMES = [{ id: 'data', label: 'Data', text: 'resume' }];
const cliFailure = notice => unwrapCliFailure(new Error(`/Users/me/.local/bin/claude exited 1: ${JSON.stringify({ ...fixture.envelope, result: notice })}`));

function candidate(index) {
  return { url: `https://example.com/jobs/${index}`, title: `Analyst ${index}`, company: 'Acme', description: 'x', bestScore: 50, scores: { data: 50 }, scoreDetails: { data: { roleRelevance: 25 } }, blockers: [], reasons: [], gaps: [] };
}
function okResponse(batch, model) {
  return { results: batch.map(job => ({ id: job.semanticId, roleType: 'new_grad', scores: { data: 80 }, recommendedTrack: 'data', matchLevel: 'high', reasons: ['fit'], gaps: [], blockers: [] })), scoringModel: `claude-${model}-5` };
}

// The matcher with a scripted fake engine; `refuse` names the models the plan rejects.
async function runMatcher({ jobs, refuse = [], plan = 'pro', policy = {}, unavailableModels = [], ladder = ['fable', 'opus', 'sonnet'] }) {
  const spy = [];
  const warnings = [];
  const quotaEvents = [];
  const marks = [];
  const auths = [];
  const makeEngine = (id, model) => {
    spy.push(model);
    return {
      id, label: `${id} engine`, model,
      async verifyAuth() { return { loggedIn: true, authMethod: 'claude.ai', subscriptionType: plan }; },
      async reviewBatch(prompt) {
        if (refuse.includes(model)) throw cliFailure(`The model claude-${model}-5 is not available on your plan.`);
        const ids = [...prompt.matchAll(/"id": "([a-f0-9]{16})"/g)].map(match => match[1]);
        return okResponse(ids.map(semanticId => ({ semanticId })), model);
      },
      modelMatches(actual) { return String(actual).includes(model); },
      describeModel() { return { engine: id, model }; },
    };
  };
  const evaluated = await applySubscriptionMatching(jobs, RESUMES, {}, {
    engine: 'claude', model: 'fable', batchSize: 2, warnings, quotaEvents, quotaPolicy: { modelLadder: ladder, ...policy },
    makeEngine, now: () => NOW, sleep: async () => {}, retryDelayMs: 0, fallbackConnected: async () => false,
    unavailableModels, markUnavailable: (model, info) => { marks.push({ model, ...info }); }, onAuth: info => { auths.push(info); },
  });
  return { evaluated, warnings, quotaEvents, spy, marks, auths };
}

test('plan-gated refusals from the recorded fixture classify as model_unavailable with the model named, and the wording never leaks JSON', () => {
  const cases = fixture.cases.filter(item => item.kind === 'model_unavailable');
  assert.ok(cases.length >= 4, 'the fixture records plan-gated refusals');
  for (const item of cases) {
    const verdict = classifyEngineError(cliFailure(item.notice), { now: NOW });
    assert.equal(verdict.kind, 'model_unavailable', item.notice);
    assert.equal(verdict.model, item.model, item.notice);
    const human = humanizeEngineError(Object.assign(cliFailure(item.notice), { plan: 'pro' }), { now: NOW });
    assert.equal(human.message, `Generation failed (the ${item.model} model is not available on Pro; pick another model or ladder step in Settings); details in the hub log`);
    assert.doesNotMatch(human.message, /[{}"]/);
  }
  // Quota refusals keep their own kinds: a Fable weekly limit is not an availability problem.
  assert.equal(classifyEngineError(cliFailure("You've reached your Fable limit. Your Fable limit resets at 9am (America/Chicago)."), { now: NOW }).kind, 'modelWeeklyLimit');
  assert.equal(classifyEngineError(new Error('claude exited 1: model output was empty'), { now: NOW }).kind, 'engine_error', 'the word "model" alone is not a refusal');
  assert.deepEqual([planLabel('max'), planLabel('pro'), planLabel(null)], ['Max', 'Pro', 'this plan']);
});

test('a plan-gated model steps the ladder down for that very call, is marked with plan and time, and the run reports the plan it saw', async () => {
  const jobs = [candidate(1), candidate(2), candidate(3)];
  const run = await runMatcher({ jobs, refuse: ['fable'] });
  assert.deepEqual(run.spy, ['fable', 'opus'], 'one step down, taken at once');
  assert.equal(run.evaluated.filter(job => job.semanticReviewed).length, 3, 'the refused batch is scored by the next model, nothing is deferred');
  assert.deepEqual([...new Set(run.evaluated.map(job => job.scoringModel))], ['claude-opus-5']);
  assert.deepEqual(run.marks, [{ model: 'fable', plan: 'pro', notice: 'The model claude-fable-5 is not available on your plan.', at: NOW.toISOString() }]);
  assert.deepEqual([run.quotaEvents[0].kind, run.quotaEvents[0].action, run.quotaEvents[0].detail, run.quotaEvents[0].model, run.quotaEvents[0].plan], ['model_unavailable', 'downgraded', 'switched to opus', 'fable', 'pro']);
  const info = run.warnings.find(warning => /not available on Pro/.test(warning.message));
  assert.equal(info.level, 'info');
  assert.equal(info.message, 'fable is not available on Pro; continuing with opus');
  assert.equal(run.warnings.some(warning => /MODEL MISMATCH/.test(warning.message)), false);
  assert.equal(run.warnings.find(warning => /scored by opus/.test(warning.message)).message, 'scored by opus: fable unavailable on Pro');
  assert.deepEqual(run.auths, [{ engine: 'claude', plan: 'pro', status: { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro' } }]);

  // Two rungs refused in a row: both are marked, the third scores.
  const twice = await runMatcher({ jobs, refuse: ['fable', 'opus'] });
  assert.deepEqual(twice.spy, ['fable', 'opus', 'sonnet']);
  assert.deepEqual(twice.marks.map(mark => mark.model), ['fable', 'opus']);
  assert.equal(twice.evaluated.every(job => job.scoringModel === 'claude-sonnet-5'), true);

  // Nothing left on the ladder: that batch uses the local fallback with a plain warning; no deferral.
  const bottom = await runMatcher({ jobs, refuse: ['fable'], ladder: ['fable'] });
  assert.equal(bottom.evaluated.every(job => job.scoringEngine === 'local_fallback'), true);
  assert.equal(bottom.evaluated.some(job => job.quotaDeferred), false);
  assert.equal(bottom.quotaEvents[0].action, 'local-fallback');
  assert.match(bottom.warnings.find(warning => /no model is left/.test(warning.message)).message, /fable is not available on Pro and no model is left on the ladder; 2 jobs used local fallback/);
});

test('models marked unavailable are skipped before the first call; the skip is audited as a plan note, never a mismatch', async () => {
  const jobs = [candidate(1), candidate(2)];
  const run = await runMatcher({ jobs, unavailableModels: ['fable'], plan: 'pro' });
  assert.deepEqual(run.spy, ['opus'], 'fable is never tried');
  assert.equal(run.marks.length, 0, 'no new mark: nothing was refused');
  assert.deepEqual([run.quotaEvents[0].kind, run.quotaEvents[0].action, run.quotaEvents[0].detail], ['model_unavailable', 'skipped', 'switched to opus (marked unavailable earlier)']);
  assert.equal(run.warnings.some(warning => /MODEL MISMATCH/.test(warning.message)), false);
  assert.equal(run.evaluated.every(job => job.scoringModel === 'claude-opus-5'), true);
  const both = await runMatcher({ jobs, unavailableModels: ['fable', 'opus'] });
  assert.deepEqual(both.spy, ['sonnet']);
  const all = await runMatcher({ jobs, unavailableModels: ['fable', 'opus', 'sonnet'] });
  assert.deepEqual(all.spy, ['fable'], 'every rung marked: the preferred model is tried again, which is the retry');
  // A weekly limit on the way down also skips marked rungs.
  assert.equal(nextAvailableModel(['fable', 'opus', 'sonnet'], 'fable', new Set(['opus'])), 'sonnet');
  assert.equal(nextAvailableModel(['fable', 'opus'], 'fable', ['opus']), null);
  assert.equal(firstAvailableModel('fable', ['fable', 'opus'], []), 'fable');
  assert.equal(firstAvailableModel('claude-fable-5', ['fable', 'opus'], ['fable']), 'opus', 'aliases normalize');
});

test('a mark lasts until the plan changes or seven days pass, then that model is tried once more; the file round-trips', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-test-'));
  try {
    const file = availabilityPath(root);
    assert.equal(file, path.join(root, 'state', 'model-availability.json'));
    const record = await readAvailability(file);
    assert.deepEqual(record, { version: 1, models: {} }, 'a missing file is an empty record');
    markModelUnavailable(record, 'claude-fable-5', { plan: 'pro', at: NOW.toISOString(), notice: 'The model claude-fable-5 is not available on your plan.' });
    assert.deepEqual(record.models.fable, { model: 'fable', plan: 'pro', detectedAt: NOW.toISOString(), notice: 'The model claude-fable-5 is not available on your plan.' });
    await writeAvailability(file, record);
    const reread = await readAvailability(file);
    assert.deepEqual(unavailableModelNames(reread), ['fable']);

    // Same plan, six days later: still skipped.
    assert.deepEqual(pruneAvailability(reread, { now: new Date(NOW.getTime() + 6 * 86_400_000), plan: 'pro' }), []);
    assert.deepEqual(unavailableModelNames(reread), ['fable']);
    // Seven days: the mark is dropped, so the next call tries fable again (and re-marks it on a refusal).
    assert.equal(RETRY_AFTER_DAYS, 7);
    const aged = pruneAvailability(reread, { now: new Date(NOW.getTime() + 7 * 86_400_000), plan: 'pro' });
    assert.deepEqual(aged.map(item => [item.model, item.reason]), [['fable', 'retry after 7 days']]);
    assert.deepEqual(unavailableModelNames(reread), []);
    // A plan change drops the mark at once.
    const upgraded = normalizeAvailability({ version: 1, models: { fable: { model: 'fable', plan: 'pro', detectedAt: NOW.toISOString() } } });
    assert.deepEqual(pruneAvailability(upgraded, { now: NOW, plan: 'max' }).map(item => item.reason), ['plan changed to max']);
    assert.deepEqual(unavailableModelNames(upgraded), []);
    // No plan observed: the mark stays until it ages out.
    const unknown = normalizeAvailability({ models: { fable: { model: 'fable', plan: 'pro', detectedAt: NOW.toISOString() } } });
    assert.deepEqual(pruneAvailability(unknown, { now: NOW, plan: null }), []);
    assert.deepEqual(normalizeAvailability({ models: { junk: { model: '', detectedAt: 'nope' } } }), { version: 1, models: {} }, 'garbage entries are dropped');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a plan change is remembered in state and sent as a macOS notification with the exact sentence; the first observation stays quiet', async () => {
  const state = {};
  assert.equal(recordObservedPlan(state, 'claude', 'max', NOW), null, 'first sighting: recorded, no notice');
  assert.deepEqual(state.observedPlans.claude, { type: 'max', at: NOW.toISOString(), previous: null, changedAt: null });
  const later = new Date(NOW.getTime() + 86_400_000);
  assert.equal(recordObservedPlan(state, 'claude', 'max', later), null, 'same plan: nothing to say');
  const change = recordObservedPlan(state, 'claude', 'pro', later);
  assert.deepEqual(change, { engine: 'claude', from: 'max', to: 'pro', at: later.toISOString(), message: 'Claude plan changed: max → pro. Review the model ladder in Settings.' });
  assert.deepEqual(state.observedPlans.claude, { type: 'pro', at: later.toISOString(), previous: 'max', changedAt: later.toISOString() });
  assert.equal(recordObservedPlan(state, 'claude', null, later), null, 'an unknown plan neither records nor notifies');
  assert.equal(state.observedPlans.claude.type, 'pro');

  const calls = [];
  assert.equal(await notifyMessage(change.message, { platform: 'darwin', runner: async (command, args) => { calls.push([command, args]); return {}; } }), true);
  assert.equal(calls[0][0], 'osascript');
  assert.match(calls[0][1][1], /display notification "Claude plan changed: max → pro\. Review the model ladder in Settings\." with title "Daily Job Match Alert"/);
  assert.equal(await notifyMessage(change.message, { platform: 'linux', runner: async () => { throw new Error('must not run'); } }), false);
  const quoted = [];
  await notifyMessage('say "hi"', { platform: 'darwin', runner: async (command, args) => { quoted.push(args[1]); return {}; } });
  assert.doesNotMatch(quoted[0], /"hi"/, 'quotes are stripped so the AppleScript stays valid');
});
