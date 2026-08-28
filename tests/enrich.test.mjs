import assert from 'node:assert/strict';
import test from 'node:test';
import { enrichJob } from '../src/enrich.mjs';

test('extracts full JSON-LD JD, employment type, and salary', async () => {
  const posting = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: 'Machine Learning Engineer Intern',
    description: `<p>${'Build and evaluate PyTorch and RAG systems. '.repeat(12)}</p>`,
    datePosted: '2026-08-27',
    employmentType: ['INTERN', 'FULL_TIME'],
    jobLocationType: 'TELECOMMUTE',
    hiringOrganization: { name: 'Acme AI' },
    baseSalary: { currency: 'USD', value: { minValue: 45, maxValue: 55, unitText: 'HOUR' } },
  };
  const fetchImpl = async () => new Response(`<script type="application/ld+json">${JSON.stringify(posting)}</script>`, {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
  const job = await enrichJob({ url: 'https://example.com/job/1', title: '', company: '', location: '', description: '' }, {}, fetchImpl);
  assert.equal(job.company, 'Acme AI');
  assert.equal(job.employmentType, 'INTERN / FULL_TIME');
  assert.equal(job.salary, 'USD 45–55 HOUR');
  assert.ok(job.description.length > 200);
});

import { enrichmentWarningMessage, workdayCxsUrl, workdayPostedOn } from '../src/enrich.mjs';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

const workdayPayload = {
  hiringOrganization: { name: 'Wells Fargo' },
  jobPostingInfo: {
    title: 'Software Engineer',
    jobDescription: '<p>About&nbsp;this role:</p><ul><li>Build &amp; ship &#39;data&#39; pipelines.</li>\n<li>Partner   with analysts &ndash; daily.</li></ul><script>alert(1)</script>',
    location: 'Charlotte, North Carolina',
    additionalLocations: ['Chandler, Arizona'],
    postedOn: 'Posted 2 Days Ago',
    startDate: '2026-08-26',
    timeType: 'Full time',
    jobReqId: 'R-123456',
  },
};

test('derives the Workday CXS endpoint with and without a locale segment', () => {
  assert.equal(
    workdayCxsUrl('https://wf.wd1.myworkdayjobs.com/en-US/WellsFargoJobs/job/Charlotte-NC/Software-Engineer_R-123456?q=data'),
    'https://wf.wd1.myworkdayjobs.com/wday/cxs/wf/WellsFargoJobs/job/Software-Engineer_R-123456',
  );
  assert.equal(
    workdayCxsUrl('https://boozallen.wd5.myworkdayjobs.com/BAH_Jobs/job/Data-Scientist_R0212345'),
    'https://boozallen.wd5.myworkdayjobs.com/wday/cxs/boozallen/BAH_Jobs/job/Data-Scientist_R0212345',
  );
  assert.equal(workdayCxsUrl('https://rtx.wd5.myworkdayjobs.com/en-US/RTX_External_Career_Site'), null);
  assert.equal(workdayCxsUrl('https://rtx.wd5.myworkdayjobs.com/en-US/RTX_External_Career_Site/job'), null);
  assert.equal(workdayCxsUrl('https://www.myworkdayjobs.com/en-US/site/job/Role_1'), null);
  assert.equal(workdayCxsUrl('https://job-boards.greenhouse.io/acme/jobs/123'), null);
  assert.equal(workdayCxsUrl('not a url'), null);
});

test('parses Workday relative posting dates', () => {
  const now = new Date('2026-08-28T20:00:00.000Z');
  assert.equal(workdayPostedOn('Posted Today', now), '2026-08-28T20:00:00.000Z');
  assert.equal(workdayPostedOn('Posted Yesterday', now), '2026-08-27T20:00:00.000Z');
  assert.equal(workdayPostedOn('Posted 3 Days Ago', now), '2026-08-25T20:00:00.000Z');
  assert.equal(workdayPostedOn('Posted 30+ Days Ago', now), null);
  assert.equal(workdayPostedOn('', now), null);
});

test('fetches a Workday posting through the CXS endpoint and returns a clean JD', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, accept: options.headers.accept });
    if (url.includes('/wday/cxs/')) return jsonResponse(workdayPayload);
    throw new Error('the HTML page should not be requested when CXS succeeds');
  };
  const job = await enrichJob({
    url: 'https://wf.wd1.myworkdayjobs.com/en-US/WellsFargoJobs/job/Charlotte-NC/Software-Engineer_R-123456',
    source: 'SimplifyJobs', title: 'SWE', company: '', location: '', description: '',
  }, {}, fetchImpl);

  assert.deepEqual(calls, [{
    url: 'https://wf.wd1.myworkdayjobs.com/wday/cxs/wf/WellsFargoJobs/job/Software-Engineer_R-123456',
    accept: 'application/json',
  }]);
  assert.equal(job.enrichment, 'workday_cxs');
  assert.equal(job.company, 'Wells Fargo');
  assert.equal(job.title, 'Software Engineer');
  assert.equal(job.location, 'Charlotte, North Carolina / Chandler, Arizona');
  assert.equal(job.employmentType, 'Full time');
  assert.equal(job.description, "About this role: Build & ship 'data' pipelines. Partner with analysts – daily.");
  assert.equal(job.postedAt, '2026-08-26T00:00:00.000Z');
  assert.equal(job.freshnessBasis, 'workday_start_date');
  assert.equal(job.finalUrl, 'https://wf.wd1.myworkdayjobs.com/en-US/WellsFargoJobs/job/Charlotte-NC/Software-Engineer_R-123456');
  assert.equal(job.url, job.finalUrl);
});

test('recognises a Workday page reached through a tracked redirect', async () => {
  const finalUrl = 'https://leidos.wd5.myworkdayjobs.com/External/job/Reston-VA/Data-Analyst_R-00123';
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url.includes('/wday/cxs/')) {
      return jsonResponse({ jobPostingInfo: { title: 'Data Analyst', jobDescription: '<p>SQL and Python.</p>', location: 'Reston, VA', postedOn: 'Posted Today' } });
    }
    const response = new Response('{"redirected":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: finalUrl });
    return response;
  };
  const before = Date.now();
  const job = await enrichJob({ url: 'https://simplify.jobs/p/abc?utm_source=github', title: '', company: 'Leidos', location: '', description: '' }, {}, fetchImpl);

  assert.deepEqual(calls, [
    'https://simplify.jobs/p/abc?utm_source=github',
    'https://leidos.wd5.myworkdayjobs.com/wday/cxs/leidos/External/job/Data-Analyst_R-00123',
  ]);
  assert.equal(job.enrichment, 'workday_cxs');
  assert.equal(job.company, 'Leidos');
  assert.equal(job.description, 'SQL and Python.');
  assert.equal(job.finalUrl, finalUrl);
  assert.equal(job.freshnessBasis, 'workday_posted_on');
  assert.ok(Math.abs(new Date(job.postedAt).getTime() - before) < 60_000);
});

test('falls back to the HTML path when the Workday CXS call fails', async () => {
  const pageUrl = 'https://marsh.wd1.myworkdayjobs.com/en-US/MMC/job/New-York/Analyst_R_300001';
  for (const cxsResponse of [
    () => jsonResponse({ error: 'not found' }, 404),
    () => jsonResponse({ jobPostingInfo: { title: 'no description here' } }),
    () => new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'application/json' } }),
    () => { throw new Error('socket hang up'); },
  ]) {
    const calls = [];
    const fetchImpl = async url => {
      calls.push(url);
      if (url.includes('/wday/cxs/')) return cxsResponse();
      return new Response('{"widget":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const job = await enrichJob({ url: pageUrl, title: 'Analyst', company: 'Marsh', location: '', description: '' }, {}, fetchImpl);
    assert.equal(calls.length, 2, 'CXS is tried once, then the page itself');
    assert.equal(calls[1], pageUrl);
    assert.equal(job.enrichment, 'failed');
    assert.equal(job.enrichmentError, 'json_unparsed');
    assert.equal(job.enrichmentRetryable, true);
  }
});

test('non-Workday URLs never touch the CXS endpoint', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    return new Response('<html><head><title>Data Engineer</title><meta name="description" content="Own the warehouse."></head></html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    });
  };
  const job = await enrichJob({ url: 'https://careers.example.com/jobs/77', title: '', company: 'Example', location: '', description: '' }, {}, fetchImpl);
  assert.deepEqual(calls, ['https://careers.example.com/jobs/77']);
  assert.equal(job.enrichment, 'html_metadata');
  assert.equal(job.title, 'Data Engineer');
  assert.equal(job.description, 'Own the warehouse.');
});

test('HTTP 403, 404, and 410 are reported as unrecoverable', async () => {
  for (const [status, reason] of [[403, 'blocked'], [404, 'removed'], [410, 'removed']]) {
    const job = await enrichJob(
      { url: `https://careers.example.com/jobs/${status}`, source: 'SimplifyJobs', title: 'Data Analyst', company: 'Acme', location: '', description: '' },
      {},
      async () => new Response('denied', { status, headers: { 'content-type': 'text/html' } }),
    );
    assert.equal(job.enrichment, 'failed');
    assert.equal(job.enrichmentError, `http_${status}`);
    assert.equal(job.enrichmentRetryable, false);
    assert.equal(job.enrichmentReason, reason);
    const message = enrichmentWarningMessage(job, { attempts: 1, completed: true });
    assert.ok(message.includes(reason), message);
    assert.ok(message.includes('Acme — Data Analyst (SimplifyJobs)'), message);
    assert.ok(message.includes(`http_${status}`), message);
    assert.ok(message.includes('will not be retried'), message);
  }
});

test('429, 5xx, timeouts, and unparsed JSON stay retryable', async () => {
  const cases = [
    ['http_429', async () => new Response('slow down', { status: 429 })],
    ['http_503', async () => new Response('down', { status: 503 })],
    ['json_unparsed', async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })],
    ['timeout', async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; }],
  ];
  for (const [expectedError, fetchImpl] of cases) {
    const job = await enrichJob({ url: 'https://careers.example.com/jobs/flaky', title: 'Data Analyst', company: 'Acme', location: '', description: '' }, {}, fetchImpl);
    assert.equal(job.enrichment, 'failed');
    assert.equal(job.enrichmentError, expectedError);
    assert.equal(job.enrichmentRetryable, true);
    assert.equal(job.enrichmentReason, undefined);
    assert.match(enrichmentWarningMessage(job, { attempts: 1, completed: false }), /attempt 1\/3 failed and will be retried next run/);
    assert.match(enrichmentWarningMessage(job, { attempts: 3, completed: true }), /failed enrichment 3 times and will not be retried/);
  }
});
