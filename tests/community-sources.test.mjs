// Community GitHub lists (four README layouts), the Hacker News "Who is hiring" thread, and the RemoteOK
// feed: one recorded fixture per source (structures recorded on 2026-09-18, companies replaced with
// placeholders), the zero-parse warning, HTTP failures, per-source isolation, and the first-run baseline.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { GITHUB_LISTS, HACKER_NEWS_SOURCE, REMOTEOK_SOURCE, builtinSources, githubLists } from '../src/collectors/catalog.mjs';
import { ageTokenToDays, collectGithubList, listDateToIso, parseListRows, parsePipeTables } from '../src/collectors/github-lists.mjs';
import { collectHackerNewsHiring, parseHiringComments, parseHiringHeader } from '../src/collectors/hn-hiring.mjs';
import { collectRemoteOk, parseRemoteOkJobs, remoteOkLocation } from '../src/collectors/remoteok.mjs';
import { collectEnabledSources } from '../src/index.mjs';
import { isJobSeen } from '../src/state.mjs';
import { sha256 } from '../src/utils.mjs';

const fixtures = new URL('./fixtures/lists/', import.meta.url);
const NOW = new Date('2026-09-19T01:00:00Z');

async function text(name) { return fs.readFile(new URL(name, fixtures), 'utf8'); }
async function json(name) { return JSON.parse(await text(name)); }
function response(body, { status = 200, type = 'text/plain' } = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } });
}

test('the catalog lists every verified GitHub list, applies per-list overrides, and reports enabled state for the hub', () => {
  assert.equal(GITHUB_LISTS.length, 11);
  const defaults = githubLists({ sources: {} });
  assert.ok(defaults.every(list => list.enabled), 'lists are on unless config says otherwise');
  assert.equal(defaults[0].url, 'https://raw.githubusercontent.com/jobright-ai/2026-Data-Analysis-Internship/master/README.md');
  const tuned = githubLists({ sources: { githubLists: { lists: { vanshNewGrad: { enabled: false }, zapplyInternships: { url: 'https://example.com/list.md' } } } } });
  assert.equal(tuned.find(list => list.id === 'vanshNewGrad').enabled, false);
  assert.equal(tuned.find(list => list.id === 'zapplyInternships').url, 'https://example.com/list.md');
  assert.ok(githubLists({ sources: { githubLists: { enabled: false } } }).every(list => !list.enabled), 'the group switch wins');
  const rows = builtinSources({ sources: { simplifyNewGrad: { enabled: true }, remoteOk: { enabled: false } } });
  assert.deepEqual(rows.slice(0, 2).map(row => [row.id, row.enabled]), [['simplifyInternships', false], ['simplifyNewGrad', true]]);
  assert.equal(rows.find(row => row.id === 'hackerNewsHiring').enabled, true);
  assert.equal(rows.find(row => row.id === 'remoteOk').enabled, false);
  assert.equal(rows.length, 2 + 11 + 2 + 3);
});

test('pipe tables split into tables with header columns; dates and age tokens normalize', () => {
  const tables = parsePipeTables('intro\n| A | B |\n|---|---|\n| 1 | 2 |\n\n| C |\n| :---: |\n| x |\n| y |\n');
  assert.deepEqual(tables, [{ columns: ['A', 'B'], rows: [['1', '2']] }, { columns: ['C'], rows: [['x'], ['y']] }]);
  assert.equal(listDateToIso('Sep 18', NOW), '2026-09-18T12:00:00.000Z');
  assert.equal(listDateToIso('Oct 02', NOW), '2025-10-02T12:00:00.000Z', 'a month/day after today belongs to last year');
  assert.equal(listDateToIso('Sep 18, 2026', NOW), '2026-09-18T12:00:00.000Z');
  assert.equal(listDateToIso('Sept 5', NOW), '2026-09-05T12:00:00.000Z');
  assert.equal(listDateToIso('Date unknown', NOW), null);
  assert.equal(ageTokenToDays('23m'), 23 / 1440);
  assert.equal(ageTokenToDays('2h'), 2 / 24);
  assert.equal(ageTokenToDays('3d'), 3);
  assert.equal(ageTokenToDays('2w'), 14);
  assert.equal(ageTokenToDays('1mo'), 30);
  assert.equal(ageTokenToDays('Date unknown'), null);
});

test('vanshb03 layout: HTML apply links, repeated company rows, split locations, and closed rows without a link', async () => {
  const jobs = parseListRows(await text('vansh-internships.md'), { source: 'vanshb03 Summer 2027 Internships', roleType: 'internship', format: 'vansh', now: NOW });
  assert.deepEqual(jobs.map(job => [job.company, job.title, job.location, job.url, job.postedAt]), [
    ['Example Corp', 'Product Management Intern', 'Westerville, OH', 'https://careers.example.com/job/20278933', '2026-08-21T12:00:00.000Z'],
    ['Example Corp', 'Data Science Intern, MBA', 'Delaware, OH', 'https://careers.example.com/job/20278958', '2026-08-21T12:00:00.000Z'],
    ['Second Co', 'New Grad 2027: Associate Engineer', 'Chicago, IL · New York, NY', 'https://job-boards.greenhouse.io/secondco/jobs/1', '2026-09-17T12:00:00.000Z'],
    ['Third Co', 'Software Engineer Intern', 'Huntsville, AL', 'https://thirdco.wd1.myworkdayjobs.com/en-US/careers/job/US---Huntsville-AL/Software-Engineering-Intern_R1', '2025-10-02T12:00:00.000Z'],
  ]);
  assert.equal(jobs[0].source, 'vanshb03 Summer 2027 Internships');
  assert.equal(jobs[0].sourceKind, 'public_github_list');
  assert.equal(jobs[0].roleType, 'internship');
  assert.equal(jobs[0].freshnessBasis, 'source_list_date_posted');
  assert.equal(jobs[0].description, '', 'the posting page is fetched later like any list row');
  assert.doesNotMatch(jobs.map(job => job.url).join(' '), /utm_source/, 'tracking parameters are stripped');
});

test('zapply layout: bold companies, minute/hour/day/month age tokens, redirect apply links, and rows without a date', async () => {
  const jobs = parseListRows(await text('zapply-internships.md'), { source: 'Zapply Internships 2027', roleType: 'internship', format: 'zapply', now: NOW });
  assert.deepEqual(jobs.map(job => [job.company, job.title, job.location, job.sourceAgeDays]), [
    ['Example Corp', 'Software Development Engineer I (Former Summer 2026 Interns)', 'Seattle', 23 / 1440],
    ['Second Co', 'Software Engineering Intern (Summer 2027)', 'VA-STERLING', 2 / 24],
    ['Third Co', 'Data Analyst Intern', 'Remote', 3],
    ['Old Co', 'Machine Learning Intern', 'Boston', 30],
  ]);
  assert.equal(jobs[0].url, 'https://zapply.jobs/l/d/workday-examplecorp-jobs-RP1?s=gh-internships-2027', 'the redirect link is kept; enrichment follows it to the employer');
  assert.equal(jobs[0].freshnessBasis, 'source_age_days_approximate');
  assert.equal(jobs[0].postedAt, undefined);
});

test('jobright layout: linked bold companies, the posting link inside the title cell, and the work model folded into the location', async () => {
  const jobs = parseListRows(await text('jobright-new-grad.md'), { source: 'Jobright Data Analysis New Grad', roleType: 'new_grad', format: 'jobright', now: NOW });
  assert.deepEqual(jobs.map(job => [job.company, job.title, job.location, job.url, job.postedAt, job.workModel]), [
    ['Example Corp', 'Quantitative Research Analyst – University Graduate (US)', 'New York, NY, United States', 'https://jobright.ai/jobs/info/6a4b0edff9cbb100d1ab52df', '2026-09-18T12:00:00.000Z', 'On Site'],
    ['Second Co', 'Data Analyst', 'Denver, CO, United States · Remote', 'https://jobright.ai/jobs/info/e36cc53e5bd543b99a90ec9b', '2026-09-17T12:00:00.000Z', 'Remote'],
    ['Third Co', 'Data Scientist', 'Toronto, ON, Canada', 'https://jobright.ai/jobs/info/20155359a0ef14d459b64acc', '2026-09-16T12:00:00.000Z', 'Hybrid'],
  ]);
  assert.equal(jobs[0].roleType, 'new_grad');
});

test('zshah101 layout: two tables, [Apply](url) links, zero-width characters, full dates, and a parenthesised work model', async () => {
  const jobs = parseListRows(await text('zshah-internships.md'), { source: 'zshah101 Tech Internships 2027', roleType: 'internship', format: 'zshah', now: NOW });
  assert.deepEqual(jobs.map(job => [job.company, job.title, job.location, job.url, job.postedAt]), [
    ['Example Lab', 'Computing Undergraduate Student Intern: DevOps Internship Program - Summer 2027', 'Livermore, CA, United States', 'https://jobs.smartrecruiters.com/ExampleLab/1', '2026-09-18T12:00:00.000Z'],
    ['Second Co', 'Cybersecurity Summer 2027 Intern (Undergraduate)', 'Trevose, PA, United States · Hybrid', 'https://secondco.wd5.myworkdayjobs.com/External/job/Remote-MO/Cybersecurity-Summer-2027-Intern_1', '2026-09-18T12:00:00.000Z'],
    ['Third Co', 'Intern, Software Engineer AI Agents (Fall 2026/Winter 2027)', 'Houston, TX', 'https://job-boards.greenhouse.io/thirdco/jobs/3', '2026-09-10T12:00:00.000Z'],
  ]);
});

test('a list that returns 200 without parsable rows warns about a format change; an HTTP error throws', async () => {
  const warnings = [];
  const empty = await collectGithubList({ url: 'https://example.com/README.md', source: 'Zapply Internships 2027', roleType: 'internship', format: 'zapply', warnings, fetchImpl: async () => response('# Moved\n\nThe table lives in data.json now.') });
  assert.deepEqual(empty, []);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].source, 'Zapply Internships 2027');
  assert.match(warnings[0].message, /no job rows were parsed.*format may have changed/);
  const agents = [];
  const jobs = await collectGithubList({ url: 'https://example.com/README.md', source: 'vanshb03 Summer 2027 Internships', roleType: 'internship', format: 'vansh', warnings, now: NOW, userAgent: 'TestAgent/1.0', fetchImpl: async (url, options) => { agents.push(options.headers['user-agent']); return response(await text('vansh-internships.md')); } });
  assert.equal(jobs.length, 4);
  assert.deepEqual(agents, ['TestAgent/1.0']);
  assert.equal(warnings.length, 1);
  await assert.rejects(collectGithubList({ url: 'x', source: 'S', roleType: 'internship', format: 'vansh', fetchImpl: async () => response('', { status: 503 }) }), /S: HTTP 503/);
});

test('Hacker News: only top-level posts that mention early-career roles become jobs, with the thread convention parsed into company, title, and location', async () => {
  const story = await json('hn-who-is-hiring.json');
  const jobs = parseHiringComments(story, { now: NOW });
  assert.deepEqual(jobs.map(job => [job.company, job.title, job.location, job.roleType, job.url]), [
    ['Example Co Two', 'Machine Learning Intern, New Grad Software Engineer', 'New York, NY · ONSITE or REMOTE (US)', 'internship', 'https://news.ycombinator.com/item?id=49522912'],
    ['Example Co Three', 'Junior Data Analyst', 'Austin, TX (Hybrid)', 'entry_level', 'https://news.ycombinator.com/item?id=49522929'],
    ['Example Co Four', 'Multiple roles', 'Bengaluru, India · ONSITE', 'internship', 'https://news.ycombinator.com/item?id=49522950'],
  ], 'the senior-only post, the reply, and the bare question are left out; non-US posts go on to the hard filter');
  assert.equal(jobs[0].source, HACKER_NEWS_SOURCE);
  assert.equal(jobs[0].sourceKind, 'public_forum_thread');
  assert.equal(jobs[0].postedAt, '2026-09-17T15:02:11.000Z');
  assert.equal(jobs[0].enrichment, 'source_api', 'the comment itself is the description; nothing is fetched');
  assert.match(jobs[0].description, /^Example Co Two \(YC W24\) \| Machine Learning Intern.*We're a small team building evaluation infrastructure/);
  assert.doesNotMatch(jobs[0].description, /<a |&#x2F;/, 'HTML and entities are decoded');
  assert.equal(jobs[0].hnStoryTitle, 'Ask HN: Who is hiring? (September 2026)');
  assert.deepEqual(parseHiringHeader('Acme | Backend Engineer | Remote (US) | Full-time'), { company: 'Acme', title: 'Backend Engineer', location: 'Remote (US)', segments: ['Acme', 'Backend Engineer', 'Remote (US)', 'Full-time'] });
  assert.equal(parseHiringHeader(''), null);

  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url.includes('search_by_date')) return response({ hits: [{ objectID: '49600000', title: 'Ask HN: Who wants to be hired? (September 2026)' }, { objectID: '49522897', title: 'Ask HN: Who is hiring? (September 2026)', created_at: '2026-09-01T15:01:17Z' }] }, { type: 'application/json' });
    return response(story, { type: 'application/json' });
  };
  const warnings = [];
  const collected = await collectHackerNewsHiring({ fetchImpl, warnings, now: NOW, userAgent: 'TestAgent/1.0' });
  assert.equal(collected.length, 3);
  assert.deepEqual(calls, ['https://hn.algolia.com/api/v1/search_by_date?query=%22who%20is%20hiring%22&tags=story,author_whoishiring&hitsPerPage=10', 'https://hn.algolia.com/api/v1/items/49522897'], 'the hiring thread is picked, not the wants-to-be-hired one');
  assert.deepEqual(warnings, []);
  const emptyWarnings = [];
  const none = await collectHackerNewsHiring({ warnings: emptyWarnings, fetchImpl: async url => (url.includes('search_by_date') ? response({ hits: [{ objectID: '1', title: 'Ask HN: Who is hiring? (September 2026)' }] }, { type: 'application/json' }) : response({ id: 1, children: [] }, { type: 'application/json' })) });
  assert.deepEqual(none, []);
  assert.match(emptyWarnings[0].message, /returned no top-level posts.*format may have changed/);
  await assert.rejects(collectHackerNewsHiring({ fetchImpl: async () => response({ hits: [] }, { type: 'application/json' }) }), /no "Ask HN: Who is hiring\?" thread/);
  await assert.rejects(collectHackerNewsHiring({ fetchImpl: async () => response('', { status: 429 }) }), /HTTP 429/);
});

test('RemoteOK: the legal notice is skipped, only early-career postings open to the United States are kept, and cards link back to remoteok.com', async () => {
  const feed = await json('remoteok-feed.json');
  const jobs = parseRemoteOkJobs(feed);
  assert.deepEqual(jobs.map(job => [job.company, job.title, job.location, job.roleType]), [
    ['Example Corp', 'Junior Data Analyst', 'Remote - US', 'entry_level'],
    ['Second Co', 'Machine Learning Intern', 'Remote', 'internship'],
    ['Fifth Co', 'New Grad Software Engineer', 'Remote · Worldwide', 'new_grad'],
    ['Sixth Co', 'Entry Level QA Tester', 'Remote · United States', 'entry_level'],
  ], 'the senior posting and the Berlin-only junior posting are dropped');
  assert.equal(jobs[0].source, REMOTEOK_SOURCE);
  assert.equal(jobs[0].sourceKind, 'public_json_feed');
  assert.equal(jobs[0].url, 'https://remoteok.com/remote-jobs/remote-junior-data-analyst-example-corp-1001');
  assert.equal(jobs[0].finalUrl, jobs[0].url);
  assert.equal(jobs[0].salary, 'USD 60000–80000 per year');
  assert.equal(jobs[0].postedAt, '2026-09-18T12:00:00.000Z');
  assert.equal(jobs[0].description, 'Example Corp is hiring a junior analyst to own weekly reporting. SQL and Python');
  assert.equal(jobs[0].enrichment, 'source_api');
  assert.deepEqual(jobs[0].tags, ['data', 'junior', 'analyst']);
  assert.equal(jobs[1].salary, '');
  assert.equal(remoteOkLocation(''), 'Remote');
  assert.equal(remoteOkLocation('Remote'), 'Remote');
  assert.equal(remoteOkLocation('Anywhere'), 'Remote · Anywhere');
  assert.equal(remoteOkLocation('Greater London, '), null);
  assert.equal(remoteOkLocation('Austin, TX'), 'Remote · Austin, TX');

  const agents = [];
  const warnings = [];
  const collected = await collectRemoteOk({ warnings, userAgent: 'TestAgent/1.0', fetchImpl: async (url, options) => { agents.push([url, options.headers['user-agent']]); return response(feed, { type: 'application/json' }); } });
  assert.equal(collected.length, 4);
  assert.deepEqual(agents, [['https://remoteok.com/api', 'TestAgent/1.0']], 'the feed is read with the configured user agent, as its terms ask');
  assert.deepEqual(warnings, []);
  const empty = await collectRemoteOk({ warnings, fetchImpl: async () => response([feed[0]], { type: 'application/json' }) });
  assert.deepEqual(empty, []);
  assert.match(warnings[0].message, /no postings were parsed.*format may have changed/);
  await assert.rejects(collectRemoteOk({ fetchImpl: async () => response('', { status: 503 }) }), /RemoteOK: HTTP 503/);
});

function sourcesConfig() {
  const lists = Object.fromEntries(GITHUB_LISTS.map(list => [list.id, { enabled: list.id === 'vanshInternships' }]));
  return { network: { userAgent: 'TestAgent/1.0' }, sources: { simplifyInternships: { enabled: false }, simplifyNewGrad: { enabled: false }, githubLists: { enabled: true, lists }, hackerNewsHiring: { enabled: true }, remoteOk: { enabled: true }, emailFiles: { enabled: false }, himalaya: { enabled: false }, careerOps: { enabled: false } } };
}

test('one failing community source only warns while the others deliver, and every source is counted', async () => {
  const warnings = [];
  const sourceStats = [];
  const seen = [];
  const jobs = await collectEnabledSources(sourcesConfig(), NOW, {
    warnings, sourceStats,
    collectors: {
      githubList: async options => { seen.push(options); return [{ url: 'https://example.com/list/1', title: 'Data Intern', company: 'A', description: '' }, { url: 'https://example.com/list/2', title: 'ML Intern', company: 'B', description: '' }]; },
      hackerNewsHiring: async () => { throw new Error('Algolia returned HTTP 503'); },
      remoteOk: async () => [{ url: 'https://remoteok.com/remote-jobs/x', title: 'Junior Analyst', company: 'C', description: 'd' }],
    },
  });
  assert.equal(jobs.length, 3);
  assert.equal(seen.length, 1, 'only the one enabled list ran');
  assert.equal(seen[0].source, 'vanshb03 Summer 2027 Internships');
  assert.equal(seen[0].format, 'vansh');
  assert.equal(seen[0].userAgent, 'TestAgent/1.0');
  assert.deepEqual(warnings.map(warning => [warning.stage, warning.source, warning.message]), [['collector', HACKER_NEWS_SOURCE, 'Algolia returned HTTP 503']]);
  assert.deepEqual(sourceStats.map(stat => [stat.name, stat.ok, stat.count]), [['vanshb03 Summer 2027 Internships', true, 2], [HACKER_NEWS_SOURCE, false, 0], [REMOTEOK_SOURCE, true, 1]]);
});

test('the first collection of a new community source baselines only old postings, keeps in-window ones, and never swallows a posting another source listed', async () => {
  const state = { seen: {} };
  const config = sourcesConfig();
  config.sources.simplifyNewGrad = { enabled: true, url: 'new-grad' };
  const collectors = {
    simplify: async () => [{ url: 'https://example.com/list/shared', title: 'Shared Intern', company: 'S', description: '', sourceAgeDays: 1 }],
    githubList: async () => [
      { url: 'https://example.com/list/old', title: 'Old Intern', company: 'A', description: '', postedAt: '2026-09-01T12:00:00Z' },
      { url: 'https://example.com/list/shared', title: 'Shared Intern', company: 'A', description: '', postedAt: '2026-09-01T12:00:00Z' },
      { url: 'https://example.com/list/undated', title: 'Undated Intern', company: 'A', description: '' },
      { url: 'https://example.com/list/fresh', title: 'Fresh Intern', company: 'A', description: '', sourceAgeDays: 0.5 },
    ],
    hackerNewsHiring: async () => [{ url: 'https://news.ycombinator.com/item?id=1', title: 'Junior Analyst', company: 'B', description: 'x', postedAt: '2026-09-18T20:00:00Z' }],
    remoteOk: async () => [{ url: 'https://remoteok.com/remote-jobs/x', title: 'Intern', company: 'C', description: 'd', postedAt: '2026-08-01T00:00:00Z' }],
  };
  const warnings = [];
  const sourceStats = [];
  const cutoff = new Date(NOW.getTime() - 24 * 3600 * 1000);
  const first = await collectEnabledSources(config, cutoff, { warnings, sourceStats, collectors, baseline: { state, now: NOW, lookbackHours: 24 } });
  assert.deepEqual(first.map(job => job.title).sort(), ['Fresh Intern', 'Junior Analyst', 'Shared Intern'], 'in-window postings and the Simplify listing go through; old and undated ones do not');
  assert.deepEqual(Object.keys(state.sourceBaselines).sort(), [HACKER_NEWS_SOURCE, REMOTEOK_SOURCE, 'vanshb03 Summer 2027 Internships']);
  assert.deepEqual(state.sourceBaselines['vanshb03 Summer 2027 Internships'], { baselinedAt: NOW.toISOString(), count: 2 });
  assert.deepEqual(state.sourceBaselines[HACKER_NEWS_SOURCE], { baselinedAt: NOW.toISOString(), count: 0 });
  for (const url of ['https://example.com/list/old', 'https://example.com/list/undated', 'https://remoteok.com/remote-jobs/x']) assert.equal(isJobSeen(state, { url }), true, `${url} is baselined`);
  for (const url of ['https://example.com/list/shared', 'https://example.com/list/fresh', 'https://news.ycombinator.com/item?id=1']) assert.equal(isJobSeen(state, { url }), false, `${url} is not swallowed`);
  const oldEntry = Object.values(state.seen).find(entry => entry.url === 'https://example.com/list/old');
  assert.equal(oldEntry.lastEnrichment, 'source_baseline');
  assert.equal(oldEntry.baseline, true);
  assert.equal(oldEntry.postedAt, '2026-09-01T12:00:00Z', 'the posting date is kept so a later release can judge it');
  assert.equal(warnings.length, 3);
  assert.ok(warnings.every(warning => warning.level === 'info' && /older than the 24-hour window as already seen \(baseline\)/.test(warning.message)));
  assert.match(warnings.find(warning => warning.source === 'vanshb03 Summer 2027 Internships').message, /recorded 2 posting\(s\).*; 1 inside the window go through the normal flow/, 'the shared posting is neither baselined nor counted as this list\'s own in-window posting');
  assert.deepEqual(sourceStats.map(stat => [stat.name, stat.baseline, stat.count, stat.jobCount, stat.baselineCount]), [['SimplifyJobs New Grad', undefined, 1, undefined, undefined], ['vanshb03 Summer 2027 Internships', true, 1, 4, 2], [HACKER_NEWS_SOURCE, true, 1, 1, 0], [REMOTEOK_SOURCE, true, 0, 1, 1]]);

  const second = await collectEnabledSources(config, cutoff, { warnings: [], sourceStats: [], collectors, baseline: { state, now: new Date('2026-09-20T01:00:00Z'), lookbackHours: 24 } });
  assert.equal(second.length, 7, 'from the second night on every posting flows through (the seen check downstream drops the old ones)');
  const deferredState = { seen: {}, sourceBaselines: {}, deferred: { [sha256('https://example.com/list/old')]: { deferredCount: 1 } } };
  const withDeferred = await collectEnabledSources({ ...config, sources: { ...config.sources, simplifyNewGrad: { enabled: false } } }, cutoff, { collectors, baseline: { state: deferredState, now: NOW, lookbackHours: 24 } });
  assert.ok(withDeferred.some(job => job.title === 'Old Intern'), 'a deferred posting is returned whatever its age');
  assert.equal(isJobSeen(deferredState, { url: 'https://example.com/list/old' }), false);
  const without = await collectEnabledSources(sourcesConfig(), cutoff, { collectors });
  assert.equal(without.length, 6, 'without a baseline context the collectors behave as before');
});
