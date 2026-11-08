// The strict 24-hour window (Settings > Pipeline, semanticMatching.strict24HourWindow): where each kind of
// posting date lands with the switch on and off, the default (on), and the Run Details line that names the mode
// and the group counts now that the header carries only the date, the match count and the run time.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DATE_ONLY_GROUP_TITLE, STRICT_WINDOW_HOURS, splitStrictWindow, strictWindowDetail, strictWindowEnabled, strictWindowPlacement } from '../src/strict-window.mjs';
import { CARRIED_OVER_TITLE, buildHtml, buildReportView } from '../src/report.mjs';
import { NOT_REVIEWED_TITLE } from '../src/review-status.mjs';
import { validateSettings } from '../src/hub/services.mjs';

// The run starts Nov 2, 8:00 PM in Chicago (Nov 3 01:00Z); its local day is Nov 2.
const RUN = { date: '2026-11-03', runDate: '2026-11-02', generatedAt: '2026-11-03T01:00:00.000Z', completedAt: '2026-11-03T01:40:00.000Z', timeZone: 'America/Chicago', lookbackHours: 24 };
const on = { ...RUN, strictWindow: { enabled: true, hours: 24 } };
const off = { ...RUN, strictWindow: { enabled: false, hours: 24 } };

function job(name, fields = {}) {
  return { url: `https://example.com/jobs/${name}`, title: `Data Analyst ${name}`, company: 'Example Corp', roleType: 'new_grad', matchLevel: 'high', semanticReviewed: true, bestScore: 80, scores: { data: 80 }, ...fields };
}

const POSTINGS = {
  precise: job('precise', { postedAt: '2026-11-02T18:00:00.000Z', postedAtPrecision: 'datetime', freshnessBasis: 'greenhouse_updated_at' }),
  preciseOld: job('precise-old', { postedAt: '2026-11-01T23:00:00.000Z', postedAtPrecision: 'datetime', freshnessBasis: 'email_received_at' }),
  newSincePoll: job('new-since-poll', { postedAt: '2026-10-20T12:00:00.000Z', postedAtPrecision: 'date', freshnessBasis: 'new since last poll', firstSeenAt: '2026-11-03T01:05:00.000Z' }),
  today: job('today', { postedAt: '2026-11-02T12:00:00.000Z', postedAtPrecision: 'date', freshnessBasis: 'workday_posted_on' }),
  yesterday: job('yesterday', { postedAt: '2026-11-01T12:00:00.000Z', postedAtPrecision: 'date', freshnessBasis: 'workday_posted_on' }),
  undated: job('undated', { discoveredAt: '2026-11-03T01:10:00.000Z' }),
  carried: job('carried', { postedAt: '2026-11-01T12:00:00.000Z', postedAtPrecision: 'date', carriedOver: true, firstSeenAt: '2026-11-02T01:05:00.000Z' }),
  notReviewed: job('not-reviewed', { postedAt: '2026-11-01T12:00:00.000Z', postedAtPrecision: 'date', matchLevel: 'unreviewed', scoringEngine: 'local_fallback', semanticReviewed: false }),
};

function urlsOf(cards) {
  return cards.map(card => card.url.split('/').pop());
}

test('strict window on: precise within 24 hours, new since the last poll, and dated the run\'s day stay; yesterday and undated move', () => {
  assert.equal(STRICT_WINDOW_HOURS, 24);
  const expected = { precise: 'main', preciseOld: 'date-only', newSincePoll: 'main', today: 'main', yesterday: 'date-only', undated: 'date-only' };
  for (const [name, placement] of Object.entries(expected)) assert.equal(strictWindowPlacement(POSTINGS[name], on), placement, name);
  // A precise time exactly 24 hours before the run start is still inside; a minute more is not.
  assert.equal(strictWindowPlacement(job('edge', { postedAt: '2026-11-02T01:00:00.000Z', postedAtPrecision: 'datetime' }), on), 'main');
  assert.equal(strictWindowPlacement(job('edge', { postedAt: '2026-11-02T00:59:00.000Z', postedAtPrecision: 'datetime' }), on), 'date-only');
  // The run's day is its local day: Nov 2 in Chicago although the UTC date is Nov 3.
  assert.equal(strictWindowPlacement(job('utc-day', { postedAt: '2026-11-03T12:00:00.000Z', postedAtPrecision: 'date' }), on), 'main');
  const split = splitStrictWindow(Object.values(expected).map((_, index) => POSTINGS[Object.keys(expected)[index]]), on);
  assert.equal(split.enabled, true);
  assert.deepEqual(split.main.map(item => item.url.split('/').pop()), ['precise', 'new-since-poll', 'today']);
  assert.deepEqual(split.dateOnly.map(item => item.url.split('/').pop()), ['precise-old', 'yesterday', 'undated']);
});

test('strict window off (and payloads from before the setting): every posting stays in the main list', () => {
  const jobs = Object.values(POSTINGS).filter(item => !item.carriedOver);
  for (const meta of [off, RUN]) {
    const split = splitStrictWindow(jobs, meta);
    assert.equal(split.enabled, false);
    assert.equal(split.main.length, jobs.length);
    assert.deepEqual(split.dateOnly, []);
  }
  assert.equal(strictWindowEnabled({}), true, 'default on');
  assert.equal(strictWindowEnabled({ semanticMatching: {} }), true);
  assert.equal(strictWindowEnabled({ semanticMatching: { strict24HourWindow: true } }), true);
  assert.equal(strictWindowEnabled({ semanticMatching: { strict24HourWindow: false } }), false, 'only an explicit false turns it off');
});

test('the report: strict on adds the folded date-only group; Carried over and Not reviewed are the same either way', () => {
  const jobs = Object.values(POSTINGS);
  const strict = buildReportView(jobs, on);
  assert.deepEqual(urlsOf(strict.cards), ['precise', 'new-since-poll', 'today']);
  assert.equal(strict.dateOnly.title, DATE_ONLY_GROUP_TITLE);
  assert.deepEqual(urlsOf(strict.dateOnly.cards), ['precise-old', 'yesterday', 'undated']);
  assert.deepEqual(urlsOf(strict.carried.cards), ['carried']);
  assert.deepEqual(urlsOf(strict.notReviewed.cards), ['not-reviewed']);
  assert.equal(strict.masthead.title, 'November 3, 2026');
  assert.equal(strict.masthead.subtitle, '7 Matches · Ran Nov 2, 7:40 PM', 'the count is all the day\'s matches, carried over included; no window phrase');

  const lenient = buildReportView(jobs, off);
  assert.deepEqual(urlsOf(lenient.cards), ['precise', 'precise-old', 'new-since-poll', 'today', 'yesterday', 'undated']);
  assert.equal(lenient.dateOnly, null);
  assert.deepEqual(urlsOf(lenient.carried.cards), ['carried']);
  assert.deepEqual(urlsOf(lenient.notReviewed.cards), ['not-reviewed']);
  assert.equal(lenient.masthead.subtitle, '7 Matches · Ran Nov 2, 7:40 PM');
  const term = (view, name) => view.runDetails.rows.find(row => row.term === name)?.detail;
  assert.equal(term(strict, 'Posting Window'), 'Main List: posted within the last 24 hours', 'measured over the main list alone');
  assert.equal(term(lenient, 'Posting Window'), 'Main List: posted within the last 2 days');

  const html = buildHtml(jobs, on);
  assert.match(html, /<details class="run" id="date-only"><summary>Date Only, May Be Older Than 24 Hours <span class="group-count">\(3\)<\/span><\/summary>[\s\S]*?<section class="jobs date-only" id="jobs-date-only">/);
  assert.ok(html.indexOf('id="jobs"') < html.indexOf('id="date-only"') && html.indexOf('id="date-only"') < html.indexOf('id="carried-over"'), 'main list, then the date-only group, then Carried over');
  assert.doesNotMatch(buildHtml(jobs, off), /id="date-only"/);
});

test('the header is the date and "N Matches · Ran <time>"; the mode and the group counts are in Run Details, without empty groups', () => {
  const jobs = Object.values(POSTINGS);
  const header = html => html.match(/<header class="masthead">([\s\S]*?)<\/header>/)[1];
  // A run on the report's own local day (the 18:00 run since 2026-11): the time alone.
  const today = { ...on, date: '2026-11-02' };
  assert.equal(header(buildHtml(jobs, today)), '<h1>November 2, 2026</h1><p class="sub">7 Matches · Ran 7:40 PM</p>');
  for (const meta of [on, off, today]) assert.doesNotMatch(header(buildHtml(jobs, meta)), /Strict|posted within|Main List|data-window-note/);
  const term = (meta, list = jobs) => buildReportView(list, meta).runDetails.rows.find(row => row.term === 'Strict 24-Hour Window')?.detail;
  assert.equal(term(on), 'On · Main List (3) · Date Only, May Be Older Than 24 Hours (3) · Carried Over From Yesterday (1) · Not Reviewed (Engine Unavailable) (1)');
  assert.equal(term(off), 'Off · Main List (6) · Carried Over From Yesterday (1) · Not Reviewed (Engine Unavailable) (1)');
  assert.equal(term(on, [POSTINGS.precise]), 'On · Main List (1)', 'a group with nothing in it is left out of the line');
  assert.equal(term(off, []), 'Off · Main List (0)');
  assert.equal(term(RUN), undefined, 'a payload from before the setting records no mode: no line');
  assert.equal(strictWindowDetail({ enabled: true, groups: [{ title: 'Main List', count: 0 }, { title: DATE_ONLY_GROUP_TITLE, count: 2 }, { title: CARRIED_OVER_TITLE, count: 0 }, { title: NOT_REVIEWED_TITLE, count: 0 }] }), 'On · Main List (0) · Date Only, May Be Older Than 24 Hours (2)');
  assert.match(buildHtml(jobs, on), /<dt>Strict 24-Hour Window<\/dt><dd>On · Main List \(3\) · /);
  // The embedded hub view has the same header and the same line.
  const embedded = buildReportView(jobs, today, { embedded: true });
  assert.deepEqual(embedded.masthead, { title: 'November 2, 2026', subtitle: '7 Matches · Ran 7:40 PM', note: null });
});

test('a group with no postings is not shown at all, the main list included', () => {
  // Only date-only postings: no empty main list, no "nothing cleared the threshold"; just the folded group.
  const onlyOld = buildHtml([POSTINGS.yesterday], on);
  assert.doesNotMatch(onlyOld, /id="jobs"|No new postings cleared|No match is known/);
  assert.match(onlyOld, /<details class="run" id="date-only"><summary>Date Only, May Be Older Than 24 Hours <span class="group-count">\(1\)<\/span>/);
  // Only main-list postings: none of the other groups appear.
  const onlyMain = buildHtml([POSTINGS.precise], on);
  assert.match(onlyMain, /<section class="jobs" id="jobs">/);
  assert.doesNotMatch(onlyMain, /id="date-only"|id="carried-over"|id="not-reviewed"/);
  // Nothing at all: the one empty-state line.
  assert.match(buildHtml([], on), /<div class="empty">No new postings cleared the configured threshold for this date\.<\/div>/);
  // A quota note stays in the header; it needs the owner's attention.
  assert.match(buildHtml([POSTINGS.precise], { ...on, quotaNote: '3 postings waited for the weekly limit' }), /<header class="masthead"><h1>[^<]+<\/h1><p class="sub">1 Match · Ran [^<]+<\/p><p class="sub quota-note" data-quota-note>3 postings waited for the weekly limit<\/p><\/header>/);
});

test('Settings → Pipeline validates the switch; a form without the Pipeline marker leaves it alone', () => {
  const base = { minimumMatchScore: '70', acceptedMatchLevels: 'high', hubPort: '4747' };
  assert.equal(validateSettings({ ...base, pipelinePresent: '1', strict24HourWindow: 'on' }).strict24HourWindow, true);
  assert.equal(validateSettings({ ...base, pipelinePresent: '1' }).strict24HourWindow, false, 'unchecked on the Pipeline form: off');
  assert.equal(validateSettings(base).strict24HourWindow, null);
});
