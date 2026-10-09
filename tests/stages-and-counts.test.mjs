// Per-stage assignments (defaults, migration, normalization, chains) and the run's breakdown: scored by
// model, deferred, prefiltered out, expired, plus the report-header line for a quota event. No CLI.
import assert from 'node:assert/strict';
import test from 'node:test';
import { stageAssignments, stageChain } from '../src/engines/assignments.mjs';
import { normalizeQuotaPolicy } from '../src/engines/quota.mjs';
import { quotaNote, runCounts } from '../src/index.mjs';
import { buildHtml, runDetailsView } from '../src/report.mjs';

test('older configs migrate: scoring keeps its engine, model, and ladder; letters get codex / gpt-5.6-sol at medium and high with the Claude Opus step behind', () => {
  const owner = stageAssignments({ semanticMatching: { engine: 'claude_subscription' } });
  assert.deepEqual(owner.scoring, { engine: 'claude', model: 'claude-fable-5-1', effort: null, fallback: ['claude-opus-5-5', 'gpt-5.6-sol'], source: 'config' }, 'the ladder, then Codex for a weekly account limit (on unless set off)');
  assert.deepEqual({ ...owner.supplemental }, { ...owner.scoring, linked: 'scoring' });
  assert.deepEqual(owner.letterDraft, { engine: 'codex', model: 'gpt-5.6-sol', effort: 'medium', fallback: ['claude-opus-5-5'], source: 'default' });
  assert.deepEqual(owner.letterEditor, { engine: 'codex', model: 'gpt-5.6-sol', effort: 'high', fallback: ['claude-opus-5-5'], source: 'default' });
  assert.deepEqual(owner.prescreen, { engine: 'codex', model: 'gpt-5.6-luna', effort: 'low', fallback: [], source: 'default' }, 'the prescreen defaults to the lightest ChatGPT model at low effort');
  assert.equal(stageAssignments({ semanticMatching: { engine: 'local_only' } }).prescreen.engine, null, 'local-only scoring has no prescreen');
  assert.deepEqual(stageAssignments({ semanticMatching: { engine: 'claude' }, models: { assignments: { prescreen: { engine: 'claude', model: 'sonnet' } } } }).prescreen, { engine: 'claude', model: 'claude-sonnet-5-5', effort: null, fallback: [], source: 'config' }, 'Settings can move it to Claude Sonnet');
  assert.deepEqual(stageChain(owner.letterDraft), [{ engine: 'codex', model: 'gpt-5.6-sol', effort: 'medium' }, { engine: 'claude', model: 'claude-opus-5-5', effort: null }]);
  // The Codex fallback can be switched off explicitly.
  assert.deepEqual(stageAssignments({ semanticMatching: { engine: 'claude', quotaPolicy: { fallbackEngine: null } } }).scoring.fallback, ['claude-opus-5-5']);
  assert.equal(normalizeQuotaPolicy({}).fallbackEngine, 'codex');
  assert.equal(normalizeQuotaPolicy({ fallbackEngine: false }).fallbackEngine, null);
  // Scoring on Codex carries its effort and no Claude ladder.
  const codex = stageAssignments({ semanticMatching: { engine: 'codex', models: { codex: 'gpt-5.6-terra' }, reasoningEffort: 'xhigh' } }).scoring;
  assert.deepEqual([codex.engine, codex.model, codex.effort, codex.fallback], ['codex', 'gpt-5.6-terra', 'xhigh', []]);
  // A local-only config keeps the letter placeholder; explicit assignments are normalized.
  assert.equal(stageAssignments({ semanticMatching: { engine: 'local_only' } }).letterDraft.source, 'placeholder');
  const explicit = stageAssignments({ semanticMatching: { engine: 'local_only' }, models: { assignments: { letterDraft: { engine: 'claude', model: 'sonnet', effort: 'high', fallback: ['claude-sonnet-5-5', 'gpt-5.5', 'nope', 'gpt-5.5'] }, letterEditor: { engine: 'codex', model: 'gpt-5.5', effort: 'ultra' } } } });
  assert.deepEqual(explicit.letterDraft, { engine: 'claude', model: 'claude-sonnet-5-5', effort: null, fallback: ['gpt-5.5'], source: 'config' }, 'aliases resolve, Claude takes no effort, unknown and repeated steps drop');
  assert.deepEqual([explicit.letterEditor.effort, explicit.letterEditor.fallback], [null, ['claude-opus-5-5']], 'an effort the model does not list is dropped; the chain defaults to Opus');
});

test('the run breakdown counts scoring by engine and model, deferrals by cause, prefilter drops, and expiry; the header names the quota hand-off', () => {
  const evaluated = [
    { semanticReviewed: true, scoringEngine: 'claude', scoringModel: 'claude-opus-5-5' },
    { semanticReviewed: true, scoringEngine: 'claude', scoringModel: 'claude-opus-5-5' },
    { semanticReviewed: true, scoringEngine: 'codex', scoringModel: 'gpt-5.6-sol' },
    { semanticReviewed: false, scoringEngine: 'local_fallback', matchLevel: 'unreviewed' },
  ];
  const counts = runCounts({ evaluated, budget: { deferred: [{}, {}] }, quotaDeferred: [{}, {}, {}], prefiltered: { titleExcluded: [{}, {}, {}, {}], locationExcluded: [{}] }, expiredBacklogCount: 6 });
  assert.deepEqual(counts, { scoredByModel: [{ label: 'claude · claude-opus-5-5', count: 2 }, { label: 'codex · gpt-5.6-sol', count: 1 }], localScores: 1, deferred: { budget: 2, quota: 3 }, prescreenedOut: 0, prefilteredOut: { title: 4, location: 1 }, expired: 6 });
  const rows = runDetailsView([], { date: '2026-10-07', resumeTracks: [], warnings: [], runCounts: counts, prefilter: { titleExcluded: [], titleExcludedCount: 4, locationExcludedCount: 1, bySource: [] } }, []).rows;
  const byTerm = Object.fromEntries(rows.map(row => [row.term, row]));
  assert.equal(byTerm['Scored by model (this run)'].detail, '3 scored · 1 kept local scores (unreviewed)');
  assert.deepEqual(byTerm['Scored by model (this run)'].items, ['claude · claude-opus-5-5: 2', 'codex · gpt-5.6-sol: 1']);
  assert.equal(byTerm.Deferred.detail, '5 (review budget 2 · quota 3)');
  assert.equal(byTerm['Prefiltered out'].detail, '4 skipped by title · 1 skipped by a non-US location (before enrichment)');
  assert.equal(byTerm.Expired.detail, '6 backlog posting(s) past the grace period, not scored');
  assert.equal(Object.hasOwn(byTerm, 'Reviewed jobs (this run)'), false);

  // The header line for a quota event.
  const downgraded = { events: [{ kind: 'modelWeeklyLimit', model: 'claude-fable-5-1', action: 'downgraded', detail: 'switched to claude-opus-5-5 (the notice named no model; claude-opus-5-5 answered)', engine: 'claude' }] };
  assert.equal(quotaNote(downgraded, 0), null, 'a step down inside the Claude family that reviewed everything is only a Run Details line');
  const deferred = { events: [{ kind: 'ambiguousWeeklyLimit', model: 'claude-fable-5-1', action: 'probed' }, { kind: 'accountWeeklyLimit', model: null, action: 'deferred', detail: 'codex fallback is not connected' }] };
  assert.equal(quotaNote(deferred, 96), 'Quota: Claude subscription weekly account limit reached. 96 posting(s) were not reviewed because of it and wait for the next run; no engine took over.');
  const handedOff = { events: [{ kind: 'accountWeeklyLimit', action: 'fallback-engine', detail: 'switched to codex' }] };
  assert.equal(quotaNote(handedOff, 0), 'Quota: Claude subscription weekly account limit reached. codex took over; every posting was reviewed.');
  assert.equal(quotaNote({ events: [] }, 0), null);
  const html = buildHtml([], { date: '2026-10-07', resumeTracks: [], warnings: [], quotaNote: quotaNote(deferred, 96) });
  assert.match(html, /<header class="masthead"><h1>[^<]*<\/h1><p class="sub">[^<]*<\/p><p class="sub quota-note" data-quota-note>Quota: Claude subscription weekly account limit reached\. 96 posting\(s\) were not reviewed because of it and wait for the next run; no engine took over\.<\/p><\/header>/);
});
