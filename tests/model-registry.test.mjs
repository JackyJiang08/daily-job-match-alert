// The model registry and the subscription view: legacy configs migrate to registry ids, the CLI's real
// model id is learned from modelUsage, a scheduled plan change reads correctly before and after its
// date, the ChatGPT plan is decoded from auth.json without any token reaching an output, CLI refusals map
// to the right status badge, and ladders are validated. Fakes and fixtures only; no CLI, no network.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_CATALOG, canonicalModelId, cliModelArg, defaultLadder, findModel, newerRelease, normalizeCatalog, validateLadder } from '../src/engines/catalog.mjs';
import { resolveModel } from '../src/engines/index.mjs';
import { normalizeQuotaPolicy } from '../src/engines/quota.mjs';
import { createClaudeEngine, redactEnvelope } from '../src/engines/claude.mjs';
import { createCodexEngine } from '../src/engines/codex.mjs';
import { classifyEngineError } from '../src/engines/engine-errors.mjs';
import { markModelUnavailable, markModelUsed, markWeeklyLimit, modelStatus, normalizeAvailability, pruneLimits } from '../src/engines/model-availability.mjs';
import { planView } from '../src/engines/plans.mjs';
import { chatgptPlanFromAuthFile, planFromIdToken } from '../src/engines/chatgpt-plan.mjs';
import { statusText } from '../src/hub/model-settings.mjs';

const fixtures = new URL('./fixtures/', import.meta.url);
const NOW = new Date('2026-10-06T22:00:00Z');
// Recorded from the 2026-10-06 nightly run (usage and modelUsage only).
const envelopeFixture = JSON.parse(await fs.readFile(new URL('usage/claude-result.json', fixtures), 'utf8'));

test('the registry holds the ids checked against the installed CLIs, and older configs migrate to them', () => {
  assert.deepEqual(DEFAULT_CATALOG.filter(entry => entry.provider === 'anthropic').map(entry => [entry.id, entry.alias]), [['claude-fable-5-1', 'fable'], ['claude-opus-5-5', 'opus'], ['claude-sonnet-5-5', 'sonnet'], ['claude-haiku-4-5', 'haiku']]);
  assert.deepEqual(DEFAULT_CATALOG.filter(entry => entry.provider === 'openai').map(entry => entry.id), ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-6-astra']);
  assert.deepEqual(findModel(DEFAULT_CATALOG, 'gpt-5.6-sol').efforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'efforts as `codex debug models` lists them');
  assert.equal(findModel(DEFAULT_CATALOG, 'claude-fable-5-1').efforts, undefined, 'efforts belong to Codex models only');

  // hub.modelChoices (older Settings dropdown lists): aliases fold into their entry, other names are added.
  const migrated = normalizeCatalog({ hub: { modelChoices: { claude: [{ value: 'fable', label: 'Fable (recommended)' }, 'opus', 'claude-opus-4-8'], codex: [{ value: 'gpt-5.6-sol', label: 'gpt-5.6-sol (Codex default)' }, 'gpt-5.5-mini'] } } });
  assert.equal(migrated.filter(entry => entry.id === 'claude-fable-5-1').length, 1, 'no duplicate for an alias');
  assert.deepEqual(migrated.slice(DEFAULT_CATALOG.length).map(entry => [entry.provider, entry.id]), [['anthropic', 'claude-opus-4-8'], ['openai', 'gpt-5.5-mini']]);
  // config.models.catalog replaces the defaults; malformed entries are dropped.
  const explicit = normalizeCatalog({ models: { catalog: [{ provider: 'anthropic', id: 'claude-opus-5-5', label: 'Opus', alias: 'opus' }, { provider: 'openai', id: 'gpt-5.6-sol', efforts: ['low', 'HIGH'] }, { provider: 'acme', id: 'x' }, { provider: 'openai', id: 'bad id!' }] } });
  assert.deepEqual(explicit.map(entry => entry.id), ['claude-opus-5-5', 'gpt-5.6-sol']);
  assert.deepEqual(explicit[1].efforts, ['low', 'high']);

  // Configs written with aliases resolve to full ids everywhere a model is chosen.
  assert.equal(resolveModel({ engine: 'claude_subscription' }), 'claude-fable-5-1');
  assert.equal(resolveModel({ engine: 'claude', model: 'opus' }), 'claude-opus-5-5');
  assert.equal(resolveModel({ engine: 'claude', models: { claude: 'claude-haiku-4-5-20251001' } }), 'claude-haiku-4-5', 'a dated id maps to its registry entry');
  assert.deepEqual(normalizeQuotaPolicy({ modelLadder: ['fable', 'opus'] }).modelLadder, ['claude-fable-5-1', 'claude-opus-5-5']);
  assert.deepEqual(defaultLadder(), ['claude-fable-5-1', 'claude-opus-5-5']);
  assert.equal(canonicalModelId('my-private-model', 'anthropic'), 'my-private-model', 'a custom name passes through');
});

test('the Claude CLI receives the registry alias, and the id it actually ran is read from modelUsage as resolvedId', async () => {
  const calls = [];
  const runner = async (command, args) => {
    calls.push(args);
    if (args.includes('--version')) return { stdout: '2.1.292 (Claude Code)', stderr: '' };
    if (args.includes('auth')) return { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }), stderr: '' };
    return { stdout: JSON.stringify({ ...envelopeFixture.envelope, result: 'OK', session_id: 'SECRET-SESSION' }), stderr: '' };
  };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'registry-test-'));
  try {
    const envelopeLog = path.join(root, 'state', 'logs', 'claude-envelope-last.json');
    const engine = createClaudeEngine({ model: 'fable', runner, claudeCommand: '/fake/claude', resolveCommand: async () => ({ found: true, command: '/fake/claude', source: 'config' }), envelopeLog });
    assert.equal(engine.model, 'claude-fable-5-1');
    const response = await engine.generateText('Reply with OK', {});
    assert.equal(calls.at(-1)[calls.at(-1).indexOf('--model') + 1], 'fable', 'the CLI is given the alias, so it picks the current release');
    assert.equal(response.scoringModel, 'claude-fable-5-1', 'the id with the most output tokens in modelUsage');
    assert.deepEqual(response.usage.models.map(item => item.model), ['claude-fable-5-1'], 'the recorded run used one model');
    const record = normalizeAvailability(null);
    markModelUsed(record, engine.model, { resolvedId: response.scoringModel, at: NOW.toISOString() });
    markModelUsed(record, 'claude-haiku-4-5', { resolvedId: 'claude-haiku-4-5-20251001', at: NOW.toISOString() });
    assert.deepEqual(record.seen, { 'claude-fable-5-1': { resolvedId: 'claude-fable-5-1', lastUsedAt: NOW.toISOString() }, 'claude-haiku-4-5': { resolvedId: 'claude-haiku-4-5-20251001', lastUsedAt: NOW.toISOString() } });
    assert.equal(modelStatus(record, 'haiku', { now: NOW }).resolvedId, 'claude-haiku-4-5-20251001', 'an alias finds the same record');

    // reviewBatch keeps a redacted copy of the envelope for fixture recording: usage yes, answers and ids no.
    const reviewRunner = async (command, args) => (args.includes('--json-schema') ? { stdout: JSON.stringify({ ...envelopeFixture.envelope, structured_output: { results: [] }, result: 'MODEL ANSWER TEXT', session_id: 'SECRET-SESSION', uuid: 'SECRET-UUID' }), stderr: '' } : runner(command, args));
    const reviewer = createClaudeEngine({ model: 'opus', runner: reviewRunner, resolveCommand: async () => ({ found: true, command: '/fake/claude', source: 'config' }), envelopeLog });
    await reviewer.reviewBatch('{}', { type: 'object' }, {});
    let captured = null;
    for (let attempt = 0; attempt < 20 && !captured; attempt += 1) { captured = await fs.readFile(envelopeLog, 'utf8').catch(() => null); if (!captured) await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.ok(captured, 'the redacted envelope is written');
    assert.deepEqual(Object.keys(JSON.parse(captured).envelope.modelUsage), ['claude-fable-5-1']);
    assert.doesNotMatch(captured, /SECRET-SESSION|SECRET-UUID|MODEL ANSWER TEXT|structured_output/);
    assert.deepEqual(Object.keys(redactEnvelope({ result: 'x', session_id: 'y', usage: {}, modelUsage: {}, type: 'result' })).sort(), ['modelUsage', 'type', 'usage']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Codex gets the registry id and, when one is set, the reasoning effort as a config override', async () => {
  const calls = [];
  const io = { writeFile: async () => {}, readFile: async () => 'OK', rm: async () => {} };
  const runner = async (command, args) => { calls.push(args); return { stdout: '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":2}}\n', stderr: '' }; };
  const resolveCommand = async () => ({ found: true, command: '/fake/codex', source: 'config' });
  await createCodexEngine({ model: 'gpt-5.6-sol', reasoningEffort: 'high', runner, io, resolveCommand }).generateText('Reply with OK', {});
  assert.deepEqual(calls.at(-1).slice(-4), ['--model', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="high"']);
  await createCodexEngine({ model: 'gpt-5.6-sol', runner, io, resolveCommand }).generateText('Reply with OK', {});
  assert.equal(calls.at(-1).includes('-c'), false, 'no effort set: the CLI default stays in charge');
  await createCodexEngine({ model: 'gpt-5.6-sol', reasoningEffort: 'high"; rm -rf /', runner, io, resolveCommand }).generateText('x', {});
  assert.equal(calls.at(-1).includes('-c'), false, 'an effort outside the plain-word pattern is ignored');
});

test('a scheduled plan change reads "Max · switches to Pro on Oct 26, 2026" until that local date, then Pro', () => {
  const config = { plans: { claude: { scheduledChange: { plan: 'pro', effectiveDate: '2026-10-26' } } } };
  const before = planView('claude', { detected: 'max', detectedSource: 'auth status', config, now: NOW });
  assert.deepEqual([before.label, before.line, before.sidebar, before.source], ['Max', 'Max · switches to Pro on Oct 26, 2026', 'Claude Max → Pro Oct 26', 'auto']);
  const lastMinute = planView('claude', { detected: 'max', config, now: new Date('2026-10-26T04:59:00Z') });
  assert.equal(lastMinute.line, 'Max · switches to Pro on Oct 26, 2026', '11:59 PM on Oct 25 in Chicago is still before the date');
  const after = planView('claude', { detected: 'max', config, now: new Date('2026-10-26T05:00:00Z') });
  assert.deepEqual([after.label, after.line, after.sidebar, after.source, after.pending], ['Pro', 'Pro', 'Claude Pro', 'manual', null]);
  assert.equal(planView('claude', { detected: 'pro', config, now: new Date('2026-10-27T00:00:00Z') }).source, 'auto', 'once the CLI reports it too, the plan is auto again');
  assert.equal(planView('claude', { detected: 'pro', config, now: NOW }).pending, null, 'no change pending when the plan already matches');
  assert.equal(planView('claude', { detected: 'max', config: { plans: { claude: { scheduledChange: { plan: 'pro', effectiveDate: 'soon' } } } }, now: NOW }).pending, null, 'a malformed date is ignored');
  assert.deepEqual([planView('chatgpt', {}).label, planView('chatgpt', {}).source], ['Unknown', null]);
  assert.deepEqual([planView('chatgpt', { detected: 'plus', config: { plans: { chatgpt: { manual: 'pro' } } } }).label, planView('chatgpt', { detected: 'plus', config: { plans: { chatgpt: { manual: 'pro' } } } }).source], ['Pro', 'manual']);
});

test('the ChatGPT plan is decoded from auth.json locally, and no token or other claim reaches any output', async () => {
  const dir = new URL('codex-auth/', fixtures);
  const read = name => chatgptPlanFromAuthFile({ file: new URL(name, dir).pathname });
  const printed = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...args) => printed.push(args.join(' '));
  console.error = (...args) => printed.push(args.join(' '));
  console.warn = (...args) => printed.push(args.join(' '));
  let results;
  try {
    results = {
      plus: await read('plus.json'),
      noClaim: await read('no-plan-claim.json'),
      noToken: await read('no-id-token.json'),
      garbled: await read('garbled-token.json'),
      missing: await chatgptPlanFromAuthFile({ file: '/nonexistent/auth.json' }),
    };
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(results, { plus: { plan: 'plus', source: 'auth.json' }, noClaim: null, noToken: null, garbled: null, missing: null });
  const secrets = [];
  for (const name of ['plus.json', 'no-plan-claim.json', 'garbled-token.json']) {
    const raw = JSON.parse(await fs.readFile(new URL(name, dir), 'utf8'));
    secrets.push(raw.tokens.id_token, raw.tokens.access_token, raw.tokens.refresh_token, raw.tokens.account_id, ...raw.tokens.id_token.split('.'));
  }
  const output = JSON.stringify(results) + printed.join('\n');
  for (const secret of secrets.filter(item => item && item.length > 8)) assert.equal(output.includes(secret), false, 'a token or token segment leaked');
  assert.doesNotMatch(output, /jane\.doe@example\.com|acct-fake|user-fake/, 'no other claim is returned or printed');
  assert.equal(planFromIdToken('a.b'), null);
  assert.equal(planFromIdToken(`x.${Buffer.from(JSON.stringify({ chatgpt_plan_type: '<script>' })).toString('base64url')}.y`), null, 'only a plain plan word is accepted');
});

test('each CLI refusal maps to its status badge; weekly limits clear at reset, success clears everything', async () => {
  const fixture = JSON.parse(await fs.readFile(new URL('engine-errors.json', fixtures), 'utf8'));
  for (const item of fixture.cases.filter(entry => entry.kind === 'model_unavailable')) {
    const verdict = classifyEngineError(new Error(`claude exited 1: ${item.notice}`), { now: NOW });
    assert.equal(verdict.kind, 'model_unavailable', item.notice);
    assert.equal(verdict.reason, item.reason, item.notice);
    assert.equal(verdict.model, item.model, item.notice);
  }
  const record = normalizeAvailability(null);
  const apply = (model, text) => {
    const verdict = classifyEngineError(new Error(text), { now: NOW });
    if (verdict.kind === 'model_unavailable') markModelUnavailable(record, model, { plan: 'pro', at: NOW.toISOString(), notice: verdict.notice, kind: verdict.reason });
    if (verdict.kind === 'modelWeeklyLimit') markWeeklyLimit(record, model, { at: NOW.toISOString(), resetsAt: verdict.quota.resetsAt });
    return modelStatus(record, model, { now: NOW });
  };
  assert.equal(apply('gpt-5.5', "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.").state, 'unknown_model');
  assert.equal(apply('gpt-6-astra', 'Unknown model `gpt-6-astra`').state, 'unknown_model');
  assert.equal(apply('claude-fable-5-1', 'The model claude-fable-5-1 is not available on your plan.').state, 'not_on_plan');
  const limited = apply('claude-opus-5-5', "claude exited 1: You've reached your Opus limit. Your Opus limit resets at 9am (America/Chicago).");
  assert.equal(limited.state, 'weekly_limit');
  assert.equal(statusText(limited, 'America/Chicago'), 'Weekly limit until Oct 7, 2026, 9:00 AM', 'the reset time the CLI gave');
  markWeeklyLimit(record, 'claude-sonnet-5-5', { at: NOW.toISOString(), resetsAt: null });
  assert.equal(statusText(modelStatus(record, 'claude-sonnet-5-5', { now: NOW }), 'America/Chicago'), 'Weekly limit since Oct 6, 2026, 5:00 PM', 'no reset time: when it was seen');
  assert.equal(statusText(modelStatus(record, 'claude-fable-5-1', { now: NOW }), 'America/Chicago'), 'Unavailable on Pro');
  assert.equal(modelStatus(record, 'claude-haiku-4-5', { now: NOW }).state, 'not_verified');
  // A weekly limit lifts by itself at its reset time; one without a reset time after 7 days.
  assert.equal(modelStatus(record, 'claude-opus-5-5', { now: new Date('2026-10-07T14:00:01Z') }).state, 'not_verified');
  assert.deepEqual(pruneLimits(record, { now: new Date('2026-10-07T14:00:01Z') }).map(item => item.model), ['claude-opus-5-5']);
  assert.deepEqual(pruneLimits(record, { now: new Date('2026-10-13T22:00:00Z') }).map(item => item.model), ['claude-sonnet-5-5']);
  // A successful call proves a mark stale.
  markModelUsed(record, 'claude-fable-5-1', { resolvedId: 'claude-fable-5-1', at: NOW.toISOString() });
  assert.equal(modelStatus(record, 'claude-fable-5-1', { now: NOW }).state, 'available');
  // Version 1 files load: marks keyed by family become registry ids and count as not on plan.
  const legacy = normalizeAvailability({ version: 1, models: { fable: { model: 'fable', plan: 'max', detectedAt: NOW.toISOString() } } });
  assert.deepEqual(Object.keys(legacy.models), ['claude-fable-5-1']);
  assert.equal(legacy.models['claude-fable-5-1'].kind, 'not_on_plan');
});

test('ladders take registry Claude models only, without repeats, and at least one', () => {
  assert.deepEqual(validateLadder(['claude-opus-5-5', 'fable']), { ladder: ['claude-opus-5-5', 'claude-fable-5-1'], errors: [] });
  assert.deepEqual(validateLadder('fable, opus').ladder, ['claude-fable-5-1', 'claude-opus-5-5'], 'a comma-separated string still works');
  assert.deepEqual(validateLadder(['claude-fable-5-1', 'gpt-5.6-sol']).errors, ['gpt-5.6-sol is a ChatGPT model; the ladder only takes Claude models']);
  assert.deepEqual(validateLadder(['opus', 'claude-opus-5-5']).errors, ['claude-opus-5-5 appears twice in the ladder']);
  assert.deepEqual(validateLadder([]).errors, ['The model ladder needs at least one model']);
  assert.deepEqual(validateLadder(['claude-opus-9']).errors, ['claude-opus-9 is not in the model registry']);
  assert.deepEqual(validateLadder(['gpt-5.5', 'gpt-5.6-sol'], { provider: 'openai' }).errors, [], 'the same rules for a Codex list');
});

test('aliased models go to the CLI as their alias, a newer release it reports counts as the same model and is flagged as a new version', async () => {
  assert.deepEqual(['claude-fable-5-1', 'opus', 'claude-sonnet-5-5', 'claude-haiku-4-5'].map(name => cliModelArg(name)), ['fable', 'opus', 'sonnet', 'haiku']);
  assert.deepEqual(['gpt-5.6-sol', 'gpt-6-astra'].map(name => cliModelArg(name)), ['gpt-5.6-sol', 'gpt-6-astra'], 'Codex entries have no alias: the full id');
  assert.equal(cliModelArg('my-private-model'), 'my-private-model');

  // The alias resolved to a release newer than the registry id.
  const calls = [];
  const runner = async (command, args) => { calls.push(args); return { stdout: JSON.stringify({ type: 'result', is_error: false, result: 'OK', modelUsage: { 'claude-fable-5-2': { inputTokens: 9, outputTokens: 2 } } }), stderr: '' }; };
  const engine = createClaudeEngine({ model: 'claude-fable-5-1', runner, resolveCommand: async () => ({ found: true, command: '/fake/claude', source: 'config' }) });
  const response = await engine.generateText('Reply with OK', {});
  assert.equal(calls[0][calls[0].indexOf('--model') + 1], 'fable');
  assert.equal(engine.model, 'claude-fable-5-1', 'the registry id stays the model of record');
  assert.equal(response.scoringModel, 'claude-fable-5-2', 'the full id the CLI reported');
  assert.equal(engine.modelMatches('claude-fable-5-2'), true, 'a newer release of the alias is not a mismatch');
  assert.equal(engine.modelMatches('claude-fable-5-1[1m]'), true);
  assert.equal(engine.modelMatches('claude-opus-5-5'), false, 'another family still is');
  const record = normalizeAvailability(null);
  markModelUsed(record, engine.model, { resolvedId: response.scoringModel, at: NOW.toISOString() });
  assert.equal(modelStatus(record, 'claude-fable-5-1', { now: NOW }).resolvedId, 'claude-fable-5-2');
  assert.equal(newerRelease('claude-fable-5-1', 'claude-fable-5-2'), 'claude-fable-5-2');
  assert.equal(newerRelease('claude-haiku-4-5', 'claude-haiku-4-5-20251001'), null, 'a dated snapshot of the same id is not a new version');
  assert.equal(newerRelease('claude-fable-5-1', 'claude-fable-5-1'), null);
  assert.equal(newerRelease('claude-fable-5-1', null), null);
});

