// Workday company-name cleaning, posting-date precision, and the post-enrichment freshness re-check.
import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanWorkdayCompany, displayCompanyName, hasClockTime, holdsToExactWindow, postedAtPrecision } from '../src/posting-fields.mjs';
import { applyFreshnessRecheck } from '../src/index.mjs';
import { enrichJob } from '../src/enrich.mjs';
import { buildReportView, runDetailsView } from '../src/report.mjs';
import { renderJobCard } from '../src/report-components.mjs';

test('Workday entity names lose tenant codes, unit suffixes, regions, and legal suffixes; real names are left alone', () => {
  const samples = [
    ['100000 Motorola Solutions, Inc.', 'Motorola Solutions'],
    ['1007 Clarios, LLC', 'Clarios'],
    ['US101 Guidehouse Inc.', 'Guidehouse'],
    ['TMN Acme Robotics Corp', 'Acme Robotics'],
    ['631 Booz Allen Hamilton_United States', 'Booz Allen Hamilton'],
    ['31 MSI - (Marvell Semiconductor Inc.) US', 'Marvell Semiconductor'],
    ['2100 NVIDIA USA', 'NVIDIA'],
    ['CP1367 GE Grid Solutions, LLC', 'GE Grid Solutions'],
    ['6942-ABIOMED Inc. Legal Entity', 'ABIOMED'],
    ['1000 Merck Sharp & Dohme LLC', 'Merck Sharp & Dohme'],
    ['The Boeing Company', 'The Boeing Company'],
    ['IBM Corporation', 'IBM Corporation'],
    ['GD Information Technology, Inc.', 'GD Information Technology'],
    ['Capital One', 'Capital One'],
    ['', ''],
  ];
  for (const [raw, expected] of samples) assert.equal(cleanWorkdayCompany(raw), expected, raw);
  assert.equal(displayCompanyName({ company: '100000 Motorola Solutions, Inc.', enrichment: 'workday_cxs' }), 'Motorola Solutions');
  assert.equal(displayCompanyName({ company: '1007 Clarios, LLC', url: 'https://clarios.wd5.myworkdayjobs.com/External/job/x' }), 'Clarios');
  assert.equal(displayCompanyName({ company: '1007 Clarios, LLC', url: 'https://example.com/jobs/1' }), '1007 Clarios, LLC', 'only Workday-origin names are cleaned');
  assert.equal(displayCompanyName({ company: 'Acme, Inc.', atsKind: 'greenhouse' }), 'Acme, Inc.');
});

test('the CXS detail keeps a company name the list or registry supplied and cleans the tenant entity otherwise', async () => {
  const payload = { hiringOrganization: { name: '100000 Motorola Solutions, Inc.' }, jobPostingInfo: { title: 'Data Analyst Intern', jobDescription: '<p>' + 'x'.repeat(300) + '</p>', location: 'Chicago, Illinois', postedOn: 'Posted Yesterday', timeType: 'Full time' } };
  const fetchImpl = async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  const url = 'https://motorola.wd5.myworkdayjobs.com/Careers/job/Chicago-IL/Data-Analyst-Intern_R1';
  const fromList = await enrichJob({ url, company: 'Motorola Solutions', title: 'Data Analyst Intern' }, {}, fetchImpl);
  assert.equal(fromList.company, 'Motorola Solutions');
  const bare = await enrichJob({ url, company: '', title: 'Data Analyst Intern' }, {}, fetchImpl);
  assert.equal(bare.company, 'Motorola Solutions', 'cleaned from the entity name');
  assert.equal(bare.postedAtPrecision, 'date');
  assert.equal(bare.enrichment, 'workday_cxs');
});

test('posting-date precision: API timestamps are precise, list dates and Workday days are date only, JSON-LD depends on a clock time', async () => {
  assert.equal(postedAtPrecision({ postedAt: '2026-09-18T10:00:00Z', freshnessBasis: 'greenhouse_updated_at' }), 'datetime');
  assert.equal(postedAtPrecision({ postedAt: '2026-09-18T10:00:00Z', freshnessBasis: 'lever_created_at' }), 'datetime');
  assert.equal(postedAtPrecision({ postedAt: '2026-09-18T12:00:00Z', freshnessBasis: 'source_list_date_posted' }), 'date');
  assert.equal(postedAtPrecision({ postedAt: '2026-09-18T01:00:00Z', freshnessBasis: 'workday_posted_on' }), 'date');
  assert.equal(postedAtPrecision({ postedAt: '2026-09-18T00:00:00.000Z', freshnessBasis: 'jobposting_date_posted' }), 'date', 'a midnight instant in an older payload came from a bare date');
  assert.equal(postedAtPrecision({ postedAt: '2026-09-18T09:30:00.000Z', freshnessBasis: 'jobposting_date_posted' }), 'datetime');
  assert.equal(postedAtPrecision({ postedAt: '2026-09-18T09:30:00.000Z', freshnessBasis: 'jobposting_date_posted', postedAtPrecision: 'date' }), 'date', 'an explicit precision wins');
  assert.equal(postedAtPrecision({ postedAt: null }), null);
  assert.equal(hasClockTime('2026-09-18'), false);
  assert.equal(hasClockTime('2026-09-18T10:00:00-05:00'), true);
  assert.equal(holdsToExactWindow({ postedAt: '2026-09-18T10:00:00Z', freshnessBasis: 'email_received_at' }), false, 'an email received time is not the posting time');
  assert.equal(holdsToExactWindow({ postedAt: '2026-09-18T10:00:00Z', freshnessBasis: 'ashby_published_at' }), true);

  const jsonLd = (datePosted) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Data Analyst', datePosted, hiringOrganization: { name: 'Acme' }, description: 'x'.repeat(300) })}</script></head><body></body></html>`;
  const fetchFor = html => async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  const dated = await enrichJob({ url: 'https://example.com/jobs/1', title: 'x' }, {}, fetchFor(jsonLd('2026-09-18')));
  assert.equal(dated.postedAtPrecision, 'date');
  const timed = await enrichJob({ url: 'https://example.com/jobs/2', title: 'x' }, {}, fetchFor(jsonLd('2026-09-18T10:15:00-05:00')));
  assert.equal(timed.postedAtPrecision, 'datetime');
  assert.equal(timed.postedAt, '2026-09-18T15:15:00.000Z');
});

test('the second freshness check drops precise timestamps outside the window, keeps day-level and deferred postings, and shows in Run Details', () => {
  const cutoff = new Date('2026-09-18T01:00:00Z');
  const jobs = [
    { url: 'https://a/1', title: 'old precise', postedAt: '2026-09-17T20:00:00Z', freshnessBasis: 'greenhouse_updated_at', postedAtPrecision: 'datetime' },
    { url: 'https://a/2', title: 'fresh precise', postedAt: '2026-09-18T20:00:00Z', freshnessBasis: 'lever_created_at', postedAtPrecision: 'datetime' },
    { url: 'https://a/3', title: 'old day-level workday', postedAt: '2026-09-17T20:00:00Z', freshnessBasis: 'workday_posted_on', postedAtPrecision: 'date' },
    { url: 'https://a/4', title: 'old list', postedAt: '2026-09-17T12:00:00Z', freshnessBasis: 'source_list_date_posted', postedAtPrecision: 'date' },
    { url: 'https://a/5', title: 'old jsonld bare date', postedAt: '2026-09-17T00:00:00.000Z', freshnessBasis: 'jobposting_date_posted', postedAtPrecision: 'date' },
    { url: 'https://a/6', title: 'old jsonld timed', postedAt: '2026-09-17T10:00:00.000Z', freshnessBasis: 'jobposting_date_posted', postedAtPrecision: 'datetime' },
    { url: 'https://a/7', title: 'deferred precise', postedAt: '2026-09-10T10:00:00.000Z', freshnessBasis: 'ashby_published_at', postedAtPrecision: 'datetime' },
    { url: 'https://a/8', title: 'no date', freshnessBasis: 'source_age_days_approximate', sourceAgeDays: 1 },
    { url: 'https://a/9', title: 'old email', postedAt: '2026-09-17T10:00:00.000Z', freshnessBasis: 'email_received_at' },
  ];
  const result = applyFreshnessRecheck(jobs, cutoff, job => job.url === 'https://a/7');
  assert.deepEqual(result.dropped.map(job => job.title), ['old precise', 'old jsonld timed']);
  assert.deepEqual(result.jobs.map(job => job.title), ['fresh precise', 'old day-level workday', 'old list', 'old jsonld bare date', 'deferred precise', 'no date', 'old email']);
  const rows = runDetailsView([], { date: '2026-09-19', droppedAfterPreciseTimestamps: 2, warnings: [] }, []).rows;
  assert.equal(rows.find(row => row.term === 'Freshness check').detail, 'dropped 2 postings after precise timestamps');
});

test('cards show day-level dates without a time and say so on hover; precise ones show the local time', () => {
  const meta = { date: '2026-09-19', timeZone: 'America/Chicago', resumeTracks: [{ id: 'data', label: 'Data' }], warnings: [] };
  const base = { title: 'Analyst', url: 'https://example.com/1', scores: { data: 80 }, bestScore: 80, recommendedTrack: 'data', reasons: [], gaps: [], source: 'fixture' };
  const [dayCard, preciseCard, workdayCard] = buildReportView([
    { ...base, company: 'Acme', postedAt: '2026-09-18T12:00:00.000Z', freshnessBasis: 'source_list_date_posted' },
    { ...base, company: 'Acme', postedAt: '2026-09-19T01:15:00.000Z', freshnessBasis: 'greenhouse_updated_at' },
    { ...base, company: '100000 Motorola Solutions, Inc.', url: 'https://motorola.wd5.myworkdayjobs.com/Careers/job/x', enrichment: 'workday_cxs', postedAt: '2026-09-19T01:00:00.000Z', freshnessBasis: 'workday_posted_on' },
  ], meta).cards;
  assert.equal(dayCard.footnote, 'Posted Sep 18 · fixture');
  assert.equal(dayCard.footnoteTitle, 'Date only: the source reports no time of day');
  assert.equal(preciseCard.footnote, 'Posted Sep 18, 8:15 PM · fixture');
  assert.equal(preciseCard.footnoteTitle, 'Posted Sep 18, 2026, 8:15 PM');
  assert.equal(workdayCard.company, 'Motorola Solutions', 'the render layer cleans a persisted Workday name');
  assert.equal(workdayCard.footnote, 'Posted Sep 18 · fixture', 'a Workday day-level date is shown as the local calendar day');
  assert.match(renderJobCard(dayCard), /<span class="meta" title="Date only: the source reports no time of day">Posted Sep 18 · fixture<\/span>/);
  assert.match(renderJobCard(preciseCard), /<span class="meta" title="Posted Sep 18, 2026, 8:15 PM">Posted Sep 18, 8:15 PM · fixture<\/span>/);
});
