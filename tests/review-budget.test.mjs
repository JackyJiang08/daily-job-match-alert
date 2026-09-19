// The per-run review budget (maxReviewedPerRun) and the one-time release of baseline entries that were
// recorded before in-window postings became exempt from baselines. Pure state logic, no network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_MAX_REVIEWED_PER_RUN, applyReviewBudget } from '../src/index.mjs';
import { deferredStatus, isJobSeen, markJobSeen, pruneDeferred, releaseRecentBaselines } from '../src/state.mjs';
import { runDetailsView } from '../src/report.mjs';

const NOW = new Date('2026-09-19T01:00:00Z');

function candidate(url, bestScore, extra = {}) {
  return { url, title: `Job ${bestScore}`, bestScore, scoreDetails: { data: { roleRelevance: 25 } }, blockers: [], ...extra };
}

test('seen entries written by a baseline carry the baseline flag and the posting date', () => {
  const state = { seen: {} };
  markJobSeen(state, { url: 'https://example.com/a', enrichment: 'ats_baseline', postedAt: '2026-09-18T20:00:00Z' }, NOW.toISOString());
  markJobSeen(state, { url: 'https://example.com/b', enrichment: 'greenhouse_api' }, NOW.toISOString());
  const [a, b] = Object.values(state.seen);
  assert.equal(a.baseline, true);
  assert.equal(a.postedAt, '2026-09-18T20:00:00Z');
  assert.equal(b.baseline, undefined);
  assert.equal(b.postedAt, undefined);
});

test('releasing recent baselines forgets only baseline entries from the last 48 hours and is idempotent', () => {
  const state = { seen: {} };
  const at = NOW.toISOString();
  markJobSeen(state, { url: 'https://example.com/new-baseline', enrichment: 'ats_baseline', postedAt: '2026-09-18T20:00:00Z' }, at);
  markJobSeen(state, { url: 'https://example.com/old-baseline', enrichment: 'source_baseline', postedAt: '2026-09-01T20:00:00Z' }, at);
  markJobSeen(state, { url: 'https://example.com/legacy-baseline', enrichment: 'ats_baseline' }, at);
  markJobSeen(state, { url: 'https://example.com/legacy-old-baseline', enrichment: 'ats_baseline' }, '2026-09-10T01:00:00.000Z');
  markJobSeen(state, { url: 'https://example.com/scored', enrichment: 'greenhouse_api', postedAt: '2026-09-18T20:00:00Z' }, at);
  assert.equal(releaseRecentBaselines(state, NOW, 48), 2, 'the dated recent baseline and the undated one recorded within 48 h are released');
  assert.equal(isJobSeen(state, { url: 'https://example.com/new-baseline' }), false);
  assert.equal(isJobSeen(state, { url: 'https://example.com/legacy-baseline' }), false, 'an entry without postedAt falls back to when it was recorded');
  assert.equal(isJobSeen(state, { url: 'https://example.com/old-baseline' }), true, 'an old posting stays baselined');
  assert.equal(isJobSeen(state, { url: 'https://example.com/legacy-old-baseline' }), true);
  assert.equal(isJobSeen(state, { url: 'https://example.com/scored' }), true, 'a normally scored posting is never released');
  assert.equal(releaseRecentBaselines(state, NOW, 48), 0, 'a second pass finds nothing');
  assert.equal(releaseRecentBaselines({ seen: {} }, NOW, 48), 0);
});

test('over the limit, the best local scores are reviewed and the rest are deferred without being seen', () => {
  const state = { seen: {} };
  const jobs = [candidate('https://x/1', 50), candidate('https://x/2', 90), candidate('https://x/3', 70), candidate('https://x/4', 80), { url: 'https://x/5', title: 'irrelevant', bestScore: 95, scoreDetails: { data: { roleRelevance: 0 } }, blockers: [] }];
  const budget = applyReviewBudget(jobs, state, 2, NOW);
  assert.deepEqual(budget.jobs.map(job => job.url), ['https://x/5', 'https://x/2', 'https://x/4'], 'non-candidates pass through untouched; the two best candidates are kept');
  assert.deepEqual(budget.deferred.map(job => job.url), ['https://x/3', 'https://x/1']);
  assert.deepEqual([budget.candidateCount, budget.reviewedCount, budget.limit], [4, 2, 2]);
  assert.equal(deferredStatus(state, { url: 'https://x/3' }).deferredCount, 1);
  assert.equal(deferredStatus(state, { url: 'https://x/2' }).deferred, false);
  assert.equal(isJobSeen(state, { url: 'https://x/3' }), false, 'a deferred posting is not marked seen');
  const rows = runDetailsView([], { date: '2026-09-19', candidateCount: 4, reviewedThisRun: 2, deferredCount: 2, maxReviewedPerRun: 2, warnings: [] }, []).rows;
  assert.equal(rows.find(row => row.term === 'Review budget').detail, '4 candidates · 2 reviewed · 2 deferred (limit 2 per run)');
  assert.equal(runDetailsView([], { date: '2026-09-19', candidateCount: 4, reviewedThisRun: 4, deferredCount: 0, maxReviewedPerRun: 0, warnings: [] }, []).rows.find(row => row.term === 'Review budget').detail, '4 candidates · 4 reviewed · 0 deferred (no limit)');
});

test('a posting deferred twice is reviewed first on the third run, and one deferral only nudges the ranking', () => {
  const state = { seen: {} };
  const low = candidate('https://x/low', 40);
  const high = () => [candidate('https://x/a', 90), candidate('https://x/b', 85)];
  let budget = applyReviewBudget([...high(), low], state, 2, NOW);
  assert.deepEqual(budget.deferred.map(job => job.url), ['https://x/low']);
  budget = applyReviewBudget([candidate('https://x/c', 90), candidate('https://x/d', 85), low], state, 2, new Date('2026-09-20T01:00:00Z'));
  assert.deepEqual(budget.deferred.map(job => job.url), ['https://x/low'], 'after one deferral the +10 bonus is not enough against much better candidates');
  assert.equal(deferredStatus(state, low).deferredCount, 2);
  budget = applyReviewBudget([candidate('https://x/e', 90), candidate('https://x/f', 85), low], state, 2, new Date('2026-09-21T01:00:00Z'));
  assert.deepEqual(budget.jobs.map(job => job.url), ['https://x/low', 'https://x/e'], 'twice deferred: reviewed first on the third run');
  assert.deepEqual(budget.deferred.map(job => job.url), ['https://x/f']);
  assert.equal(deferredStatus(state, low).deferred, false, 'the deferral record is cleared once reviewed');
  assert.equal(deferredStatus(state, { url: 'https://x/f' }).deferredCount, 1);
  const nudged = applyReviewBudget([candidate('https://x/g', 88), candidate('https://x/f', 85)], { seen: {}, deferred: { ...state.deferred } }, 1, NOW);
  assert.deepEqual(nudged.jobs.map(job => job.url), ['https://x/f'], 'one deferral adds 10 points: 85 + 10 beats 88');
});

test('a limit of 0 means no limit, an absent limit means the default, and stale deferrals are pruned', () => {
  const state = { seen: {} };
  const jobs = Array.from({ length: 5 }, (_, index) => candidate(`https://x/${index}`, 50 + index));
  assert.equal(applyReviewBudget(jobs, state, 0, NOW).deferred.length, 0);
  assert.equal(applyReviewBudget(jobs, state, 0, NOW).limit, 0);
  assert.equal(applyReviewBudget(jobs, state, undefined, NOW).limit, DEFAULT_MAX_REVIEWED_PER_RUN);
  assert.equal(applyReviewBudget(jobs, state, '', NOW).limit, 120);
  assert.equal(applyReviewBudget(jobs, state, 'abc', NOW).limit, 0, 'a non-number is treated as no limit');
  assert.equal(applyReviewBudget(jobs, state, undefined, NOW).deferred.length, 0);
  applyReviewBudget(jobs, state, 3, NOW);
  assert.equal(Object.keys(state.deferred).length, 2);
  assert.equal(pruneDeferred(state, new Date('2026-09-25T01:00:00Z'), 7), 0);
  assert.equal(pruneDeferred(state, new Date('2026-09-27T01:00:00Z'), 7), 2, 'deferrals older than a week are forgotten');
});
