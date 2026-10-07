// Zapply links resolve to the employer posting before enrichment: redirects are walked one hop at a time
// (recorded chains in tests/fixtures/zapply/redirects.json), slugs that spell out the address are decoded
// when the network is unavailable, a gone listing or an undecodable slug is a failure the pipeline warns
// about, and the Zapply copy dedupes with the employer's own listing. No network.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { decodeZapplySlug, isZapplyLink, resolveZapplyLink } from '../src/collectors/zapply.mjs';
import { dedupeByUrl, resolveZapplyJobs } from '../src/index.mjs';
import { identifyBoard } from '../src/collectors/ats-boards.mjs';

const { chains } = JSON.parse(await fs.readFile(new URL('./fixtures/zapply/redirects.json', import.meta.url), 'utf8'));

// A fetch that answers from the recorded chains: the n-th request of a chain gets its n-th hop.
function recordedFetch(calls = []) {
  const hops = new Map();
  for (const [start, chain] of Object.entries(chains)) {
    let current = start;
    for (const hop of chain) { hops.set(current, hop); current = new URL(hop.location, current).href; }
  }
  return async (url, options) => {
    calls.push({ url, redirect: options.redirect });
    const hop = hops.get(url);
    if (!hop) return { status: 404, headers: new Map() };
    return { status: hop.status, headers: new Map([['location', hop.location]]) };
  };
}

test('every recorded slug shape resolves through its redirects to the employer posting', async () => {
  const calls = [];
  const fetchImpl = recordedFetch(calls);
  const expected = {
    'workday-examplecorp-examplecorp-jobs-R0240630': 'https://examplecorp.wd1.myworkdayjobs.com/examplecorp_jobs/job/McLean-VA/Data-Engineer_R0240630',
    'greenhouse-exampleboard-8873383002': 'https://boards.greenhouse.io/exampleboard/jobs/8873383002?gh_jid=8873383002',
    'ashby-example-ai-2796d32a-9f7c-4008-a2c5-50dd53b0f2fe': 'https://jobs.ashbyhq.com/example-ai/2796d32a-9f7c-4008-a2c5-50dd53b0f2fe',
    'oracle-example-bank-210794467': 'https://examplebank.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/210794467',
    'sr-ExampleInc-744000153809000': 'https://jobs.smartrecruiters.com/ExampleInc/744000153809000',
  };
  for (const [start] of Object.entries(chains)) {
    assert.equal(isZapplyLink(start), true);
    const slug = new URL(start).pathname.split('/')[3];
    const result = await resolveZapplyLink(start, { fetchImpl });
    if (slug.startsWith('lever-')) {
      assert.deepEqual(result, { url: null, reason: 'the listing is gone (redirects to https://zapply.jobs/jobs)' }, 'a gone listing is not decoded into a dead employer link');
      continue;
    }
    assert.deepEqual(result, { url: expected[slug], via: 'redirect' }, slug);
  }
  assert.equal(calls.every(call => call.redirect === 'manual'), true, 'redirects are never followed blindly');
  assert.equal(identifyBoard(expected['workday-examplecorp-examplecorp-jobs-R0240630'])?.kind, 'workday', 'the resolved URL reaches the Workday-aware path');
  assert.equal(identifyBoard(expected['greenhouse-exampleboard-8873383002'])?.kind, 'greenhouse');
  assert.equal(isZapplyLink('https://zapply.jobs/jobs'), false);
  assert.equal(isZapplyLink('https://example.com/l/d/greenhouse-x-1'), false);
});

test('offline or on a network error, slugs that spell out the address are decoded; the others fail', async () => {
  assert.equal(decodeZapplySlug('https://zapply.jobs/l/d/greenhouse-exampleboard-8873383002?s=x'), 'https://boards.greenhouse.io/exampleboard/jobs/8873383002');
  assert.equal(decodeZapplySlug('https://zapply.jobs/l/d/lever-example-ai-40a22216-c73b-4ec1-bfc1-dc0e1938eaba'), 'https://jobs.lever.co/example-ai/40a22216-c73b-4ec1-bfc1-dc0e1938eaba');
  assert.equal(decodeZapplySlug('https://zapply.jobs/l/d/ashby-example-ai-2796d32a-9f7c-4008-a2c5-50dd53b0f2fe'), 'https://jobs.ashbyhq.com/example-ai/2796d32a-9f7c-4008-a2c5-50dd53b0f2fe');
  assert.equal(decodeZapplySlug('https://zapply.jobs/l/d/sr-ExampleInc-744000153809000'), 'https://jobs.smartrecruiters.com/ExampleInc/744000153809000');
  assert.equal(decodeZapplySlug('https://zapply.jobs/l/d/workday-examplecorp-examplecorp-jobs-R0240630'), null, 'a Workday slug lacks the host and the site name');
  assert.equal(decodeZapplySlug('https://zapply.jobs/l/d/oracle-example-bank-210794467'), null);
  const offline = await resolveZapplyLink('https://zapply.jobs/l/d/greenhouse-exampleboard-8873383002?s=x', { network: false });
  assert.deepEqual(offline, { url: 'https://boards.greenhouse.io/exampleboard/jobs/8873383002', via: 'slug' });
  const down = async () => { throw new Error('getaddrinfo ENOTFOUND zapply.jobs'); };
  assert.deepEqual(await resolveZapplyLink('https://zapply.jobs/l/d/sr-ExampleInc-744000153809000', { fetchImpl: down }), { url: 'https://jobs.smartrecruiters.com/ExampleInc/744000153809000', via: 'slug' });
  assert.deepEqual(await resolveZapplyLink('https://zapply.jobs/l/d/workday-examplecorp-examplecorp-jobs-R0240630', { fetchImpl: down }), { url: null, reason: 'getaddrinfo ENOTFOUND zapply.jobs' });
  const looping = async url => ({ status: 302, headers: new Map([['location', `${url.replace(/\/?(\?.*)?$/, '')}x/`]]) });
  assert.match((await resolveZapplyLink('https://zapply.jobs/l/d/workday-a-b-1', { fetchImpl: looping })).reason, /more than 4 redirects/);
});

test('the pipeline step swaps in the employer URL, keeps the Zapply link as the original, reports failures, and dedupes against the employer listing', async () => {
  const zapplyJob = (slug, extra = {}) => ({ url: `https://zapply.jobs/l/d/${slug}?s=gh-new-grad-jobs-2027`, title: 'Data Engineer', company: 'Example Corp', source: 'Zapply New Grad Jobs 2027', sourceKind: 'public_github_list', ...extra });
  const jobs = [
    zapplyJob('workday-examplecorp-examplecorp-jobs-R0240630'),
    zapplyJob('lever-example-ai-40a22216-c73b-4ec1-bfc1-dc0e1938eaba', { url: 'https://zapply.jobs/l/d/lever-example-ai-40a22216-c73b-4ec1-bfc1-dc0e1938eaba?s=gh-internships-2027' }),
    { url: 'https://boards.greenhouse.io/exampleboard/jobs/8873383002?gh_jid=8873383002', title: 'Data Engineer', company: 'Example Board', source: 'Example Board (Greenhouse)', sourceKind: 'public_ats_board', enrichment: 'ats_api', description: 'full text from the board API' },
    zapplyJob('greenhouse-exampleboard-8873383002'),
    { url: 'https://example.com/jobs/1', title: 'Analyst', source: 'Email' },
  ];
  const result = await resolveZapplyJobs(jobs, { fetchImpl: recordedFetch() });
  assert.deepEqual(result.jobs.map(job => job.url), [
    'https://examplecorp.wd1.myworkdayjobs.com/examplecorp_jobs/job/McLean-VA/Data-Engineer_R0240630',
    'https://zapply.jobs/l/d/lever-example-ai-40a22216-c73b-4ec1-bfc1-dc0e1938eaba?s=gh-internships-2027',
    'https://boards.greenhouse.io/exampleboard/jobs/8873383002?gh_jid=8873383002',
    'https://boards.greenhouse.io/exampleboard/jobs/8873383002?gh_jid=8873383002',
    'https://example.com/jobs/1',
  ]);
  assert.deepEqual([result.jobs[0].originalUrl, result.jobs[0].zapplyUrl, result.jobs[0].zapplyResolvedVia], ['https://zapply.jobs/l/d/workday-examplecorp-examplecorp-jobs-R0240630?s=gh-new-grad-jobs-2027', 'https://zapply.jobs/l/d/workday-examplecorp-examplecorp-jobs-R0240630?s=gh-new-grad-jobs-2027', 'redirect']);
  assert.deepEqual(result.failures, [{ url: 'https://zapply.jobs/l/d/lever-example-ai-40a22216-c73b-4ec1-bfc1-dc0e1938eaba?s=gh-internships-2027', reason: 'the listing is gone (redirects to https://zapply.jobs/jobs)' }]);
  // Deduped on the resolved URL: one posting, the board's full description and API enrichment kept, the
  // Zapply link kept as the original so it is marked seen with it.
  const merged = dedupeByUrl(result.jobs);
  assert.equal(merged.length, 4);
  const greenhouse = merged.find(job => job.url.startsWith('https://boards.greenhouse.io/'));
  assert.deepEqual([greenhouse.enrichment, greenhouse.description, greenhouse.zapplyUrl, greenhouse.source], ['ats_api', 'full text from the board API', 'https://zapply.jobs/l/d/greenhouse-exampleboard-8873383002?s=gh-new-grad-jobs-2027', 'Example Board (Greenhouse) | Zapply New Grad Jobs 2027']);
  // A 404 from Zapply (no redirect) falls back to the slug when it spells out the address.
  const unknown = await resolveZapplyJobs([zapplyJob('lever-example-ai-40a22216-c73b-4ec1-bfc1-dc0e1938eaba')], { fetchImpl: recordedFetch() });
  assert.equal(unknown.jobs[0].url, 'https://jobs.lever.co/example-ai/40a22216-c73b-4ec1-bfc1-dc0e1938eaba');
  assert.equal(unknown.jobs[0].zapplyResolvedVia, 'slug');
  // Offline (fetchDescriptions false): decode what can be decoded, and no warning for the rest.
  const offline = await resolveZapplyJobs(jobs, { network: false });
  assert.deepEqual(offline.failures, []);
  assert.equal(offline.jobs[3].url, 'https://boards.greenhouse.io/exampleboard/jobs/8873383002');
});
