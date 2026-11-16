// Message to Recruiters (2026-11-08, named Reach Out until 2026-11-15; people list 2026-11-16): the panel, the
// two outreach texts and the JD contacts. Hard limits under test: nothing ever requests linkedin.com (asserted at
// the network layer), nothing is sent, and without a search key nothing is searched. The people search itself
// (queries, parsing, ranking, cache, cap) is in tests/people.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { extractJdContacts } from '../src/outreach/contacts.mjs';
import { assertNotLinkedIn, googleSearchUrl, isLinkedInUrl } from '../src/outreach/links.mjs';
import { FIRST_NAME_PLACEHOLDER, cleanOutreachText, connectionNoteLimit, fitToLimit, hasDashPunctuation, outreachFrom, outreachRules, personalizeMessage } from '../src/outreach/messages.mjs';
import { peopleCachePath, peopleUsagePath } from '../src/outreach/people.mjs';
import { readOutreach } from '../src/outreach/store.mjs';
import { generateCoverLetter } from '../src/cover-letter/generate.mjs';
import { LETTER_SCHEMA } from '../src/cover-letter/compose.mjs';
import { jobIdOf } from '../src/hub/letters.mjs';
import { OUTREACH_SCRIPT } from '../src/hub/outreach-views.mjs';
import { fixtureJob, fixturePayload, prepareReportProject, startReportHub, writePayload } from './helpers/report-hub.mjs';

// ------------------------------------------------------------------------------------------ guard

test('the LinkedIn guard: linkedin.com and its subdomains are refused, other hosts pass; Google links are plain URLs', () => {
  assert.equal(googleSearchUrl('x y'), 'https://www.google.com/search?q=x%20y');
  for (const url of ['https://www.linkedin.com/in/someone', 'https://linkedin.com', 'http://uk.LinkedIn.com/jobs']) {
    assert.equal(isLinkedInUrl(url), true, url);
    assert.throws(() => assertNotLinkedIn(url), /never requests linkedin\.com/);
  }
  for (const url of ['https://api.search.brave.com/res/v1/web/search?q=site%3Alinkedin.com', 'https://notlinkedin.com/x', 'https://www.google.com/search?q=linkedin.com']) assert.equal(assertNotLinkedIn(url), url);
});

// ------------------------------------------------------------------------------------------ JD contacts

test('contacts the JD names: labeled recruiters, "contact … at …", "Name, Recruiter", and recruiting mailboxes; not accommodation addresses', () => {
  const jd = [
    'About the role: build dashboards for the Finance team.',
    'Recruiter: Jane Doe (jane.doe@example.com).',
    'Questions about this role? Contact Alex Morgan, University Recruiter, at alex.morgan@example.com.',
    'Our team is led by Priya Shah, Talent Acquisition Partner for early careers.',
    'Please send questions to campus.recruiting@example.com.',
    'For accommodations during the application process email accommodations@example.com.',
    'Contact: Human Resources Department.',
  ].join(' ');
  const contacts = extractJdContacts(jd);
  assert.deepEqual(contacts.map(({ name, title, email, source }) => ({ name, title, email, source })), [
    { name: 'Jane Doe', title: 'Recruiter', email: 'jane.doe@example.com', source: 'JD' },
    { name: 'Alex Morgan', title: 'University Recruiter', email: 'alex.morgan@example.com', source: 'JD' },
    { name: 'Priya Shah', title: 'Talent Acquisition Partner', email: null, source: 'JD' },
    { name: null, title: null, email: 'campus.recruiting@example.com', source: 'JD' },
  ]);
  assert.match(contacts[0].excerpt, /Recruiter: Jane Doe/);
  assert.deepEqual(extractJdContacts('Equal Opportunity Employer. Apply online. Benefits include health insurance.'), []);
  assert.deepEqual(extractJdContacts('Hiring Manager - Sam Lee'), [{ name: 'Sam Lee', title: 'Hiring Manager', email: null, source: 'JD', excerpt: 'Hiring Manager - Sam Lee' }]);
});

// ------------------------------------------------------------------------------------------ messages

const NOTE = `${FIRST_NAME_PLACEHOLDER}, I am a senior studying Computer Science and Statistics at Example University, graduating in May 2027. I saw the Data Analyst opening at Example Corp; I built SQL models that cut reporting time by 30%. I can help your team speed up weekly reporting.`;

test('the invitation note is held to the limit, opens with the greeting, and takes the first name live', () => {
  assert.equal(connectionNoteLimit({}), 200);
  assert.equal(connectionNoteLimit({ outreach: { connectionNoteLimit: 300 } }), 300);
  assert.equal(connectionNoteLimit({ outreach: { connectionNoteLimit: 999 } }), 300);
  assert.equal(connectionNoteLimit({ outreach: { connectionNoteLimit: 20 } }), 100);
  const long = outreachFrom({ connectionNote: `Hi ${NOTE}`, followUpMessage: 'Hi {First Name}, thank you for connecting.' }, { limit: 200 });
  assert.ok(long.connectionNote.length <= 200, long.connectionNote);
  assert.ok(long.connectionNote.startsWith('Hi {First Name},'));
  assert.match(long.connectionNote, /\.$/, 'cut after a whole sentence');
  assert.deepEqual(long.issues, ['Shortened the connection note to 200 characters']);
  const roomy = outreachFrom({ connectionNote: `Hi ${NOTE}`, followUpMessage: 'x' }, { limit: 300 });
  assert.equal(roomy.connectionNote, `Hi ${NOTE}`, 'under 300 nothing is cut');
  assert.equal(fitToLimit('Hi {First Name}, one two three four five six seven', 30).text.length <= 30, true);
  // The drawer fills the selected person's name with the same function, and its counter turns red past the limit.
  assert.doesNotThrow(() => new Function(OUTREACH_SCRIPT), 'the drawer script parses');
  assert.ok(OUTREACH_SCRIPT.includes(personalizeMessage.toString()));
  assert.match(OUTREACH_SCRIPT, /count\.classList\.toggle\('over', note && node\.textContent\.length > limit\)/);
  // A missing or different greeting is replaced by the fixed one.
  assert.equal(cleanOutreachText('Hello Sam, I saw the role.'), 'Hi {First Name}, I saw the role.');
});

test('no dashes as punctuation in either text; the rules say so and name the facts allowed', () => {
  const out = outreachFrom({
    connectionNote: 'Hi {First Name}, I study statistics — and data science – at school - and I build models -- fast.',
    followUpMessage: 'Hi {First Name},\n\nThanks for connecting — I led a dashboard rebuild.\n\nMy resume is attached; would you have 15 minutes for a brief call?',
  }, { limit: 300 });
  assert.equal(hasDashPunctuation(out.connectionNote), false, out.connectionNote);
  assert.equal(hasDashPunctuation(out.followUpMessage), false, out.followUpMessage);
  assert.equal(out.connectionNote, 'Hi {First Name}, I study statistics, and data science, at school, and I build models, fast.');
  assert.equal(out.followUpMessage, 'Hi {First Name},\n\nThanks for connecting, I led a dashboard rebuild.\n\nMy resume is attached; would you have 15 minutes for a brief call?');
  assert.ok(out.issues.includes('Rewrote a dash as a comma'));
  assert.equal(hasDashPunctuation('A well-known data-driven team'), false, 'hyphenated words are not dashes');
  const rules = outreachRules({ limit: 250, graduation: { month: 'May 2027' } }).join('\n');
  assert.match(rules, /at most 250 characters/);
  assert.match(rules, /never use an em dash, an en dash, or a hyphen as punctuation/);
  assert.match(rules, /only facts that appear in the RESUME, the PLAYBOOK evidence library, or the posting's MATCH EVIDENCE/);
  assert.match(rules, /May 2027/);
  assert.match(rules, /resume is attached and asking for a brief conversation/);
});

test('the cover letter call returns both texts in the same call; no extra call is made', async () => {
  assert.deepEqual(LETTER_SCHEMA.required, ['paragraphs', 'shortName', 'connectionNote', 'followUpMessage']);
  const prompts = [];
  const engine = {
    id: 'claude', label: 'Claude subscription', model: 'fable',
    async generateText(prompt, context) {
      prompts.push({ prompt, schema: context.schema });
      return { output: { paragraphs: Array.from({ length: 5 }, (_, index) => `Paragraph ${index + 1} ${'word '.repeat(95)}`.trim()), shortName: 'Example Corp', connectionNote: 'Hi {First Name}, I am a statistics student — and I saw the Data Analyst role.', followUpMessage: 'Hi {First Name}, thank you for connecting. My resume is attached; could we talk briefly?' } };
    },
  };
  const job = fixtureJob(1, { company: 'Example Corp' });
  const result = await generateCoverLetter({ engine, review: false, inputs: { playbook: 'Evidence.', samples: [], track: { id: 'data', label: 'Data' }, resumeText: 'Resume.', job, outreachLimit: 250, naming: { chainName: 'Example Corp', aliases: [], fixed: null } } });
  assert.equal(prompts.length, 1, 'one engine call for the letter and the two texts');
  assert.match(prompts[0].prompt, /"connectionNote" is a LinkedIn invitation note[^\n]*at most 250 characters/);
  assert.deepEqual(Object.keys(prompts[0].schema.properties), ['paragraphs', 'shortName', 'connectionNote', 'followUpMessage']);
  assert.equal(result.outreach.connectionNote, 'Hi {First Name}, I am a statistics student, and I saw the Data Analyst role.');
  assert.equal(result.outreach.limit, 250);
});

// ------------------------------------------------------------------------------------------ hub

function post(hub, pathname, fields) {
  const body = new URLSearchParams(fields).toString();
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: hub.port(), path: pathname, method: 'POST', headers: { host: `127.0.0.1:${hub.port()}`, 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

const JD = 'You will join our Payments Analytics team and build dashboards. Recruiter: Jane Doe (jane.doe@example.com). '.repeat(4);
const URL_OF = slug => `https://www.linkedin.com/in/${slug}`;
const ANSWERS = {
  recruiter: [
    { title: 'Jane Doe - University Recruiter - Example Corp | LinkedIn', url: URL_OF('jane-doe'), description: 'Campus recruiting at Example Corp.' },
    { title: 'Sam Lee - Campus Recruiter - Example Corp | LinkedIn', url: URL_OF('sam-lee'), description: 'Early career recruiting, Chicago.' },
    { title: 'Kim Roe - Former Recruiter | LinkedIn', url: URL_OF('kim-roe'), description: 'Ex-Example Corp.' },
  ],
  team: [{ title: 'Lee Park - Payments Analytics Manager - Example Corp | LinkedIn', url: URL_OF('lee-park'), description: 'Example Corp.' }],
  alumni: [{ title: 'Ana Ruiz - Data Engineer - Example Corp | LinkedIn', url: URL_OF('ana-ruiz'), description: 'Example State University. Analytics platform.' }],
};
const SAVED_NOTE = 'Hi {First Name}, I study statistics at Example State University and saw the Data Analyst Intern role at Example Corp. I built SQL dashboards.';
const FOLLOW = 'Hi {First Name}, thank you for connecting. I rebuilt a weekly SQL dashboard. My resume is attached; could we have a brief conversation?';

function kindOf(url) {
  const query = new URL(url).searchParams.get('q');
  return /recruiter/.test(query) ? 'recruiter' : /manager OR/.test(query) ? 'team' : 'alumni';
}

async function prepareOutreachProject({ key = true, usage = null, jobs = null } = {}) {
  const root = await prepareReportProject();
  const config = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
  config.outreach = { connectionNoteLimit: 200 };
  config.sources = { searchDiscovery: { enabled: false, provider: 'brave', monthlyQueryCap: 5 } };
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(config, null, 2));
  await fs.mkdir(path.join(root, 'resumes'), { recursive: true });
  await fs.writeFile(path.join(root, 'resumes', 'data.digest.md'), 'Skills: sql\nExample State University Aug 2023 – May 2027\nExample Co | Data Intern | Chicago, IL Jun 2026 – Aug 2026\n');
  if (key) await fs.writeFile(path.join(root, 'private', 'search.json'), JSON.stringify({ brave: 'test-key-not-real' }));
  if (usage) {
    await fs.mkdir(path.dirname(peopleUsagePath(root)), { recursive: true });
    await fs.writeFile(peopleUsagePath(root), JSON.stringify(usage));
  }
  const list = jobs || [fixtureJob(1, { description: JD, company: 'Example Corp', title: 'Data Analyst Intern', roleType: 'internship', location: 'Chicago, IL' })];
  await writePayload(root, fixturePayload('2026-10-17', list));
  const ids = list.map(jobIdOf);
  await fs.mkdir(path.join(root, 'private', 'outreach'), { recursive: true });
  await fs.writeFile(path.join(root, 'private', 'outreach', 'state.json'), JSON.stringify({ version: 1, jobs: Object.fromEntries(ids.map(id => [id, { messages: { connectionNote: SAVED_NOTE, followUpMessage: FOLLOW, limit: 200, source: 'letter' } }])) }));
  return { root, jobId: ids[0], ids };
}

// Every request the hub makes goes through ctx.fetchImpl; the global fetch must never be used.
function networkSpy(reply = url => new Response(JSON.stringify({ web: { results: ANSWERS[kindOf(url)] } }), { status: 200, headers: { 'content-type': 'application/json' } })) {
  const requests = [];
  return { requests, fetchImpl: async (url, init) => { requests.push(String(url)); assert.equal(isLinkedInUrl(url), false, `asked for ${url}`); return reply(url, init); } };
}

async function withGlobalFetchBlocked(work) {
  const original = globalThis.fetch;
  const global = [];
  globalThis.fetch = async url => { global.push(String(url)); throw new Error(`unexpected global fetch: ${url}`); };
  try {
    return await work(global);
  } finally {
    globalThis.fetch = original;
  }
}

const rows = html => [...html.matchAll(/<li class="reach-person[^"]*" data-person="([^"]+)" data-first="([^"]*)" data-fellow="([^"]*)"[\s\S]*?<span class="badge reach-kind" data-kind="([a-z]+)">([^<]+)<\/span>/g)].map(match => ({ key: match[1], first: match[2], fellow: match[3], kind: match[4], label: match[5] }));

test('the panel: people found on open (three searches for a new company, none after), one row each with the message for them; never linkedin.com', async () => {
  const { root, jobId } = await prepareOutreachProject();
  const spy = networkSpy();
  await withGlobalFetchBlocked(async global => {
    const hub = await startReportHub(root, { context: { fetchImpl: spy.fetchImpl } });
    try {
      const page = (await hub.request('/reports/2026-10-17')).text;
      assert.match(page, new RegExp(`<button type="button" class="btn secondary" data-reach="1" data-date="2026-10-17" data-job="${jobId}">Message to Recruiters</button>`));
      assert.match(page, /<aside class="reach-drawer" id="reach-drawer" hidden aria-label="Message to Recruiters"><\/aside>/);

      // Not cached yet: the panel says "Finding People…" and asks nothing by itself.
      let panel = (await hub.request(`/outreach/panel?date=2026-10-17&job=${jobId}`)).text;
      assert.match(panel, /<p class="reach-title">Example Corp — Data Analyst Intern<\/p><button class="reach-close" type="button" data-reach-close title="Close" aria-label="Close">×<\/button>/);
      assert.match(panel, /<section class="reach-people" id="reach-people" data-loading="1"><ul class="reach-list"><li class="reach-person selected" data-person="posting-jane-doe"[\s\S]*<p class="muted reach-finding">Finding People…<\/p><\/section><template id="reach-fallback">/);
      assert.match(panel, /<p class="reach-text" id="reach-text">Hi Jane, I study statistics/, 'the JD contact is there while the search runs');
      assert.equal(spy.requests.length, 0, 'opening the panel requests nothing');
      // Only the three parts: no explanations, search link lists, resume, side-by-side messages, or Mark as Contacted.
      assert.doesNotMatch(panel, /reach-resume|Mark as Contacted|reach-first-name|linkedin\.com\/search|<h3>|Connection Note/);

      const found = JSON.parse((await post(hub, '/outreach/people', { date: '2026-10-17', job: jobId })).text);
      assert.equal(found.status, 'ok');
      assert.equal(found.calls, 3, 'a new company costs three searches');
      assert.equal(spy.requests.length, 3);
      assert.ok(spy.requests.every(url => url.startsWith('https://api.search.brave.com/res/v1/web/search?q=site%3Alinkedin.com%2Fin')));
      // The JD's recruiter first (and the same person from the search is not listed twice), then the searched kinds.
      assert.deepEqual(rows(found.html).map(row => [row.key, row.label]), [['posting-jane-doe', 'In Posting'], ['sam-lee', 'Recruiter'], ['lee-park', 'Team'], ['ana-ruiz', 'Alumni']]);
      assert.equal(rows(found.html)[3].fellow, 'ESU');
      assert.match(found.html, /<a class="reach-icon" href="https:\/\/www\.linkedin\.com\/in\/jane-doe" target="_blank" rel="noopener noreferrer" title="Open Profile" aria-label="Open Profile">↗<\/a>/);
      assert.equal([...found.html.matchAll(/data-reach-copy-person/g)].length, 4);
      assert.doesNotMatch(found.html, /kim-roe/, 'a former employee is left out');

      // Opened again (or another posting at the same company): straight from the cache, no search.
      panel = (await hub.request(`/outreach/panel?date=2026-10-17&job=${jobId}`)).text;
      assert.doesNotMatch(panel, /data-loading/);
      assert.equal(rows(panel).length, 4);
      assert.equal(spy.requests.length, 3);
      assert.match(panel, /<p class="reach-text" id="reach-text">Hi Jane, I study statistics/, 'the first row is selected');
      assert.match(panel, /data-note="Hi \{First Name\}, I study statistics[^"]*" data-follow="Hi \{First Name\}, thank you for connecting/);
      assert.match(panel, /<button class="reach-link" type="button" data-reach-mode>Follow-Up<\/button><span class="reach-count" id="reach-count"><\/span>/);
      assert.match(panel, /data-reach-copy title="Copy" aria-label="Copy"/);

      const cacheText = await fs.readFile(peopleCachePath(root), 'utf8');
      assert.doesNotMatch(cacheText, /test-key-not-real/);
      assert.match((await hub.request('/settings?tab=letters')).text, /<p class="muted" id="people-search-usage">Used This Month: 3 \/ 300 searches\.<\/p>/);
      assert.deepEqual(spy.requests.filter(isLinkedInUrl), []);
      assert.deepEqual(global, []);
    } finally {
      await hub.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

test('no key, or the monthly cap reached: Find Recruiters / Find Team / Find Alumni open Google; nothing is requested; "Hi there," without a name', async () => {
  const plain = fixtureJob(2, { description: 'Build dashboards for the finance team. '.repeat(10), company: 'Example Corp', title: 'Data Analyst', roleType: 'new_grad', location: 'Chicago, IL' });
  for (const options of [{ key: false }, { key: true, usage: { month: '2026-10', queries: 300 } }]) {
    const { root, ids } = await prepareOutreachProject({ ...options, jobs: [fixtureJob(1, { description: JD, company: 'Example Corp', title: 'Data Analyst Intern', roleType: 'internship', location: 'Chicago, IL' }), plain] });
    const spy = networkSpy();
    const hub = await startReportHub(root, { context: { fetchImpl: spy.fetchImpl } });
    try {
      const panel = (await hub.request(`/outreach/panel?date=2026-10-17&job=${ids[0]}`)).text;
      assert.doesNotMatch(panel, /Finding People/);
      assert.deepEqual(rows(panel).map(row => row.label), ['In Posting'], 'the JD contact stays');
      const buttons = [...panel.matchAll(/<a class="btn secondary small" data-reach-find="([a-z]+)" href="([^"]+)" target="_blank" rel="noopener noreferrer">([^<]+)<\/a>/g)];
      assert.deepEqual(buttons.map(match => match[3]), ['Find Recruiters', 'Find Team', 'Find Alumni']);
      assert.ok(buttons.every(match => match[2].startsWith('https://www.google.com/search?q=site%3Alinkedin.com%2Fin%20%22Example%20Corp%22')));
      assert.equal(new URL(buttons[2][2].replace(/&amp;/g, '&')).searchParams.get('q'), 'site:linkedin.com/in "Example Corp" ("Example State University" OR "ESU")');
      const other = (await hub.request(`/outreach/panel?date=2026-10-17&job=${ids[1]}`)).text;
      assert.match(other, /<p class="reach-text" id="reach-text">Hi there, I study statistics/);
      const reply = JSON.parse((await post(hub, '/outreach/people', { date: '2026-10-17', job: ids[1] })).text);
      assert.equal(reply.status, options.key ? 'cap' : 'no-key');
      assert.equal([...reply.html.matchAll(/data-reach-find=/g)].length, 3);
      assert.equal(spy.requests.length, 0);
    } finally {
      await hub.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test('a timeout or a 429 from the search API falls back to the three buttons, with no error and no hang', async () => {
  for (const reply of [() => new Response('{}', { status: 429 }), () => new Promise(() => {})]) {
    const { root, jobId } = await prepareOutreachProject();
    const spy = networkSpy(reply);
    const hub = await startReportHub(root, { context: { fetchImpl: spy.fetchImpl, peopleTimeoutMs: 50 } });
    try {
      const answer = await post(hub, '/outreach/people', { date: '2026-10-17', job: jobId });
      assert.equal(answer.status, 200);
      const data = JSON.parse(answer.text);
      assert.equal(data.status, 'error');
      assert.equal(data.calls, 1, 'the first failure stops the rest');
      assert.equal([...data.html.matchAll(/data-reach-find=/g)].length, 3);
    } finally {
      await hub.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test('a row\'s copy icon marks that person copied and the posting contacted ("Contacted Nov 8" on the card); Settings saves the switch and cap', async () => {
  const { root, jobId } = await prepareOutreachProject({ key: false });
  const hub = await startReportHub(root, { now: '2026-11-08T23:30:00Z' }); // Nov 8, 5:30 PM in Chicago
  try {
    const marked = JSON.parse((await post(hub, '/outreach/copied', { job: jobId, person: 'posting-jane-doe' })).text);
    assert.deepEqual(marked, { copied: 'posting-jane-doe', label: 'Contacted Nov 8' });
    const stored = (await readOutreach(root)).jobs[jobId];
    assert.equal(stored.contactedAt, '2026-11-08T23:30:00.000Z');
    assert.deepEqual(stored.copied, { 'posting-jane-doe': '2026-11-08T23:30:00.000Z' });
    assert.match((await hub.request('/reports/2026-10-17')).text, /<span class="badge" data-badge="contacted" title="A message was copied in the Message to Recruiters panel">Contacted Nov 8<\/span>/);
    assert.match((await hub.request(`/outreach/panel?date=2026-10-17&job=${jobId}`)).text, /<li class="reach-person selected copied" data-person="posting-jane-doe"/);
    assert.equal((await post(hub, '/outreach/copied', { job: 'not-a-job', person: 'x' })).status, 400);
    assert.equal((await post(hub, '/outreach/copied', { job: jobId, person: '<script>' })).status, 400);
    // Settings > Cover Letters: the limit, the switch and the cap; the older searchCandidates key is dropped.
    const settings = (await hub.request('/settings?tab=letters')).text;
    assert.match(settings, /<article class="card" id="reach-out"><h2>Message to Recruiters<\/h2>[\s\S]*name="connectionNoteLimit"[^>]*value="200"[\s\S]*name="peopleSearch" checked> People Search[\s\S]*name="peopleSearchCap"[^>]*value="300"/);
    assert.match(settings, /No Search Key in private\/search\.json: the panel offers Google searches instead\./);
    const config = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
    config.outreach.searchCandidates = true;
    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(config));
    assert.equal((await post(hub, '/settings/outreach', { connectionNoteLimit: '300', peopleSearchCap: '50' })).status, 303);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8')).outreach, { connectionNoteLimit: 300, peopleSearch: { enabled: false, monthlyCap: 50 } });
    assert.match(decodeURIComponent((await post(hub, '/settings/outreach', { connectionNoteLimit: '500' })).headers.location), /from 100 to 300/);
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
