// Fable on Pro (2026-11-15): Pro bills Fable to paid usage credits from the first call, so on Pro no task's
// chain holds Fable (scoring starts at Opus, the weekly-limit ladder starts at Opus, letter and prescreen chains
// drop it), Settings warns beside each task whose configured chain names it, and config.json is not changed.
// On Max nothing changes. Fakes only: no CLI is started.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { effectiveStageModels, stageAssignments, stageChain } from '../src/engines/assignments.mjs';
import { normalizeCatalog } from '../src/engines/catalog.mjs';
import { normalizeQuotaPolicy } from '../src/engines/quota.mjs';
import { PAID_CREDIT_WARNING, claudePlanOf, paidCreditModel, paidCreditModels, planAdjustedConfig } from '../src/engines/plan-models.mjs';
import { applySubscriptionMatching } from '../src/subscription-match.mjs';
import { testModel } from '../src/hub/services.mjs';
import { prepareReportProject, startReportHub } from './helpers/report-hub.mjs';

const FABLE = 'claude-fable-5-1';
const OPUS = 'claude-opus-5-5';
// The owner's shape: Fable as the scoring model and the top of the ladder, Codex as the fallback engine,
// plus letter and prescreen assignments that name Fable.
const CONFIG = {
  semanticMatching: { engine: 'claude', models: { claude: FABLE }, quotaPolicy: { modelLadder: [FABLE, OPUS], fallbackEngine: 'codex' } },
  models: { assignments: {
    letterDraft: { engine: 'codex', model: 'gpt-5.6-sol', effort: 'medium', fallback: [FABLE, OPUS] },
    letterEditor: { engine: 'claude', model: FABLE, fallback: [OPUS] },
    prescreen: { engine: 'claude', model: FABLE, fallback: [] },
  } },
};

const chainIds = config => {
  const catalog = normalizeCatalog(config);
  const stages = stageAssignments(config);
  return Object.fromEntries(Object.entries(stages).map(([stage, value]) => [stage, stageChain(value, catalog).map(step => step.model)]));
};

test('Pro: no chain holds Fable, Review starts at Opus, the weekly-limit ladder starts at Opus; config.json values untouched', () => {
  const before = JSON.stringify(CONFIG);
  const pro = planAdjustedConfig(CONFIG, 'pro');
  assert.equal(JSON.stringify(CONFIG), before, 'the config object is not mutated');
  const chains = chainIds(pro);
  for (const [stage, chain] of Object.entries(chains)) assert.equal(chain.some(id => paidCreditModel(id, 'pro')), false, `${stage}: ${chain.join(' → ')}`);
  assert.deepEqual(chains.scoring, [OPUS, 'gpt-5.6-sol'], 'Review: Opus first, then the Codex hand-over');
  assert.deepEqual(normalizeQuotaPolicy(pro.semanticMatching.quotaPolicy).modelLadder, [OPUS]);
  assert.deepEqual(chains.letterDraft, ['gpt-5.6-sol', OPUS]);
  assert.deepEqual(chains.letterEditor, [OPUS], 'a Fable stage model gives way to its first fallback');
  assert.deepEqual(chains.prescreen, [OPUS], 'no fallback left: Opus');
  // A config that names no model (the registry default is Fable) and the default ladder.
  const bare = chainIds(planAdjustedConfig({ semanticMatching: { engine: 'claude' } }, 'pro'));
  assert.equal(bare.scoring[0], OPUS);
  assert.equal(Object.values(bare).flat().includes(FABLE), false);
  assert.deepEqual(paidCreditModels('pro'), [FABLE]);
  assert.deepEqual(paidCreditModels('max'), []);
});

test('Max (and an unknown plan): the same object, the same chains as before', () => {
  for (const plan of ['max', null, 'team']) {
    assert.equal(planAdjustedConfig(CONFIG, plan), CONFIG, String(plan));
  }
  const chains = chainIds(CONFIG);
  assert.deepEqual(chains.scoring, [FABLE, OPUS, 'gpt-5.6-sol']);
  assert.deepEqual(chains.letterEditor, [FABLE, OPUS]);
  assert.deepEqual(normalizeQuotaPolicy(CONFIG.semanticMatching.quotaPolicy).modelLadder, [FABLE, OPUS]);
});

test('the plan in effect: a scheduled switch to Pro applies from its date, a manual Max wins over the CLI, and back on Max Fable returns', () => {
  const scheduled = { ...CONFIG, timeZone: 'America/Chicago', plans: { claude: { scheduledChange: { plan: 'pro', effectiveDate: '2026-10-26' } } } };
  assert.equal(claudePlanOf(scheduled, { detected: 'max', now: new Date('2026-10-25T18:00:00Z') }), 'max');
  assert.equal(claudePlanOf(scheduled, { detected: 'max', now: new Date('2026-10-26T18:00:00Z') }), 'pro');
  assert.equal(claudePlanOf({ plans: { claude: { manual: 'max' } } }, { detected: 'pro' }), 'max');
  assert.equal(claudePlanOf({}, { detected: 'pro' }), 'pro');
  const back = { ...CONFIG, plans: { claude: { manual: 'max' } } };
  assert.equal(chainIds(planAdjustedConfig(back, claudePlanOf(back, { detected: 'pro' }))).scoring[0], FABLE);
});

function fakeEngines(calls, plan) {
  return (id, model) => ({
    id, label: `${id} engine`, model,
    async verifyAuth() { return { subscriptionType: plan }; },
    async reviewBatch(prompt) {
      calls.push(model);
      const ids = [...prompt.matchAll(/"id": "([a-f0-9]{16})"/g)].map(match => match[1]);
      return { results: ids.map(item => ({ id: item, roleType: 'new_grad', scores: { data: 80 }, recommendedTrack: 'data', matchLevel: 'high', reasons: ['fit'], gaps: [], blockers: [] })), scoringModel: model };
    },
    modelMatches() { return true; },
    describeModel() { return { engine: id, model }; },
  });
}

const JOBS = [1, 2].map(index => ({ url: `https://example.com/jobs/${index}`, title: `Data Analyst ${index}`, company: 'Example Corp', location: 'Remote - US', description: 'SQL', bestScore: 60, scores: { data: 60 }, scoreDetails: { data: { roleRelevance: 25 } }, blockers: [], reasons: [], gaps: [] }));
const RESUMES = [{ id: 'data', label: 'Data', text: 'resume' }];

test('scoring: on Pro Fable is never called (even when the CLI reports Pro before the recorded plan does); on Max it is', async () => {
  const run = async (config, plan) => {
    const calls = [];
    const warnings = [];
    await applySubscriptionMatching(JOBS, RESUMES, {}, {
      ...config.semanticMatching, warnings, quotaEvents: [], makeEngine: fakeEngines(calls, plan), now: () => new Date('2026-11-15T23:00:00Z'), sleep: async () => {},
      paidCreditModels: detected => paidCreditModels(claudePlanOf(config, { detected }), normalizeCatalog(config)),
    });
    return { calls, warnings };
  };
  const pro = await run(planAdjustedConfig(CONFIG, 'pro'), 'pro');
  assert.ok(pro.calls.length > 0);
  assert.equal(pro.calls.includes(FABLE), false, pro.calls.join(', '));
  // The recorded plan still said Max (config unadjusted), the CLI says Pro at the auth check.
  const late = await run(CONFIG, 'pro');
  assert.equal(late.calls.includes(FABLE), false, late.calls.join(', '));
  assert.deepEqual([...new Set(late.calls)], [OPUS]);
  assert.match(late.warnings.map(item => item.message).join('\n'), /claude-fable-5-1 is billed to usage credits on Pro; scoring with claude-opus-5-5/);
  const max = await run(CONFIG, 'max');
  assert.deepEqual([...new Set(max.calls)], [FABLE], 'Max: unchanged');
});

test('hub on Pro: Settings warns beside each task that names Fable, the sidebar Review line reads Opus 5.5, Fable is not tested; Max shows none of it', async () => {
  for (const plan of ['pro', 'max']) {
    const root = await prepareReportProject();
    const configPath = path.join(root, 'config.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    const written = { ...config, semanticMatching: { ...config.semanticMatching, ...CONFIG.semanticMatching }, models: { ...(config.models || {}), assignments: CONFIG.models.assignments } };
    await fs.writeFile(configPath, JSON.stringify(written));
    const hub = await startReportHub(root, { context: { describeConnections: async () => ({ claude: { installed: true, connected: true, plan }, codex: { installed: true, connected: true } }) } });
    try {
      const settings = (await hub.request('/settings?tab=models')).text;
      const badges = [...settings.matchAll(/<span class="badge badge-warn" data-paid-credits="([a-zA-Z]+)">([^<]+)<\/span>/g)].map(match => [match[1], match[2]]);
      const nav = /<nav class="hub-nav">([\s\S]*?)<\/nav>/.exec((await hub.request('/status')).text)[1];
      if (plan === 'pro') {
        assert.deepEqual(badges, [['scoring', PAID_CREDIT_WARNING], ['letterDraft', PAID_CREDIT_WARNING], ['letterEditor', PAID_CREDIT_WARNING], ['prescreen', PAID_CREDIT_WARNING]]);
        assert.match(nav, /<span class="model fallback" data-model="review" title="Review: Opus 5\.5 in place of Fable 5\.1 \(paid credits on Pro\)">Review · Opus 5\.5<\/span>/);
        assert.match(nav, /data-model="prescreen" title="Prescreen: Opus 5\.5 in place of Fable 5\.1 \(paid credits on Pro\)">Prescreen · Opus 5\.5</);
        await assert.rejects(testModel(hub.ctx, await hub.ctx.loadConfig(), { model: FABLE, confirm: '1' }), { message: "Fable Uses Paid Credits On Pro: claude-fable-5-1 is not tested on Pro" });
      } else {
        assert.deepEqual(badges, []);
        assert.match(nav, /data-model="review" title="Review: claude-fable-5-1">Review · Fable 5\.1</);
      }
      assert.equal(await fs.readFile(configPath, 'utf8'), JSON.stringify(written), 'config.json is never rewritten');
    } finally {
      await hub.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test('the sidebar helper alone: Pro steps past Fable with the reason, Max does not', () => {
  const now = new Date('2026-11-15T15:00:00Z');
  const pro = effectiveStageModels(CONFIG, { now, claudePlan: 'pro' });
  assert.deepEqual(pro.map(item => [item.short, item.reason]), [['Opus 5.5', 'paid credits on Pro'], ['Opus 5.5', 'paid credits on Pro'], ['GPT-5.6 Sol', null]]);
  assert.deepEqual(effectiveStageModels(CONFIG, { now, claudePlan: 'max' }).map(item => item.short), ['Fable 5.1', 'Fable 5.1', 'GPT-5.6 Sol']);
});
