// Job cards and the letter page (2026-11-08): Why It Matches is no longer shown (cards, hub, xlsx) though
// scoring still produces it; the JD keeps the posting's own markup through a whitelist (src/jd-html.mjs) or,
// for plain text, its line breaks; Open Letter opens a new tab; the letter page copies the letter as plain
// text, whole or from the salutation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { identifyBoard, parseAshbyJobs, parseGreenhouseJobs, parseLeverPostings } from '../src/collectors/ats-boards.mjs';
import { enrichJob, smartRecruitersEnrichment } from '../src/enrich.mjs';
import { jobDescriptionHtml, sanitizeJobHtml, textToParagraphs } from '../src/jd-html.mjs';
import { slimPayload } from '../src/payload-store.mjs';
import { cleanText } from '../src/utils.mjs';
import { buildHtml } from '../src/report.mjs';
import { assembleLetter } from '../src/cover-letter/compose.mjs';
import { letterPlainText } from '../src/cover-letter/plain-text.mjs';
import { LETTER_SCRIPT } from '../src/hub/letter-views.mjs';
import { fixtureJob, fixturePayload, prepareReportProject, startReportHub, writePayload } from './helpers/report-hub.mjs';

const MALICIOUS = '<div style="color:red" onclick="steal()"><h2 onmouseover="x()">About the Role</h2><p>Build <strong>SQL</strong> &amp; <em>Python</em> models.</p><script>alert(document.cookie)</script><style>p{display:none}</style><iframe src="https://evil.example"></iframe><ul><li>Dashboards</li><li>Experiments<img src=x onerror=alert(1)></li></ul><p><a href="javascript:alert(1)">bad link</a> <a href="https://example.com/benefits" style="x" onclick="y()">Benefits</a></p></div>';
const CLEAN = '<h2>About the Role</h2><p>Build <strong>SQL</strong> &amp; <em>Python</em> models.</p><ul><li>Dashboards</li><li>Experiments</li></ul><p>bad link <a href="https://example.com/benefits" target="_blank" rel="noopener noreferrer">Benefits</a></p>';

test('the whitelist keeps paragraphs, headings, lists, bold, italics and safe links; drops scripts, styles, frames, inline styles and handlers', () => {
  assert.equal(sanitizeJobHtml(MALICIOUS), CLEAN);
  const out = sanitizeJobHtml(MALICIOUS);
  assert.doesNotMatch(out, /script|style|iframe|onclick|onerror|onmouseover|javascript:|<img|<div/i);
  // Entities are decoded and the text escaped again; a stray "<" stays text.
  assert.equal(sanitizeJobHtml('<p>R&amp;D &lt;team&gt; &nbsp;&#8212; 5 &lt; 6 &copy;</p>'), '<p>R&amp;D &lt;team&gt; — 5 &lt; 6 ©</p>');
  // Unclosed and misnested markup is balanced; empty elements and runs of breaks go.
  assert.equal(sanitizeJobHtml('<p>one<p>two <b>bold<ul><li>a<li>b</ul><p></p><br><br><br>'), '<p>one</p><p>two <b>bold</b></p><ul><li>a</li><li>b</li></ul>');
  assert.equal(sanitizeJobHtml('<h5>Small</h5><div>Line</div><table><tr><td>a</td><td>b</td></tr></table>'), 'Small<br>Line<br> a b');
  assert.equal(sanitizeJobHtml('<script>only</script>'), '', 'nothing readable left: no markup at all');
  assert.equal(sanitizeJobHtml('<a href="mailto:jobs@example.com">Email us</a>'), '<a href="mailto:jobs@example.com" target="_blank" rel="noopener noreferrer">Email us</a>');
});

test('each ATS keeps its markup beside the unchanged plain text the scorer reads', async () => {
  // Greenhouse sends its content entity-escaped.
  const content = MALICIOUS.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const greenhouse = parseGreenhouseJobs({ jobs: [{ id: 1, absolute_url: 'https://job-boards.greenhouse.io/examplecorp/jobs/1', title: 'Data Analyst', location: { name: 'Remote - US' }, updated_at: '2026-11-08T15:00:00Z', content }] }, identifyBoard('https://job-boards.greenhouse.io/examplecorp'))[0];
  assert.equal(greenhouse.descriptionHtml, CLEAN);
  assert.equal(greenhouse.description, cleanText(content), 'the text the scorer reads is what it was before');

  const lever = parseLeverPostings([{ id: 'a', hostedUrl: 'https://jobs.lever.co/examplecorp/a', text: 'Data Analyst', createdAt: Date.parse('2026-11-08T15:00:00Z'), categories: { location: 'Remote' },
    description: '<div><b>Who we are</b></div><div style="font-size:12px">A small team.</div>', descriptionPlain: 'Who we are\nA small team.',
    lists: [{ text: 'What you will do', content: '<li>Model data</li><li onclick="x()">Ship <script>bad()</script>dashboards</li>' }], additional: '<p>Equal opportunity.</p>', additionalPlain: 'Equal opportunity.' }], identifyBoard('https://jobs.lever.co/examplecorp'))[0];
  assert.equal(lever.descriptionHtml, '<b>Who we are</b><br>A small team.<h3>What you will do</h3><ul><li>Model data</li><li>Ship dashboards</li></ul><p>Equal opportunity.</p>');
  assert.equal(lever.description, 'Who we are A small team. What you will do Model data Ship dashboards Equal opportunity.');

  const ashby = parseAshbyJobs({ jobs: [{ id: 'b', jobUrl: 'https://jobs.ashbyhq.com/examplecorp/b', title: 'Data Analyst', location: 'Remote', publishedAt: '2026-11-08T15:00:00Z', descriptionPlain: 'Plain text.',
    descriptionHtml: '<h3 style="x">Requirements</h3><ol><li><p>SQL</p></li></ol><iframe src="x"></iframe>' }] }, identifyBoard('https://jobs.ashbyhq.com/examplecorp'))[0];
  assert.equal(ashby.descriptionHtml, '<h3>Requirements</h3><ol><li><p>SQL</p></li></ol>');
  assert.equal(ashby.description, 'Plain text.');

  const workday = await enrichJob({ url: 'https://wf.wd1.myworkdayjobs.com/en-US/Jobs/job/Chicago-IL/Data-Analyst_R-1', title: 'Data Analyst', company: '', location: '', description: '' }, {}, async () => new Response(JSON.stringify({
    jobPostingInfo: { title: 'Data Analyst', jobDescription: '<p style="margin:0">About&nbsp;this role:</p><ul><li>Build &amp; ship.</li></ul><script>alert(1)</script>', startDate: '2026-11-08' },
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  assert.equal(workday.enrichment, 'workday_cxs');
  assert.equal(workday.descriptionHtml, '<p>About this role:</p><ul><li>Build &amp; ship.</li></ul>');
  assert.equal(workday.description, 'About this role: Build & ship.');

  const smart = smartRecruitersEnrichment({ url: 'https://jobs.smartrecruiters.com/ExampleCorp/1-data-analyst', title: 'Data Analyst', company: 'Example Corp' }, { name: 'Data Analyst', jobAd: { sections: {
    jobDescription: { title: 'Job Description', text: '<p>Analyze <b>data</b>.</p><script>x()</script>' },
    qualifications: { title: 'Qualifications', text: '<ul><li style="color:red">SQL</li></ul>' },
  } } });
  assert.equal(smart.descriptionHtml, '<h3>Job Description</h3><p>Analyze <b>data</b>.</p><h3>Qualifications</h3><ul><li>SQL</li></ul>');
  assert.equal(smart.description, 'Job Description\nAnalyze data .\nQualifications\nSQL', 'the scorer text as before (cleanText spacing)');

  const posting = { '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Data Analyst', datePosted: '2026-11-08', hiringOrganization: { name: 'Example Corp' }, description: `<h2>Overview</h2><p onclick="x()">${'Build analyses. '.repeat(15).trim()}</p><style>h2{}</style>` };
  const jsonLd = await enrichJob({ url: 'https://careers.example.com/job/1', title: '', company: '', location: '', description: '' }, {}, async () => new Response(`<script type="application/ld+json">${JSON.stringify(posting)}</script>`, { status: 200, headers: { 'content-type': 'text/html' } }));
  assert.equal(jsonLd.descriptionHtml, `<h2>Overview</h2><p>${'Build analyses. '.repeat(15).trim()}</p>`);
});

test('plain text and older payloads show as paragraphs at their own line breaks; the report embeds the cleaned markup', () => {
  assert.equal(textToParagraphs('First paragraph.\nSecond line.\n\n\nNew <paragraph> & more.\r\n\r\n  '), '<p>First paragraph.<br>Second line.</p><p>New &lt;paragraph&gt; &amp; more.</p>');
  assert.equal(jobDescriptionHtml({ description: 'One\n\nTwo' }), '<p>One</p><p>Two</p>');
  assert.equal(jobDescriptionHtml({ description: 'Text', descriptionHtml: '<script>x</script>' }), '<p>Text</p>', 'markup with nothing readable falls back to the text');
  // An edited payload cannot carry markup in: the report cleans it again.
  assert.equal(jobDescriptionHtml({ description: 'x', descriptionHtml: MALICIOUS }), CLEAN);
  const meta = fixturePayload('2026-11-08', []).meta;
  const html = buildHtml([fixtureJob(1, { descriptionHtml: MALICIOUS }), fixtureJob(2, { url: 'https://jobs.example.com/2', description: 'Line one.\n\nLine two.' })], meta);
  assert.ok(html.includes(`<details class="jd"><summary>Job Description</summary><div class="jd-body">${CLEAN}</div></details>`), 'folded by default, markup inside');
  assert.ok(html.includes('<details class="jd"><summary>Job Description</summary><div class="jd-body"><p>Line one.</p><p>Line two.</p></div></details>'));
  assert.doesNotMatch(html, /steal\(\)|evil\.example|Why It Matches|facts reasons/);
  assert.match(html, /<div class="facts-label">Gaps \/ Verify<\/div><ul class="facts gaps"><li>JD skill not found in resume: dbt<\/li><\/ul>/, 'Gaps / Verify is open');
});

test('the slim payload keeps descriptionHtml only for postings that went to the review', () => {
  const matched = fixtureJob(1, { descriptionHtml: CLEAN });
  const notSent = { ...fixtureJob(2, { url: 'https://jobs.example.com/2', descriptionHtml: CLEAN }), semanticReviewed: false, matchLevel: 'local', bestScore: 10, scores: { data: 10 }, scoreDetails: { data: { roleRelevance: 0 } } };
  const slim = slimPayload({ meta: { date: '2026-11-08' }, matches: [matched], reviewed: [matched, notSent] });
  assert.equal(slim.reviewed[0].descriptionHtml, CLEAN);
  assert.equal(slim.reviewed[1].jdOmitted, true);
  assert.equal(slim.reviewed[1].descriptionHtml, undefined);
});

test('the hub: no Why It Matches, the lazy JD loads the cleaned markup, Open Letter opens a new tab', async () => {
  const root = await prepareReportProject();
  const long = fixtureJob(1, { descriptionHtml: `${MALICIOUS}<p>${'More detail. '.repeat(40)}</p>` });
  await writePayload(root, fixturePayload('2026-10-17', [long]));
  const hub = await startReportHub(root);
  try {
    const page = (await hub.request('/reports/2026-10-17')).text;
    assert.doesNotMatch(page, /Why It Matches|class="facts reasons"/);
    const src = /<details class="jd" data-jd-src="([^"]+)"><summary>Job Description<\/summary><div class="jd-body"><p>/.exec(page)?.[1];
    assert.ok(src, 'a long JD loads on demand');
    const jd = await hub.request(src);
    assert.equal(jd.headers['content-type'], 'text/html; charset=utf-8');
    assert.ok(jd.text.startsWith(CLEAN));
    assert.doesNotMatch(jd.text, /script|onclick|style=/);
    assert.match(page, /<a class="btn secondary small" href="\/letters\/2026-10-17\/ExampleCorp1" target="_blank" rel="noopener noreferrer">Open Letter<\/a>/);
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

// A fixed letter: the copied text must match this exactly.
const PROFILE = { name: 'Jane Doe', phone: '555-0100', email: 'jane.doe@example.com', signatureName: 'Jane Doe' };
const PARAGRAPHS = [
  'I am writing to apply for the Data Analyst role at Example Corp.',
  'At my last internship I built the SQL models behind a weekly revenue dashboard.',
  'I would welcome the chance to discuss how I can help your analytics team.',
];
const FULL = `Jane Doe
555-0100 · jane.doe@example.com

November 8, 2026

Dear Example Corp Recruiting Team,

I am writing to apply for the Data Analyst role at Example Corp.

At my last internship I built the SQL models behind a weekly revenue dashboard.

I would welcome the chance to discuss how I can help your analytics team.

Sincerely,
Jane Doe`;
const FROM_SALUTATION = FULL.slice(FULL.indexOf('Dear '));

test('Copy Full Letter and Copy From Salutation give exactly the expected plain text', () => {
  const letter = assembleLetter({ profile: PROFILE, company: 'Example Corp', paragraphs: PARAGRAPHS, now: new Date('2026-11-09T00:30:00Z'), timeZone: 'America/Chicago' });
  const parts = { name: letter.name, contact: letter.contact, date: letter.date, signature: letter.signature, company: 'Example Corp', paragraphs: PARAGRAPHS };
  assert.equal(letterPlainText(parts, 'top'), FULL);
  assert.equal(letterPlainText(parts, 'salutation'), FROM_SALUTATION);
  assert.ok(FROM_SALUTATION.startsWith('Dear Example Corp Recruiting Team,\n\nI am writing'));
  // The same salutation and sign-off as the PDF.
  assert.equal(letter.salutation, 'Dear Example Corp Recruiting Team,');
  assert.equal(letter.closing, 'Sincerely,');
  // Blank paragraphs and stray whitespace from the editor do not leave empty blocks.
  assert.equal(letterPlainText({ ...parts, paragraphs: ['  ', ...PARAGRAPHS.map(text => ` ${text}\n`)] }, 'top'), FULL);
});

test('the letter page: Copy Full Letter is the primary button, Copy From Salutation beside it, no per-paragraph copy; the page builds the same text', async () => {
  const root = await prepareReportProject();
  await fs.writeFile(path.join(root, 'private', 'cover-letter', 'profile.json'), JSON.stringify(PROFILE)).catch(async () => {
    await fs.mkdir(path.join(root, 'private', 'cover-letter'), { recursive: true });
    await fs.writeFile(path.join(root, 'private', 'cover-letter', 'profile.json'), JSON.stringify(PROFILE));
  });
  const recordFile = path.join(root, 'private', 'cover-letters', '2026-10-17', 'ExampleCorp1', 'letter.json');
  const record = JSON.parse(await fs.readFile(recordFile, 'utf8'));
  await fs.writeFile(recordFile, JSON.stringify({ ...record, company: 'Example Corp', paragraphs: PARAGRAPHS, createdAt: '2026-11-09T00:30:00Z', timeZone: 'America/Chicago' }));
  const hub = await startReportHub(root);
  try {
    const page = (await hub.request('/letters/2026-10-17/ExampleCorp1')).text;
    assert.match(page, /<h1 class="hub-title">Cover Letter<\/h1>\s*<div class="row letter-copy" id="letter-copy" data-letter="[^"]+"><button class="btn" id="copy-full" type="button">Copy Full Letter<\/button><button class="btn secondary" id="copy-salutation" type="button">Copy From Salutation<\/button><span class="letter-status" id="copy-status" role="status"><\/span><\/div>/);
    assert.doesNotMatch(page, /Copy Paragraph|data-copy-paragraph|class="[^"]*copy-para/i);
    // What the page script has to work with: the parts in data-letter, the company field, the paragraph boxes.
    const parts = JSON.parse(/data-letter="([^"]+)"/.exec(page)[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    const company = /id="letter-company" class="control-input" value="([^"]*)"/.exec(page)[1];
    const paragraphs = [...page.matchAll(/<textarea class="para" name="paragraph" data-index="\d+">([^<]*)<\/textarea>/g)].map(match => match[1]);
    assert.deepEqual(parts, { name: 'Jane Doe', contact: '555-0100 · jane.doe@example.com', date: 'November 8, 2026', signature: 'Jane Doe' });
    assert.equal(letterPlainText({ ...parts, company, paragraphs }, 'top'), FULL);
    assert.equal(letterPlainText({ ...parts, company, paragraphs }, 'salutation'), FROM_SALUTATION);
    // The page runs the same function source, and says when the copy worked.
    assert.ok(LETTER_SCRIPT.includes(letterPlainText.toString()));
    const script = new Function(`${LETTER_SCRIPT.slice(0, LETTER_SCRIPT.indexOf('(function () {'))}; return letterPlainText;`)();
    assert.equal(script({ ...parts, company, paragraphs }, 'top'), FULL);
    assert.match(LETTER_SCRIPT, /copied to the clipboard/);
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
