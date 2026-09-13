// Engine layer: the shared interface, the Codex login allow-list, OPENAI_* scrubbing, Codex exec
// invocation and output parsing, the orchestrator running on Codex, and the hub connection probe.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ENGINE_IDS, createEngine, describeConnections, normalizeEngineId, resolveModel } from '../src/engines/index.mjs';
import { assessCodexLoginStatus, createCodexEngine, describeCodexConnection, extractCodexModel, lastAgentMessage, parseCodexOutput, verifyCodexSubscription } from '../src/engines/codex.mjs';
import { describeClaudeConnection } from '../src/engines/claude.mjs';
import { isCredentialEnvironmentKey, subscriptionEnvironment } from '../src/engines/shared.mjs';
import { applySubscriptionMatching } from '../src/subscription-match.mjs';
import { createConnectionsProbe } from '../src/hub/connections.mjs';
import { sha256 } from '../src/utils.mjs';

const REQUIRED_METHODS = ['verifyAuth', 'reviewBatch', 'describeModel', 'modelMatches', 'describeConnection'];

function candidate(url = 'https://example.com/jobs/1') {
  return {
    url, source: 'fixture', company: 'Acme', title: 'Data Analyst', location: 'Remote - US', roleType: 'new_grad',
    description: 'Use SQL and Python for analytics.'.repeat(8), scores: { data: 82, ai: 68 }, bestScore: 82, recommendedTrack: 'data', recommendedResume: 'Data',
    reasons: ['SQL'], gaps: [], blockers: [], scoreDetails: { data: { roleRelevance: 25 }, ai: { roleRelevance: 14 } },
  };
}

test('both engines expose the same interface and the registry normalizes ids and models', () => {
  for (const id of ENGINE_IDS) {
    const engine = createEngine(id, { model: 'x' });
    assert.equal(engine.id, id);
    for (const method of REQUIRED_METHODS) assert.equal(typeof engine[method], 'function', `${id}.${method}`);
    assert.deepEqual(engine.describeModel(), { engine: id, model: 'x', label: `${id === 'claude' ? 'Claude' : 'Codex'} · x` });
  }
  assert.equal(normalizeEngineId(undefined), 'claude');
  assert.equal(normalizeEngineId('claude_subscription'), 'claude');
  assert.equal(normalizeEngineId('Codex'), 'codex');
  assert.equal(normalizeEngineId('local_only'), 'local_only');
  assert.equal(normalizeEngineId('codex_subscription'), null);
  assert.equal(normalizeEngineId('openai_api'), null);
  assert.throws(() => createEngine('codex_subscription'), /Unsupported semanticMatching.engine: codex_subscription/);
  assert.equal(resolveModel({}), 'fable');
  assert.equal(resolveModel({ engine: 'codex' }), 'gpt-5.6-sol');
  assert.equal(resolveModel({ engine: 'codex', model: 'fable' }), 'gpt-5.6-sol', 'the legacy single model only ever named Claude aliases');
  assert.equal(resolveModel({ engine: 'codex', models: { codex: 'gpt-5.5' } }), 'gpt-5.5');
  assert.equal(resolveModel({ engine: 'claude', model: 'opus', models: { claude: 'sonnet' } }), 'sonnet');
  assert.equal(createEngine('claude').model, 'fable');
  assert.equal(createEngine('codex').model, 'gpt-5.6-sol');
  assert.equal(createEngine('claude', { model: 'fable' }).modelMatches('claude-fable-5'), true);
  assert.equal(createEngine('codex', { model: 'gpt-5.6-sol' }).modelMatches('gpt-5.6-sol'), true);
  assert.equal(createEngine('codex', { model: 'gpt-5.6-sol' }).modelMatches('gpt-5.5'), false);
});

test('OPENAI_* variables are scrubbed alongside ANTHROPIC_* and AWS_* before any CLI subprocess', () => {
  const env = subscriptionEnvironment({
    PATH: '/bin', HOME: '/Users/me', CODEX_HOME: '/Users/me/.codex',
    OPENAI_API_KEY: 'sk', OPENAI_BASE_URL: 'https://proxy.example', OPENAI_ORG_ID: 'org', OPENAI_PROJECT_ID: 'proj', OPENAI_ANYTHING_NEW: '1',
    ANTHROPIC_API_KEY: 'a', AWS_PROFILE: 'p',
  });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/Users/me', CODEX_HOME: '/Users/me/.codex' });
  for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'ANTHROPIC_MODEL', 'AWS_REGION']) assert.equal(isCredentialEnvironmentKey(key), true, key);
  assert.equal(isCredentialEnvironmentKey('CODEX_HOME'), false);
});

test('Codex login is allow-listed to ChatGPT accounts', async () => {
  assert.deepEqual(assessCodexLoginStatus('Logged in using ChatGPT\n'), { accepted: true, reason: null, method: 'ChatGPT' });
  assert.match(assessCodexLoginStatus('Logged in using API key').reason, /API key.*codex logout/);
  assert.match(assessCodexLoginStatus('Not logged in', 1).reason, /codex login status said: Not logged in/);
  assert.match(assessCodexLoginStatus('', 1).reason, /not logged in/);
  assert.match(assessCodexLoginStatus('something else').reason, /unrecognized login status/);
  for (const verdict of [assessCodexLoginStatus('Logged in using API key'), assessCodexLoginStatus('Not logged in', 1)]) {
    assert.equal(verdict.accepted, false);
    assert.match(verdict.reason, /not signed in with a ChatGPT subscription/);
  }

  const runner = status => async (_command, args) => {
    if (args[0] === '--version') return { stdout: 'codex-cli 0.153.0', stderr: '' };
    if (status instanceof Error) throw status;
    return { stdout: status, stderr: '' };
  };
  assert.deepEqual(await verifyCodexSubscription({ runner: runner('Logged in using ChatGPT') }), { accepted: true, reason: null, method: 'ChatGPT' });
  await assert.rejects(verifyCodexSubscription({ runner: runner('Logged in using API key') }), /API key/);
  await assert.rejects(verifyCodexSubscription({ runner: runner(Object.assign(new Error('codex exited 1: Not logged in'), { code: 1 })) }), /Not logged in/);
  await assert.rejects(verifyCodexSubscription({ runner: async () => { throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }); } }), /Install it with `npm i -g @openai\/codex`/);
});

test('the Codex engine runs codex exec read-only with a schema file and parses the last message strictly', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-engine-'));
  const calls = [];
  const results = [{ id: 'abc', roleType: 'new_grad', scores: { data: 90, ai: 40 }, recommendedTrack: 'data', matchLevel: 'high', reasons: ['SQL'], gaps: [], blockers: [] }];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    const lastPath = args[args.indexOf('--output-last-message') + 1];
    await fs.writeFile(lastPath, `Here you go:\n${JSON.stringify({ results })}\n`);
    return { stdout: '{"type":"thread.started","thread_id":"t1"}\n{"type":"session_meta","payload":{"model":"gpt-5.6-sol","cwd":"/tmp"}}\n{"type":"turn.completed","usage":{"input_tokens":10}}\n', stderr: '' };
  };
  try {
    const engine = createCodexEngine({ model: 'gpt-5.6-sol', runner, codexCommand: '/opt/codex' });
    const schema = { type: 'object', properties: { results: { type: 'array' } } };
    const response = await engine.reviewBatch('PROMPT', schema, { tempDirectory: directory });
    assert.deepEqual(response.results, results);
    assert.equal(response.scoringModel, 'gpt-5.6-sol');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, '/opt/codex');
    const args = calls[0].args;
    assert.equal(args[0], 'exec');
    for (const flag of ['--ephemeral', '--skip-git-repo-check', '--json']) assert.ok(args.includes(flag), flag);
    assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
    assert.equal(args[args.indexOf('--cd') + 1], directory);
    assert.equal(args[args.indexOf('--model') + 1], 'gpt-5.6-sol');
    assert.equal(args[args.indexOf('--color') + 1], 'never');
    assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.equal(calls[0].options.input, 'PROMPT');
    assert.equal(calls[0].options.cwd, directory);
    assert.equal(Object.hasOwn(calls[0].options.env, 'OPENAI_API_KEY'), false);
    assert.equal(await fs.readdir(directory).then(names => names.length), 0, 'schema and last-message files are cleaned up');

    assert.equal(extractCodexModel('{"type":"x"}\n{"item":{"model":"gpt-5.5"}}', 'cfg'), 'gpt-5.5');
    assert.equal(extractCodexModel('not json\n{"type":"turn.completed"}', 'cfg'), 'cfg', 'falls back to the configured model');
    assert.equal(lastAgentMessage('{"type":"item.completed","item":{"type":"agent_message","text":"{\\"results\\":[]}"}}'), '{"results":[]}');
    assert.deepEqual(parseCodexOutput('', '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"results\\":[]}"}}', 'm').results, []);
    assert.throws(() => parseCodexOutput('', '', 'm'), /no final message/);
    assert.throws(() => parseCodexOutput('I could not do that', '', 'm'), /not a JSON object/);
    assert.throws(() => parseCodexOutput('{"answer": 1}', '', 'm'), /results\[\]/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('the orchestrator scores with Codex and degrades to local fallback when the ChatGPT login is missing', async () => {
  const first = candidate();
  const id = sha256(first.url).slice(0, 16);
  const runner = async (_command, args) => {
    if (args[0] === '--version') return { stdout: 'codex-cli 0.153.0', stderr: '' };
    if (args[0] === 'login') return { stdout: 'Logged in using ChatGPT', stderr: '' };
    const lastPath = args[args.indexOf('--output-last-message') + 1];
    await fs.writeFile(lastPath, JSON.stringify({ results: [{ id, roleType: 'new_grad', scores: { data: 91, ai: 55 }, recommendedTrack: 'data', matchLevel: 'high', reasons: ['Great'], gaps: [], blockers: [] }] }));
    return { stdout: '{"type":"session_meta","payload":{"model":"gpt-5.6-sol"}}\n', stderr: '' };
  };
  const warnings = [];
  const [job] = await applySubscriptionMatching([first], { data: 'DATA', ai: 'AI' }, {}, { engine: 'codex', models: { codex: 'gpt-5.6-sol' }, runner, warnings });
  assert.equal(job.semanticReviewed, true);
  assert.equal(job.scoringEngine, 'codex');
  assert.equal(job.scoringModel, 'gpt-5.6-sol');
  assert.equal(job.bestScore, 91);
  assert.deepEqual(warnings, []);

  const denied = [];
  const [fallback] = await applySubscriptionMatching([candidate('https://example.com/jobs/2')], { data: 'DATA', ai: 'AI' }, {}, {
    engine: 'codex', warnings: denied,
    runner: async (_command, args) => (args[0] === '--version' ? { stdout: 'codex-cli 0.153.0', stderr: '' } : { stdout: 'Logged in using API key', stderr: '' }),
  });
  assert.equal(fallback.scoringEngine, 'local_fallback');
  assert.equal(fallback.matchLevel, 'unreviewed');
  assert.equal(denied[0].source, 'codex');
  assert.match(denied[0].message, /authentication check failed.*ChatGPT subscription.*API key/);

  const mismatch = [];
  const [reported] = await applySubscriptionMatching([candidate('https://example.com/jobs/3')], { data: 'DATA', ai: 'AI' }, {}, {
    engine: 'codex', models: { codex: 'gpt-5.6-sol' }, warnings: mismatch,
    runner: async (_command, args) => {
      if (args[0] === '--version') return { stdout: 'codex-cli 0.153.0', stderr: '' };
      if (args[0] === 'login') return { stdout: 'Logged in using ChatGPT', stderr: '' };
      await fs.writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ results: [{ id: sha256('https://example.com/jobs/3').slice(0, 16), roleType: 'new_grad', scores: { data: 80, ai: 50 }, recommendedTrack: 'data', matchLevel: 'high', reasons: [], gaps: [], blockers: [] }] }));
      return { stdout: '{"type":"session_meta","payload":{"model":"gpt-5.5"}}\n', stderr: '' };
    },
  });
  assert.equal(reported.scoringModel, 'gpt-5.5');
  assert.match(mismatch.find(warning => /MODEL MISMATCH/.test(warning.message)).message, /"gpt-5.6-sol".*Codex.*"gpt-5.5"/);
});

test('connection probes report installed, connected, and signed-out states without signing in', async () => {
  const claudeRunner = status => async () => ({ stdout: JSON.stringify(status), stderr: '' });
  assert.deepEqual(await describeClaudeConnection({ runner: claudeRunner({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' }) }), { installed: true, connected: true, detail: 'Claude · Max · claude.ai', hint: null, reason: null });
  const consoleLogin = await describeClaudeConnection({ runner: claudeRunner({ loggedIn: true, authMethod: 'console' }) });
  assert.equal(consoleLogin.connected, false);
  assert.equal(consoleLogin.hint, 'claude auth login --claudeai');
  const missingClaude = await describeClaudeConnection({ runner: async () => { throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }); } });
  assert.deepEqual([missingClaude.installed, missingClaude.connected], [false, false]);

  assert.deepEqual(await describeCodexConnection({ runner: async () => ({ stdout: 'Logged in using ChatGPT', stderr: '' }) }), { installed: true, connected: true, detail: 'Codex · ChatGPT', hint: null, reason: null });
  const apiKey = await describeCodexConnection({ runner: async () => ({ stdout: 'Logged in using API key', stderr: '' }) });
  assert.equal(apiKey.connected, false);
  assert.equal(apiKey.hint, 'codex login');
  const missingCodex = await describeCodexConnection({ runner: async () => { throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }); } });
  assert.equal(missingCodex.installed, false);
  assert.equal(missingCodex.hint, 'npm i -g @openai/codex');

  const both = await describeConnections({ runner: async (command) => (command === 'claude' ? { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro' }), stderr: '' } : { stdout: 'Not logged in', stderr: '' }) });
  assert.equal(both.claude.detail, 'Claude · Pro · claude.ai');
  assert.equal(both.codex.connected, false);

  let clock = Date.parse('2026-09-13T12:00:00Z');
  let calls = 0;
  const probe = createConnectionsProbe({ now: () => new Date(clock), describe: async () => { calls += 1; return { claude: { connected: true }, codex: { connected: false } }; } });
  const first = await probe.status();
  await probe.status();
  assert.equal(calls, 1, 'cached inside the 60 second window');
  assert.equal(first.checkedAt, '2026-09-13T12:00:00.000Z');
  clock += 61_000;
  await probe.status();
  assert.equal(calls, 2, 'refreshed after the window');
  await probe.status({ force: true });
  assert.equal(calls, 3);
});
