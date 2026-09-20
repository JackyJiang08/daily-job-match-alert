// Workday company-name cleaning, posting-date precision, and the post-enrichment freshness re-check.
import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanWorkdayCompany, companyFromUrl, companyIsUncertain, displayCompanyName, hasClockTime, holdsToExactWindow, isValidCompanyName, postedAtPrecision, resolveCompanyName } from '../src/posting-fields.mjs';
import { finalizeCompany } from '../src/index.mjs';
import { buildResultSchema, buildSemanticPrompt, mergeSemanticResults } from '../src/subscription-match.mjs';
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

test('company validation: legal words alone, codes, numbers, and generic words fail; real names pass', () => {
  for (const [name, expected] of [
    ['Inc. Company', false], ['LLC', false], ['US101', false], ['Us101', false], ['1007 Clarios, LLC', false], ['R-123456', false], ['100000', false],
    ['Company', false], ['External', false], ['Hiring', false], ['a', false], ['', false], [null, false],
    ['The Boeing Company', true], ['Clarios', true], ['IBM', true], ['Motorola Solutions', true], ['LexisNexis Legal', true], ['Acme, Inc.', true], ['GD Information Technology, Inc.', true],
  ]) assert.equal(isValidCompanyName(name), expected, String(name));
});

test('the URL is the last candidate: Workday site names become words, board slugs are title-cased', () => {
  assert.equal(companyFromUrl('https://relx.wd3.myworkdayjobs.com/LexisNexisLegal/job/x'), 'LexisNexis Legal');
  assert.equal(companyFromUrl('https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/x'), 'NVIDIA');
  assert.equal(companyFromUrl('https://x.wd5.myworkdayjobs.com/External/job/y'), 'X', 'a generic site name falls back to the tenant');
  assert.equal(companyFromUrl('https://job-boards.greenhouse.io/acme-inc/jobs/1'), 'Acme Inc');
  assert.equal(companyFromUrl('https://jobs.lever.co/zoox/abc'), 'Zoox');
  assert.equal(companyFromUrl('https://jobs.ashbyhq.com/examplecorp/1'), 'Examplecorp');
  assert.equal(companyFromUrl('https://www.example.com/careers/1'), '');
  assert.equal(companyFromUrl('nope'), '');
});

test('the candidate chain takes the first valid name in order and marks the job uncertain when none passes', () => {
  const url = 'https://relx.wd3.myworkdayjobs.com/LexisNexisLegal/job/Analyst_R1';
  assert.deepEqual(resolveCompanyName({ companyFromSource: 'RELX', boardCompany: 'LexisNexis', employerNameFromJd: 'LexisNexis Risk', atsCompany: '1000 RELX Inc.', url }).name, 'RELX');
  assert.equal(resolveCompanyName({ companyFromSource: 'US101', boardCompany: 'LexisNexis', employerNameFromJd: 'LexisNexis Risk', atsCompany: '1000 RELX Inc.', url }).source, 'registry', 'an invalid source name falls through');
  assert.equal(resolveCompanyName({ companyFromSource: '', employerNameFromJd: 'LexisNexis Risk', atsCompany: '1000 RELX Inc.', url }).source, 'employerName', 'the scorer\'s employer name is third');
  const ats = resolveCompanyName({ companyFromSource: '', atsCompany: '1000 RELX Inc.', url });
  assert.deepEqual([ats.name, ats.source], ['RELX', 'ats'], 'the ATS entity is cleaned before it is judged');
  const fromUrl = resolveCompanyName({ companyFromSource: '', atsCompany: 'US101', url });
  assert.deepEqual([fromUrl.name, fromUrl.source, fromUrl.uncertain], ['LexisNexis Legal', 'url', false]);
  const nothing = resolveCompanyName({ company: 'US101', atsCompany: 'US101', url: 'https://x.wd5.myworkdayjobs.com/External/job/y' });
  assert.deepEqual([nothing.name, nothing.uncertain], ['US101', true], 'the most name-like candidate is kept but flagged');
  assert.equal(resolveCompanyName({ company: '1007 Clarios, LLC', enrichment: 'workday_cxs', url: 'https://clarios.wd5.myworkdayjobs.com/External/job/x' }).name, 'Clarios', 'an older payload with only the raw Workday entity still cleans it');
  assert.equal(resolveCompanyName({ company: 'Acme, Inc.', url: 'https://example.com/jobs/1' }).name, 'Acme, Inc.', 'a non-Workday stored name is the source name');
  const finalized = finalizeCompany({ company: 'US101', atsCompany: 'US101', url: 'https://x.wd5.myworkdayjobs.com/External/job/y' });
  assert.deepEqual([finalized.company, finalized.companySource, finalized.companyUncertain], ['US101', 'ats', true]);
  assert.equal(companyIsUncertain(finalized), true);
  const settled = finalizeCompany({ companyFromSource: 'Guidehouse', atsCompany: 'US101 Guidehouse Inc.', url });
  assert.deepEqual([settled.company, settled.companySource, settled.companyUncertain], ['Guidehouse', 'source', false]);
  assert.equal(displayCompanyName(settled), 'Guidehouse');
  assert.equal(companyIsUncertain(settled), false);
});

test('enrichment keeps a valid list name over the ATS entity and stores the entity as a candidate', async () => {
  const workday = { hiringOrganization: { name: '100000 Motorola Solutions, Inc.' }, jobPostingInfo: { title: 'Data Analyst Intern', jobDescription: '<p>' + 'x'.repeat(300) + '</p>', location: 'Chicago, Illinois', postedOn: 'Posted Yesterday' } };
  const fetchWorkday = async () => new Response(JSON.stringify(workday), { status: 200, headers: { 'content-type': 'application/json' } });
  const url = 'https://motorola.wd5.myworkdayjobs.com/Careers/job/Chicago-IL/Data-Analyst-Intern_R1';
  const kept = await enrichJob({ url, company: 'Motorola', title: 'x' }, {}, fetchWorkday);
  assert.deepEqual([kept.company, kept.companyFromSource, kept.atsCompany], ['Motorola', 'Motorola', '100000 Motorola Solutions, Inc.']);
  const codeOnly = await enrichJob({ url, company: 'US101', title: 'x' }, {}, fetchWorkday);
  assert.deepEqual([codeOnly.company, codeOnly.companyFromSource, codeOnly.atsCompany], ['Motorola Solutions', 'US101', '100000 Motorola Solutions, Inc.'], 'an invalid list name is replaced by the cleaned entity');
  const greenhouse = { title: 'Analyst', company_name: 'Acme Holdings LLC', location: { name: 'Remote' }, content: 'x'.repeat(300), updated_at: '2026-09-18T10:00:00Z' };
  const fromBoard = await enrichJob({ url: 'https://job-boards.greenhouse.io/acme/jobs/1', company: 'Acme', title: 'x' }, {}, async () => new Response(JSON.stringify(greenhouse), { status: 200, headers: { 'content-type': 'application/json' } }));
  assert.deepEqual([fromBoard.company, fromBoard.atsCompany], ['Acme', 'Acme Holdings LLC']);
});

test('the scoring schema requires employerName and the merge keeps it beside, never over, the settled company', () => {
  const schema = buildResultSchema([{ id: 'data', label: 'Data' }]);
  assert.ok(schema.properties.results.items.required.includes('employerName'));
  assert.deepEqual(schema.properties.results.items.properties.employerName, { type: 'string' });
  assert.match(buildSemanticPrompt([{ semanticId: 'a', title: 't', company: 'c', description: 'd' }], [{ id: 'data', label: 'Data', text: 'r' }], {}), /Set "employerName" to the employer's public brand name/);
  const merged = mergeSemanticResults([{ semanticId: 'abc', url: 'https://x/1', company: 'Acme', scores: { data: 10 }, bestScore: 10 }], [{ id: 'abc', roleType: 'new_grad', scores: { data: 80 }, recommendedTrack: 'data', employerName: 'Acme Robotics', matchLevel: 'high', reasons: [], gaps: [], blockers: [] }], 'claude', [{ id: 'data', label: 'Data', text: 'r' }]);
  assert.equal(merged[0].company, 'Acme', 'the existing valid name is not overwritten');
  assert.equal(merged[0].employerNameFromJd, 'Acme Robotics');
  const blank = mergeSemanticResults([{ semanticId: 'abc', url: 'https://x/1', company: 'Acme', scores: { data: 10 }, bestScore: 10 }], [{ id: 'abc', roleType: 'new_grad', scores: { data: 80 }, recommendedTrack: 'data', employerName: '   ', matchLevel: 'high', reasons: [], gaps: [], blockers: [] }], 'claude', [{ id: 'data', label: 'Data', text: 'r' }]);
  assert.equal(blank[0].employerNameFromJd, null);
  const resolved = finalizeCompany({ companyFromSource: 'US101', employerNameFromJd: 'Acme Robotics', atsCompany: 'US101', url: 'https://x.wd5.myworkdayjobs.com/External/job/y' });
  assert.deepEqual([resolved.company, resolved.companySource], ['Acme Robotics', 'employerName'], 'the employer name from the posting is the third candidate');
});
