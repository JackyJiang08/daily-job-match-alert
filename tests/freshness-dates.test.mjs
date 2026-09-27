// Freshness is judged by the posting date alone: a date-only value counts as the end of that local day
// (so "yesterday" passes and "3 days ago" does not under the 24 + 24 hour rule), relative ages from
// Workday and the community lists become dates, and the discovery time stands in only when the source
// gives no date at all. Undated postings show "Unknown (found …)", rank last, and stop being carried
// after two nights. Fakes and fixtures only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { endOfLocalDay } from '../src/time-format.mjs';
import { ageBasisInstant, datePrecisionSummary, freshnessInstant, unknownPostedLabel } from '../src/posting-fields.mjs';
import { workdayPostedOn } from '../src/enrich.mjs';
import { ageDaysToPostedAt, parseListRows } from '../src/collectors/github-lists.mjs';
import { withinWindow } from '../src/collectors/ats-boards.mjs';
import { UNDATED_DEFERRAL_NIGHTS, applyBacklogExpiry, applyReviewBudget, freshnessBucket, insideLookbackWindow, postingAgeHours } from '../src/index.mjs';
import { deferredStatus, expireDeferred, isJobSeen, markDeferred } from '../src/state.mjs';
import { buildHtml, cardView, runDetailsView } from '../src/report.mjs';

const execFileAsync = promisify(execFile);
const ZONE = 'America/Chicago';
// A nightly run at 8:00 PM Chicago on Sep 26, 2026.
const NOW = new Date('2026-09-27T01:00:00Z');
const LOOKBACK = 24;
const GRACE = 24;
const cutoff = new Date(NOW.getTime() - LOOKBACK * 3_600_000);
const backlogCutoffHours = LOOKBACK + GRACE;

function candidate(url, bestScore, extra = {}) {
  return { url, title: `Job ${bestScore}`, company: 'Example Corp', source: 'fixture', bestScore, scoreDetails: { data: { roleRelevance: 25 } }, blockers: [], ...extra };
}
function workdayJob(postedOn, extra = {}) {
  return candidate(`https://example.wd5.myworkdayjobs.com/Careers/job/${postedOn.replace(/\W+/g, '-')}`, 70, { postedAt: workdayPostedOn(postedOn, NOW), freshnessBasis: 'workday_posted_on', postedAtPrecision: 'date', ...extra });
}

test('a date-only posting date is held to the window by the end of its local day, across DST and at the zone boundary', () => {
  assert.equal(endOfLocalDay('2026-09-26T15:00:00Z', ZONE), '2026-09-27T04:59:59.999Z', 'CDT: 23:59:59.999 Chicago is 04:59:59.999Z next day');
  assert.equal(endOfLocalDay('2026-09-27T04:30:00Z', ZONE), '2026-09-27T04:59:59.999Z', 'an instant late on Sep 26 Chicago time still ends on Sep 26');
  assert.equal(endOfLocalDay('2026-09-27T05:00:00Z', ZONE), '2026-09-28T04:59:59.999Z', 'one second past midnight Chicago is Sep 27');
  assert.equal(endOfLocalDay('2026-12-10T12:00:00Z', ZONE), '2026-12-11T05:59:59.999Z', 'CST');
  assert.equal(endOfLocalDay('2026-11-01T06:30:00Z', ZONE), '2026-11-02T05:59:59.999Z', 'the day the clocks fall back ends on standard time');
  assert.equal(endOfLocalDay('2026-09-26T12:00:00Z', 'Asia/Shanghai'), '2026-09-26T15:59:59.999Z');
  assert.equal(endOfLocalDay('garbage', ZONE), null);
  const precise = { postedAt: '2026-09-26T15:00:00Z', freshnessBasis: 'greenhouse_updated_at' };
  const dayOnly = { postedAt: '2026-09-26T15:00:00Z', freshnessBasis: 'workday_posted_on' };
  assert.equal(freshnessInstant(precise, ZONE), '2026-09-26T15:00:00Z', 'a precise time is used as is');
  assert.equal(freshnessInstant(dayOnly, ZONE), '2026-09-27T04:59:59.999Z');
  assert.equal(freshnessInstant({ postedAt: null, discoveredAt: NOW.toISOString() }, ZONE), null);
});

test('Workday "Posted 3 Days Ago" is out under the 24 + 24 hour rule while "Posted Yesterday" and "Posted 2 Days Ago" stay in the backlog', () => {
  const yesterday = workdayJob('Posted Yesterday');
  const twoDays = workdayJob('Posted 2 Days Ago');
  const threeDays = workdayJob('Posted 3 Days Ago');
  assert.equal(yesterday.postedAt, '2026-09-26T01:00:00.000Z', 'the relative age becomes a date instant');
  // Collection: only yesterday's posting is inside the 24-hour window; both Workday paths agree.
  assert.equal(insideLookbackWindow(yesterday, cutoff, LOOKBACK, ZONE), true);
  assert.equal(insideLookbackWindow(twoDays, cutoff, LOOKBACK, ZONE), false);
  assert.equal(withinWindow(yesterday, cutoff, ZONE), true);
  assert.equal(withinWindow(twoDays, cutoff, ZONE), false);
  // Ages: end of Sep 25 (yesterday) is 20 h before 8 PM Sep 26; end of Sep 24 is 44 h; end of Sep 23 is 68 h.
  assert.equal(Math.round(postingAgeHours(yesterday, NOW, ZONE)), 20);
  assert.equal(Math.round(postingAgeHours(twoDays, NOW, ZONE)), 44);
  assert.equal(Math.round(postingAgeHours(threeDays, NOW, ZONE)), 68);
  assert.deepEqual([yesterday, twoDays, threeDays].map(job => freshnessBucket(job, NOW, LOOKBACK, ZONE)), [0, 1, 1]);
  // The backlog: a deferred "2 Days Ago" posting is still worth scoring tonight; "3 Days Ago" expires.
  const state = { seen: {}, deferred: {} };
  for (const job of [twoDays, threeDays]) markDeferred(state, job, '2026-09-26T01:00:00.000Z');
  assert.equal(state.deferred[Object.keys(state.deferred)[0]].postedAtPrecision, 'date', 'the queue remembers the precision');
  const expiry = expireDeferred(state, NOW, backlogCutoffHours, { timeZone: ZONE });
  assert.deepEqual(expiry.urls, [threeDays.url]);
  assert.equal(deferredStatus(state, twoDays).deferred, true);
  const afterEnrichment = applyBacklogExpiry([twoDays, { ...twoDays, postedAt: workdayPostedOn('Posted 3 Days Ago', NOW) }], state, NOW, backlogCutoffHours, { timeZone: ZONE });
  assert.deepEqual(afterEnrichment.expired.map(job => job.url), [twoDays.url], 'enrichment re-dating the posting to three days ago expires it');
  // The same date judged as a precise instant would already be out; the day-level rule is the lenient one.
  const preciseTwoDays = { ...twoDays, postedAtPrecision: 'datetime', freshnessBasis: 'greenhouse_updated_at' };
  assert.equal(Math.round(postingAgeHours(preciseTwoDays, NOW, ZONE)), 48);
});

test('list age tokens ("3d", "23m") become date-only posting dates, and the collectors no longer leave such rows undated', async () => {
  assert.equal(ageDaysToPostedAt(3, NOW), '2026-09-24T01:00:00.000Z');
  assert.equal(ageDaysToPostedAt(23 / 1440, NOW), NOW.toISOString(), 'minutes round down to today');
  assert.equal(ageDaysToPostedAt(null, NOW), null);
  const rows = ['| Company | Role | Location | Posted | Visa | **Apply** |', '|---|---|---|---|---|---|', '| **Example Corp** | Data Intern | Remote | 3d |  | [Apply](https://example.com/a) |', '| **Second Co** | ML Intern | Boston | 2h |  | [Apply](https://example.com/b) |'].join('\n');
  const jobs = parseListRows(rows, { source: 'Zapply Internships 2027', roleType: 'internship', format: 'zapply', now: NOW });
  assert.deepEqual(jobs.map(job => [job.postedAt, job.postedAtPrecision, job.freshnessBasis, job.sourceAgeDays]), [
    ['2026-09-24T01:00:00.000Z', 'date', 'source_list_age', 3],
    [NOW.toISOString(), 'date', 'source_list_age', 2 / 24],
  ]);
  assert.equal(insideLookbackWindow(jobs[0], cutoff, LOOKBACK, ZONE), false, '"3d" is Sep 23: out of the window');
  assert.equal(insideLookbackWindow(jobs[1], cutoff, LOOKBACK, ZONE), true);
});

test('the discovery time stands in only for a posting with no date at all; a dated posting is never judged by when it was found', () => {
  // Posted yesterday, but first seen by this pipeline five days ago (a list that lagged): still fresh.
  const datedOldDiscovery = workdayJob('Posted Yesterday', { discoveredAt: '2026-09-21T01:00:00Z' });
  assert.equal(ageBasisInstant(datedOldDiscovery, ZONE), '2026-09-26T04:59:59.999Z', 'the end of Sep 25 Chicago time');
  assert.equal(freshnessBucket(datedOldDiscovery, NOW, LOOKBACK, ZONE), 0);
  // Posted three days ago, discovered tonight: the discovery time does not rescue it.
  const staleFoundTonight = workdayJob('Posted 3 Days Ago', { discoveredAt: NOW.toISOString() });
  assert.equal(freshnessBucket(staleFoundTonight, NOW, LOOKBACK, ZONE), 1);
  const state = { seen: {}, deferred: {} };
  markDeferred(state, staleFoundTonight, NOW.toISOString());
  assert.deepEqual(expireDeferred(state, NOW, backlogCutoffHours, { timeZone: ZONE }).urls, [staleFoundTonight.url], 'the queue ages it by its posting date, not its discovery');
  // No date at all: the discovery time is the only basis.
  const undated = candidate('https://careers.example.com/oracle/job/1', 65, { postedAt: null, discoveredAt: '2026-09-26T02:00:00Z' });
  assert.equal(ageBasisInstant(undated, ZONE), '2026-09-26T02:00:00Z');
  assert.equal(Math.round(postingAgeHours(undated, NOW, ZONE)), 23);
  markDeferred(state, undated, NOW.toISOString());
  assert.deepEqual(expireDeferred(state, NOW, backlogCutoffHours, { timeZone: ZONE }), { removed: 0, urls: [] });
  assert.deepEqual(expireDeferred(state, new Date(NOW.getTime() + 30 * 3_600_000), backlogCutoffHours, { timeZone: ZONE }).urls, [undated.url], 'an undated posting expires by its discovery time');
});

test('an undated posting shows "Unknown (found Sep 26)" on the card and in the workbook', async () => {
  const undated = { ...candidate('https://careers.example.com/oracle/job/1', 65), roleType: 'new_grad', postedAt: null, discoveredAt: '2026-09-26T02:00:00Z', scores: { data: 65 }, recommendedTrack: 'data', matchLevel: 'high', reasons: ['fit'], gaps: [], description: 'x' };
  assert.equal(unknownPostedLabel(undated, ZONE), 'Unknown (found Sep 25)', 'the discovery instant is rendered in the local zone');
  assert.equal(unknownPostedLabel({ ...undated, discoveredAt: '2026-09-26T15:00:00Z' }, ZONE), 'Unknown (found Sep 26)');
  assert.equal(unknownPostedLabel({ ...undated, discoveredAt: null }, ZONE), 'Unknown');
  const card = cardView({ ...undated, discoveredAt: '2026-09-26T15:00:00Z' }, [{ id: 'data', label: 'Data' }], ZONE);
  assert.equal(card.footnote, 'Posted Unknown (found Sep 26) · fixture');
  assert.equal(card.footnoteTitle, 'The source reports no posting date; the day shown is when this pipeline first found it');
  const html = buildHtml([{ ...undated, discoveredAt: '2026-09-26T15:00:00Z' }], { date: '2026-09-26', lookbackHours: 24, timeZone: ZONE, resumeTracks: [{ id: 'data', label: 'Data' }] });
  assert.match(html, /Posted Unknown \(found Sep 26\) · fixture/);

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xlsx-undated-'));
  try {
    const payload = { meta: { applicationDate: '2026-09-26', date: '2026-09-26', generatedAt: NOW.toISOString(), timeZone: ZONE, lookbackHours: 24, reviewedCount: 1, minimumMatchScore: 60, scoringModel: 'local_only', resumeTracks: [{ id: 'data', label: 'Data' }], warnings: [] }, matches: [{ ...undated, discoveredAt: '2026-09-26T15:00:00Z', recommendedResume: 'Data' }], reviewed: [] };
    const payloadPath = path.join(directory, 'payload.json');
    const outputPath = path.join(directory, 'report.xlsx');
    await fs.writeFile(payloadPath, JSON.stringify(payload));
    await execFileAsync(process.execPath, [new URL('../src/report-xlsx.mjs', import.meta.url).pathname, payloadPath, outputPath, '--verify']);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    const sheet = workbook.getWorksheet('Matches');
    const postedColumn = sheet.getRow(1).values.indexOf('Posted At');
    assert.equal(sheet.getCell(2, postedColumn).value, 'Unknown (found Sep 26)');
    let note = '';
    workbook.getWorksheet('Notes').eachRow(row => { if (String(row.getCell(1).value) === 'Posted At') note = String(row.getCell(2).value); });
    assert.match(note, /Unknown \(found Sep 26\)/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('undated postings rank after every dated one and are dropped from the queue after two nights without a date', () => {
  const state = { seen: {}, deferred: {} };
  const fresh = workdayJob('Posted Yesterday', { bestScore: 40 });
  const backlog = workdayJob('Posted 2 Days Ago', { bestScore: 90 });
  const undatedHigh = candidate('https://careers.example.com/oracle/job/high', 99, { discoveredAt: NOW.toISOString() });
  const undatedLow = candidate('https://careers.example.com/oracle/job/low', 30, { discoveredAt: NOW.toISOString() });
  const night = (state, jobs, now) => applyReviewBudget(jobs, state, 1, now, { lookbackHours: LOOKBACK, timeZone: ZONE });
  const first = night(state, [undatedHigh, backlog, undatedLow, fresh], NOW);
  assert.deepEqual(first.ranking.map(item => [item.url, item.bucket, item.kept]), [
    [fresh.url, 0, true], [backlog.url, 1, false], [undatedHigh.url, 2, false], [undatedLow.url, 2, false],
  ], 'fresh, then backlog, then undated, whatever the local score');
  assert.equal(first.undatedCount, 2);
  assert.deepEqual(first.abandoned, []);
  assert.deepEqual([undatedHigh, undatedLow].map(job => deferredStatus(state, job).deferredCount), [1, 1]);

  // Night two: still no date, deferred once more.
  const nightTwo = new Date(NOW.getTime() + 24 * 3_600_000);
  const second = night(state, [undatedHigh, undatedLow, workdayJob('Posted Today', { bestScore: 10, url: 'https://example.com/tonight-2' })], nightTwo);
  assert.deepEqual(second.abandoned, []);
  assert.deepEqual([undatedHigh, undatedLow].map(job => deferredStatus(state, job).deferredCount), [2, 2]);

  // Night three: two nights of deferral without a date; they are not deferred again, and are marked seen so they stop returning.
  const nightThree = new Date(NOW.getTime() + 48 * 3_600_000);
  const third = night(state, [undatedHigh, undatedLow, workdayJob('Posted Today', { bestScore: 10, url: 'https://example.com/tonight-3' })], nightThree);
  assert.equal(UNDATED_DEFERRAL_NIGHTS, 2);
  assert.deepEqual(third.abandoned.map(job => job.url), [undatedHigh.url, undatedLow.url]);
  assert.deepEqual(third.deferred, []);
  assert.deepEqual([undatedHigh, undatedLow].map(job => deferredStatus(state, job).deferred), [false, false]);
  assert.deepEqual([undatedHigh, undatedLow].map(job => isJobSeen(state, job)), [true, true]);
  assert.equal(Object.values(state.seen).find(entry => entry.url === undatedHigh.url).lastEnrichment, 'undated_abandoned');
  assert.deepEqual(third.ranking.filter(item => item.abandoned).length, 2);

  // An undated posting that gains a date after a deferral is a dated posting again and is never abandoned.
  const dated = { ...candidate('https://careers.example.com/oracle/job/dated', 50, { discoveredAt: NOW.toISOString() }) };
  const other = { seen: {}, deferred: {} };
  markDeferred(other, dated, NOW.toISOString());
  markDeferred(other, dated, nightTwo.toISOString());
  const result = night(other, [{ ...dated, postedAt: '2026-09-28T15:00:00Z', postedAtPrecision: 'date' }, workdayJob('Posted Today', { bestScore: 99, url: 'https://example.com/top' })], nightThree);
  assert.deepEqual(result.abandoned, []);
  assert.equal(result.ranking.find(item => item.url === dated.url).bucket, 0);
});

test('Run Details counts date precision per source and reports undated postings dropped from the queue', () => {
  const jobs = [
    { source: 'Example Corp (Greenhouse)', postedAt: '2026-09-26T15:00:00Z', freshnessBasis: 'greenhouse_updated_at' },
    { source: 'Example Corp (Greenhouse)', postedAt: '2026-09-26T16:00:00Z', freshnessBasis: 'greenhouse_updated_at' },
    { source: 'Workday · Example Corp', postedAt: '2026-09-26T01:00:00Z', freshnessBasis: 'workday_posted_on', postedAtPrecision: 'date' },
    { source: 'Workday · Example Corp', postedAt: null, discoveredAt: NOW.toISOString() },
    { source: 'Zapply Internships 2027', postedAt: '2026-09-25T01:00:00Z', postedAtPrecision: 'date', freshnessBasis: 'source_list_age' },
    { postedAt: null },
  ];
  const summary = datePrecisionSummary(jobs);
  assert.deepEqual(summary, {
    datetime: 2, date: 2, none: 2,
    bySource: [
      { source: 'Example Corp (Greenhouse)', datetime: 2, date: 0, none: 0 },
      { source: 'Workday · Example Corp', datetime: 0, date: 1, none: 1 },
      { source: 'unknown source', datetime: 0, date: 0, none: 1 },
      { source: 'Zapply Internships 2027', datetime: 0, date: 1, none: 0 },
    ],
  });
  const meta = { date: '2026-09-26', timeZone: ZONE, resumeTracks: [{ id: 'data', label: 'Data' }], warnings: [], datePrecision: summary, candidateCount: 6, candidateInWindowCount: 3, reviewedThisRun: 4, deferredCount: 0, expiredBacklogCount: 1, undatedAbandonedCount: 2, maxReviewedPerRun: 120 };
  const rows = runDetailsView([], meta, meta.resumeTracks).rows;
  const precision = rows.find(row => row.term === 'Date precision');
  assert.equal(precision.detail, '2 precise · 2 date only · 2 undated (by source below)');
  assert.deepEqual(precision.items, [
    'Example Corp (Greenhouse): 2 precise · 0 date only · 0 undated',
    'Workday · Example Corp: 0 precise · 1 date only · 1 undated',
    'unknown source: 0 precise · 0 date only · 1 undated',
    'Zapply Internships 2027: 0 precise · 1 date only · 0 undated',
  ]);
  assert.equal(rows.find(row => row.term === 'Review budget').detail, '6 candidates (3 within the window) · 4 reviewed · 0 deferred · expired 1 backlog postings · stopped carrying 2 undated postings (limit 120 per run)');
  assert.equal(runDetailsView([], { ...meta, datePrecision: undefined }, meta.resumeTracks).rows.some(row => row.term === 'Date precision'), false, 'older payloads have no row');
});
