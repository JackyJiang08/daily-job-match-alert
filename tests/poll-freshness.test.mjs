// Freshness by poll snapshot, carried-over postings, posting-date display, and future-time correction.
// Every board answer is an injected fake; nothing here reaches the network or a model.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  SNAPSHOT_MAX_AGE_HOURS, buildSnapshot, collectAtsBoards, identifyBoard, normalizeRegistry, normalizeSnapshots, readSnapshots, registerBoards, usableSnapshot,
} from '../src/collectors/ats-boards.mjs';
import { enrichJob } from '../src/enrich.mjs';
import { freshnessMeta, main } from '../src/index.mjs';
import {
  NEW_SINCE_LAST_POLL, correctFutureTimestamp, freshnessInstant, freshnessLabel, isUndated, parsePostingDate, postedText,
} from '../src/posting-fields.mjs';
import { CARRIED_OVER_TITLE, buildHtml, buildReportView, runDetailsView } from '../src/report.mjs';
import { deferralAgeBasis, markDeferred } from '../src/state.mjs';

const ZONE = 'America/Chicago';
const LAST_NIGHT = new Date('2026-10-09T01:04:00Z'); // Oct 8, 8:04 PM in Chicago
const TONIGHT = new Date('2026-10-10T01:04:00Z'); // Oct 9, 8:04 PM

function jsonResponse(payload, { status = 200 } = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function workdayRow(title, requisition, postedOn) {
  return { title, externalPath: `/job/US-IL-Chicago/${title.replace(/\W+/g, '-')}_${requisition}`, locationsText: 'US, IL, Chicago', postedOn, bulletFields: [requisition] };
}

function workdayRegistry(extra = {}) {
  const registry = normalizeRegistry(null);
  registerBoards(registry, [identifyBoard('https://examplecorp.wd5.myworkdayjobs.com/External')], { now: new Date('2026-09-01T00:00:00Z') });
  Object.assign(registry.boards['workday:examplecorp/External'], { baselinedAt: '2026-09-01T00:00:00Z', lastNewAt: '2026-10-07T01:00:00Z', ...extra });
  return registry;
}

function workdayFetch(rows) {
  return async () => jsonResponse({ total: rows.length, jobPostings: rows });
}

// Last night's board: one posting from the day before, one posted that day.
const LAST_NIGHT_ROWS = [workdayRow('Data Analyst I', 'R100', 'Posted Today'), workdayRow('Data Engineer I', 'R090', 'Posted Yesterday')];
// Tonight: R100 now reads "Posted Yesterday" but was already there; R200 is new; R090 has aged out.
const TONIGHT_ROWS = [workdayRow('Junior Data Scientist', 'R200', 'Posted Yesterday'), workdayRow('Data Analyst I', 'R100', 'Posted Yesterday'), workdayRow('Data Engineer I', 'R090', 'Posted 2 Days Ago')];

async function twoNights({ registryExtra = {}, isDeferred = () => false, tonight = TONIGHT } = {}) {
  const registry = workdayRegistry(registryExtra);
  const snapshots = normalizeSnapshots(null);
  const first = await collectAtsBoards({ registry, snapshots, now: LAST_NIGHT, timeZone: ZONE, fetchImpl: workdayFetch(LAST_NIGHT_ROWS) });
  const second = await collectAtsBoards({ registry, snapshots, now: tonight, timeZone: ZONE, isDeferred, fetchImpl: workdayFetch(TONIGHT_ROWS) });
  return { registry, snapshots, first, second };
}

// ------------------------------------------------------------------------------------------ snapshots

test('a board posting that first appears tonight is "new since last poll"; one already there last night is left out despite "Posted Yesterday"', async () => {
  const { first, second, snapshots } = await twoNights();
  assert.equal(first.results[0].freshnessRule, 'date', 'no snapshot yet: the posting dates decide');
  assert.equal(first.results[0].snapshotReason, 'no snapshot');
  assert.deepEqual(first.jobs.map(job => job.externalId).sort(), ['R090', 'R100']);

  assert.equal(second.results[0].freshnessRule, 'snapshot');
  assert.deepEqual(second.jobs.map(job => job.externalId), ['R200'], 'R100 says "Posted Yesterday" but was on the board last night');
  const [fresh] = second.jobs;
  assert.equal(fresh.freshnessBasis, NEW_SINCE_LAST_POLL);
  assert.equal(fresh.sourceFreshnessBasis, 'workday_posted_on');
  assert.equal(fresh.firstSeenAt, TONIGHT.toISOString());
  assert.equal(fresh.previousPollAt, LAST_NIGHT.toISOString());
  assert.equal(freshnessInstant(fresh, ZONE), TONIGHT.toISOString(), 'held to the window by the moment it was first seen');
  assert.equal(second.results[0].newSinceLastPoll, 1);
  assert.equal(second.results[0].snapshotExcluded, 1, 'R100 would have passed the date rule; it is counted as left out');
  assert.equal(snapshots.boards['workday:examplecorp/External'].at, TONIGHT.toISOString(), 'tonight replaces the snapshot');
  assert.equal(snapshots.boards['workday:examplecorp/External'].count, 3);
  assert.equal(snapshots.boards['workday:examplecorp/External'].complete, true, 'the walk reached the end of the list');
});

test('a posting already on the board stays eligible when the review budget deferred it (carried over)', async () => {
  const { second } = await twoNights({ isDeferred: job => job.externalId === 'R100' });
  assert.deepEqual(second.jobs.map(job => job.externalId).sort(), ['R100', 'R200']);
  const carried = second.jobs.find(job => job.externalId === 'R100');
  assert.equal(carried.freshnessBasis, 'workday_posted_on', 'a carried posting is not new since the last poll');
  assert.equal(second.results[0].snapshotExcluded, 0);
});

test('without a usable snapshot (stale, older than 30 hours, or a failed poll after it) the board falls back to the day-level dates', async () => {
  // Tonight's poll comes 31 hours after the snapshot.
  const stale = await twoNights({ tonight: new Date(LAST_NIGHT.getTime() + (SNAPSHOT_MAX_AGE_HOURS + 1) * 3_600_000) });
  assert.equal(stale.second.results[0].freshnessRule, 'date');
  assert.equal(stale.second.results[0].snapshotReason, `snapshot older than ${SNAPSHOT_MAX_AGE_HOURS} h`);
  assert.ok(stale.second.jobs.every(job => job.freshnessBasis === 'workday_posted_on'), 'no posting is called new since the last poll');
  assert.ok(stale.second.jobs.some(job => job.externalId === 'R100'), '"Posted Yesterday" passes the day-level rule again');

  const board = { lastFailureAt: '2026-10-09T13:00:00Z' };
  const entry = buildSnapshot([{ url: 'https://example.com/a' }], { now: LAST_NIGHT, complete: true });
  assert.equal(usableSnapshot(entry, board, TONIGHT).reason, 'last poll failed');
  assert.equal(usableSnapshot(null, {}, TONIGHT).reason, 'no snapshot');
  assert.ok(usableSnapshot(entry, {}, TONIGHT).snapshot, '24 hours old and no failure after it: usable');

  // A new board: the first poll takes the baseline by dates and records the first snapshot.
  const registry = normalizeRegistry(null);
  registerBoards(registry, [identifyBoard('https://examplecorp.wd5.myworkdayjobs.com/External')], { now: TONIGHT });
  const snapshots = normalizeSnapshots(null);
  const fresh = await collectAtsBoards({ registry, snapshots, now: TONIGHT, timeZone: ZONE, fetchImpl: workdayFetch(TONIGHT_ROWS) });
  assert.equal(fresh.results[0].baseline, true);
  assert.equal(fresh.results[0].freshnessRule, 'date');
  assert.deepEqual(fresh.jobs.map(job => job.externalId).sort(), ['R100', 'R200']);
  assert.equal(snapshots.boards['workday:examplecorp/External'].count, 3);
});

test('a partial snapshot (the walk stopped at the window) still needs the posting date for a posting it may simply not have reached', async () => {
  const registry = workdayRegistry();
  const snapshots = normalizeSnapshots(null);
  const key = 'workday:examplecorp/External';
  snapshots.boards[key] = { ...buildSnapshot([], { now: LAST_NIGHT, complete: false }) };
  const result = await collectAtsBoards({ registry, snapshots, now: TONIGHT, timeZone: ZONE, fetchImpl: workdayFetch([workdayRow('Data Analyst I', 'R300', 'Posted Today'), workdayRow('Data Analyst II', 'R050', 'Posted 5 Days Ago')]) });
  assert.deepEqual(result.jobs.map(job => job.externalId), ['R300'], 'the five-day-old posting was beyond last night\'s walk, not new');
  assert.equal(result.jobs[0].freshnessBasis, NEW_SINCE_LAST_POLL);
});

test('a board answering 304 keeps its snapshot fresh; without a snapshot the conditional headers are left off', async () => {
  const registry = normalizeRegistry(null);
  registerBoards(registry, [identifyBoard('https://job-boards.greenhouse.io/examplecorp')], { now: new Date('2026-09-01T00:00:00Z') });
  Object.assign(registry.boards['greenhouse:examplecorp'], { baselinedAt: '2026-09-01T00:00:00Z', lastNewAt: '2026-10-07T00:00:00Z', etag: 'W/"abc"' });
  const snapshots = normalizeSnapshots(null);
  const seen = [];
  const listing = { jobs: [{ id: 1, absolute_url: 'https://job-boards.greenhouse.io/examplecorp/jobs/1', title: 'Data Analyst', location: { name: 'Remote - US' }, updated_at: '2026-09-20T10:00:00-04:00', content: 'SQL and Python.' }] };
  await collectAtsBoards({ registry, snapshots, now: LAST_NIGHT, fetchImpl: async (url, options) => { seen.push(options.headers['if-none-match'] || null); return new Response(JSON.stringify(listing), { status: 200, headers: { 'content-type': 'application/json', etag: 'W/"def"' } }); } });
  assert.deepEqual(seen, [null], 'no snapshot yet: the full list is fetched although the board has an ETag');
  await collectAtsBoards({ registry, snapshots, now: TONIGHT, fetchImpl: async (url, options) => { seen.push(options.headers['if-none-match'] || null); return new Response(null, { status: 304 }); } });
  assert.equal(seen[1], 'W/"def"', 'with a snapshot on file the conditional request is safe');
  assert.equal(snapshots.boards['greenhouse:examplecorp'].at, TONIGHT.toISOString());
  assert.equal(snapshots.boards['greenhouse:examplecorp'].count, 1);
});

test('the snapshot file lives beside the registry and an unreadable one only means no snapshot tonight', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshots-'));
  try {
    const file = path.join(root, 'ats-snapshots.json');
    assert.deepEqual(await readSnapshots(file), { version: 1, boards: {} });
    await fs.writeFile(file, '{ not json');
    assert.deepEqual(await readSnapshots(file), { version: 1, boards: {} });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------ carried over

test('a deferred posting new since the last poll keeps its first-seen night in the queue', () => {
  const state = {};
  const job = { url: 'https://example.com/r200', postedAt: '2026-10-08T12:00:00.000Z', postedAtPrecision: 'date', freshnessBasis: NEW_SINCE_LAST_POLL, firstSeenAt: TONIGHT.toISOString(), discoveredAt: TONIGHT.toISOString() };
  const entry = markDeferred(state, job, TONIGHT.toISOString());
  assert.equal(entry.reason, 'budget');
  assert.equal(entry.freshnessBasis, NEW_SINCE_LAST_POLL);
  assert.equal(deferralAgeBasis(entry, ZONE), TONIGHT.toISOString());
  assert.equal(markDeferred(state, { url: 'https://example.com/q' }, TONIGHT.toISOString(), 'quota').reason, 'quota');
});

const TRACKS = [{ id: 'data', label: 'Data' }];
function card(overrides = {}) {
  return { source: 'Workday · Example Corp', company: 'Example Corp', title: 'Data Analyst I', location: 'Chicago, IL', roleType: 'entry_level', url: 'https://example.com/1', scores: { data: 81 }, bestScore: 81, recommendedTrack: 'data', reasons: ['SQL'], gaps: [], matchLevel: 'high', semanticReviewed: true, ...overrides };
}

test('carried-over postings render in their own "Carried over from yesterday" group with their first-seen time; the main list keeps tonight\'s window', () => {
  const meta = { date: '2026-10-10', timeZone: ZONE, resumeTracks: TRACKS, warnings: [], completedAt: TONIGHT.toISOString() };
  const jobs = [
    card({ url: 'https://example.com/new', postedAt: '2026-10-08T12:00:00.000Z', postedAtPrecision: 'date', freshnessBasis: NEW_SINCE_LAST_POLL, firstSeenAt: TONIGHT.toISOString(), previousPollAt: LAST_NIGHT.toISOString() }),
    card({ url: 'https://example.com/old', title: 'BI Analyst', postedAt: '2026-10-08T12:00:00.000Z', postedAtPrecision: 'date', freshnessBasis: 'workday_posted_on', carriedOver: true, firstSeenAt: LAST_NIGHT.toISOString(), discoveredAt: LAST_NIGHT.toISOString() }),
  ];
  const view = buildReportView(jobs, meta);
  assert.deepEqual(view.cards.map(item => item.url), ['https://example.com/new']);
  assert.equal(view.carried.title, CARRIED_OVER_TITLE);
  assert.deepEqual(view.carried.cards.map(item => item.url), ['https://example.com/old']);
  assert.equal(view.carried.cards[0].footnote, 'Posted Oct 8 (date only) · first seen Oct 8, 8:04 PM · Workday · Example Corp');
  assert.equal(view.cards[0].footnote, 'first seen Oct 9, 8:04 PM · Workday · Example Corp');
  assert.match(view.cards[0].footnoteTitle, /not on the board at the previous poll \(Oct 8, 8:04 PM\)/);
  assert.equal(view.masthead.subtitle.includes('posted within the last 24 hours'), true, 'the carried posting does not stretch the headline window');

  const html = buildHtml(jobs, meta);
  const main = html.indexOf('<section class="jobs" id="jobs">');
  const group = html.indexOf('<h2 class="group-title" id="carried-over">Carried over from yesterday <span class="group-count">(1)</span></h2>');
  const carried = html.indexOf('<section class="jobs carried" id="jobs-carried">');
  assert.ok(main >= 0 && group > main && carried > group, 'main list, then the group heading, then the carried cards');
  assert.ok(html.indexOf('https://example.com/old') > carried, 'the carried card sits in its group');
  assert.ok(html.indexOf('https://example.com/new') < group, 'the new card sits in the main list');

  // Only carried postings: the main list says it is empty and the group still shows.
  const onlyCarried = buildHtml([jobs[1]], meta);
  assert.match(onlyCarried, /No new postings cleared the configured threshold for this date\.[\s\S]*Carried over from yesterday/);
});

test('Run Details reports the freshness rule, the postings left out, carried-over counts, and corrected future times', () => {
  const meta = freshnessMeta({
    sourceStats: [
      { kind: 'ats', ok: true, freshnessRule: 'snapshot', newSinceLastPoll: 3, snapshotExcluded: 2 },
      { kind: 'ats', ok: true, freshnessRule: 'date', snapshotReason: 'no snapshot' },
      { kind: 'ats', skipped: 'quiet (weekly poll)' },
      { kind: 'list', ok: true },
    ],
    evaluated: [{ carriedOver: true }, {}],
    futureCorrections: [{ source: 'Jobright Data Analysis New Grad', company: 'Example Corp', title: 'Data Analyst', from: '2026-10-10T04:49:00.000Z', to: '2026-10-09T12:00:00.000Z', precision: 'datetime' }],
  });
  assert.deepEqual({ ...meta, futureCorrections: undefined }, { snapshotBoards: 1, dateBoards: 1, fallbackReasons: { 'no snapshot': 1 }, newSinceLastPoll: 3, snapshotExcluded: 2, carriedOver: 1, includeCarriedOver: true, futureCorrected: 1, futureCorrections: undefined });
  const row = runDetailsView([], { date: '2026-10-10', warnings: [], freshness: meta }, TRACKS).rows.find(item => item.term === 'Freshness');
  assert.equal(row.detail, '3 new since last poll · 1 board(s) compared with the previous poll, 1 judged by posting dates (1 no snapshot) · 2 already on the board at the last poll left out · 1 carried over · 1 future posting time(s) corrected');
  assert.deepEqual(row.items, ['Example Corp · Data Analyst · Jobright Data Analysis New Grad: 2026-10-10T04:49:00.000Z → 2026-10-09 (date only)']);
});

// ------------------------------------------------------------------------------------------ display

test('dates display as "Oct 8 (date only)", "first seen Oct 9, 8:04 PM", or a local time; the Freshness label says which', () => {
  const dateOnly = { postedAt: '2026-10-08T12:00:00.000Z', postedAtPrecision: 'date', freshnessBasis: 'source_list_date_posted' };
  assert.equal(postedText(dateOnly, ZONE), 'Oct 8 (date only)');
  assert.equal(freshnessLabel(dateOnly), 'date only');
  // Older payloads stored a bare JSON-LD date as UTC midnight; it still reads as the day it names, never 00:00.
  assert.equal(postedText({ postedAt: '2026-10-08T00:00:00.000Z', postedAtPrecision: 'date' }, ZONE), 'Oct 8 (date only)');
  // A Workday "Posted Yesterday" instant is read as the local day.
  assert.equal(postedText({ postedAt: '2026-10-08T01:04:00.000Z', postedAtPrecision: 'date', freshnessBasis: 'workday_posted_on' }, ZONE), 'Oct 7 (date only)');
  const precise = { postedAt: '2026-10-09T20:12:00.000Z', postedAtPrecision: 'datetime', freshnessBasis: 'greenhouse_first_published' };
  assert.equal(postedText(precise, ZONE), 'Oct 9, 3:12 PM');
  assert.equal(freshnessLabel(precise), 'posted today');
  const fresh = { ...dateOnly, freshnessBasis: NEW_SINCE_LAST_POLL, firstSeenAt: TONIGHT.toISOString() };
  assert.equal(postedText(fresh, ZONE), 'first seen Oct 9, 8:04 PM');
  assert.equal(freshnessLabel(fresh), 'new since last poll');
  assert.equal(isUndated({ freshnessBasis: NEW_SINCE_LAST_POLL, firstSeenAt: TONIGHT.toISOString() }), false, 'a new board posting without a date is not undated');
  assert.equal(freshnessLabel({ ...dateOnly, carriedOver: true }), 'carried over');
  assert.equal(freshnessLabel({ discoveredAt: TONIGHT.toISOString() }), 'undated');
});

// ------------------------------------------------------------------------------------------ future times

test('posting pages: jobright times are UTC, a zoneless time elsewhere is cut to its date, a padded midnight is a date', () => {
  assert.deepEqual(parsePostingDate('2026-10-11 23:49:00', { url: 'https://jobright.ai/jobs/info/0a0b0c0d0e0f101112131415' }), { postedAt: '2026-10-11T23:49:00.000Z', precision: 'datetime', zoneless: true, zone: 'UTC' });
  assert.deepEqual(parsePostingDate('2026-10-11 23:49:00', { url: 'https://careers.example.com/jobs/1' }), { postedAt: '2026-10-11T12:00:00.000Z', precision: 'date', zoneless: true });
  assert.deepEqual(parsePostingDate('2026-10-08T00:00:00'), { postedAt: '2026-10-08T12:00:00.000Z', precision: 'date', zoneless: true });
  assert.deepEqual(parsePostingDate('2026-10-08'), { postedAt: '2026-10-08T12:00:00.000Z', precision: 'date', zoneless: false });
  assert.deepEqual(parsePostingDate('2026-10-08T10:15:00-05:00'), { postedAt: '2026-10-08T15:15:00.000Z', precision: 'datetime', zoneless: false });
  assert.deepEqual(parsePostingDate('2026-10-08T10:15:00Z'), { postedAt: '2026-10-08T10:15:00.000Z', precision: 'datetime', zoneless: false });
  assert.equal(parsePostingDate(''), null);
  assert.equal(parsePostingDate('soon'), null);
});

test('a jobright page enriched at 9:04 PM Chicago no longer lands in the future', async () => {
  const page = `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Data Analyst', datePosted: '2026-10-11 23:49:00', hiringOrganization: { name: 'Example Corp' }, description: 'SQL '.repeat(100) })}</script></head><body></body></html>`;
  const url = 'https://jobright.ai/jobs/info/0a0b0c0d0e0f101112131415';
  const job = await enrichJob({ url, title: 'Data Analyst', company: 'Example Corp' }, {}, async () => Object.assign(new Response(page, { status: 200, headers: { 'content-type': 'text/html' } }), {}));
  assert.equal(job.postedAt, '2026-10-11T23:49:00.000Z', '6:49 PM Chicago, not 11:49 PM');
  assert.equal(job.postedAtPrecision, 'datetime');
  assert.equal(job.postedAtZoneless, 'read as UTC');
  const run = new Date('2026-10-12T02:04:00Z');
  assert.equal(correctFutureTimestamp(job, { now: run, timeZone: ZONE }), job, 'not later than the run');
});

test('a posting time later than the run is cut to a date-only value on the run\'s day; one published while the run collects is kept', () => {
  const now = new Date('2026-10-10T01:00:00Z'); // Oct 9, 8:00 PM Chicago
  const misread = { title: 'x', postedAt: '2026-10-10T04:49:00.000Z', postedAtPrecision: 'datetime', freshnessBasis: 'jobposting_date_posted' };
  const fixed = correctFutureTimestamp(misread, { now, timeZone: ZONE });
  assert.equal(fixed.postedAt, '2026-10-09T12:00:00.000Z');
  assert.equal(fixed.postedAtPrecision, 'date');
  assert.deepEqual({ from: fixed.postedAtCorrection.from, to: fixed.postedAtCorrection.to }, { from: misread.postedAt, to: '2026-10-09T12:00:00.000Z' });
  assert.equal(postedText(fixed, ZONE), 'Oct 9 (date only)');
  // A list date one day ahead of Chicago (the list's own day is UTC) is clamped to the run's local day.
  const listAhead = correctFutureTimestamp({ postedAt: '2026-10-10T12:00:00.000Z', postedAtPrecision: 'date', freshnessBasis: 'source_list_date_posted' }, { now, timeZone: ZONE });
  assert.equal(listAhead.postedAt, '2026-10-09T12:00:00.000Z');
  // Today's date-only value is not in the future even though noon UTC may lie ahead of an early run.
  const early = new Date('2026-10-09T11:00:00Z');
  const today = { postedAt: '2026-10-09T12:00:00.000Z', postedAtPrecision: 'date' };
  assert.equal(correctFutureTimestamp(today, { now: early, timeZone: ZONE }), today);
  // A board publishing a minute after the run started, before the check: real, kept.
  const during = { postedAt: '2026-10-10T01:03:00.000Z', postedAtPrecision: 'datetime', freshnessBasis: 'greenhouse_first_published' };
  assert.equal(correctFutureTimestamp(during, { now, checkedAt: new Date('2026-10-10T01:05:00Z'), timeZone: ZONE }), during);
  assert.equal(correctFutureTimestamp(during, { now, timeZone: ZONE }).postedAtPrecision, 'date', 'without a later check time it counts as future');
});

// ------------------------------------------------------------------------------------------ end to end

async function prepareProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'poll-freshness-'));
  await fs.copyFile(new URL('./fixtures/data-resume.md', import.meta.url), path.join(root, 'data-resume.md'));
  const config = {
    lookbackHours: 24, timeZone: ZONE, minimumMatchScore: 0, reportDateOffsetDays: 0,
    semanticMatching: { engine: 'local_only', acceptedMatchLevels: ['high', 'medium', 'low'], maxReviewedPerRun: 1 },
    prescreen: { enabled: false },
    coverLetter: { autoGenerate: { enabled: false } },
    reports: { xlsx: { enabled: false, required: false } },
    outputDirectory: './output',
    resumes: { tracks: [{ id: 'data', label: 'Data', profile: './data-resume.md' }] },
    preferences: { roleTypes: ['internship', 'new_grad', 'entry_level'], locations: ['Remote'], remoteOkay: true, maxYearsExperience: 3, graduationDate: '2027-05', excludeTitleTerms: [], titleFamilies: ['data analyst', 'data scientist', 'data engineer'] },
    sources: {
      githubLists: { enabled: false }, hackerNewsHiring: { enabled: false }, remoteOk: { enabled: false }, simplifyInternships: { enabled: false }, simplifyNewGrad: { enabled: false },
      emailFiles: { enabled: false }, himalaya: { enabled: false }, careerOps: { enabled: false }, searchDiscovery: { enabled: false },
      atsBoards: { enabled: true, boards: [{ key: 'greenhouse:examplecorp', company: 'Example Corp' }] },
    },
    network: { fetchDescriptions: false, concurrency: 2, timeoutMs: 1000 },
  };
  await fs.mkdir(path.join(root, 'state'), { recursive: true });
  // An existing board (baseline taken long ago) with no snapshot yet: the first night uses the dates.
  const registry = normalizeRegistry(null);
  registerBoards(registry, [{ ...identifyBoard('https://job-boards.greenhouse.io/examplecorp'), company: 'Example Corp' }], { now: new Date('2026-09-01T00:00:00Z') });
  Object.assign(registry.boards['greenhouse:examplecorp'], { baselinedAt: '2026-09-01T00:00:00Z', lastNewAt: '2026-10-07T00:00:00Z' });
  await fs.writeFile(path.join(root, 'state', 'ats-boards.json'), JSON.stringify(registry));
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  return { root, configPath };
}

const DESCRIPTION = 'Entry-level role for recent graduates (0-2 years). Build SQL and Python analyses, dashboards in Tableau, and statistics for product teams. Must be authorized to work in the United States. '.repeat(3);
function greenhouseJob(id, title, updatedAt) {
  return { id, absolute_url: `https://job-boards.greenhouse.io/examplecorp/jobs/${id}`, title, company_name: 'Example Corp', location: { name: 'Remote - United States' }, updated_at: updatedAt, first_published: updatedAt, content: DESCRIPTION };
}

test('end to end: night one judges by dates and defers one posting; night two carries it over, takes a new posting by snapshot, and leaves out a re-dated old one', async () => {
  const { root, configPath } = await prepareProject();
  const silence = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {};
  try {
    const nightOne = [greenhouseJob(1, 'Data Analyst, New Grad', '2026-10-08T15:00:00Z'), greenhouseJob(2, 'Junior Data Scientist', '2026-10-08T16:00:00Z'), greenhouseJob(3, 'Data Engineer I', '2026-10-05T16:00:00Z')];
    await main({ argv: ['node', 'index.mjs', '--config', configPath, '--now', LAST_NIGHT.toISOString()], atsFetchImpl: async () => jsonResponse({ jobs: nightOne }), autoLetters: false });
    const first = JSON.parse(await fs.readFile(path.join(root, 'state', 'report-payload-2026-10-08.json'), 'utf8'));
    assert.equal(first.meta.freshness.dateBoards, 1);
    assert.equal(first.meta.freshness.fallbackReasons['no snapshot'], 1);
    assert.equal(first.meta.deferredCount, 1, 'the review limit of one defers the second posting');
    const deferredTitle = ['Data Analyst, New Grad', 'Junior Data Scientist'].find(title => !first.reviewed.some(job => job.title === title));

    // Night two: posting 3 was on the board last night and now looks updated; posting 4 is new with an old date.
    const nightTwo = [...nightOne.slice(0, 2), greenhouseJob(3, 'Data Engineer I', '2026-10-09T18:00:00Z'), greenhouseJob(4, 'Data Analyst I', '2026-09-20T16:00:00Z')];
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    config.semanticMatching.maxReviewedPerRun = 5;
    await fs.writeFile(configPath, JSON.stringify(config));
    await main({ argv: ['node', 'index.mjs', '--config', configPath, '--now', TONIGHT.toISOString()], atsFetchImpl: async () => jsonResponse({ jobs: nightTwo }), autoLetters: false });
    const second = JSON.parse(await fs.readFile(path.join(root, 'state', 'report-payload-2026-10-09.json'), 'utf8'));
    const byTitle = Object.fromEntries(second.reviewed.map(job => [job.title, job]));
    assert.deepEqual(Object.keys(byTitle).sort(), ['Data Analyst I', deferredTitle].sort(), 'the re-dated posting 3 is left out');
    assert.equal(byTitle['Data Analyst I'].freshnessBasis, NEW_SINCE_LAST_POLL, 'absent last night: new, despite a September date');
    assert.equal(byTitle['Data Analyst I'].firstSeenAt, TONIGHT.toISOString());
    assert.equal(byTitle[deferredTitle].carriedOver, true);
    assert.equal(byTitle[deferredTitle].firstSeenAt, LAST_NIGHT.toISOString(), 'first found on night one');
    assert.deepEqual({ snapshotBoards: second.meta.freshness.snapshotBoards, newSinceLastPoll: second.meta.freshness.newSinceLastPoll, snapshotExcluded: second.meta.freshness.snapshotExcluded, carriedOver: second.meta.freshness.carriedOver }, { snapshotBoards: 1, newSinceLastPoll: 1, snapshotExcluded: 1, carriedOver: 1 });
    const html = await fs.readFile(path.join(root, 'output', '2026-10-09', 'Daily Job Match Alert - 2026-10-09.html'), 'utf8');
    assert.match(html, /<dt>Freshness<\/dt><dd>1 new since last poll · 1 board\(s\) compared with the previous poll, 0 judged by posting dates · 1 already on the board at the last poll left out · 1 carried over · 0 future posting time\(s\) corrected/);
    assert.ok(second.matches.some(job => job.carriedOver), 'the carried posting is a match at minimum score 0');
    assert.match(html, /<h2 class="group-title" id="carried-over">Carried over from yesterday/);
    const snapshots = JSON.parse(await fs.readFile(path.join(root, 'state', 'ats-snapshots.json'), 'utf8'));
    assert.equal(snapshots.boards['greenhouse:examplecorp'].count, 4);
    assert.doesNotMatch(JSON.stringify(JSON.parse(await fs.readFile(path.join(root, 'state', 'ats-boards.json'), 'utf8'))), /"ids"/, 'the registry the hub reads stays free of snapshot ids');
  } finally {
    [console.log, console.warn, console.error] = silence;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('with carried-over postings switched off, nothing is carried: the budget leaves the rest unreviewed and an old queue is dropped', async () => {
  const { root, configPath } = await prepareProject();
  const silence = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {};
  try {
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    config.semanticMatching.includeCarriedOver = false;
    await fs.writeFile(configPath, JSON.stringify(config));
    const statePath = path.join(root, 'state', 'state.json');
    await fs.writeFile(statePath, JSON.stringify({ seen: {}, deferred: {
      a: { url: 'https://example.com/old-budget', deferredCount: 1, firstDeferredAt: '2026-10-08T01:00:00Z', postedAt: '2026-10-08T12:00:00.000Z', postedAtPrecision: 'date', reason: 'budget' },
      b: { url: 'https://example.com/old-quota', deferredCount: 1, firstDeferredAt: '2026-10-08T01:00:00Z', postedAt: '2026-10-08T12:00:00.000Z', postedAtPrecision: 'date', reason: 'quota' },
    } }));
    const jobs = [greenhouseJob(1, 'Data Analyst, New Grad', '2026-10-08T15:00:00Z'), greenhouseJob(2, 'Junior Data Scientist', '2026-10-08T16:00:00Z')];
    await main({ argv: ['node', 'index.mjs', '--config', configPath, '--now', LAST_NIGHT.toISOString()], atsFetchImpl: async () => jsonResponse({ jobs }), autoLetters: false });
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert.deepEqual(Object.values(state.deferred || {}).map(entry => entry.url), ['https://example.com/old-quota'], 'quota deferrals stay; budget ones are neither kept nor added');
    const payload = JSON.parse(await fs.readFile(path.join(root, 'state', 'report-payload-2026-10-08.json'), 'utf8'));
    assert.equal(payload.meta.freshness.includeCarriedOver, false);
    assert.ok(payload.meta.warnings.some(item => /carried-over postings are switched off: dropped 1 posting/.test(item.message)));
    assert.ok(payload.meta.warnings.some(item => /left 1 postings unreviewed .*not carried to the next run/.test(item.message)));
  } finally {
    [console.log, console.warn, console.error] = silence;
    await fs.rm(root, { recursive: true, force: true });
  }
});
