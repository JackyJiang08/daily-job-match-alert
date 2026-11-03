// The strict 24-hour window (Settings > Pipeline, semanticMatching.strict24HourWindow): where each kind of
// posting date lands with the switch on and off, and the report header that names the mode and group counts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DATE_ONLY_GROUP_TITLE, STRICT_WINDOW_HOURS, splitStrictWindow, strictWindowEnabled, strictWindowHeadline, strictWindowPlacement } from '../src/strict-window.mjs';
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
  assert.equal(strictWindowEnabled({}), false, 'default off');
  assert.equal(strictWindowEnabled({ semanticMatching: { strict24HourWindow: true } }), true);
});

test('the report: strict on adds the folded date-only group; Carried over and Not reviewed are the same either way', () => {
  const jobs = Object.values(POSTINGS);
  const strict = buildReportView(jobs, on);
  assert.deepEqual(urlsOf(strict.cards), ['precise', 'new-since-poll', 'today']);
  assert.equal(strict.dateOnly.title, DATE_ONLY_GROUP_TITLE);
  assert.deepEqual(urlsOf(strict.dateOnly.cards), ['precise-old', 'yesterday', 'undated']);
  assert.deepEqual(urlsOf(strict.carried.cards), ['carried']);
  assert.deepEqual(urlsOf(strict.notReviewed.cards), ['not-reviewed']);
  assert.match(strict.masthead.subtitle, /^November 3, 2026 · 7 matches · posted within the last 24 hours · Ran /, 'the count is all the day\'s matches, carried over included; the window phrase is the main list\'s');

  const lenient = buildReportView(jobs, off);
  assert.deepEqual(urlsOf(lenient.cards), ['precise', 'precise-old', 'new-since-poll', 'today', 'yesterday', 'undated']);
  assert.equal(lenient.dateOnly, null);
  assert.deepEqual(urlsOf(lenient.carried.cards), ['carried']);
  assert.deepEqual(urlsOf(lenient.notReviewed.cards), ['not-reviewed']);
  assert.match(lenient.masthead.subtitle, /7 matches · posted within the last 2 days/);

  const html = buildHtml(jobs, on);
  assert.match(html, /<details class="run" id="date-only"><summary>Date only, may be older than 24 hours <span class="group-count">\(3\)<\/span><\/summary>[\s\S]*?<section class="jobs date-only" id="jobs-date-only">/);
  assert.ok(html.indexOf('id="jobs"') < html.indexOf('id="date-only"') && html.indexOf('id="date-only"') < html.indexOf('id="carried-over"'), 'main list, then the date-only group, then Carried over');
  assert.doesNotMatch(buildHtml(jobs, off), /id="date-only"/);
});

test('the header names the mode and every group\'s count', () => {
  const jobs = Object.values(POSTINGS);
  const header = html => html.match(/<header class="masthead">([\s\S]*?)<\/header>/)[1];
  assert.match(header(buildHtml(jobs, on)), /<p class="sub" data-window-note>Strict 24-hour window: on · Main list \(3\) · Date only, may be older than 24 hours \(3\) · Carried over from yesterday \(1\) · Not reviewed \(engine unavailable\) \(1\)<\/p>/);
  assert.match(header(buildHtml(jobs, off)), /<p class="sub" data-window-note>Strict 24-hour window: off · Main list \(6\) · Carried over from yesterday \(1\) · Not reviewed \(engine unavailable\) \(1\)<\/p>/);
  assert.equal(buildReportView([], off).masthead.windowNote, 'Strict 24-hour window: off · Main list (0) · Carried over from yesterday (0) · Not reviewed (engine unavailable) (0)');
  assert.equal(buildReportView([], RUN).masthead.windowNote, null, 'a payload from before the setting records no mode: no line');
  assert.doesNotMatch(buildHtml([POSTINGS.precise], RUN), /data-window-note/);
  assert.equal(strictWindowHeadline({ enabled: true, main: 0, dateOnly: 2, carried: 0, notReviewed: 0, carriedTitle: CARRIED_OVER_TITLE, notReviewedTitle: NOT_REVIEWED_TITLE }), 'Strict 24-hour window: on · Main list (0) · Date only, may be older than 24 hours (2) · Carried over from yesterday (0) · Not reviewed (engine unavailable) (0)');
  // Only date-only postings: the main list says where they went instead of "nothing cleared the threshold".
  const onlyOld = buildHtml([POSTINGS.yesterday], on);
  assert.match(onlyOld, /No match is known to be posted within 24 hours; see &quot;Date only, may be older than 24 hours&quot; below\./);
  // The embedded hub view carries the same line.
  assert.match(buildReportView(jobs, on, { embedded: true }).masthead.windowNote, /^Strict 24-hour window: on · Main list \(3\)/);
});

test('Settings → Pipeline validates the switch; a form without the Pipeline marker leaves it alone', () => {
  const base = { minimumMatchScore: '70', acceptedMatchLevels: 'high', hubPort: '4747' };
  assert.equal(validateSettings({ ...base, pipelinePresent: '1', strict24HourWindow: 'on' }).strict24HourWindow, true);
  assert.equal(validateSettings({ ...base, pipelinePresent: '1' }).strict24HourWindow, false, 'unchecked on the Pipeline form: off');
  assert.equal(validateSettings(base).strict24HourWindow, null);
});
