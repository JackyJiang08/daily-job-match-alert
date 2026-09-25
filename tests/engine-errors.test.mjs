// Expired Claude logins: classification from the recorded CLI envelope, humanized wording, the nightly
// deferral with a desktop notification (fake runner), and the hub's Session expired state.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { AUTH_EXPIRED_MESSAGE, AuthExpiredError, EngineError, classifyEngineError, engineNotice, humanizeEngineError, resultFieldOf, shortReason, unwrapCliEnvelope } from '../src/engines/engine-errors.mjs';
import { assertNotErrorEnvelope, createClaudeEngine, unwrapCliFailure } from '../src/engines/claude.mjs';
import { normalizeQuotaPolicy } from '../src/engines/quota.mjs';
import { applySubscriptionMatching } from '../src/subscription-match.mjs';
import { notifyAuthExpired } from '../src/index.mjs';
import { annotateConnections } from '../src/hub/services.mjs';
import { buildReportView } from '../src/report.mjs';
import { renderReportBody } from '../src/report-components.mjs';

const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/engine-errors.json', import.meta.url), 'utf8'));
const NOW = new Date('2026-09-19T05:00:00Z');
const cliFailure = notice => new Error(`/Users/me/.local/bin/claude exited 1: ${JSON.stringify({ ...fixture.envelope, result: notice })}`);

test('the recorded CLI envelope is unwrapped to its notice and classified: expired logins, quotas, and plain failures', () => {
  for (const item of fixture.cases) {
    const error = unwrapCliFailure(cliFailure(item.notice));
    assert.equal(engineNotice(error), item.notice, item.notice);
    assert.equal(classifyEngineError(error, { now: NOW }).kind, item.kind, item.notice);
    assert.doesNotMatch(humanizeEngineError(error, { now: NOW }).message, /[{}"]/, `no JSON in the wording for ${item.notice}`);
  }
  const expired = unwrapCliFailure(cliFailure('Failed to authenticate: OAuth session expired and could not be refreshed'));
  assert.ok(expired instanceof AuthExpiredError);
  assert.equal(expired.code, 'SUBSCRIPTION_AUTH');
  assert.equal(expired.message, AUTH_EXPIRED_MESSAGE);
  assert.equal(expired.notice, 'Failed to authenticate: OAuth session expired and could not be refreshed');
  assert.equal(unwrapCliEnvelope('nothing json here'), null);
  assert.equal(unwrapCliEnvelope('claude exited 1: {"foo":1}'), null, 'an unrelated object is not a result envelope');
  assert.throws(() => assertNotErrorEnvelope({ type: 'result', is_error: true, result: 'You are not logged in. Run /login' }), AuthExpiredError, 'an exit-0 error envelope is caught too');
  assert.throws(() => assertNotErrorEnvelope({ type: 'result', is_error: true, result: 'Something odd' }), /Something odd/);
  assert.deepEqual(assertNotErrorEnvelope({ type: 'result', is_error: false, result: 'ok' }), { type: 'result', is_error: false, result: 'ok' });
  const custom = normalizeQuotaPolicy({ patterns: { authExpired: ['tenant login lapsed'] } });
  assert.equal(classifyEngineError(new Error('tenant login lapsed'), { policy: custom }).kind, 'auth_expired');
  assert.equal(classifyEngineError(new Error('Failed to authenticate'), { policy: custom }).kind, 'engine_error', 'an override replaces the default table');
  assert.equal(classifyEngineError(new Error('claude exited 1: Claude Code is not authenticated with a Claude subscription (loggedIn=false, authMethod="")')).kind, 'auth_expired');
  assert.equal(classifyEngineError(new Error('Claude Code is not authenticated with a Claude subscription (authMethod="console")')).kind, 'engine_error', 'a Console login is a configuration problem, not an expiry');
  assert.equal(classifyEngineError(null), null);
});

test('humanizeEngineError gives one sentence per class and never the raw text', () => {
  assert.deepEqual(humanizeEngineError(new AuthExpiredError('x')), { kind: 'auth_expired', message: AUTH_EXPIRED_MESSAGE, codexSuggested: true, notice: 'x' });
  const quota = humanizeEngineError(cliFailure("You've reached your Fable limit. Your Fable limit resets at 9am (America/Chicago)."), { now: NOW });
  assert.equal(quota.kind, 'modelWeeklyLimit');
  assert.match(quota.message, /^Claude subscription Fable weekly limit reached/);
  const plain = humanizeEngineError(cliFailure('Unexpected token in JSON at position 0'));
  assert.equal(plain.message, 'Generation failed (Unexpected token in JSON at position 0); details in the hub log');
  assert.equal(plain.codexSuggested, false);
  assert.equal(humanizeEngineError(new Error('claude timed out after 600000ms')).message, 'Generation failed (claude timed out after 600000ms); details in the hub log');
  assert.equal(humanizeEngineError(new Error(`x ${'y'.repeat(300)}`)).message, `Generation failed (x ${'y'.repeat(115)}…); details in the hub log`, 'reasons are cut at 120 characters');
  assert.equal(humanizeEngineError(new EngineError('Generation failed (custom); details in the hub log', new Error('raw'))).message, 'Generation failed (raw); details in the hub log', 'an EngineError is rebuilt from its raw text, never echoed');
  assert.equal(humanizeEngineError(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })).message, 'Generation failed (the Claude CLI was not found on this Mac); details in the hub log');
  assert.equal(humanizeEngineError(undefined).message, 'Generation failed (unknown error); details in the hub log');
});

test('the Claude engine surfaces an expired login as AuthExpiredError from both call paths', async () => {
  const runner = async (_command, args) => {
    if (args[0] === '--version') return { stdout: '2.1.269 (Claude Code)', stderr: '' };
    if (args[0] === 'auth') return { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }), stderr: '' };
    throw cliFailure('Failed to authenticate: OAuth session expired and could not be refreshed');
  };
  const engine = createClaudeEngine({ runner, resolveCommand: async () => ({ found: true, command: '/fake/claude', source: 'path' }), model: 'fable' });
  await assert.rejects(engine.reviewBatch('prompt', { type: 'object' }, {}), AuthExpiredError);
  await assert.rejects(engine.generateText('prompt', {}), AuthExpiredError);
});

test('the nightly run defers every candidate on an expired login, warns plainly, records the event, and the caller notifies', async () => {
  const resumes = [{ id: 'data', label: 'Data', text: 'resume' }];
  const jobs = [1, 2, 3].map(index => ({ url: `https://example.com/jobs/${index}`, title: `Analyst ${index}`, company: 'Acme', description: 'x', bestScore: 50, scores: { data: 50 }, scoreDetails: { data: { roleRelevance: 25 } }, blockers: [], reasons: [], gaps: [] }));
  const warnings = [];
  const quotaEvents = [];
  const makeEngine = () => ({
    id: 'claude', label: 'claude engine', model: 'fable',
    async verifyAuth() {},
    async reviewBatch() { throw unwrapCliFailure(cliFailure('Failed to authenticate: OAuth session expired and could not be refreshed')); },
    modelMatches() { return true; },
    describeModel() { return { engine: 'claude', model: 'fable' }; },
  });
  const evaluated = await applySubscriptionMatching(jobs, resumes, {}, { engine: 'claude', model: 'fable', batchSize: 2, warnings, quotaEvents, makeEngine, now: () => NOW, sleep: async () => {}, retryDelayMs: 0 });
  assert.deepEqual(evaluated.map(job => job.quotaDeferred), [true, true, true], 'every candidate waits for the next run');
  assert.equal(evaluated.some(job => job.matchLevel === 'unreviewed' || job.scoringEngine === 'local_fallback'), false, 'nothing is marked unreviewed');
  assert.deepEqual([quotaEvents[0].kind, quotaEvents[0].action, quotaEvents[0].detail], ['auth_expired', 'deferred', 'Failed to authenticate: OAuth session expired and could not be refreshed']);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].message, `${AUTH_EXPIRED_MESSAGE} 3 postings were deferred to the next run (not marked unreviewed).`);
  assert.doesNotMatch(warnings[0].message, /[{}]/);

  // The auth check itself failing with "not logged in" takes the same path.
  const checkFails = await applySubscriptionMatching(jobs, resumes, {}, { engine: 'claude', model: 'fable', warnings: [], quotaEvents: [], now: () => NOW, makeEngine: () => ({ ...makeEngine(), async verifyAuth() { throw new Error('Claude Code is not authenticated with a Claude subscription (loggedIn=false, authMethod="")'); } }) });
  assert.deepEqual(checkFails.map(job => job.quotaDeferred), [true, true, true]);

  const calls = [];
  assert.equal(await notifyAuthExpired({ platform: 'darwin', runner: async (command, args) => { calls.push([command, args]); return {}; } }), true);
  assert.equal(calls[0][0], 'osascript');
  assert.match(calls[0][1][1], /display notification "Claude login expired, run claude auth login" with title "Daily Job Match Alert"/);
  assert.equal(await notifyAuthExpired({ platform: 'linux', runner: async () => { throw new Error('must not run'); } }), false);

  const meta = { date: '2026-09-19', timeZone: 'America/Chicago', resumeTracks: [{ id: 'data', label: 'Data' }], warnings: [], authExpired: { at: NOW.toISOString(), notice: 'x', deferred: 3, message: AUTH_EXPIRED_MESSAGE } };
  const html = renderReportBody(buildReportView([], meta));
  assert.match(html, /<div class="banner" data-banner="quota">Claude session expired\. Run `claude auth login --claudeai` in Terminal, then try again\. 3 posting\(s\) were deferred to the next run and are not lost\.<\/div>/);
  assert.match(html, /<footer class="foot">Generated locally\.[^<]*Claude session expired\. Run `claude auth login --claudeai` in Terminal, then try again\.<\/footer>/);
  assert.match(html, /<dt>Claude login<\/dt><dd>Claude session expired\.[^<]*\(3 deferred\)<\/dd>/);
});

test('Session expired is a distinct connection state from Not connected and clears with a refresh', () => {
  const probe = { claude: { installed: true, connected: true, detail: 'Claude · Max · claude.ai', hint: null, reason: null }, codex: { installed: false, connected: false } };
  assert.equal(annotateConnections(probe, { expired: false }), probe, 'no flag, nothing changes');
  const flagged = annotateConnections(probe, { expired: true, notice: 'OAuth session expired' });
  assert.deepEqual([flagged.claude.connected, flagged.claude.sessionExpired, flagged.claude.reason, flagged.claude.hint], [false, true, 'OAuth session expired', 'claude auth login --claudeai']);
  assert.equal(flagged.codex, probe.codex);
});

test('an unknown error carrying a CLI JSON envelope, intact or cut off, is shown as its result field only, never as JSON', () => {
  const envelope = { ...fixture.envelope, result: 'TypeError: cannot read properties of undefined (reading foo)', usage: { output_tokens_details: { thinking_tokens: 0 } } };
  const full = `/Users/me/.local/bin/claude exited 1: ${JSON.stringify(envelope)}`;
  const truncated = full.slice(0, full.length - 40);
  const cases = [
    ['intact envelope', new Error(full)],
    ['truncated envelope (no closing brace)', new Error(truncated)],
    ['EngineError whose message already carries the raw JSON', new EngineError(`Generation failed (${truncated}); details in the hub log`, new Error(truncated))],
    ['EngineError with the raw text only on cause', Object.assign(new EngineError('Generation failed (x); details in the hub log', new Error(full)), { raw: '' })],
  ];
  for (const [label, error] of cases) {
    const message = humanizeEngineError(error).message;
    assert.equal(message, 'Generation failed (TypeError: cannot read properties of undefined (reading foo)); details in the hub log', label);
    assert.doesNotMatch(message, /[{}]|is_error|session_id/, label);
  }
  const noResult = new Error('claude exited 1: {"type":"result","is_error":true,"usage":{"input_tokens":0');
  const shown = humanizeEngineError(noResult).message;
  assert.equal(shown, 'Generation failed (claude exited 1:); details in the hub log', 'without a result field the first line loses everything from the brace on');
  assert.doesNotMatch(shown, /[{}]|is_error/);
  assert.equal(resultFieldOf('{"is_error":true,"result":"He said \\"no\\" and left","num'), 'He said "no" and left', 'escaped quotes survive a cut-off envelope');
  assert.equal(resultFieldOf('nothing'), '');
  assert.equal(shortReason('a'.repeat(200)), `${'a'.repeat(117)}…`);
  assert.equal(shortReason('{"is_error":true}'), 'is_error :true', 'braces and quotes never survive');
  assert.equal(shortReason(''), 'unknown error');
  assert.equal(engineNotice(new Error(truncated)), 'TypeError: cannot read properties of undefined (reading foo)');
});
