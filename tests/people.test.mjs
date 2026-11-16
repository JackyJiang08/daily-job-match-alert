// Message to Recruiters people (2026-11-16): queries, result parsing, the company filter, ranking with the kind
// caps, the 30-day cache, the monthly cap, and the no-key path. Every search answer here is a stub; no test
// reaches a real search API, and every stub asserts it is never asked for linkedin.com.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isLinkedInUrl } from '../src/outreach/links.mjs';
import { personalizeMessage } from '../src/outreach/messages.mjs';
import {
  companyMention, companyNamesFor, fallbackSearches, findPeople, functionTerm, jobPlace, outreachProfile, parseProfileResult,
  peopleCachePath, peopleFromResults, peopleQueries, peopleSearchSettings, peopleUsagePath, pickPeople, postingPeople, profileFromText,
  schoolShortName, scorePerson,
} from '../src/outreach/people.mjs';

const URL_OF = slug => `https://www.linkedin.com/in/${slug}`;
const JOB = { title: 'Data Analyst Intern', roleType: 'internship', location: 'Chicago, IL', description: 'You will join our Payments Analytics team and build dashboards.' };
const PROFILE = { schools: [{ name: 'Example State University', short: 'ESU' }], pastEmployers: [] };
const NOW = new Date('2026-11-16T18:00:00Z');

test('titles: "Name - Title - Company", "Name - Company", "Name – Title at Company", middle names, emoji and the LinkedIn suffix', () => {
  const parse = (title, snippet = '') => parseProfileResult({ title, url: URL_OF('x'), snippet });
  assert.deepEqual(
    (({ name, firstName, headline }) => ({ name, firstName, headline }))(parse('Jane A. Doe - University Recruiter - Example Corp | LinkedIn')),
    { name: 'Jane A. Doe', firstName: 'Jane', headline: 'University Recruiter · Example Corp' },
  );
  assert.equal(parse('Sam Lee - Example Corp | LinkedIn').headline, 'Example Corp');
  assert.equal(parse('Sam Lee – Data Science Manager at Example Corp - LinkedIn').headline, 'Data Science Manager at Example Corp');
  assert.equal(parse('Maria José de la Cruz - Talent Acquisition - Example Corp').name, 'Maria José de la Cruz');
  const emoji = parse('🌟 Ana Ruiz 🚀, MBA (She/Her) - Campus Recruiting 🎓 - Example Corp | LinkedIn');
  assert.equal(emoji.name, 'Ana Ruiz');
  assert.equal(emoji.headline, 'Campus Recruiting · Example Corp');
  assert.equal(parse('Dr. Lee Park - Director - Example Corp').firstName, 'Lee');
  // Any LinkedIn subdomain becomes the www profile link; anything but /in/<slug> is not a person.
  assert.equal(parseProfileResult({ title: 'Jane Doe - Example Corp', url: 'https://uk.linkedin.com/in/Jane-Doe-123/' }).url, URL_OF('jane-doe-123'));
  for (const url of ['https://www.linkedin.com/company/example-corp', 'https://www.linkedin.com/posts/jane-doe_hiring', 'https://www.linkedin.com/pub/dir/Jane/Doe', 'https://example.com/in/jane']) {
    assert.equal(parseProfileResult({ title: 'Jane Doe - Example Corp', url }), null, url);
  }
});

test('results: kept only when the company is named and not as a former employer; one per slug', () => {
  const names = companyNamesFor(['Example Corp', 'Example Corporation Inc.']);
  assert.ok(names.includes('Example Corporation'));
  assert.equal(companyMention('Former Example Corp recruiter', names), 'former');
  assert.equal(companyMention('Ex-Example Corp · now at Other Co', names), 'former');
  assert.equal(companyMention('previously at Example Corp', names), 'former');
  assert.equal(companyMention('Retired from Example Corp', names), 'former');
  assert.equal(companyMention('Recruiter at Example Corp', names), 'current');
  assert.equal(companyMention('Recruiter at ExampleCorpX', names), null);
  const people = peopleFromResults([
    { title: 'Jane Doe - University Recruiter - Example Corp | LinkedIn', url: URL_OF('jane'), snippet: '' },
    { title: 'Jane Doe - Recruiter - Example Corp | LinkedIn', url: URL_OF('jane'), snippet: 'duplicate slug' },
    { title: 'Sam Lee - Recruiter - Other Co | LinkedIn', url: URL_OF('sam'), snippet: 'Talent at Other Co.' },
    { title: 'Ana Ruiz - Recruiter | LinkedIn', url: URL_OF('ana'), snippet: 'Formerly Example Corp; now Other Co.' },
    { title: 'Example Corp | LinkedIn', url: 'https://www.linkedin.com/company/example-corp', snippet: 'Example Corp' },
    { title: 'Lee Park - Example Corp | LinkedIn', url: URL_OF('lee'), snippet: 'Recruiting at Example Corp.' },
  ], names);
  assert.deepEqual(people.map(person => person.slug), ['jane', 'lee']);
});

test('the profile: schools and employers from the digest, short names, config fallback with its own short', () => {
  const digest = 'Skills: sql\nExample State University Aug 2023 – May 2027\nBachelor of Science, Statistics\nPublication: A Paper at Example Institute 2026\nExample Corp | Data Intern | Chicago, IL Jun 2026 – Aug 2026\n';
  assert.deepEqual(profileFromText(digest), { schools: ['Example State University'], pastEmployers: ['Example Corp'] });
  assert.equal(schoolShortName('University of Example at North Town'), 'UENT');
  assert.equal(schoolShortName('Example College'), 'Example College', 'fewer than three initials keeps the name');
  assert.deepEqual(outreachProfile({ digests: [digest] }).schools, [{ name: 'Example State University', short: 'ESU' }]);
  // The config's short wins; without a digest the config is read; with neither there is no Alumni search.
  assert.deepEqual(outreachProfile({ digests: [digest], config: { outreach: { profile: { schools: [{ name: 'Example State University', short: 'Example State' }] } } } }).schools[0].short, 'Example State');
  assert.deepEqual(outreachProfile({ config: { outreach: { profile: { schools: ['University of Example at North Town'], pastEmployers: ['Other Co'] } } } }), { schools: [{ name: 'University of Example at North Town', short: 'UENT' }], pastEmployers: ['Other Co'] });
  const none = outreachProfile({});
  assert.deepEqual(none.schools, []);
  assert.deepEqual(peopleQueries({ company: 'Example Corp', job: JOB, profile: none }).map(item => item.kind), ['recruiter', 'team']);
});

test('queries: early-career recruiter terms, the team name from the JD with the city, every spelling of the school', () => {
  const school = { schools: [{ name: 'University of Example at North Town', short: 'UENT' }] };
  const [recruiter, team, alumni] = peopleQueries({ company: 'Example Corp', job: JOB, profile: school });
  assert.equal(recruiter.query, 'site:linkedin.com/in "Example Corp" ("university recruiter" OR "campus recruiter" OR "early career" OR "talent acquisition" OR recruiter)');
  assert.equal(team.query, 'site:linkedin.com/in "Example Corp" "Payments Analytics" (manager OR director OR lead OR head) "Chicago"');
  assert.equal(alumni.query, 'site:linkedin.com/in "Example Corp" ("University of Example at North Town" OR "University of Example North Town" OR "UENT")');
  assert.equal(team.cacheKey, 'team:example corp:payments analytics');
  const experienced = peopleQueries({ company: 'Example Corp', job: { title: 'Senior Machine Learning Engineer', roleType: 'entry_level', location: 'Remote - US' } });
  assert.equal(experienced[0].query, 'site:linkedin.com/in "Example Corp" ("technical recruiter" OR "talent acquisition" OR recruiter)');
  assert.equal(experienced[1].query, 'site:linkedin.com/in "Example Corp" "machine learning" (manager OR director OR lead OR head)', 'Remote adds no city');
  assert.deepEqual(['Product Analyst', 'Consultant, Technology', 'Data Scientist I'].map(title => functionTerm({ title }).term), ['analytics', 'consulting', 'data science']);
  assert.deepEqual(jobPlace({ location: 'New York, NY' }), { city: 'New York', state: 'NY', stateName: 'New York' });
  const buttons = fallbackSearches({ company: 'Example Corp', job: JOB, profile: PROFILE });
  assert.deepEqual(buttons.map(item => item.label), ['Find Recruiters', 'Find Team', 'Find Alumni']);
  assert.equal(new URL(buttons[2].url).searchParams.get('q'), 'site:linkedin.com/in "Example Corp" ("Example State University" OR "ESU")');
  assert.ok(buttons.every(item => item.url.startsWith('https://www.google.com/search?q=')));
});

test('ranking: the scores, the threshold, In Posting first, and the kind caps with the others filling in', () => {
  const ctx = { job: JOB, fn: functionTerm(JOB, 'Example Corp'), place: jobPlace(JOB), schools: PROFILE.schools, companyNames: ['Example Corp'] };
  const person = (headline, snippet = '') => ({ headline, snippet });
  assert.equal(scorePerson(person('University Recruiter · Example Corp'), { ...ctx, kind: 'recruiter' }), 5);
  assert.equal(scorePerson(person('Recruiter · Example Corp', 'Chicago, Illinois'), { ...ctx, kind: 'recruiter' }), 4);
  assert.equal(scorePerson(person('Example Corp', 'Talent acquisition partner at Example Corp.'), { ...ctx, kind: 'recruiter' }), 2, 'a company-only headline reads the snippet');
  assert.equal(scorePerson(person('Payments Analytics Manager · Example Corp'), { ...ctx, kind: 'team' }), 5);
  assert.equal(scorePerson(person('VP, Payments Analytics · Example Corp'), { ...ctx, kind: 'team', bigCompany: true }), 1);
  assert.equal(scorePerson(person('Software Engineer · Example Corp', 'Example State University. Analytics.'), { ...ctx, kind: 'alumni' }), 4);
  assert.equal(scorePerson(person('Sales · Example Corp', 'ESU alum'), { ...ctx, kind: 'alumni' }), 2);
  assert.equal(scorePerson(person('Sales · Example Corp'), { ...ctx, kind: 'alumni' }), 0);

  const row = (kind, slug, score) => ({ kind, slug, key: slug, score, name: slug });
  const posting = postingPeople([{ name: 'Pat Kim', title: 'Recruiter', email: null }]);
  const picked = pickPeople(posting, [row('recruiter', 'r1', 5), row('recruiter', 'r2', 5), row('recruiter', 'r3', 5), row('team', 't1', 4), row('team', 't2', 3), row('team', 't3', 3), row('alumni', 'a1', 2), row('alumni', 'a2', 2), row('team', 'low', 1)]);
  assert.deepEqual(picked.map(item => item.slug), ['posting-pat-kim', 'r1', 'r2', 't1', 't2']);
  // Alumni only one: no alumni row here because In Posting took a row and the caps filled the rest.
  const short = pickPeople([], [row('recruiter', 'r1', 5), row('recruiter', 'r2', 4), row('recruiter', 'r3', 3), row('recruiter', 'r4', 3), row('alumni', 'a1', 2)]);
  assert.deepEqual(short.map(item => item.slug), ['r1', 'r2', 'r3', 'r4', 'a1'], 'with no team the other recruiters fill the free rows');
  assert.deepEqual(pickPeople([], [row('alumni', 'a1', 4), row('alumni', 'a2', 4), row('team', 't1', 2)]).map(item => item.slug), ['a1', 'a2', 't1']);
  assert.deepEqual(pickPeople([], [row('recruiter', 'same', 2), row('team', 'same', 6)]).map(item => item.kind), ['team'], 'one row per slug, the higher score');
});

test('the message: "Hi <First Name>," or "Hi there,", and "Fellow <School> here." only while it fits the limit', () => {
  const note = 'Hi {First Name}, I study statistics and saw the Data Analyst role.';
  assert.equal(personalizeMessage(note, { firstName: 'Jane' }), 'Hi Jane, I study statistics and saw the Data Analyst role.');
  assert.equal(personalizeMessage(note, {}), 'Hi there, I study statistics and saw the Data Analyst role.');
  assert.equal(personalizeMessage('Hi {First Name},\n\nThanks for connecting.', { firstName: '' }), 'Hi there,\n\nThanks for connecting.');
  assert.equal(personalizeMessage(note, { firstName: 'Jane', fellow: 'ESU', limit: 200 }), 'Hi Jane, Fellow ESU here. I study statistics and saw the Data Analyst role.');
  const tight = personalizeMessage(note, { firstName: 'Jane', fellow: 'ESU', limit: 60 });
  assert.equal(tight, 'Hi Jane, I study statistics and saw the Data Analyst role.', 'over the limit the phrase is left out');
  assert.doesNotThrow(() => new Function(`${personalizeMessage.toString()}; return personalizeMessage('Hi {First Name}, x', { firstName: 'A' });`)(), 'the function is self-contained for the drawer script');
});

test('settings: on by default, the older searchCandidates switch reads as on, the cap defaults to 300', () => {
  assert.deepEqual(peopleSearchSettings({}), { enabled: true, monthlyCap: 300, provider: 'brave' });
  assert.equal(peopleSearchSettings({ outreach: { peopleSearch: { enabled: false } } }).enabled, false);
  assert.equal(peopleSearchSettings({ outreach: { searchCandidates: true, peopleSearch: { enabled: false } } }).enabled, true);
  assert.equal(peopleSearchSettings({ outreach: { searchCandidates: false } }).enabled, true);
  assert.equal(peopleSearchSettings({ outreach: { peopleSearch: { monthlyCap: 20 } } }).monthlyCap, 20);
});

// ------------------------------------------------------------------------------------------ findPeople

const ANSWERS = {
  recruiter: [
    { title: 'Jane Doe - University Recruiter - Example Corp | LinkedIn', url: URL_OF('jane-doe'), description: 'Campus recruiting at Example Corp. Chicago, Illinois.' },
    { title: 'Sam Lee - Former Recruiter | LinkedIn', url: URL_OF('sam-lee'), description: 'Ex-Example Corp recruiter.' },
  ],
  team: [{ title: 'Lee Park - Payments Analytics Manager - Example Corp | LinkedIn', url: URL_OF('lee-park'), description: 'Example Corp.' }],
  alumni: [{ title: 'Ana Ruiz - Data Engineer - Example Corp | LinkedIn', url: URL_OF('ana-ruiz'), description: 'Example State University. Analytics platform.' }],
};

function kindOf(url) {
  const query = new URL(url).searchParams.get('q');
  return /recruiter/.test(query) ? 'recruiter' : /manager OR/.test(query) ? 'team' : 'alumni';
}

function searchStub(reply = url => new Response(JSON.stringify({ web: { results: ANSWERS[kindOf(url)] } }), { status: 200 })) {
  const requests = [];
  return { requests, fetchImpl: async (url, init) => { assert.equal(isLinkedInUrl(url), false, `asked for ${url}`); requests.push({ url: String(url), init }); return reply(url, init); } };
}

async function project({ key = true, cap } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'people-'));
  await fs.mkdir(path.join(root, 'private'), { recursive: true });
  if (key) await fs.writeFile(path.join(root, 'private', 'search.json'), JSON.stringify({ brave: 'test-key-not-real' }));
  const config = { root, timeZone: 'America/Chicago', outreach: cap == null ? {} : { peopleSearch: { monthlyCap: cap } } };
  return { root, config };
}

test('a new company costs three searches; the cache serves the next posting with none, and holds no key', async () => {
  const { root, config } = await project();
  try {
    const stub = searchStub();
    const args = { root, config, company: 'Example Corp', job: JOB, profile: PROFILE, contacts: [], fetchImpl: stub.fetchImpl, now: NOW };
    const first = await findPeople(args);
    assert.equal(first.status, 'ok');
    assert.equal(first.calls, 3);
    assert.equal(stub.requests.length, 3);
    assert.deepEqual(first.people.map(person => [person.name, person.kind]), [['Jane Doe', 'recruiter'], ['Lee Park', 'team'], ['Ana Ruiz', 'alumni']]);
    assert.ok(stub.requests.every(item => item.url.startsWith('https://api.search.brave.com/') && !/freshness=/.test(item.url)));
    const cacheText = await fs.readFile(peopleCachePath(root), 'utf8');
    assert.doesNotMatch(cacheText, /test-key-not-real/);
    const cache = JSON.parse(cacheText);
    assert.deepEqual(Object.keys(cache.entries).sort(), ['alumni:example corp:example state university|esu', 'recruiter:example corp:early', 'team:example corp:payments analytics']);
    assert.deepEqual(Object.keys(cache.entries['recruiter:example corp:early'].people[0]).sort(), ['firstName', 'headline', 'name', 'slug', 'snippet', 'url']);
    assert.deepEqual(JSON.parse(await fs.readFile(peopleUsagePath(root), 'utf8')), { month: '2026-11', queries: 3, provider: 'brave', lastQueryAt: NOW.toISOString() });
    // Another posting at the same company and function, 10 days later: all from the cache.
    const again = await findPeople({ ...args, job: { ...JOB, title: 'Data Analyst Intern, Summer' }, now: new Date('2026-11-26T18:00:00Z') });
    assert.equal(again.calls, 0);
    assert.equal(stub.requests.length, 3);
    assert.equal(again.people.length, 3);
    // After 30 days the entries are searched again.
    const later = await findPeople({ ...args, now: new Date('2026-12-17T18:00:00Z') });
    assert.equal(later.calls, 3);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('no key: no request at all; the cap reached: no request; a 429 or a timeout stops the searches without throwing', async () => {
  const noKey = await project({ key: false });
  const capped = await project({ cap: 2 });
  const failing = await project();
  try {
    const stub = searchStub();
    const args = { company: 'Example Corp', job: JOB, profile: PROFILE, contacts: [{ name: 'Pat Kim', title: 'Recruiter', email: null }], fetchImpl: stub.fetchImpl, now: NOW };
    const none = await findPeople({ ...args, root: noKey.root, config: noKey.config });
    assert.equal(none.status, 'no-key');
    assert.equal(stub.requests.length, 0);
    assert.deepEqual(none.people.map(person => person.kind), ['posting'], 'the JD contact is still listed');

    const firstTwo = await findPeople({ ...args, root: capped.root, config: capped.config });
    assert.equal(firstTwo.status, 'cap');
    assert.equal(firstTwo.calls, 2);
    const atCap = await findPeople({ ...args, root: capped.root, config: capped.config, job: { ...JOB, title: 'Product Analyst', description: '' } });
    assert.equal(atCap.status, 'cap');
    assert.equal(atCap.calls, 0);
    assert.equal(stub.requests.length, 2);

    const limited = searchStub(() => new Response('{}', { status: 429 }));
    const rateLimited = await findPeople({ ...args, root: failing.root, config: failing.config, fetchImpl: limited.fetchImpl });
    assert.equal(rateLimited.status, 'error');
    assert.equal(rateLimited.reason, 'The search answered HTTP 429');
    assert.equal(limited.requests.length, 1, 'a refusal stops the remaining queries');
    const hanging = searchStub(() => new Promise(() => {}));
    const slow = await findPeople({ ...args, root: failing.root, config: failing.config, fetchImpl: hanging.fetchImpl, timeoutMs: 30 });
    assert.equal(slow.status, 'error');
    assert.match(slow.reason, /did not answer within/);
    assert.doesNotMatch(slow.reason, /test-key-not-real/);
  } finally {
    for (const item of [noKey, capped, failing]) await fs.rm(item.root, { recursive: true, force: true });
  }
});
