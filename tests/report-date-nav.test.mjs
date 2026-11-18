// The report's date controls (2026-11-18): the date column is gone; the top row reads ‹ "November 15, 2026" ›
// · N Jobs, the date opens a month picker, ← and → step like ‹ and ›, and every date link keeps the filter
// query. Rendering and the page script against a small fake DOM: no browser, no network.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { formatLongDate, formatMonthLabel } from '../src/time-format.mjs';
import { jobCountLabel } from '../src/report-components.mjs';
import { REPORT_SCRIPT } from '../src/report-theme.mjs';
import { REPORTS_SCRIPT, calendarMonth, datesWithMatches, neighborDates, renderDateNav } from '../src/hub/views.mjs';

const DATES = [
  { date: '2026-11-15', matchCount: 3 }, { date: '2026-11-14', matchCount: 0 }, { date: '2026-11-12', matchCount: 1 },
  { date: '2026-10-30', matchCount: 2 }, { date: '2026-08-03', matchCount: 5 },
];

test('the date reads "November 15, 2026" in the configured zone (Intl, month name, no weekday); "1 Job" in the singular', () => {
  assert.equal(formatLongDate('2026-11-15', 'America/Chicago'), 'November 15, 2026');
  // A calendar date stays that date in zones far from UTC on either side.
  for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Tokyo', 'UTC', 'Not/AZone']) assert.equal(formatLongDate('2026-01-01', zone), 'January 1, 2026', zone);
  assert.equal(formatMonthLabel('2026-11', 'America/Chicago'), 'November 2026');
  assert.equal(formatLongDate('not-a-date', 'UTC'), 'not-a-date');
  assert.equal(jobCountLabel(1), '1 Job');
  assert.equal(jobCountLabel(0), '0 Jobs');
  assert.equal(jobCountLabel(3), '3 Jobs');
});

test('‹ › go to the nearest report date with matches: 0-match days and days without a report are skipped', () => {
  assert.deepEqual(datesWithMatches(DATES), ['2026-08-03', '2026-10-30', '2026-11-12', '2026-11-15']);
  assert.deepEqual(neighborDates(DATES, '2026-11-15'), { prev: '2026-11-12', next: null }, '11-14 has 0 matches, 11-13 no report');
  assert.deepEqual(neighborDates(DATES, '2026-11-14'), { prev: '2026-11-12', next: '2026-11-15' }, 'a 0-match day still steps both ways');
  assert.deepEqual(neighborDates(DATES, '2026-08-03'), { prev: null, next: '2026-10-30' }, 'September has no report');
  const nav = renderDateNav({ dates: DATES, selected: '2026-11-15', today: '2026-11-15', timeZone: 'America/Chicago' });
  assert.match(nav, /^<span class="date-nav" id="date-nav"><a class="date-step" id="date-prev" href="\/reports\/2026-11-12" data-keep-query aria-label="Previous Day With Matches" title="Previous Day With Matches: November 12, 2026">‹<\/a><span class="date-pick"><button type="button" class="bar-date date-button" id="date-button" aria-haspopup="dialog" aria-expanded="false" aria-controls="calendar">November 15, 2026<\/button>/);
  assert.match(nav, /<button type="button" class="date-step" id="date-next" aria-label="Next Day With Matches" title="Next Day With Matches" disabled>›<\/button><\/span>$/, 'the end: disabled');
});

test('the month picker: Sunday-first, a count under each day, grey days are not links, 0 is a light link, today ringed, the date on view filled', () => {
  const byDate = new Map(DATES.map(item => [item.date, item]));
  const grid = calendarMonth({ month: '2026-11', byDate, selected: '2026-11-14', today: '2026-11-15', timeZone: 'America/Chicago', prev: '2026-10', next: '' });
  assert.match(grid, /^<div class="cal-grid" data-month="2026-11" data-label="November 2026" data-prev="2026-10" data-next="">/, 'the month on view is not hidden');
  // November 1, 2026 is a Sunday: no blank cell before it.
  assert.match(grid, /data-next=""><span class="cal-day off" aria-disabled="true" title="No Report"><span class="cal-d">1<\/span><span class="cal-n"><\/span><\/span>/);
  assert.match(grid, /<a class="cal-day" href="\/reports\/2026-11-12" data-keep-query data-date="2026-11-12" aria-label="November 12, 2026 · 1 Job"><span class="cal-d">12<\/span><span class="cal-n">1<\/span><\/a>/);
  assert.match(grid, /<span class="cal-day off" aria-disabled="true" title="No Report"><span class="cal-d">13<\/span>/, 'no report: grey, a span, not a link');
  assert.match(grid, /<a class="cal-day zero current" href="\/reports\/2026-11-14" data-keep-query data-date="2026-11-14" aria-label="November 14, 2026 · 0 Jobs" aria-current="date"><span class="cal-d">14<\/span><span class="cal-n">0<\/span><\/a>/);
  assert.match(grid, /<a class="cal-day today" href="\/reports\/2026-11-15"[^>]*><span class="cal-d">15<\/span><span class="cal-n">3<\/span><\/a>/);
  assert.equal((grid.match(/<a /g) || []).length, 3, 'only days with a report are links');
  assert.equal((grid.match(/class="cal-d"/g) || []).length, 30);
  // October 2026 starts on a Thursday: four blanks.
  assert.match(calendarMonth({ month: '2026-10', byDate, selected: '2026-11-14', today: '2026-11-15', timeZone: 'UTC' }), /hidden>(?:<span class="cal-blank" aria-hidden="true"><\/span>){4}<span class="cal-day off"[^>]*><span class="cal-d">1<\/span>/);
  const nav = renderDateNav({ dates: DATES, selected: '2026-11-14', today: '2026-11-15', timeZone: 'America/Chicago' });
  assert.deepEqual([...nav.matchAll(/data-month="(\d{4}-\d{2})"/g)].map(match => match[1]), ['2026-08', '2026-10', '2026-11'], 'only months with reports');
  assert.match(nav, /data-month="2026-10" data-label="October 2026" data-prev="2026-08" data-next="2026-11" hidden>/, 'paging skips September');
  assert.match(nav, /<div class="cal" id="calendar" role="dialog" aria-label="Choose Date" data-current="2026-11" hidden>/);
  assert.match(nav, /id="cal-prev" aria-label="Previous Month">‹<\/button><span class="cal-title" id="cal-title">November 2026<\/span><button type="button" class="cal-step" id="cal-next" aria-label="Next Month" disabled>›<\/button>/, 'the newest month: › disabled');
  assert.match(nav, /<div class="cal-foot"><a class="btn secondary cal-today" id="cal-today" href="\/reports\/2026-11-15" data-keep-query title="Today&#39;s Report: November 15, 2026">Today<\/a><\/div>/);
});

// A tiny DOM: elements with attributes, listeners, hidden/disabled, and the picker's queries.
function element(tagName, attrs = {}) {
  return {
    tagName, attrs: { ...attrs }, hidden: false, disabled: false, textContent: '', listeners: {}, children: [],
    getAttribute(name) { return this.attrs[name] ?? null; },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    contains(node) { return node === this || this.children.includes(node); },
    focus() {},
    closest() { return null; },
    get pathname() { return String(this.attrs.href || '').split('?')[0]; },
  };
}

function pageWith({ prev, next, search = '?role=internship&min=80' }) {
  const listeners = {};
  const grids = [['2026-08', '', '2026-10', 'August 2026'], ['2026-10', '2026-08', '2026-11', 'October 2026'], ['2026-11', '2026-10', '', 'November 2026']]
    .map(([month, before, after, label]) => Object.assign(element('DIV', { 'data-month': month, 'data-prev': before, 'data-next': after, 'data-label': label }), { hidden: month !== '2026-11' }));
  const calendar = element('DIV', { 'data-current': '2026-11' });
  calendar.hidden = true;
  calendar.children = grids;
  calendar.querySelectorAll = () => grids;
  calendar.querySelector = selector => {
    const month = /data-month="([^"]+)"/.exec(selector);
    if (month) return grids.find(grid => grid.attrs['data-month'] === month[1]) || null;
    if (selector === '.cal-grid:not([hidden])') return grids.find(grid => !grid.hidden) || null;
    return null;
  };
  const elements = {
    'date-button': element('BUTTON'), calendar, 'cal-backdrop': Object.assign(element('DIV'), { hidden: true }), 'cal-title': element('SPAN'),
    'cal-prev': element('BUTTON'), 'cal-next': element('BUTTON'),
    'date-prev': prev ? element('A', { href: `/reports/${prev}` }) : Object.assign(element('BUTTON'), { disabled: true }),
    'date-next': next ? element('A', { href: `/reports/${next}` }) : Object.assign(element('BUTTON'), { disabled: true }),
  };
  const removed = [];
  const location = { search, href: '' };
  const document = {
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    getElementById: id => elements[id] || null,
    querySelector: () => null,
  };
  vm.runInNewContext(REPORTS_SCRIPT, { document, location, localStorage: { removeItem: key => removed.push(key) }, fetch: () => Promise.reject(new Error('no network')) });
  const fire = (type, event) => (listeners[type] || []).forEach(fn => fn({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...event }));
  const press = (key, target = element('BODY'), extra = {}) => fire('keydown', { key, target, ...extra });
  const click = (node, target = node) => { (node.listeners.click || []).forEach(fn => fn({ target })); fire('click', { target }); };
  return { elements, grids, calendar, location, removed, fire, press, click };
}

test('the page script: date links keep the filter query, ← → step unless a field has focus, the old column\'s keys are cleared', () => {
  const page = pageWith({ prev: '2026-11-12', next: '2026-11-15' });
  assert.deepEqual(page.removed, ['hub.reports.history', 'hub.reports.onlyMatches']);
  // A click (or middle click) on ‹, ›, a picker day or Today: the href gets the current query before the browser follows it.
  const link = element('A', { href: '/reports/2026-10-30' });
  page.fire('click', { target: { closest: selector => (selector === 'a[data-keep-query]' ? link : null) } });
  assert.equal(link.attrs.href, '/reports/2026-10-30?role=internship&min=80');
  page.fire('auxclick', { target: { closest: () => link } });
  assert.equal(link.attrs.href, '/reports/2026-10-30?role=internship&min=80', 'the query is not doubled');

  page.press('ArrowLeft');
  assert.equal(page.location.href, '/reports/2026-11-12?role=internship&min=80', '← = ‹, filters kept');
  page.press('ArrowRight');
  assert.equal(page.location.href, '/reports/2026-11-15?role=internship&min=80');
  page.location.href = '';
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) page.press('ArrowLeft', element(tag));
  page.press('ArrowLeft', Object.assign(element('DIV'), { isContentEditable: true }));
  page.press('ArrowLeft', element('BODY'), { metaKey: true });
  page.press('ArrowLeft', element('BODY'), { altKey: true });
  assert.equal(page.location.href, '', 'a field with focus or a modifier: no step');

  const end = pageWith({ prev: null, next: null });
  end.press('ArrowLeft');
  end.press('ArrowRight');
  assert.equal(end.location.href, '', 'at either end the disabled button does nothing');
});

test('the page script: the picker opens on the month on view, pages only to months with reports, and closes on Escape or a click outside', () => {
  const page = pageWith({ prev: '2026-11-12', next: null });
  const { elements, grids, calendar } = page;
  const shown = () => grids.filter(grid => !grid.hidden).map(grid => grid.attrs['data-month']);
  page.click(elements['date-button']);
  assert.equal(calendar.hidden, false);
  assert.equal(elements['cal-backdrop'].hidden, false);
  assert.equal(elements['date-button'].attrs['aria-expanded'], 'true');
  assert.deepEqual(shown(), ['2026-11']);
  assert.equal(elements['cal-title'].textContent, 'November 2026');
  assert.deepEqual([elements['cal-prev'].disabled, elements['cal-next'].disabled], [false, true], 'the newest month: › disabled');
  page.click(elements['cal-prev'], calendar);
  assert.deepEqual(shown(), ['2026-10']);
  page.click(elements['cal-prev'], calendar);
  assert.deepEqual(shown(), ['2026-08'], 'September has no report and is skipped');
  assert.equal(elements['cal-title'].textContent, 'August 2026');
  assert.deepEqual([elements['cal-prev'].disabled, elements['cal-next'].disabled], [true, false], 'the first month: ‹ disabled');
  page.click(elements['cal-prev'], calendar);
  assert.deepEqual(shown(), ['2026-08'], 'nothing before the first month');
  // ← while the picker is open does not leave the page.
  page.press('ArrowLeft');
  assert.equal(page.location.href, '');
  page.press('Escape');
  assert.equal(calendar.hidden, true);
  assert.equal(elements['cal-backdrop'].hidden, true);
  assert.equal(elements['date-button'].attrs['aria-expanded'], 'false');
  page.click(elements['date-button']);
  assert.deepEqual(shown(), ['2026-11'], 'reopening shows the month on view again');
  page.fire('click', { target: element('MAIN') });
  assert.equal(calendar.hidden, true, 'a click outside closes it');
});

test('the shared bar script folds Role Type, then Track, into Filters when the one-row bar does not fit, and only then', () => {
  assert.match(REPORT_SCRIPT, /var folds = \[\['resume', 'Track'\], \['role', 'Role Type'\]\]/);
  assert.match(REPORT_SCRIPT, /if \(getComputedStyle\(toolbar\)\.flexWrap === 'nowrap'\) \{\s*for \(var i = folds\.length - 1; i >= 0 && toolbar\.scrollWidth > toolbar\.clientWidth \+ 1; i -= 1\)/, 'Role Type first, while the row overflows');
  assert.match(REPORT_SCRIPT, /\|\| \(folded\.indexOf\(' resume '\) >= 0 && current\.resume\) \|\| \(folded\.indexOf\(' role '\) >= 0 && current\.role\)/, 'a folded control that is set marks the Filters button');
  assert.match(REPORT_SCRIPT, /window\.addEventListener\('resize'/);
});

test('a filter value another date offers stays in the URL and selected on a date without it, so filters survive ‹ ›', () => {
  assert.match(REPORT_SCRIPT, /if \(control\.tagName === 'SELECT' && saved\[key\] && !Array\.prototype\.some\.call\(control\.options, function \(option\) \{ return option\.value === saved\[key\]; \}\)\) \{\s*var extra = document\.createElement\('option'\);[\s\S]*?control\.appendChild\(extra\);\s*\}\s*control\.value = saved\[key\] == null \? '' : saved\[key\];/);
});
