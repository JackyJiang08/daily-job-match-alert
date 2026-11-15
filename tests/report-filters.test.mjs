// The report filter bar (2026-11-08 redesign, compacted 2026-11-15): track, role type, Freshness, score range,
// Hide Contacted, with the state kept in the URL query. Mark as Applied and Hide Applied left the page on
// 2026-11-15: no button, no filter, no route; an appliedAt already on disk is left alone.
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
  const state = { ...DEFAULT_FILTERS, q: ' Acme ', sort: 'posted', resume: 'data', role: 'internship', freshness: 'undated', min: '80', max: '95', hideContacted: true };
  const query = writeFilters(state, '?notice=Saved');
  assert.equal(query, '?notice=Saved&q=Acme&sort=posted&resume=data&role=internship&freshness=undated&min=80&max=95&hideContacted=1');
  assert.equal(writeFilters(state, '?hideApplied=1'), query.replace('?notice=Saved&', '?'), 'an old hideApplied parameter is dropped');
  assert.deepEqual(readFilters(query), { ...state, q: 'Acme' });
  assert.equal(writeFilters(DEFAULT_FILTERS, ''), '', 'nothing set, nothing written');
  assert.equal(writeFilters(DEFAULT_FILTERS, '?role=x&min=3'), '', 'clearing the filters removes them from the URL');
  // Malformed values fall back to the defaults; a score above 100 is held to 100.
  assert.deepEqual(readFilters('?sort=evil&min=-5&max=250&hideApplied=1'), { ...DEFAULT_FILTERS, max: '100' }, 'hideApplied is no longer read');
  assert.equal(freshnessKey('new since last poll'), 'new-since-last-poll');
});

test('a card passes only when it meets every filter', () => {
  const card = { score: '84', role: 'internship', track: 'data', search: 'acme data analyst', freshness: 'undated', contacted: '0' };
  const pass = extra => cardPasses(card, { ...DEFAULT_FILTERS, ...extra });
  assert.equal(pass({}), true);
  assert.equal(pass({ role: 'internship', resume: 'data', freshness: 'undated', q: 'ACME', min: '80', max: '84' }), true);
  assert.equal(pass({ role: 'new_grad' }), false);
  assert.equal(pass({ resume: 'llm' }), false);
  assert.equal(pass({ freshness: 'posted-today' }), false);
  assert.equal(pass({ min: '85' }), false);
  assert.equal(pass({ max: '83' }), false);
  assert.equal(pass({ q: 'zeta' }), false);
  assert.equal(pass({ hideContacted: true }), true);
  assert.equal(pass({ hideApplied: true }), true, 'no such filter any more');
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
  assert.match(html, /<label class="control"><span>Freshness<\/span><select id="fresh"><option value="">Any Freshness<\/option><\/select><\/label>/, 'date-only postings sit in the main list and are no filter value');
  const mixed = buildHtml([fixtureJob(5, { carriedOver: true, firstSeenAt: '2026-10-16T02:00:00Z' }), fixtureJob(6, { postedAt: null, url: 'https://jobs.example.com/6' })], meta);
  assert.match(mixed, /<select id="fresh"><option value="">Any Freshness<\/option><option value="carried-over">Carried Over<\/option><option value="undated">Undated<\/option><\/select>/, 'in FRESHNESS_LABELS order');
  assert.match(html, /<span class="control score-range"><span>Score<\/span><input type="number" id="score-min"[^>]*aria-label="Minimum Score">/);
  assert.match(html, /<select id="role" class="control" aria-label="Role type">/);
  assert.doesNotMatch(html.split('<script>')[0], /hide-contacted|hide-applied|Mark as Applied|Hide Applied/);
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

test('Mark as Applied is gone: no button, no Hide Applied, no route; an appliedAt already on disk is kept and not shown', async () => {
  const root = await prepareReportProject();
  const hub = await startReportHub(root, { now: '2026-11-08T23:30:00Z' });
  const jobId = jobIdOf(selectedMatches()[1]);
  const stateFile = path.join(root, 'private', 'outreach', 'state.json');
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify({ version: 1, jobs: { [jobId]: { appliedAt: '2026-11-07T20:00:00.000Z', contactedAt: '2026-11-08T20:00:00.000Z' } } }));
  try {
    const page = (await hub.request('/reports/2026-10-17')).text.split('<script')[0];
    assert.match(page, /<label class="check"><input type="checkbox" id="hide-contacted"> Hide Contacted<\/label>/);
    assert.doesNotMatch(page, /hide-applied|Hide Applied|Mark as Applied|data-apply-mark|data-applied|Applied Nov/);
    assert.match(page, /data-badge="contacted"[^>]*>Contacted Nov 8</, 'the contacted mark still shows');
    assert.equal((await post(hub, '/outreach/applied', { job: jobId, applied: '1' })).status, 404, 'the route is gone');
    assert.equal(JSON.parse(await fs.readFile(stateFile, 'utf8')).jobs[jobId].appliedAt, '2026-11-07T20:00:00.000Z', 'the stored mark is untouched');
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
