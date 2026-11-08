// The report filter bar (2026-11-08 redesign): track, role type, Freshness, score range, Hide Contacted /
// Hide Applied, with the state kept in the URL query; and the cards' Mark as Applied, recorded in private/.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_FILTERS, cardPasses, filtersActive, freshnessKey, readFilters, writeFilters } from '../src/report-filters.mjs';
import { REPORT_SCRIPT } from '../src/report-theme.mjs';
import { buildHtml } from '../src/report.mjs';
import { jobIdOf } from '../src/hub/letters.mjs';
import { scanTitleCase } from './helpers/title-case.mjs';
import { fixtureJob, prepareReportProject, selectedMatches, startReportHub } from './helpers/report-hub.mjs';

test('the filter state round-trips through the URL query; defaults stay out and other parameters are kept', () => {
  assert.deepEqual(readFilters(''), DEFAULT_FILTERS);
  const state = { ...DEFAULT_FILTERS, q: ' Acme ', sort: 'posted', resume: 'data', role: 'internship', freshness: 'date-only', min: '80', max: '95', hideContacted: true, hideApplied: true };
  const query = writeFilters(state, '?notice=Saved');
  assert.equal(query, '?notice=Saved&q=Acme&sort=posted&resume=data&role=internship&freshness=date-only&min=80&max=95&hideContacted=1&hideApplied=1');
  assert.deepEqual(readFilters(query), { ...state, q: 'Acme' });
  assert.equal(writeFilters(DEFAULT_FILTERS, ''), '', 'nothing set, nothing written');
  assert.equal(writeFilters(DEFAULT_FILTERS, '?role=x&min=3'), '', 'clearing the filters removes them from the URL');
  // Malformed values fall back to the defaults; a score above 100 is held to 100.
  assert.deepEqual(readFilters('?sort=evil&min=-5&max=250&hideApplied=yes'), { ...DEFAULT_FILTERS, max: '100' });
  assert.equal(freshnessKey('new since last poll'), 'new-since-last-poll');
});

test('a card passes only when it meets every filter', () => {
  const card = { score: '84', role: 'internship', track: 'data', search: 'acme data analyst', freshness: 'date-only', contacted: '0', applied: '1' };
  const pass = extra => cardPasses(card, { ...DEFAULT_FILTERS, ...extra });
  assert.equal(pass({}), true);
  assert.equal(pass({ role: 'internship', resume: 'data', freshness: 'date-only', q: 'ACME', min: '80', max: '84' }), true);
  assert.equal(pass({ role: 'new_grad' }), false);
  assert.equal(pass({ resume: 'llm' }), false);
  assert.equal(pass({ freshness: 'posted-today' }), false);
  assert.equal(pass({ min: '85' }), false);
  assert.equal(pass({ max: '83' }), false);
  assert.equal(pass({ q: 'zeta' }), false);
  assert.equal(pass({ hideContacted: true }), true);
  assert.equal(pass({ hideApplied: true }), false);
  assert.equal(filtersActive(DEFAULT_FILTERS), false);
  assert.equal(filtersActive({ ...DEFAULT_FILTERS, sort: 'company' }), false, 'sorting is not a filter');
  assert.equal(filtersActive({ ...DEFAULT_FILTERS, min: '0' }), true);
});

test('the page script carries the same filter functions, reads the URL on load and writes it back', () => {
  new Function(REPORT_SCRIPT);
  for (const fn of [readFilters, writeFilters, cardPasses, filtersActive]) assert.ok(REPORT_SCRIPT.includes(fn.toString()), fn.name);
  assert.match(REPORT_SCRIPT, /restore\(readFilters\(location\.search\)\);/);
  assert.match(REPORT_SCRIPT, /history\.replaceState\(history\.state, '', location\.pathname \+ query \+ location\.hash\)/);
  assert.match(REPORT_SCRIPT, /document\.addEventListener\('report-cards-changed', apply\)/);
});

test('the Desktop report has the filter bar without the hub marks; Freshness offers only the values present', () => {
  const meta = { date: '2026-10-17', lookbackHours: 24, timeZone: 'America/Chicago', resumeTracks: [{ id: 'data', label: 'Data' }] };
  const html = buildHtml(selectedMatches().slice(0, 2), meta);
  assert.match(html, /<label class="control"><span>Freshness<\/span><select id="fresh"><option value="">Any Freshness<\/option><option value="date-only">Date Only<\/option><\/select><\/label>/);
  const mixed = buildHtml([fixtureJob(5, { carriedOver: true, firstSeenAt: '2026-10-16T02:00:00Z' }), fixtureJob(6, { postedAt: null, url: 'https://jobs.example.com/6' })], meta);
  assert.match(mixed, /<select id="fresh"><option value="">Any Freshness<\/option><option value="carried-over">Carried Over<\/option><option value="undated">Undated<\/option><\/select>/, 'in FRESHNESS_LABELS order');
  assert.match(html, /<span class="control score-range"><span>Score<\/span><input type="number" id="score-min"[^>]*aria-label="Minimum Score">/);
  assert.match(html, /<label class="control"><span>Role Type<\/span><select id="role"/);
  assert.doesNotMatch(html.split('<script>')[0], /hide-contacted|hide-applied|Mark as Applied/);
  assert.match(html, /data-freshness="date-only"/);
  assert.deepEqual(scanTitleCase(html), []);
});

function post(hub, pathname, fields) {
  const body = new URLSearchParams(fields).toString();
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: hub.port(), path: pathname, method: 'POST', headers: { host: `127.0.0.1:${hub.port()}`, 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('Mark as Applied records the day in private/, shows "Applied Nov 8" and data-applied on the card, and clears when pressed again', async () => {
  const root = await prepareReportProject();
  const hub = await startReportHub(root, { now: '2026-11-08T23:30:00Z' });
  const jobId = jobIdOf(selectedMatches()[1]);
  const cardOf = html => new RegExp(`<article class="job"[^>]*>(?:(?!<article)[\\s\\S])*?data-job="${jobId}"[^>]*aria-pressed`).exec(html)?.[0] || '';
  try {
    const before = (await hub.request('/reports/2026-10-17')).text;
    assert.match(before, /<label class="check"><input type="checkbox" id="hide-contacted"> Hide Contacted<\/label><label class="check"><input type="checkbox" id="hide-applied"> Hide Applied<\/label>/);
    assert.match(before, new RegExp(`<button type="button" class="btn secondary mark-applied" data-apply-mark="1" data-job="${jobId}" aria-pressed="false" title="[^"]+">Mark as Applied</button>`));
    assert.match(cardOf(before), /data-contacted="0" data-applied="0"/);
    const marked = JSON.parse((await post(hub, '/outreach/applied', { job: jobId, applied: '1' })).text);
    assert.deepEqual(marked, { appliedAt: '2026-11-08T23:30:00.000Z', label: 'Applied Nov 8' });
    const stored = JSON.parse(await fs.readFile(path.join(root, 'private', 'outreach', 'state.json'), 'utf8'));
    assert.equal(stored.jobs[jobId].appliedAt, '2026-11-08T23:30:00.000Z');
    const after = (await hub.request('/reports/2026-10-17')).text;
    assert.match(after, new RegExp(`data-job="${jobId}" aria-pressed="true" title="[^"]+">Applied Nov 8</button>`), 'the render cache key follows the mark');
    assert.match(cardOf(after), /data-applied="1"/);
    assert.deepEqual(JSON.parse((await post(hub, '/outreach/applied', { job: jobId, applied: '0' })).text), { appliedAt: null, label: null });
    assert.match((await hub.request('/reports/2026-10-17')).text, new RegExp(`data-job="${jobId}" aria-pressed="false"[^>]*>Mark as Applied</button>`));
    assert.equal((await post(hub, '/outreach/applied', { job: 'not-a-job', applied: '1' })).status, 400);
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
