// The per-run review budget (maxReviewedPerRun) and the one-time release of baseline entries that were
// recorded before in-window postings became exempt from baselines. Pure state logic, no network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BUDGET_ALERT_NIGHTS, DEFAULT_MAX_REVIEWED_PER_RUN, applyBacklogExpiry, applyReviewBudget, freshnessBucket, mergeNearDuplicates, recordBudgetHistory } from '../src/index.mjs';
import { deferredStatus, expireDeferred, isJobSeen, markDeferred, markJobSeen, releaseRecentBaselines } from '../src/state.mjs';
import { mastheadSubtitle, postingWindowLabel } from '../src/report.mjs';
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

test('a limit of 0 means no limit and an absent limit means the default', () => {
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
});

test('the backlog expires by posting age, not by how long it has waited: 48 hours after posting (or first discovery) a deferred entry leaves the queue unscored and unseen', () => {
  const state = { seen: {} };
  const at = '2026-09-19T01:00:00.000Z';
  markDeferred(state, { url: 'https://x/fresh', postedAt: '2026-09-18T20:00:00Z' }, at);
  markDeferred(state, { url: 'https://x/old', postedAt: '2026-09-16T20:00:00Z' }, at);
  markDeferred(state, { url: 'https://x/day-level', discoveredAt: '2026-09-18T02:00:00Z' }, at);
  markDeferred(state, { url: 'https://x/day-level-old', discoveredAt: '2026-09-16T02:00:00Z' }, at);
  markDeferred(state, { url: 'https://x/undated' }, '2026-09-10T01:00:00.000Z');
  const result = expireDeferred(state, NOW, 48);
  assert.deepEqual(result.urls.sort(), ['https://x/day-level-old', 'https://x/old', 'https://x/undated'], 'posting date, then first discovery, then first deferral decide');
  assert.equal(result.removed, 3);
  assert.deepEqual(Object.values(state.deferred).map(entry => entry.url).sort(), ['https://x/day-level', 'https://x/fresh']);
  for (const url of result.urls) assert.equal(isJobSeen(state, { url }), false, `${url} is not marked seen`);
  assert.deepEqual(expireDeferred(state, NOW, 48), { removed: 0, urls: [] }, 'a second pass (the startup migration is idempotent) finds nothing');
  // After enrichment a deferred posting can turn out older than the queue knew.
  const enriched = [{ ...candidate('https://x/fresh', 60), postedAt: '2026-09-15T20:00:00Z' }, candidate('https://x/day-level', 70)];
  const expiry = applyBacklogExpiry(enriched, state, NOW, 48);
  assert.deepEqual(expiry.expired.map(job => job.url), ['https://x/fresh']);
  assert.deepEqual(expiry.jobs.map(job => job.url), ['https://x/day-level']);
  assert.equal(deferredStatus(state, { url: 'https://x/fresh' }).deferred, false, 'the expired entry is cleared');
  assert.equal(isJobSeen(state, { url: 'https://x/fresh' }), false);
  assert.deepEqual(applyBacklogExpiry([candidate('https://x/never-deferred', 60)], state, NOW, 48).expired, [], 'only deferred postings expire here');
});

test('tonight\'s postings always rank ahead of the backlog; score and deferral bonuses only reorder within a bucket', () => {
  const state = { seen: {} };
  const tonightLow = { ...candidate('https://x/tonight-low', 40), postedAt: '2026-09-18T20:00:00Z' };
  const tonightHigh = { ...candidate('https://x/tonight-high', 60), postedAt: '2026-09-18T22:00:00Z' };
  const backlogHigh = { ...candidate('https://x/backlog-high', 95), postedAt: '2026-09-17T12:00:00Z' };
  const backlogTwice = { ...candidate('https://x/backlog-twice', 50), postedAt: '2026-09-17T13:00:00Z' };
  state.deferred = {};
  markDeferred(state, backlogTwice, '2026-09-17T01:00:00Z');
  markDeferred(state, backlogTwice, '2026-09-18T01:00:00Z');
  markDeferred(state, backlogHigh, '2026-09-18T01:00:00Z');
  assert.equal(freshnessBucket(tonightLow, NOW, 24), 0);
  assert.equal(freshnessBucket(backlogHigh, NOW, 24), 1);
  assert.equal(freshnessBucket(candidate('https://x/undated', 10), NOW, 24), 0, 'no date at all counts as tonight');
  const budget = applyReviewBudget([backlogHigh, tonightLow, backlogTwice, tonightHigh], state, 3, NOW, { lookbackHours: 24 });
  assert.deepEqual(budget.ranking.map(item => [item.url, item.bucket, item.kept]), [
    ['https://x/tonight-high', 0, true], ['https://x/tonight-low', 0, true], ['https://x/backlog-twice', 1, true], ['https://x/backlog-high', 1, false],
  ], 'both of tonight\'s postings come first even against a 95-point backlog posting; within the backlog the twice-deferred one leads');
  assert.deepEqual([budget.candidateCount, budget.inWindowCount, budget.reviewedCount], [4, 2, 3]);
  assert.deepEqual(budget.deferred.map(job => job.url), ['https://x/backlog-high']);
});

test('the budget alert fires only after three consecutive nights over budget and shows the seven-night curve', () => {
  const state = { seen: {} };
  const night = (date, inWindow, limit = 2) => recordBudgetHistory(state, { date, at: `${date}T01:00:00Z`, candidates: inWindow + 1, inWindow, limit, reviewed: Math.min(inWindow, limit) });
  assert.equal(night('2026-09-16', 5), null);
  assert.equal(night('2026-09-17', 5), null, 'two nights are not enough');
  assert.equal(night('2026-09-18', 1), null, 'a quiet night resets the streak');
  assert.equal(night('2026-09-19', 5), null);
  assert.equal(night('2026-09-20', 5), null);
  const alert = night('2026-09-21', 6);
  assert.equal(alert.nights, BUDGET_ALERT_NIGHTS);
  assert.equal(alert.message, 'Candidates inside the lookback window have exceeded the review budget for 3 nights in a row (2026-09-19: 5/2, 2026-09-20: 5/2, 2026-09-21: 6/2); raise semanticMatching.maxReviewedPerRun or tighten the prefilter');
  assert.equal(alert.history.length, 6);
  const rerun = night('2026-09-21', 7);
  assert.equal(rerun.history.length, 6, 'a same-day rerun overwrites its own entry instead of adding one');
  assert.match(rerun.message, /2026-09-21: 7\/2\)/);
  assert.equal(night('2026-09-22', 9).history.length, 7);
  night('2026-09-23', 9);
  assert.equal(state.budgetHistory.length, 7, 'only the last seven nights are kept');
  assert.equal(state.budgetHistory[0].date, '2026-09-17');
  const unlimited = { seen: {} };
  for (const date of ['2026-09-19', '2026-09-20', '2026-09-21']) recordBudgetHistory(unlimited, { date, at: `${date}T01:00:00Z`, candidates: 9, inWindow: 9, limit: 0, reviewed: 9 });
  assert.equal(recordBudgetHistory(unlimited, { date: '2026-09-22', at: 'x', candidates: 9, inWindow: 9, limit: 0, reviewed: 9 }), null, 'no budget, no alert');
});

test('near-duplicate postings (same company, normalized title, and location on different URLs) merge into one card with alternate links; URLs elsewhere stay distinct', () => {
  const base = { company: 'Live Oak Bank', location: 'Wilmington, NC', description: 'x'.repeat(300), postedAt: '2026-09-18T20:00:00Z', source: 'Workday · Live Oak Bank' };
  const jobs = [
    { ...base, url: 'https://liveoak.wd1.myworkdayjobs.com/External/job/Wilmington-NC/Data-Analyst_R-1234', title: 'Data Analyst (R-1234)', description: 'x'.repeat(200) },
    { ...base, url: 'https://liveoak.wd1.myworkdayjobs.com/Campus/job/Wilmington-NC/Data-Analyst_R-1234-1', title: 'Data Analyst', source: 'SimplifyJobs New Grad' },
    { ...base, url: 'https://liveoak.wd1.myworkdayjobs.com/External/job/Raleigh-NC/Data-Analyst_R-9999', title: 'Data Analyst', location: 'Raleigh, NC' },
    { ...base, company: 'Live Oak Bank, Inc.', url: 'https://example.com/other', title: 'Data  Analyst!' },
    { company: '', title: 'Nameless', url: 'https://example.com/nameless', description: 'y' },
  ];
  const merged = mergeNearDuplicates(jobs);
  assert.equal(merged.mergedCount, 2);
  assert.equal(merged.jobs.length, 3);
  const primary = merged.jobs.find(job => job.alternates);
  assert.equal(primary.url, 'https://liveoak.wd1.myworkdayjobs.com/Campus/job/Wilmington-NC/Data-Analyst_R-1234-1', 'the copy with the longest description is the card');
  assert.deepEqual(primary.alternates.map(item => item.url), ['https://liveoak.wd1.myworkdayjobs.com/External/job/Wilmington-NC/Data-Analyst_R-1234', 'https://example.com/other']);
  assert.equal(primary.source, 'Workday · Live Oak Bank | SimplifyJobs New Grad');
  assert.ok(merged.jobs.some(job => job.location === 'Raleigh, NC' && !job.alternates), 'a different location is a different posting');
  assert.ok(merged.jobs.some(job => job.url === 'https://example.com/nameless'), 'a posting without a company is left alone');
  assert.deepEqual(merged.groups, [{ primary: primary.url, alternates: primary.alternates.map(item => item.url) }]);
  assert.equal(mergeNearDuplicates([]).mergedCount, 0);
});

test('the masthead describes the real posting window of the report', () => {
  const meta = { date: '2026-09-19', timeZone: 'America/Chicago', completedAt: '2026-09-19T01:00:00Z' };
  assert.equal(postingWindowLabel([{ postedAt: '2026-09-18T20:00:00Z' }, { postedAt: '2026-09-18T02:00:00Z' }], meta), 'posted within the last 24 hours');
  assert.equal(postingWindowLabel([{ postedAt: '2026-09-18T20:00:00Z' }, { postedAt: '2026-09-17T12:00:00Z' }], meta), 'posted within the last 2 days');
  assert.equal(postingWindowLabel([{ discoveredAt: '2026-09-14T12:00:00Z' }], meta), 'posted within the last 5 days', 'discovery time stands in for day-level sources');
  assert.equal(postingWindowLabel([{ title: 'undated' }], meta), null);
  assert.equal(postingWindowLabel([], meta), null);
  assert.equal(postingWindowLabel([{ postedAt: '2026-09-18T20:00:00Z' }], { date: '2026-09-19' }), null, 'no run time, no window (never the wall clock)');
  assert.equal(mastheadSubtitle([{ postedAt: '2026-09-18T20:00:00Z' }], meta), 'September 19, 2026 · 1 match · posted within the last 24 hours · Ran Sep 18, 8:00 PM');
  assert.equal(mastheadSubtitle([], meta), 'September 19, 2026 · No matches · Ran Sep 18, 8:00 PM');
});
