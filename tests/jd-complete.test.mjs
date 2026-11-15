// Job Description completeness (2026-11-14): the description of a posting page is read from the page body or its
// embedded JSON when the JSON-LD is missing or a cut summary, never from the meta tags alone; every posting says
// where its description came from and whether it is complete; the public ATS entries are asked for the final URL
// too; an incomplete description shows as one line with a link on the card. Every page here is a local fixture
// (tests/fixtures/pages, synthetic) or an inline string; the fake fetch answers by URL and nothing leaves the test.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ashbyApiUrl, enrichJob, leverApiUrl, pickDescription } from '../src/enrich.mjs';
import { cleanDescriptionHtml, sanitizeJobHtml } from '../src/jd-html.mjs';
import { CONTAINER_RULES, descriptionStatus, extractEmbeddedDescription, extractJobBody, incompleteDescriptionSummary, isCompleteText, parseTree, withDescriptionStatus } from '../src/jd-extract.mjs';
import { INCOMPLETE_DESCRIPTION_LABEL } from '../src/report-components.mjs';
import { buildHtml, buildReportView } from '../src/report.mjs';
import { fixtureJob, fixturePayload, prepareReportProject, startReportHub, writePayload } from './helpers/report-hub.mjs';

const pages = new URL('./fixtures/pages/', import.meta.url);
const page = name => fs.readFile(new URL(name, pages), 'utf8');
const html = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
const BODY = `<p><strong>About the role</strong></p><p>${'Build analyses and dashboards for the product team. '.repeat(6)}</p><ul><li>Write SQL.</li><li>Ship dashboards.</li></ul>`;
const seed = (url, extra = {}) => ({ url, title: '', company: '', location: '', description: '', ...extra });

// A fetch that answers by URL: routes[url] is a Response or a function (url, options) → Response; a URL with
// no route answers 404. `calls` records every request in order. A Response built for a different URL can be
// given a redirect target with { to } so response.url reports where the request landed.
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(String(url));
    const route = routes[String(url)];
    if (!route) return new Response('not found', { status: 404 });
    const answer = typeof route === 'function' ? await route(url, options) : route;
    // A fresh copy each time: the same route may be asked more than once in one test.
    const response = (answer instanceof Response ? answer : answer.response).clone();
    if (answer.to) Object.defineProperty(response, 'url', { value: answer.to });
    return response;
  };
  return { fetchImpl, calls };
}

// ------------------------------------------------------------------------------------------ extraction

test('completeness: at least the minimum, never a meta tag; an ellipsis only cuts a short JSON-LD or list summary', () => {
  assert.equal(isCompleteText('x'.repeat(200), 200), true);
  assert.equal(isCompleteText('x'.repeat(199), 200), false);
  assert.equal(isCompleteText(`${'x'.repeat(300)}…`, 200), false, 'no source: the summary rule');
  assert.equal(isCompleteText(`${'x'.repeat(300)}...  `, 200, 'json_ld'), false);
  assert.equal(isCompleteText(`${'x'.repeat(300)}…`, 200, 'list'), false);
  assert.equal(isCompleteText(`${'x'.repeat(1500)}…`, 200, 'json_ld'), true, '1,500 characters or more: the ellipsis is part of the text');
  for (const source of ['ats_api', 'page_body', 'embedded_json']) {
    assert.equal(isCompleteText(`${'x'.repeat(200)}…`, 200, source), true, `${source}: length alone`);
    assert.equal(isCompleteText(`${'x'.repeat(199)}`, 200, source), false, `${source}: still the minimum`);
  }
  assert.equal(isCompleteText('x'.repeat(5000), 200, 'meta'), false, 'a meta tag is never complete');
  assert.deepEqual(descriptionStatus({ description: `${'x'.repeat(5800)}…`, enrichment: 'greenhouse_api' }, { minimum: 200 }), { descriptionComplete: true, descriptionSource: 'ats_api' });
  assert.deepEqual(descriptionStatus({ description: `${'x'.repeat(300)}...`, enrichment: 'json_ld_jobposting' }, { minimum: 200 }), { descriptionComplete: false, descriptionSource: 'json_ld' });
  assert.deepEqual(descriptionStatus({ description: `${'x'.repeat(300)}…`, descriptionSource: 'page_body' }, { minimum: 200 }), { descriptionComplete: true, descriptionSource: 'page_body' });
  assert.deepEqual(descriptionStatus({ description: 'x'.repeat(300), enrichment: 'html_metadata' }, { minimum: 200 }), { descriptionComplete: false, descriptionSource: 'meta' });
  assert.deepEqual(descriptionStatus({ description: 'x'.repeat(300), enrichment: 'ats_api' }, { minimum: 200 }), { descriptionComplete: true, descriptionSource: 'ats_api' });
  assert.deepEqual(descriptionStatus({ description: 'x'.repeat(300), enrichment: 'json_ld_jobposting' }), { descriptionComplete: true, descriptionSource: 'json_ld' });
  assert.deepEqual(descriptionStatus({ description: 'short', enrichment: 'failed' }), { descriptionComplete: false, descriptionSource: 'list' });
  assert.deepEqual(descriptionStatus({ description: '', enrichment: 'failed' }), { descriptionComplete: false, descriptionSource: null });
  // A posting enrich already judged keeps its verdict; one without a verdict gets one.
  const judged = { description: 'x'.repeat(300), descriptionComplete: false, descriptionSource: 'meta' };
  assert.equal(withDescriptionStatus(judged), judged);
  assert.deepEqual(withDescriptionStatus({ description: 'x'.repeat(300), enrichment: 'source_api' }), { description: 'x'.repeat(300), enrichment: 'source_api', descriptionComplete: true, descriptionSource: 'ats_api' });
});

test('the page tree: nesting, text and link measures, void elements, stray closing tags', () => {
  const root = parseTree('<div id="a"><p>one <a href="/x">link</a><br>two</p><img src="x"></div></span><div>three</div>');
  assert.equal(root.children.length, 2);
  const [a, b] = root.children;
  assert.equal(a.children.length, 2, 'p and img');
  assert.equal(a.text, 'one' .length + 'link'.length + 'two'.length, 'each text node trimmed');
  assert.equal(a.link, 'link'.length);
  assert.equal(b.text, 'three'.length);
  assert.equal(a.children[1].name, 'img');
});

test('extractJobBody: a known container wins over nav links, the outermost of nested matches is kept, a shell gives nothing', () => {
  const nav = `<nav>${'<a href="/x">Link to a page</a> '.repeat(40)}</nav>`;
  const found = extractJobBody(`<html><body>${nav}<div class="wrapper"><div class="iCIMS_JobContent"><div class="iCIMS_InfoMsg_Job">${BODY}</div></div></div><footer>${'<a href="/y">Footer link</a>'.repeat(30)}</footer></body></html>`, { minimum: 200 });
  assert.equal(found.ats, 'iCIMS');
  assert.equal(found.method, 'container');
  assert.ok(found.html.startsWith('<div class="iCIMS_InfoMsg_Job">'), 'the outermost match (JobContent), not the section inside it');
  assert.doesNotMatch(found.text, /Link to a page|Footer link/);
  // Workable keeps every section the page marks, in order.
  const workable = extractJobBody(`<main><div data-ui="job-description">${BODY}</div><div data-ui="job-requirements"><ul><li>SQL and Python, graduating in 2027.</li></ul></div><div data-ui="job-benefits"><p>A laptop.</p></div></main>`, { minimum: 200 });
  assert.equal(workable.ats, 'Workable');
  assert.match(workable.html, /About the role[\s\S]*graduating in 2027[\s\S]*A laptop/);
  // A container with only a summary does not count; neither does a page of scripts.
  assert.equal(extractJobBody(`<div class="job-description"><p>Short summary…</p></div>`, { minimum: 200 }), null);
  assert.equal(extractJobBody('<html><body><div id="root"></div><script>window.x = 1</script></body></html>', { minimum: 200 }), null);
  assert.equal(extractJobBody('plain text without any markup at all', { minimum: 5 }), null);
  assert.ok(CONTAINER_RULES.length >= 15);
});

test('extractJobBody: without a known container the densest low-link block is taken and tightened past a sidebar', async () => {
  const found = extractJobBody(await page('density-fallback.html'), { minimum: 200 });
  assert.equal(found.method, 'density');
  assert.equal(found.ats, null);
  assert.match(found.text, /^Applied Scientist I, Example Devices Job ID: 1060/, 'the main column, from its title');
  assert.doesNotMatch(found.text, /Related jobs|Search jobs|Privacy/, 'the sidebar, the nav and the footer are left behind');
  assert.match(found.text, /PREFERRED QUALIFICATIONS[\s\S]*equal opportunity employer/, 'through the last section');
  // Mostly links: not a description, even when long.
  const links = `<div class="list">${'<a href="/j">Data Analyst, Example Corp, Chicago</a> '.repeat(30)}</div>`;
  assert.equal(extractJobBody(`<html><body>${links}</body></html>`, { minimum: 200 }), null);
});

test('extractEmbeddedDescription: the longest complete description field with markup or line breaks; JSON-LD and bare one-liners are skipped', () => {
  const long = BODY.replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  const html = `<script type="application/ld+json">{"@type":"JobPosting","description":"${'x'.repeat(400)}"}</script>
    <script id="__NEXT_DATA__" type="application/json">{"props":{"job":{"description":"${long}","shortDescription":"${'y'.repeat(300)}","metaDescription":"Short one-liner without markup"}}}</script>
    <script>window.__INITIAL_STATE__ = {"posting":{"description_html":"<p>Shorter than the other one but still fine.</p><p>${'More text here. '.repeat(14)}</p>"}};</script>`;
  const found = extractEmbeddedDescription(html, { minimum: 200 });
  assert.ok(found.html.startsWith('<p><strong>About the role</strong></p>'), 'decoded from \\u003c escapes');
  assert.match(found.text, /^About the role Build analyses/);
  assert.equal(extractEmbeddedDescription('<script>var a = {"description":"short"}</script>', { minimum: 200 }), null);
  assert.equal(extractEmbeddedDescription(`<script>var a = {"description":"${'no markup '.repeat(40)}"}</script>`, { minimum: 200 }), null, 'a long string without markup or line breaks is not a description field');
});

test('the summary: count and the first hosts by count, failed fetches left out', () => {
  const jobs = [
    ...Array.from({ length: 3 }, (_, i) => ({ url: `https://www.alpha.example/j/${i}`, descriptionComplete: false })),
    { url: 'https://beta.example/j/1', descriptionComplete: false },
    { url: 'https://gamma.example/j/1', descriptionComplete: false, enrichment: 'failed' },
    { url: 'https://delta.example/j/1', descriptionComplete: true },
  ];
  const summary = incompleteDescriptionSummary(jobs, { minimum: 200 });
  assert.equal(summary.count, 4);
  assert.deepEqual(summary.hosts, [{ host: 'alpha.example', count: 3 }, { host: 'beta.example', count: 1 }]);
  assert.match(summary.message, /^4 posting\(s\) have an incomplete Job Description \(a page summary, fewer than 200 characters, or a short summary cut with an ellipsis\); their cards link to the posting page instead: alpha\.example \(3\), beta\.example \(1\)$/);
  const many = incompleteDescriptionSummary(Array.from({ length: 10 }, (_, i) => ({ url: `https://h${i}.example/`, descriptionComplete: false })));
  assert.equal(many.hosts.length, 8);
  assert.match(many.message, /, and 2 more host\(s\)$/);
  assert.deepEqual(incompleteDescriptionSummary([]), { count: 0, hosts: [], message: '' });
});

// ------------------------------------------------------------------------------------------ enrichJob

test('a page with only a meta description: the body container gives the full JD as page_body, with its paragraphs, list and bold', async () => {
  const { fetchImpl, calls } = fakeFetch({ 'https://careers-example.icims.com/jobs/1234/data-analyst-intern/job': html(await page('icims-meta-only.html')) });
  const job = await enrichJob(seed('https://careers-example.icims.com/jobs/1234/data-analyst-intern/job'), { minimumDescriptionCharacters: 200 }, fetchImpl);
  assert.deepEqual(calls, ['https://careers-example.icims.com/jobs/1234/data-analyst-intern/job'], 'one request');
  assert.equal(job.descriptionSource, 'page_body');
  assert.equal(job.descriptionComplete, true);
  assert.equal(job.descriptionContainer, 'iCIMS');
  assert.equal(job.enrichment, 'html_page');
  assert.doesNotMatch(job.description, /…/);
  assert.match(job.description, /^Overview Example Corp is hiring a Data Analyst Intern for Summer 2027[\s\S]*equal opportunity employer\.$/);
  assert.match(job.descriptionHtml, /^<h2>Overview<\/h2><p>Example Corp is hiring a <strong>Data Analyst Intern<\/strong> for Summer 2027/);
  assert.match(job.descriptionHtml, /<ul><li>Model data in SQL and dbt, and document the tables you own\.<\/li>/);
  assert.match(job.descriptionHtml, /<p><em>Example Corp is an equal opportunity employer\.<\/em><\/p>$/);
  assert.equal(job.descriptionHtml, sanitizeJobHtml(job.descriptionHtml), 'already clean: the whitelist changes nothing');
  assert.doesNotMatch(job.descriptionHtml, /<div|class=|<script|<nav|Search Jobs|Privacy Policy/);
  assert.equal(job.title, 'Data Analyst Intern (Summer 2027)');
});

test('a truncated JSON-LD description with a complete body: the body is used, the rest of the JSON-LD still read', async () => {
  const { fetchImpl } = fakeFetch({ 'https://jobs.smartrecruiters.com/ExampleCorp/744000160931919-data-analyst-new-grad': html(await page('smartrecruiters-truncated-jsonld.html')) });
  const job = await enrichJob(seed('https://jobs.smartrecruiters.com/ExampleCorp/744000160931919-data-analyst-new-grad'), { minimumDescriptionCharacters: 200 }, fetchImpl);
  assert.equal(job.descriptionSource, 'page_body');
  assert.equal(job.descriptionComplete, true);
  assert.equal(job.descriptionContainer, 'SmartRecruiters');
  assert.equal(job.enrichment, 'json_ld_jobposting', 'the JSON-LD still supplied title, company, date and location');
  assert.equal(job.company, 'Example Corp');
  assert.equal(job.location, 'Des Moines, IA, US');
  assert.equal(job.postedAt, '2026-11-10T14:02:11.000Z');
  assert.doesNotMatch(job.description, /…/);
  assert.match(job.description, /Company Description[\s\S]*Job Description[\s\S]*Qualifications[\s\S]*Additional Information[\s\S]*equal opportunity employer/);
  assert.match(job.descriptionHtml, /<h2>Qualifications<\/h2><ul><li>Bachelor/);
  // Direct: the picker's order.
  const picked = pickDescription({ body: `<script type="application/ld+json">{"@type":"JobPosting","description":"${'Full JSON-LD text. '.repeat(20)}"}</script><main>${BODY}</main>`, posting: { description: 'Full JSON-LD text. '.repeat(20) }, originalJob: {}, minimum: 200 });
  assert.equal(picked.source, 'json_ld', 'a complete JSON-LD description comes first');
});

test('a JavaScript shell: the meta text is kept but marked incomplete; an empty shell has no source at all', async () => {
  const { fetchImpl } = fakeFetch({ 'https://careers.example-spa.com/search/7706693387932633397': html(await page('spa-meta-only.html')), 'https://recruiting2.ultipro.example/x/JobBoard/y/OpportunityDetail?opportunityId=1': html(await page('ultipro-shell.html')) });
  const shell = await enrichJob(seed('https://careers.example-spa.com/search/7706693387932633397'), { minimumDescriptionCharacters: 200 }, fetchImpl);
  assert.equal(shell.descriptionComplete, false);
  assert.equal(shell.descriptionSource, 'meta');
  assert.equal(shell.descriptionHtml, undefined);
  assert.equal(shell.enrichment, 'html_metadata');
  assert.match(shell.description, /^View our opening for Machine Learning Engineer Intern/);
  const empty = await enrichJob(seed('https://recruiting2.ultipro.example/x/JobBoard/y/OpportunityDetail?opportunityId=1'), { minimumDescriptionCharacters: 200 }, fetchImpl);
  assert.equal(empty.descriptionComplete, false);
  assert.equal(empty.descriptionSource, null);
  assert.equal(empty.description, '');
  // The list's own text stands in for a shell when it is complete, with its source named.
  const fromList = await enrichJob(seed('https://careers.example-spa.com/search/7706693387932633397', { description: 'List text. '.repeat(30).trim(), descriptionHtml: '<p>List markup</p>' }), { minimumDescriptionCharacters: 200 }, fetchImpl);
  assert.equal(fromList.descriptionSource, 'list');
  assert.equal(fromList.descriptionComplete, true);
  assert.equal(fromList.descriptionHtml, '<p>List markup</p>');
  // A short list text loses to nothing: it is kept over the meta text and marked incomplete.
  const shortList = await enrichJob(seed('https://careers.example-spa.com/search/7706693387932633397', { description: 'Short list text, longer than the meta line? No, but it is the list\'s own and that is what stays. '.repeat(2) }), { minimumDescriptionCharacters: 200 }, fetchImpl);
  assert.equal(shortList.descriptionSource, 'list');
  assert.equal(shortList.descriptionComplete, false);
});

test('embedded JSON: a Workable preloaded state and a __NEXT_DATA__ block give the description when the body is a shell', async () => {
  const { fetchImpl } = fakeFetch({ 'https://apply.workable.example/example-corp-1/j/71AEBBCADE': html(await page('workable-preloaded-state.html')), 'https://careers.example-spa.com/search/1': html(await page('nextdata-shell.html')) });
  const workable = await enrichJob(seed('https://apply.workable.example/example-corp-1/j/71AEBBCADE'), { minimumDescriptionCharacters: 200 }, fetchImpl);
  assert.equal(workable.descriptionSource, 'embedded_json');
  assert.equal(workable.descriptionComplete, true);
  assert.doesNotMatch(workable.description, /\.\.\.$/);
  assert.match(workable.descriptionHtml, /^<p><strong>About Example Corp<\/strong><\/p><p>Example Corp is a software platform[\s\S]*<ul><li>Build and monitor/);
  const next = await enrichJob(seed('https://careers.example-spa.com/search/1'), { minimumDescriptionCharacters: 200 }, fetchImpl);
  assert.equal(next.descriptionSource, 'embedded_json');
  assert.match(next.description, /^Responsibilities - Participate in the design/);
  assert.match(next.descriptionHtml, /^<p>Responsibilities<br>- Participate in the design/, 'line breaks of a plain-text field become paragraphs and breaks');
  assert.match(next.descriptionHtml, /<\/p><p>Qualifications<br>/);
});

test('the extracted markup goes through the whitelist: scripts, handlers, styles and frames inside the container are gone', async () => {
  const malicious = `<div class="job-description"><h2 onmouseover="x()">About</h2><p style="color:red">${'Build <strong>SQL</strong> models. '.repeat(12)}</p><script>steal()</script><iframe src="https://evil.example"></iframe><ul><li>Dashboards<img src=x onerror=alert(1)></li></ul><p><a href="javascript:alert(1)">bad</a> <a href="https://example.com/b" onclick="y()">Benefits</a></p></div>`;
  const { fetchImpl } = fakeFetch({ 'https://careers.example.com/job/9': html(`<html><head><meta name="description" content="Short…"></head><body><nav><a href="/">Home</a></nav>${malicious}</body></html>`) });
  const job = await enrichJob(seed('https://careers.example.com/job/9'), { minimumDescriptionCharacters: 200 }, fetchImpl);
  assert.equal(job.descriptionSource, 'page_body');
  assert.doesNotMatch(job.descriptionHtml, /script|steal|iframe|evil|onmouseover|onerror|onclick|style=|javascript:|<img|<div/);
  assert.match(job.descriptionHtml, /^<h2>About<\/h2><p>Build <strong>SQL<\/strong> models\./);
  assert.match(job.descriptionHtml, /<ul><li>Dashboards<\/li><\/ul><p>bad <a href="https:\/\/example\.com\/b" target="_blank" rel="noopener noreferrer">Benefits<\/a><\/p>$/);
  assert.equal(job.descriptionHtml, cleanDescriptionHtml(job.descriptionHtml));
});

test('a short link that redirects into Greenhouse: the board API is asked for the final URL before the page is read', async () => {
  const api = 'https://boards-api.greenhouse.io/v1/boards/examplecorp/jobs/8230677';
  const final = 'https://job-boards.greenhouse.io/examplecorp/jobs/8230677';
  const { fetchImpl, calls } = fakeFetch({
    'https://go.example.link/1xI': { response: html(await page('greenhouse-closed.html')), to: final },
    [api]: json({ title: 'Data Science Intern', company_name: 'Example Corp', location: { name: 'Boston, Massachusetts, United States' }, updated_at: '2026-11-11T15:00:00Z', content: BODY.replace(/</g, '&lt;').replace(/>/g, '&gt;') }),
  });
  const job = await enrichJob(seed('https://go.example.link/1xI'), { minimumDescriptionCharacters: 200 }, fetchImpl);
  assert.deepEqual(calls, ['https://go.example.link/1xI', api]);
  assert.equal(job.enrichment, 'greenhouse_api');
  assert.equal(job.descriptionSource, 'ats_api');
  assert.equal(job.descriptionComplete, true);
  assert.equal(job.url, final);
  assert.equal(job.finalUrl, final);
  assert.equal(job.originalUrl, 'https://go.example.link/1xI');
  assert.match(job.descriptionHtml, /^<p><strong>About the role<\/strong><\/p>/);
  // The API refusing (the posting closed): the page's one line is all there is, marked incomplete.
  const closed = fakeFetch({ 'https://go.example.link/1xI': { response: html(await page('greenhouse-closed.html')), to: final }, [final]: html(await page('greenhouse-closed.html')) });
  const gone = await enrichJob(seed('https://go.example.link/1xI'), { minimumDescriptionCharacters: 200 }, closed.fetchImpl);
  assert.deepEqual(closed.calls, ['https://go.example.link/1xI', api, final], 'API for the final URL, then the landing page once more by its own address');
  assert.equal(gone.descriptionComplete, false);
  // The page's own words (title, location, "no longer open") are the partial body and beat the meta line.
  assert.equal(gone.descriptionSource, 'page_body');
  assert.match(gone.description, /^Data Science Intern Boston, Massachusetts, United States The job you are looking for is no longer open/);
});

test('a redirect into SmartRecruiters asks the posting API for the final URL; an API answering HTML gives way to the page', async () => {
  const final = 'https://jobs.smartrecruiters.com/ExampleCorp/744000160931919';
  const api = 'https://api.smartrecruiters.com/v1/companies/ExampleCorp/postings/744000160931919';
  const { fetchImpl, calls } = fakeFetch({
    'https://go.example.link/1rG': { response: html(await page('smartrecruiters-truncated-jsonld.html')), to: final },
    [api]: json({ name: 'Data Analyst - New Grad', company: { name: 'Example Corp' }, releasedDate: '2026-11-10T14:02:11.000Z', location: { fullLocation: 'Des Moines, IA, US' }, jobAd: { sections: { jobDescription: { title: 'Job Description', text: BODY }, qualifications: { title: 'Qualifications', text: '<ul><li>SQL</li></ul>' } } } }),
  });
  const job = await enrichJob(seed('https://go.example.link/1rG'), { minimumDescriptionCharacters: 200 }, fetchImpl);
  assert.deepEqual(calls, ['https://go.example.link/1rG', api]);
  assert.equal(job.enrichment, 'smartrecruiters_api');
  assert.equal(job.descriptionSource, 'ats_api');
  assert.equal(job.url, final);
  const broken = fakeFetch({ [final]: html(await page('smartrecruiters-truncated-jsonld.html')), [api]: html('<html>maintenance</html>') });
  const fromPage = await enrichJob(seed(final), { minimumDescriptionCharacters: 200 }, broken.fetchImpl);
  assert.deepEqual(broken.calls, [api, final]);
  assert.equal(fromPage.descriptionSource, 'page_body');
  assert.equal(fromPage.descriptionComplete, true);
});

test('Lever and Ashby posting pages have public entries: the Lever posting endpoint and the Ashby board, matched by job id', async () => {
  assert.equal(leverApiUrl('https://jobs.lever.co/examplecorp/be41a03c-460e-4ff7-b817-f012aa1c4b37/apply'), 'https://api.lever.co/v0/postings/examplecorp/be41a03c-460e-4ff7-b817-f012aa1c4b37');
  assert.equal(leverApiUrl('https://jobs.eu.lever.co/examplecorp/be41a03c-460e-4ff7-b817-f012aa1c4b37'), 'https://api.eu.lever.co/v0/postings/examplecorp/be41a03c-460e-4ff7-b817-f012aa1c4b37');
  assert.equal(leverApiUrl('https://jobs.lever.co/examplecorp'), null);
  assert.deepEqual(ashbyApiUrl('https://jobs.ashbyhq.com/examplecorp/0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d/application'), { apiUrl: 'https://api.ashbyhq.com/posting-api/job-board/examplecorp', id: '0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d' });
  assert.equal(ashbyApiUrl('https://jobs.ashbyhq.com/examplecorp'), null);

  const leverUrl = 'https://jobs.lever.co/examplecorp/be41a03c-460e-4ff7-b817-f012aa1c4b37/apply';
  const lever = fakeFetch({
    'https://api.lever.co/v0/postings/examplecorp/be41a03c-460e-4ff7-b817-f012aa1c4b37': json({ id: 'be41a03c-460e-4ff7-b817-f012aa1c4b37', text: 'Research Intern, Robotics', hostedUrl: 'https://jobs.lever.co/examplecorp/be41a03c-460e-4ff7-b817-f012aa1c4b37', createdAt: Date.parse('2026-11-10T15:00:00Z'), categories: { location: 'Los Altos, CA', commitment: 'Intern', allLocations: ['Los Altos, CA'] },
      description: '<div><b>Who we are</b></div><div>A robotics lab.</div>', descriptionPlain: 'Who we are\nA robotics lab.', lists: [{ text: 'What you will do', content: `<li>${'Implement and evaluate learning algorithms on real robot data. '.repeat(4)}</li><li>Write a report.</li>` }], additional: '<p>Equal opportunity.</p>', additionalPlain: 'Equal opportunity.' }),
  });
  const leverJob = await enrichJob(seed(leverUrl), { minimumDescriptionCharacters: 200 }, lever.fetchImpl);
  assert.deepEqual(lever.calls, ['https://api.lever.co/v0/postings/examplecorp/be41a03c-460e-4ff7-b817-f012aa1c4b37'], 'the apply page itself is never fetched');
  assert.equal(leverJob.enrichment, 'lever_api');
  assert.equal(leverJob.descriptionSource, 'ats_api');
  assert.equal(leverJob.descriptionComplete, true);
  assert.equal(leverJob.title, 'Research Intern, Robotics');
  assert.equal(leverJob.location, 'Los Altos, CA');
  assert.equal(leverJob.postedAt, '2026-11-10T15:00:00.000Z');
  assert.equal(leverJob.freshnessBasis, 'lever_created_at');
  assert.match(leverJob.description, /^Who we are\nA robotics lab\.\nWhat you will do Implement/);
  assert.match(leverJob.descriptionHtml, /^<b>Who we are<\/b><br>A robotics lab\.<h3>What you will do<\/h3><ul><li>Implement/);
  assert.equal(leverJob.url, leverUrl);

  const ashbyUrl = 'https://jobs.ashbyhq.com/examplecorp/0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d';
  const ashby = fakeFetch({
    'https://api.ashbyhq.com/posting-api/job-board/examplecorp': json({ jobs: [
      { id: 'ffffffff-0000-0000-0000-000000000000', title: 'Other Role', jobUrl: 'https://jobs.ashbyhq.com/examplecorp/ffffffff-0000-0000-0000-000000000000', descriptionHtml: '<p>Other</p>', descriptionPlain: 'Other', location: 'Remote', publishedAt: '2026-11-01T00:00:00Z' },
      { id: '0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d', title: 'Data Analyst', jobUrl: ashbyUrl, descriptionHtml: BODY, descriptionPlain: 'About the role. '.repeat(20), location: 'New York', secondaryLocations: [{ location: 'Remote' }], employmentType: 'FullTime', publishedAt: '2026-11-11T12:00:00Z', isRemote: true },
    ] }),
  });
  const ashbyJob = await enrichJob(seed(ashbyUrl), { minimumDescriptionCharacters: 200 }, ashby.fetchImpl);
  assert.deepEqual(ashby.calls, ['https://api.ashbyhq.com/posting-api/job-board/examplecorp']);
  assert.equal(ashbyJob.enrichment, 'ashby_api');
  assert.equal(ashbyJob.descriptionSource, 'ats_api');
  assert.equal(ashbyJob.title, 'Data Analyst');
  assert.equal(ashbyJob.location, 'New York · Remote');
  assert.equal(ashbyJob.postedAt, '2026-11-11T12:00:00.000Z');
  assert.match(ashbyJob.descriptionHtml, /^<p><strong>About the role<\/strong><\/p>/);
  // No such job on the board: the page is read instead.
  const missing = fakeFetch({ 'https://api.ashbyhq.com/posting-api/job-board/examplecorp': json({ jobs: [] }), [ashbyUrl]: html(`<html><body><main>${BODY}</main></body></html>`) });
  const fromPage = await enrichJob(seed(ashbyUrl), { minimumDescriptionCharacters: 200 }, missing.fetchImpl);
  assert.deepEqual(missing.calls, ['https://api.ashbyhq.com/posting-api/job-board/examplecorp', ashbyUrl]);
  assert.equal(fromPage.descriptionSource, 'page_body');
});

test('a redirect that lands on a shell: the landing page is fetched once more by its own address and the better answer kept', async () => {
  const final = 'https://careers.example.com/jobs/77';
  const { fetchImpl, calls } = fakeFetch({
    'https://go.example.link/77': { response: html(await page('spa-meta-only.html')), to: final },
    [final]: html(`<html><head><meta name="description" content="Short…"></head><body><main>${BODY}</main></body></html>`),
  });
  const job = await enrichJob(seed('https://go.example.link/77'), { minimumDescriptionCharacters: 200 }, fetchImpl);
  assert.deepEqual(calls, ['https://go.example.link/77', final]);
  assert.equal(job.descriptionSource, 'page_body');
  assert.equal(job.descriptionComplete, true);
  assert.equal(job.url, final);
  // A complete first answer is never fetched twice.
  const once = fakeFetch({ 'https://go.example.link/78': { response: html(`<html><body><main>${BODY}</main></body></html>`), to: final } });
  await enrichJob(seed('https://go.example.link/78'), { minimumDescriptionCharacters: 200 }, once.fetchImpl);
  assert.deepEqual(once.calls, ['https://go.example.link/78']);
});

test('every fixture page gives the outcome its manifest names, with the minimum from the config', async () => {
  const manifest = JSON.parse(await page('manifest.json'));
  assert.ok(manifest.length >= 13);
  for (const entry of manifest) {
    const url = `https://${entry.host}/jobs/1`;
    const { fetchImpl } = fakeFetch({ [url]: html(await page(entry.file)) });
    const job = await enrichJob(seed(url), { minimumDescriptionCharacters: 200 }, fetchImpl);
    if (entry.expect === 'incomplete') {
      assert.equal(job.descriptionComplete, false, entry.file);
      assert.ok(job.description.length < 200, `${entry.file}: ${job.description.length} characters`);
      // A shell's crumb ("Loading…") never stands in for the meta summary; a page's own closing words may.
      if (job.descriptionSource === 'page_body') assert.ok(job.description.length >= 50 && job.descriptionHtml === sanitizeJobHtml(job.descriptionHtml), entry.file);
      else assert.ok((job.descriptionSource === 'meta' || job.descriptionSource === null) && job.descriptionHtml === undefined, `${entry.file}: ${job.descriptionSource}`);
    } else {
      assert.equal(job.descriptionSource, entry.expect, entry.file);
      assert.equal(job.descriptionComplete, true, entry.file);
      assert.doesNotMatch(job.description, /(?:…|\.\.\.)$/, entry.file);
      assert.ok(job.description.length >= 400, `${entry.file}: ${job.description.length} characters`);
      assert.match(job.descriptionHtml, /<(?:p|ul|li|h[1-4]|strong|b)>/, `${entry.file}: markup kept`);
      assert.equal(job.descriptionHtml, sanitizeJobHtml(job.descriptionHtml), `${entry.file}: clean`);
      if (entry.container) assert.equal(job.descriptionContainer, entry.container, entry.file);
      else assert.equal(job.descriptionContainer, undefined, entry.file);
    }
  }
});

test('the ellipsis rule by source: a long ATS text ending in … is complete and shown whole, a short JSON-LD one is not', async () => {
  const api = 'https://boards-api.greenhouse.io/v1/boards/examplecorp/jobs/5150';
  const url = 'https://job-boards.greenhouse.io/examplecorp/jobs/5150';
  const long = `<p>${'We analyze product data and ship models to production. '.repeat(100)}</p><p>Applications are reviewed on a rolling basis…</p>`;
  const { fetchImpl, calls } = fakeFetch({ [api]: json({ title: 'Data Scientist, New Grad', company_name: 'Example Corp', location: { name: 'Austin, Texas' }, updated_at: '2026-11-14T15:00:00Z', content: long.replace(/</g, '&lt;').replace(/>/g, '&gt;') }) });
  const job = await enrichJob(seed(url), { minimumDescriptionCharacters: 200 }, fetchImpl);
  assert.deepEqual(calls, [api]);
  assert.ok(job.description.length > 5000 && /…$/.test(job.description), 'over 5,000 characters, ending in an ellipsis');
  assert.equal(job.descriptionSource, 'ats_api');
  assert.equal(job.descriptionComplete, true);
  const card = fixtureJob(1, { description: job.description, descriptionHtml: job.descriptionHtml, descriptionComplete: job.descriptionComplete, descriptionSource: job.descriptionSource, url });
  const rendered = buildHtml([card], fixturePayload('2026-11-15', [card]).meta);
  assert.match(rendered, /<details class="jd"><summary><span>Job Description<\/span><button type="button" class="jd-copy"[^>]*>[\s\S]*?<\/button><\/summary><div class="jd-body"><p>We analyze product data/, 'the full JD is on the card');
  assert.ok(rendered.includes('rolling basis…</p></div></details>'), 'whole, ellipsis included');
  assert.doesNotMatch(rendered, new RegExp(INCOMPLETE_DESCRIPTION_LABEL));

  // A 300-character JSON-LD description cut with "..." on a page with no body: still incomplete.
  const summary = `${'Join our analytics team to build dashboards. '.repeat(6).trim()}...`;
  assert.ok(summary.length >= 250 && summary.length <= 320);
  const shell = `<html><head><title>Analyst</title><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Analyst', description: summary, hiringOrganization: { name: 'Example Corp' }, jobLocation: { address: { addressLocality: 'Austin', addressRegion: 'TX', addressCountry: 'US' } } })}</script></head><body><div id="app"></div></body></html>`;
  const jsonLd = fakeFetch({ 'https://careers.example-corp.com/jobs/9': html(shell) });
  const cut = await enrichJob(seed('https://careers.example-corp.com/jobs/9'), { minimumDescriptionCharacters: 200 }, jsonLd.fetchImpl);
  assert.equal(cut.descriptionSource, 'json_ld');
  assert.equal(cut.descriptionComplete, false);
  assert.equal(cut.description, summary);
});

test('with nothing complete, a short page body is kept over an empty answer and over the meta line, marked incomplete', async () => {
  const body = `<p>${'Analyst role. '.repeat(10).trim()}</p>`;
  assert.ok(cleanDescriptionHtml(body).length < 200);
  const text = 'Analyst role. '.repeat(10).trim();
  assert.ok(text.length >= 100 && text.length < 200, `${text.length} characters`);
  const noMeta = fakeFetch({ 'https://careers.example-corp.com/jobs/150': html(`<html><head><title>Analyst</title></head><body><nav><a href="/">Home</a></nav><main>${body}</main></body></html>`) });
  const job = await enrichJob(seed('https://careers.example-corp.com/jobs/150'), { minimumDescriptionCharacters: 200 }, noMeta.fetchImpl);
  assert.equal(job.description, text, 'the body\'s text, not an empty string');
  assert.equal(job.descriptionSource, 'page_body');
  assert.equal(job.descriptionComplete, false);
  assert.equal(job.descriptionHtml, `<p>${text}</p>`);
  assert.equal(job.enrichment, 'html_page');
  // The same body beside a meta summary: the body wins, since the meta tag comes last.
  const withMeta = fakeFetch({ 'https://careers.example-corp.com/jobs/150': html(`<html><head><title>Analyst</title><meta name="description" content="${'Summary line. '.repeat(12)}"></head><body><main>${body}</main></body></html>`) });
  const beatsMeta = await enrichJob(seed('https://careers.example-corp.com/jobs/150'), { minimumDescriptionCharacters: 200 }, withMeta.fetchImpl);
  assert.equal(beatsMeta.descriptionSource, 'page_body');
  assert.equal(beatsMeta.description, text);
  // A crumb of a body (a loading placeholder) is no partial: the meta summary stays.
  const crumb = fakeFetch({ 'https://careers.example-corp.com/jobs/150': html(`<html><head><meta name="description" content="${'Summary line. '.repeat(12)}"></head><body><main><p>Loading…</p></main></body></html>`) });
  const placeholder = await enrichJob(seed('https://careers.example-corp.com/jobs/150'), { minimumDescriptionCharacters: 200 }, crumb.fetchImpl);
  assert.equal(placeholder.descriptionSource, 'meta');
  assert.equal(placeholder.descriptionComplete, false);
  assert.match(placeholder.description, /^Summary line\./);
  // pickDescription itself: the longest partial of JSON-LD, list and body is taken.
  const picked = pickDescription({ body: `<html><body><main>${body}</main></body></html>`, posting: { description: 'Short JSON-LD.' }, originalJob: { description: 'Shorter list.' }, minimum: 200 });
  assert.equal(picked.source, 'page_body');
  assert.equal(picked.text, text);
});

test('ashbyApiUrl decodes the organisation segment before checking it and encodes it again in the API address', () => {
  assert.deepEqual(ashbyApiUrl('https://jobs.ashbyhq.com/Acme%20Co/0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d'), { apiUrl: 'https://api.ashbyhq.com/posting-api/job-board/Acme%20Co', id: '0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d' });
  assert.deepEqual(ashbyApiUrl('https://jobs.ashbyhq.com/Acme%20Co/0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d/application'), { apiUrl: 'https://api.ashbyhq.com/posting-api/job-board/Acme%20Co', id: '0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d' });
  assert.equal(ashbyApiUrl('https://jobs.ashbyhq.com/Acme%2FCo/0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d'), null, 'a slash inside the organisation is refused');
  assert.equal(ashbyApiUrl('https://jobs.ashbyhq.com/%E0%A4%A/0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d'), null, 'a malformed escape is refused');
});

// ------------------------------------------------------------------------------------------ the report

test('a card with an incomplete JD shows one line with the posting link, no fragment and no ellipsis; a complete one is unchanged', async () => {
  const meta = fixturePayload('2026-11-14', []).meta;
  const incomplete = fixtureJob(1, { description: 'Explore corporate jobs and career programs at Example Corp, from full-time roles to internships…', descriptionComplete: false, descriptionSource: 'meta', url: 'https://www.example.com/en/jobs/10601943' });
  const complete = fixtureJob(2, { description: 'A complete JD.\n\nSecond paragraph.', descriptionComplete: true, descriptionSource: 'page_body', url: 'https://jobs.example.com/2' });
  const legacy = fixtureJob(3, { description: 'An older payload without the flag…', url: 'https://jobs.example.com/3' });
  const html = buildHtml([incomplete, complete, legacy], { ...meta, incompleteDescriptions: { count: 1, hosts: [{ host: 'example.com', count: 1 }] } });
  assert.match(html, new RegExp(`<p class="jd-missing">${INCOMPLETE_DESCRIPTION_LABEL} · <a target="_blank" rel="noopener noreferrer" href="https://www\\.example\\.com/en/jobs/10601943">Open Posting</a></p>`));
  assert.doesNotMatch(html, /Explore corporate jobs/, 'the fragment is not shown');
  assert.equal((html.split('<script>')[0].match(/…/g) || []).length, 1, 'the only ellipsis left on the page is the legacy card\'s, rendered as before');
  assert.match(html, /<details class="jd"><summary><span>Job Description<\/span><button type="button" class="jd-copy"[^>]*>[\s\S]*?<\/button><\/summary><div class="jd-body"><p>A complete JD\.<\/p><p>Second paragraph\.<\/p><\/div><\/details>/);
  assert.match(html, /<details class="jd"><summary><span>Job Description<\/span><button type="button" class="jd-copy"[^>]*>[\s\S]*?<\/button><\/summary><div class="jd-body"><p>An older payload without the flag…<\/p><\/div><\/details>/);
  assert.equal((html.match(/<details class="jd">/g) || []).length, 2, 'two folded JDs, none for the incomplete card');
  assert.match(html, /Incomplete Job Descriptions<\/dt>[\s\S]*?1 posting\(s\): their cards link to the posting page[\s\S]*?example\.com: 1/);
  // The view: no lazy preview for an incomplete card even in the hub, which asks for one.
  const view = buildReportView([incomplete, complete], meta, { lazyDescription: { limit: 10, src: card => `/jd/${card.id}` } });
  const [first, second] = view.cards;
  assert.equal(first.descriptionComplete, false);
  assert.equal(first.descriptionSrc, undefined);
  assert.equal(first.descriptionHtml, undefined);
  assert.equal(second.descriptionSrc, `/jd/${second.id}`);
});

test('the hub renders the same line and never offers the fragment on demand; complete JDs still load in full', async () => {
  const root = await prepareReportProject();
  const incomplete = fixtureJob(5, { description: 'Only a summary…', descriptionComplete: false, descriptionSource: 'meta', url: 'https://jobs.example.com/5' });
  const long = fixtureJob(6, { descriptionComplete: true, descriptionSource: 'page_body', descriptionHtml: `<h2>About</h2><p>${'More detail. '.repeat(60)}</p>`, url: 'https://jobs.example.com/6' });
  await writePayload(root, fixturePayload('2026-11-14', [incomplete, long]));
  const hub = await startReportHub(root);
  try {
    const text = (await hub.request('/reports/2026-11-14')).text;
    assert.match(text, new RegExp(`<p class="jd-missing">${INCOMPLETE_DESCRIPTION_LABEL} · <a target="_blank" rel="noopener noreferrer" href="https://jobs\\.example\\.com/5">Open Posting</a></p>`));
    assert.doesNotMatch(text, /Only a summary/);
    const sources = [...text.matchAll(/data-jd-src="([^"]+)"/g)].map(match => match[1]);
    assert.equal(sources.length, 1, 'only the long complete JD loads on demand');
    const full = await hub.request(sources[0]);
    assert.equal(full.status, 200);
    assert.ok(full.text.startsWith('<h2>About</h2><p>More detail. More detail.'));
    assert.ok(full.text.length > 700, 'the whole JD, not the 300-character preview');
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the only display-side cut is the hub preview: the Desktop report embeds a 40,000-character JD whole and the route returns it whole', async () => {
  const text = `${'Paragraph of the posting. '.repeat(1500)}END`;
  assert.ok(text.length > 39_000 && text.length < 50_000);
  const job = fixtureJob(7, { description: text, descriptionComplete: true, descriptionSource: 'page_body', url: 'https://jobs.example.com/7' });
  const html = buildHtml([job], fixturePayload('2026-11-14', [job]).meta);
  assert.ok(html.includes(`${'Paragraph of the posting. '.repeat(1500)}END</p></div></details>`), 'inline and uncut');
  const root = await prepareReportProject();
  await writePayload(root, fixturePayload('2026-11-14', [job]));
  const hub = await startReportHub(root);
  try {
    const pageText = (await hub.request('/reports/2026-11-14')).text;
    const src = /data-jd-src="([^"]+)"/.exec(pageText)[1];
    const full = (await hub.request(src)).text;
    assert.equal(full, `<p>${text}</p>`);
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
