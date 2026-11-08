// Reach Out (2026-11-08): finding a recruiter and the two outreach texts. Hard limits under test: nothing ever
// requests linkedin.com (asserted at the network layer), nothing is sent, and without a search key the
// candidate search stays silent.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { candidateQuery, searchCandidates } from '../src/outreach/candidates.mjs';
import { extractJdContacts } from '../src/outreach/contacts.mjs';
import { assertNotLinkedIn, googleSearchUrl, isLinkedInUrl, linkedInPeopleSearchUrl, outreachLinks, roleDirection } from '../src/outreach/links.mjs';
import { FIRST_NAME_PLACEHOLDER, cleanOutreachText, connectionNoteLimit, fitToLimit, hasDashPunctuation, outreachFrom, outreachRules, withFirstName } from '../src/outreach/messages.mjs';
import { readOutreach } from '../src/outreach/store.mjs';
import { generateCoverLetter } from '../src/cover-letter/generate.mjs';
import { LETTER_SCHEMA } from '../src/cover-letter/compose.mjs';
import { originalResumeName } from '../src/hub/outreach.mjs';
import { jobIdOf } from '../src/hub/letters.mjs';
import { OUTREACH_SCRIPT } from '../src/hub/outreach-views.mjs';
import { fixtureJob, fixturePayload, prepareReportProject, startReportHub, writePayload } from './helpers/report-hub.mjs';

// ------------------------------------------------------------------------------------------ links

test('search links: LinkedIn people search and Google, URL-encoded, the company quoted when it has spaces', () => {
  const links = outreachLinks({ company: 'Dow Jones', job: { title: 'Data Analyst, New Grad' } });
  assert.deepEqual(links.map(link => link.label), ['LinkedIn: Recruiters', 'LinkedIn: Data Recruiters', 'Google: LinkedIn Profiles']);
  assert.equal(links[0].url, 'https://www.linkedin.com/search/results/people/?keywords=%22Dow%20Jones%22%20(recruiter%20OR%20%22talent%20acquisition%22%20OR%20%22university%20recruiting%22%20OR%20%22campus%20recruiting%22)');
  assert.equal(links[1].url, 'https://www.linkedin.com/search/results/people/?keywords=%22Dow%20Jones%22%20(recruiter%20OR%20%22talent%20acquisition%22%20OR%20%22university%20recruiting%22%20OR%20%22campus%20recruiting%22)%20data');
  assert.equal(links[2].url, 'https://www.google.com/search?q=site%3Alinkedin.com%2Fin%20%22Dow%20Jones%22%20(recruiter%20OR%20%22talent%20acquisition%22)');
  // One word stays bare on LinkedIn and is quoted for Google; & and + are encoded.
  const pg = outreachLinks({ company: 'P&G', job: { title: 'Software Engineer I' } });
  assert.equal(new URL(pg[0].url).searchParams.get('keywords'), 'P&G (recruiter OR "talent acquisition" OR "university recruiting" OR "campus recruiting")');
  assert.equal(new URL(pg[1].url).searchParams.get('keywords'), 'P&G (recruiter OR "talent acquisition" OR "university recruiting" OR "campus recruiting") technology');
  assert.equal(new URL(pg[2].url).searchParams.get('q'), 'site:linkedin.com/in "P&G" (recruiter OR "talent acquisition")');
  assert.ok(pg[0].url.includes('P%26G'));
  assert.equal(linkedInPeopleSearchUrl('a+b c'), 'https://www.linkedin.com/search/results/people/?keywords=a%2Bb%20c');
  assert.equal(googleSearchUrl('x y'), 'https://www.google.com/search?q=x%20y');
  assert.deepEqual(['Product Analyst', 'Technology Consulting Analyst', 'Machine Learning Engineer', 'Business Intelligence Analyst'].map(title => roleDirection({ title })), ['product', 'consulting', 'technology', 'data']);
  assert.equal(candidateQuery('Dow Jones'), 'site:linkedin.com/in "Dow Jones" (recruiter OR "talent acquisition")');
});

test('the LinkedIn guard: linkedin.com and its subdomains are refused, other hosts pass', () => {
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
  // The name the owner types replaces the placeholder; without one the placeholder stays.
  assert.equal(withFirstName('Hi {First Name}, thanks {First Name}.', ' Jordan '), 'Hi Jordan, thanks Jordan.');
  assert.equal(withFirstName('Hi {First Name},', ''), 'Hi {First Name},');
  // The drawer does the same live: the placeholder split and joined with the typed name, and a counter
  // against the limit that turns red past it.
  assert.doesNotThrow(() => new Function(OUTREACH_SCRIPT), 'the drawer script parses');
  assert.match(OUTREACH_SCRIPT, /text\.split\(p\.getAttribute\('data-placeholder'\)\)\.join\(name\)/);
  assert.match(OUTREACH_SCRIPT, /count\.classList\.toggle\('over', node\.textContent\.length > limit\)/);
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

test('a managed resume downloads under its original file name', () => {
  assert.equal(originalResumeName('/x/private/resumes/data/2026-11-01T10-00-00-000Z-Jane Doe Resume.pdf'), 'Jane Doe Resume.pdf');
  assert.equal(originalResumeName('/Users/x/Desktop/Data Resume.pdf'), 'Data Resume.pdf');
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

const JD = 'We are hiring a Data Analyst to build dashboards. Recruiter: Jane Doe (jane.doe@example.com). '.repeat(4);
const BRAVE = { web: { results: [
  { title: 'Jane Doe - University Recruiter - Example Corp | LinkedIn', url: 'https://www.linkedin.com/in/jane-doe-example', description: 'Recruiting early-career talent at Example Corp.' },
  { title: 'Example Corp Careers', url: 'https://careers.example.com/', description: 'Jobs.' },
  { title: 'Sam Lee – Talent Acquisition – Example Corp', url: 'https://www.linkedin.com/in/sam-lee', description: 'Talent acquisition.' },
  { title: 'Ana Ruiz | Example Corp', url: 'https://www.linkedin.com/in/ana-ruiz', description: 'Campus recruiting.' },
  { title: 'Lee Park - Recruiter', url: 'https://www.linkedin.com/in/lee-park', description: 'Fourth result, not shown.' },
] } };

async function prepareOutreachProject({ key = true, searchCandidates = true } = {}) {
  const root = await prepareReportProject();
  const config = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
  const resumeDirectory = path.join(root, 'private', 'resumes', 'data');
  await fs.mkdir(resumeDirectory, { recursive: true });
  await fs.writeFile(path.join(resumeDirectory, '2026-11-01T10-00-00-000Z-Jane Doe Resume.pdf'), '%PDF-1.4 resume');
  config.resumes.tracks[0].pdf = './private/resumes/data/2026-11-01T10-00-00-000Z-Jane Doe Resume.pdf';
  config.outreach = { connectionNoteLimit: 200, searchCandidates };
  config.sources = { searchDiscovery: { enabled: false, provider: 'brave', monthlyQueryCap: 5 } };
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(config, null, 2));
  if (key) await fs.writeFile(path.join(root, 'private', 'search.json'), JSON.stringify({ brave: 'test-key-not-real' }));
  const job = fixtureJob(1, { description: JD, company: 'Example Corp', recommendedTrack: 'data' });
  await writePayload(root, fixturePayload('2026-10-17', [job]));
  return { root, jobId: jobIdOf(job) };
}

// Every request the hub makes goes through ctx.fetchImpl; the global fetch must never be used.
function networkSpy(reply = () => new Response(JSON.stringify(BRAVE), { status: 200, headers: { 'content-type': 'application/json' } })) {
  const requests = [];
  return { requests, fetchImpl: async (url, init) => { requests.push(String(url)); return reply(url, init); } };
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

test('the hub: every card offers Reach Out; the panel lists JD contacts, search links in new tabs, candidates, messages, the resume; and never requests linkedin.com', async () => {
  const { root, jobId } = await prepareOutreachProject();
  const spy = networkSpy();
  const engine = { id: 'claude', label: 'Claude subscription', model: 'fable', async generateText() { return { output: { connectionNote: 'Hi {First Name}, I study statistics and saw the Data Analyst role at Example Corp. I built SQL dashboards and can help speed up reporting.', followUpMessage: 'Hi {First Name}, thank you for connecting. I rebuilt a weekly SQL dashboard. My resume is attached; could we have a brief conversation?' } }; } };
  await withGlobalFetchBlocked(async global => {
    const hub = await startReportHub(root, { context: { fetchImpl: spy.fetchImpl, letterEngine: engine } });
    try {
      const page = (await hub.request('/reports/2026-10-17')).text;
      assert.match(page, new RegExp(`<button type="button" class="btn secondary small" data-reach="1" data-date="2026-10-17" data-job="${jobId}">Reach Out</button>`));
      assert.match(page, /<aside class="reach-drawer" id="reach-drawer" hidden aria-label="Reach Out"><\/aside>/);

      let panel = (await hub.request(`/outreach/panel?date=2026-10-17&job=${jobId}`)).text;
      const order = ['id="reach-contacts"', 'id="reach-search"', 'id="reach-candidates"', 'id="reach-first-name"', 'id="reach-messages-empty"', 'id="reach-resume-section"', 'id="reach-contacted"'].map(marker => panel.indexOf(marker));
      assert.ok(order.every((position, index) => position > 0 && (index === 0 || position > order[index - 1])), `panel order ${order}`);
      assert.match(panel, /<strong>Jane Doe<\/strong> · Recruiter · <a href="mailto:jane\.doe@example\.com">jane\.doe@example\.com<\/a> <span class="badge" data-badge="source-jd">From the JD<\/span>/);
      for (const match of panel.matchAll(/<a class="btn secondary small" data-reach-link="[^"]+" href="([^"]+)" target="_blank" rel="noopener noreferrer">/g)) assert.match(match[1], /^https:\/\/www\.(?:linkedin|google)\.com\//);
      assert.equal([...panel.matchAll(/data-reach-link=/g)].length, 3);
      assert.match(panel, /From search results, may be outdated, verify before reaching out/);
      assert.match(panel, /<button class="btn secondary small" type="button" data-reach-candidates>Search Candidates<\/button>/);
      assert.match(panel, /href="\/outreach\/resume\?date=2026-10-17&amp;job=[a-f0-9]{16}" download="Jane Doe Resume\.pdf">Download Data Resume<\/a>/);
      assert.equal(spy.requests.length, 0, 'opening the panel requests nothing');

      // One candidate search, from the API's own results; the profiles are links, never fetched.
      const found = JSON.parse((await post(hub, '/outreach/candidates', { date: '2026-10-17', job: jobId })).text);
      assert.equal(found.status, 'ok');
      assert.deepEqual(found.results.map(item => item.name), ['Jane Doe', 'Sam Lee', 'Ana Ruiz']);
      assert.equal(found.results[0].headline, 'University Recruiter · Example Corp · Recruiting early-career talent at Example Corp.');
      const again = JSON.parse((await post(hub, '/outreach/candidates', { date: '2026-10-17', job: jobId })).text);
      assert.equal(again.cached, true, 'at most one query per posting');
      assert.equal(spy.requests.length, 1);
      assert.match(spy.requests[0], /^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?q=site%3Alinkedin\.com%2Fin\+%22Example\+Corp%22/);
      assert.doesNotMatch(spy.requests[0], /freshness=/, 'no past-day filter for people');

      // Messages for a posting without a letter: one call, stored in private/.
      const generated = await post(hub, '/outreach/messages', { date: '2026-10-17', job: jobId });
      assert.equal(generated.status, 200, generated.text);
      panel = (await hub.request(`/outreach/panel?date=2026-10-17&job=${jobId}`)).text;
      assert.match(panel, /<h3>Connection Note <span class="reach-count" data-reach-count data-limit="200"><\/span><\/h3><p class="reach-text" data-reach-text data-template="Hi \{First Name\}, I study statistics/);
      assert.match(panel, /<button class="btn secondary small" type="button" data-reach-copy="reach-follow-up">Copy<\/button>/);
      assert.match(panel, /<a href="https:\/\/www\.linkedin\.com\/in\/jane-doe-example" target="_blank" rel="noopener noreferrer">Jane Doe<\/a>/);

      const resume = await hub.request(`/outreach/resume?date=2026-10-17&job=${jobId}`);
      assert.equal(resume.status, 200);
      assert.equal(resume.headers['content-type'], 'application/pdf');
      assert.match(resume.headers['content-disposition'], /attachment; filename="Jane Doe Resume\.pdf"/);
      assert.equal(resume.text, '%PDF-1.4 resume');

      // At the network layer: not one request to linkedin.com, and nothing through the global fetch.
      assert.deepEqual(spy.requests.filter(isLinkedInUrl), []);
      assert.deepEqual(global, []);
    } finally {
      await hub.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

test('without a search key (or with the switch off) the candidate search is silent: no section, no request', async () => {
  for (const options of [{ key: false, searchCandidates: true }, { key: true, searchCandidates: false }]) {
    const { root, jobId } = await prepareOutreachProject(options);
    const spy = networkSpy();
    const hub = await startReportHub(root, { context: { fetchImpl: spy.fetchImpl } });
    try {
      const panel = (await hub.request(`/outreach/panel?date=2026-10-17&job=${jobId}`)).text;
      assert.doesNotMatch(panel, /reach-candidates|From search results/);
      const reply = JSON.parse((await post(hub, '/outreach/candidates', { date: '2026-10-17', job: jobId })).text);
      assert.equal(reply.status, options.key ? 'off' : 'no-key');
      assert.deepEqual(reply.results, []);
      assert.equal(spy.requests.length, 0);
      assert.equal((await readOutreach(root)).jobs[jobId]?.candidates, undefined, 'nothing recorded');
    } finally {
      await hub.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
  // The module alone: no key, no request.
  const requests = [];
  const result = await searchCandidates({ config: { root: '/nonexistent', outreach: { searchCandidates: true } }, company: 'Example Corp', fetchImpl: async url => { requests.push(url); } });
  assert.equal(result.status, 'no-key');
  assert.equal(requests.length, 0);
});

test('Mark as Contacted records the day, shows "Contacted Nov 8" on the card and in the panel, and clears when unticked; the first name is kept', async () => {
  const { root, jobId } = await prepareOutreachProject({ key: false });
  const hub = await startReportHub(root, { now: '2026-11-08T23:30:00Z' }); // Nov 8, 5:30 PM in Chicago
  try {
    const marked = JSON.parse((await post(hub, '/outreach/contacted', { job: jobId, contacted: '1' })).text);
    assert.deepEqual(marked, { contactedAt: '2026-11-08T23:30:00.000Z', label: 'Contacted Nov 8' });
    const stored = JSON.parse(await fs.readFile(path.join(root, 'private', 'outreach', 'state.json'), 'utf8'));
    assert.equal(stored.jobs[jobId].contactedAt, '2026-11-08T23:30:00.000Z');
    assert.match((await hub.request('/reports/2026-10-17')).text, /<span class="badge" data-badge="contacted" title="Marked as contacted in the Reach Out panel">Contacted Nov 8<\/span>/);
    assert.match((await hub.request(`/outreach/panel?date=2026-10-17&job=${jobId}`)).text, /<input type="checkbox" id="reach-contacted" checked> Mark as Contacted<\/label> <span class="muted" id="reach-contacted-label">Contacted Nov 8<\/span>/);
    await post(hub, '/outreach/name', { job: jobId, firstName: '  Jordan  ' });
    assert.match((await hub.request(`/outreach/panel?date=2026-10-17&job=${jobId}`)).text, /id="reach-first-name" value="Jordan"/);
    const cleared = JSON.parse((await post(hub, '/outreach/contacted', { job: jobId, contacted: '0' })).text);
    assert.deepEqual(cleared, { contactedAt: null, label: null });
    assert.doesNotMatch((await hub.request('/reports/2026-10-17')).text, /data-badge="contacted"/);
    assert.equal((await post(hub, '/outreach/contacted', { job: 'not-a-job', contacted: '1' })).status, 400);
    // Settings > Cover Letters saves the limit and the switch.
    assert.match((await hub.request('/settings?tab=letters')).text, /<article class="card" id="reach-out"><h2>Reach Out<\/h2>[\s\S]*name="connectionNoteLimit"[^>]*value="200"/);
    assert.equal((await post(hub, '/settings/outreach', { connectionNoteLimit: '300', searchCandidates: 'on' })).status, 303);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8')).outreach, { connectionNoteLimit: 300, searchCandidates: true });
    assert.match(decodeURIComponent((await post(hub, '/settings/outreach', { connectionNoteLimit: '500' })).headers.location), /from 100 to 300/);
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
