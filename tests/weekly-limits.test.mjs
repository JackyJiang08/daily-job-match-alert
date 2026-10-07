// Weekly limits whose notice names no model: classified ambiguousWeeklyLimit and settled by asking the
// next ladder model (an answer means the first model's own limit, recorded until the reset or for 7 days;
// a second refusal means the account limit); recorded limits are skipped on the next run; named notices
// keep their old path; the CLI's words are kept, sanitized, for calibration. Fakes only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyQuotaError, sanitizeNotice } from '../src/engines/quota.mjs';
import { applySubscriptionMatching } from '../src/subscription-match.mjs';
import { appendQuotaNotices, readQuotaNotices, NOTICE_LIMIT } from '../src/engines/quota-notices.mjs';

const NOW = new Date('2026-10-07T01:00:00Z');
const RESUMES = [{ id: 'data', label: 'Data', text: 'resume' }];
// Verbatim from the 2026-10-06 nightly run (the path is the CLI's, as the error message carried it).
const REAL_NOTICE = "/Users/jane/.local/bin/claude exited 1: You're out of usage credits. Switch to another model, or manage usage credits at https://claude.ai/settings/usage?from=cc_cli_limit_message, to continue.";

function candidate(index) {
  return { url: `https://example.com/jobs/${index}`, title: `Analyst ${index}`, company: 'Acme', description: 'x', bestScore: 50, scores: { data: 50 }, scoreDetails: { data: { roleRelevance: 25 } }, blockers: [], reasons: [], gaps: [] };
}
function ok(batch, model) {
  return { results: batch.map(job => ({ id: job.semanticId, roleType: 'new_grad', scores: { data: 80 }, recommendedTrack: 'data', matchLevel: 'high', reasons: ['fit'], gaps: [], blockers: [] })), scoringModel: model };
}
async function run({ jobs, refuse, limitedModels = [], policy = {}, fallbackConnected = async () => false }) {
  const spy = [];
  const warnings = [];
  const quotaEvents = [];
  const makeEngine = (id, model) => ({
    id, label: id, model,
    async verifyAuth() {},
    async reviewBatch(prompt) {
      const batch = [...prompt.matchAll(/"id": "([a-f0-9]{16})"/g)].map(match => ({ semanticId: match[1] }));
      spy.push(model);
      const refusal = refuse(model, id);
      if (refusal) throw new Error(refusal);
      return ok(batch, model);
    },
    modelMatches(actual) { return String(actual).startsWith(model); },
    describeModel() { return { engine: id, model }; },
  });
  const evaluated = await applySubscriptionMatching(jobs, RESUMES, {}, {
    engine: 'claude', model: 'fable', models: { claude: 'fable', codex: 'gpt-5.6-sol' }, batchSize: 2, warnings, quotaEvents, quotaPolicy: policy,
    makeEngine, now: () => NOW, sleep: async () => {}, retryDelayMs: 0, fallbackConnected, limitedModels,
  });
  return { evaluated, warnings, quotaEvents, spy };
}

test('a weekly notice that names no model is ambiguous; a notice that names one is unchanged', () => {
  const verdict = classifyQuotaError(new Error(REAL_NOTICE), { now: NOW });
  assert.deepEqual([verdict.kind, verdict.model, verdict.resetsAt], ['ambiguousWeeklyLimit', null, null]);
  assert.equal(verdict.message, "You're out of usage credits. Switch to another model, or manage usage credits at https://claude.ai/settings/usage, to continue.", 'no CLI path (it carries the user name), no URL query');
  assert.equal(classifyQuotaError(new Error('claude exited 1: Usage limit reached|1791507600'), { now: NOW }).kind, 'ambiguousWeeklyLimit', 'a generic notice resetting in more than five hours');
  assert.equal(classifyQuotaError(new Error('claude exited 1: Usage limit reached|1791342000'), { now: NOW }).kind, 'fiveHourLimit', 'a reset within five hours is still the rolling window');
  const named = classifyQuotaError(new Error("claude exited 1: You've reached your Fable limit. Your Fable limit resets at 9am (America/Chicago)."), { now: NOW });
  assert.deepEqual([named.kind, named.model], ['modelWeeklyLimit', 'claude-fable-5-1']);
  assert.equal(classifyQuotaError(new Error('claude exited 1: Opus limit reached|1791507600'), { now: NOW }).kind, 'modelWeeklyLimit', 'a generic notice that names a model is that model limit');
});

test('ambiguous notice, next model answers: the first model hit its own weekly limit and the run continues on the next one', async () => {
  const jobs = [1, 2, 3, 4, 5].map(candidate);
  const result = await run({ jobs, refuse: model => (model === 'claude-fable-5-1' ? REAL_NOTICE : null) });
  assert.deepEqual(result.spy, ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5'], 'the refused batch is retried on opus at once, and the remaining batches go straight to opus');
  assert.equal(result.evaluated.every(job => job.semanticReviewed && job.scoringModel === 'claude-opus-5-5'), true);
  assert.equal(result.evaluated.some(job => job.quotaDeferred), false, 'nothing is deferred');
  assert.equal(result.quotaEvents.length, 1);
  const [event] = result.quotaEvents;
  assert.deepEqual([event.kind, event.model, event.action, event.settledFrom], ['modelWeeklyLimit', 'claude-fable-5-1', 'downgraded', 'ambiguousWeeklyLimit']);
  assert.equal(event.resetsAt, '2026-10-14T01:00:00.000Z', 'no reset time in the notice: held for 7 days');
  assert.equal(event.detail, 'switched to claude-opus-5-5 (the notice named no model; claude-opus-5-5 answered)');
  assert.match(event.message, /^You're out of usage credits\./);
  assert.equal(result.warnings.find(warning => /answered/.test(warning.message)).level, 'info');
  assert.equal(result.warnings.find(warning => /scored by claude-opus-5-5/.test(warning.message)).message, 'scored by claude-opus-5-5: claude-fable-5-1 weekly limit');
  assert.equal(result.warnings.some(warning => /MODEL MISMATCH|deferred/.test(warning.message)), false);

  // A reset time in the notice is kept as is.
  const withReset = await run({ jobs: [candidate(1)], refuse: model => (model === 'claude-fable-5-1' ? 'claude exited 1: you have reached your weekly usage limit|1790200000' : null) });
  assert.equal(withReset.quotaEvents[0].resetsAt, new Date(1790200000 * 1000).toISOString());
});

test('ambiguous notice, next model refused too: the account limit, with the existing deferral or Codex hand-off', async () => {
  const jobs = [1, 2, 3].map(candidate);
  const refused = await run({ jobs, refuse: (model, id) => (id === 'claude' ? REAL_NOTICE : null) });
  assert.deepEqual(refused.spy, ['claude-fable-5-1', 'claude-opus-5-5']);
  assert.equal(refused.evaluated.every(job => job.quotaDeferred), true);
  assert.deepEqual(refused.quotaEvents.map(event => [event.kind, event.model, event.action]), [['ambiguousWeeklyLimit', 'claude-fable-5-1', 'probed'], ['accountWeeklyLimit', null, 'deferred']]);
  const codex = await run({ jobs, policy: { fallbackEngine: 'codex' }, fallbackConnected: async engine => engine === 'codex', refuse: (model, id) => (id === 'claude' ? REAL_NOTICE : null) });
  assert.deepEqual(codex.spy, ['claude-fable-5-1', 'claude-opus-5-5', 'gpt-5.6-sol', 'gpt-5.6-sol']);
  assert.equal(codex.evaluated.every(job => job.scoringEngine === 'codex'), true);
  // Nothing left to ask (a one-step ladder): the notice is treated as the account limit, as before.
  const single = await run({ jobs, policy: { modelLadder: ['fable'] }, refuse: model => (model === 'claude-fable-5-1' ? REAL_NOTICE : null) });
  assert.deepEqual(single.quotaEvents.map(event => [event.kind, event.action]), [['accountWeeklyLimit', 'deferred']]);
});

test('a recorded weekly limit that has not reset is skipped on the next run, without hitting the model first', async () => {
  const jobs = [1, 2, 3].map(candidate);
  const result = await run({ jobs, limitedModels: [{ model: 'claude-fable-5-1', resetsAt: '2026-10-14T01:00:00.000Z', notice: "You're out of usage credits." }], refuse: model => (model === 'claude-fable-5-1' ? 'must not be called' : null) });
  assert.equal(result.spy.includes('claude-fable-5-1'), false, 'fable is never asked');
  assert.equal(result.evaluated.every(job => job.scoringModel === 'claude-opus-5-5'), true);
  assert.deepEqual([result.quotaEvents[0].kind, result.quotaEvents[0].action, result.quotaEvents[0].detail], ['modelWeeklyLimit', 'skipped', 'switched to claude-opus-5-5 (weekly limit recorded earlier)']);
  assert.equal(result.warnings.find(warning => /scored by claude-opus-5-5/.test(warning.message)).message, 'scored by claude-opus-5-5: claude-fable-5-1 weekly limit');
  // A named weekly limit still steps down the ladder as before.
  const named = await run({ jobs, refuse: model => (model === 'claude-fable-5-1' ? "claude exited 1: You've reached your Fable limit. Your Fable limit resets at 9am (America/Chicago)." : null) });
  assert.deepEqual(named.quotaEvents.map(event => [event.kind, event.action, event.detail]), [['modelWeeklyLimit', 'downgraded', 'switched to claude-opus-5-5']]);
  assert.equal(named.quotaEvents[0].settledFrom, undefined);
});

test('the CLI notices are kept sanitized and capped for calibration', async () => {
  assert.equal(sanitizeNotice('/Users/jane/.local/bin/claude exited 1: Your organization org-AbC123xyz789 (jane.doe@example.com, 4f1c2b3a-1111-4222-8333-123456789abc) is out of credits; see https://claude.ai/x?account=999#frag.'),
    'Your organization [id] ([email], [id]) is out of credits; see https://claude.ai/x.');
  assert.equal(sanitizeNotice('x'.repeat(400)).length, 300);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notices-'));
  try {
    const file = path.join(root, 'state', 'quota-notices.json');
    await appendQuotaNotices(file, [{ at: '2026-08-01T00:00:00Z', kind: 'fiveHourLimit', text: 'old' }], { now: new Date('2026-08-01T00:00:00Z') });
    await appendQuotaNotices(file, Array.from({ length: 60 }, (_, index) => ({ at: NOW.toISOString(), kind: 'ambiguousWeeklyLimit', model: 'claude-fable-5-1', action: 'downgraded', text: `${REAL_NOTICE} #${index}` })), { now: NOW });
    const notices = await readQuotaNotices(file);
    assert.equal(notices.length, NOTICE_LIMIT);
    assert.equal(notices.some(item => item.text === 'old'), false, 'older than 35 days');
    assert.equal(notices.every(item => !item.text.includes('/Users/') && !item.text.includes('?from=')), true);
    assert.deepEqual(Object.keys(notices[0]).sort(), ['action', 'at', 'engine', 'kind', 'model', 'source', 'text']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the command prefix is dropped whatever the command is called', () => {
  assert.equal(sanitizeNotice('/Users/jane/bin/my-claude-wrapper.sh exited 1: Usage limit reached'), 'Usage limit reached');
  assert.equal(sanitizeNotice('Usage limit reached; see /Users/jane/notes'), 'Usage limit reached; see ~/notes', 'a home path elsewhere loses the user name');
});
