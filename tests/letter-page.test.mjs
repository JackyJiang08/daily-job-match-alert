// The Open CoverLetter page (2026-11-15): the letter and two buttons, Copy and Regenerate, nothing else.
// Needs-review notes underline their sentence (the note is the hover text) or share one line above the letter;
// info notes are not shown; Copy's text carries no marks; a failed Regenerate leaves the old letter in place.
// Fake letter engines and pdfkit only: no CLI, no Chrome.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { letterPlainText } from '../src/cover-letter/plain-text.mjs';
import { notePhrases, placeNotes, splitSentences } from '../src/cover-letter/note-marks.mjs';
import { parseLetterMarkdown } from '../src/hub/letter-page.mjs';
import { jobIdOf, oneClickLetter } from '../src/hub/letters.mjs';
import { createHubContext, createHubServer } from '../src/hub/server.mjs';

const fixtures = new URL('./fixtures/', import.meta.url);
const NOW = '2026-09-15T15:00:00Z';
const DATE = '2026-09-15';
const PROFILE = { name: 'Jane Doe', phone: '555-0100', email: 'jane.doe@example.com', signatureName: 'Jane Doe' };
const WORDS = ['data', 'model', 'team', 'built', 'shipped', 'metric', 'query', 'result', 'plan', 'growth', 'weekly', 'report'];
// Two sentences per paragraph, so an underline covers one sentence, not the paragraph.
const body = version => Array.from({ length: 5 }, (_, index) => `Paragraph ${index + 1} version ${version} ${Array.from({ length: 90 }, (__, i) => WORDS[i % WORDS.length]).join(' ')}. Second sentence of paragraph ${index + 1} names the ${index === 2 ? 'retail inventory dashboard' : 'weekly report'}.`);
const JOB = {
  url: 'https://example.com/jobs/1', title: 'Data Analyst', company: 'Example Corp', companySource: 'source', location: 'Remote - US',
  roleType: 'new_grad', bestScore: 80, scores: { data: 80 }, recommendedTrack: 'data', recommendedResume: 'Data', matchLevel: 'high', semanticReviewed: true,
  reasons: ['SQL'], gaps: [], blockers: [], description: 'Use SQL and Python to answer product questions every week at Example Corp.',
};
const NOTES = [
  'unverified detail: the retail inventory dashboard',
  'The 35% figure does not appear in the resume or the playbook',
  'salutation says Example Corp, body says Example Labs',
  'Draft: claude · claude-opus-5-5 (info, how the letter was made)',
];

async function setUp() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'letter-page-'));
  await fs.mkdir(path.join(root, 'state'), { recursive: true });
  await fs.copyFile(new URL('data-resume.md', fixtures), path.join(root, 'data-resume.md'));
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({
    timeZone: 'America/Chicago', semanticMatching: { engine: 'claude', models: { claude: 'opus' } },
    resumes: { autoRefresh: false, tracks: [{ id: 'data', label: 'Data', profile: './data-resume.md', enabled: true }] },
    preferences: { graduationDate: '2027-05' }, outputDirectory: './out',
  }));
  const meta = { date: DATE, applicationDate: DATE, generatedAt: NOW, lookbackHours: 24, runsToday: 1, resumeTracks: [{ id: 'data', label: 'Data' }], scoringModel: 'claude-opus-5-5', warnings: [], matchCount: 1 };
  await fs.writeFile(path.join(root, 'state', `report-payload-${DATE}.json`), JSON.stringify({ meta, matches: [JOB], reviewed: [JOB], complete: true }));
  const engine = { version: 1, fail: false };
  const engineFor = (choice = {}) => ({
    id: choice.engine || 'claude', label: choice.engine || 'claude', model: choice.model || 'claude-opus-5-5', effort: null,
    async generateText(prompt) {
      const kind = prompt.startsWith('EDITOR REVIEW') ? 'editor' : prompt.startsWith('CONDENSE') ? 'condense' : 'draft';
      if (kind === 'draft' && engine.fail) throw Object.assign(new Error('codex exited 1: {"type":"error","status":500}'), { raw: 'stack' });
      const usage = { engine: 'claude', effort: null, models: [{ model: 'claude-opus-5-5', input: 10, output: 5, cacheRead: 0, cacheCreation: 0, reasoning: 0 }] };
      if (kind === 'editor') return { output: { issues: [], revised_paragraphs: [] }, scoringModel: 'claude-opus-5-5', usage };
      return { output: { paragraphs: body(engine.version) }, scoringModel: 'claude-opus-5-5', usage };
    },
  });
  const ctx = createHubContext({
    timingLog: () => {}, configPath: path.join(root, 'config.json'), port: 0, now: () => new Date(NOW), homedir: root, chromeCommand: false,
    pidAlive: pid => pid === process.pid, letterEngine: engineFor(),
    describeConnections: async () => ({ claude: { installed: true, connected: true }, codex: { installed: true, connected: true } }),
  });
  ctx.makeLetterEngine = engineFor;
  await ctx.letterStore.saveProfileFields(PROFILE);
  await ctx.letterStore.savePlaybook({ filename: 'playbook.md', data: Buffer.from(`# Playbook\n${'Real evidence line. '.repeat(10)}`) });
  // A saved letter, then the editor notes this page is about.
  const saved = await oneClickLetter(ctx, { date: DATE, jobId: jobIdOf(JOB) });
  const slug = saved.openUrl.split('/').pop();
  const existing = await ctx.letterStore.loadLetter(DATE, slug);
  await ctx.letterStore.saveLetter({ date: DATE, company: existing.record.company, markdown: existing.markdown, meta: { ...existing.record, editorNotes: NOTES } });
  const server = createHubServer(ctx);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const request = (method, pathname, form = null) => new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}${pathname}`, { method, headers: { host: `127.0.0.1:${port}`, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (form) req.write(new URLSearchParams(form).toString());
    req.end();
  });
  return { root, ctx, engine, slug, request, close: () => new Promise(resolve => server.close(resolve)) };
}

const decode = text => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const lettersParts = html => JSON.parse(decode(/<article class="sheet" id="letter" data-letter="([^"]*)">/.exec(html)[1]));
const sheetText = html => decode(/<article class="sheet"[^>]*>([\s\S]*?)<\/article>/.exec(html)[1].replace(/<\/p>/g, '\n').replace(/<[^>]+>/g, '')).split('\n').map(line => line.trim()).filter(Boolean);

test('locating notes: quoted phrases, unverified details, body names and numbers; sentences rejoin to the paragraph', () => {
  assert.deepEqual(notePhrases('The number "40%" does not appear verbatim in the RESUME'), ['40%']);
  assert.deepEqual(notePhrases('unverified detail: the claim that the dashboard cut review time.'), ['the dashboard cut review time']);
  assert.deepEqual(notePhrases('salutation says Example Corp, body says Example Labs'), ['Example Labs']);
  const paragraphs = ['I built a model. It cut costs by 40% in 2024.', 'The dashboard reduced weekly review time for analysts.'];
  for (const paragraph of paragraphs) assert.equal(splitSentences(paragraph).join(' '), paragraph);
  const { marks, unplaced } = placeNotes(paragraphs, ['The number "40%" does not appear in the resume', 'unverified detail: dashboard reduced review time', 'The number 2025 does not appear in the playbook']);
  assert.deepEqual([...marks.keys()], ['0:1', '1:0']);
  assert.deepEqual(unplaced, ['The number 2025 does not appear in the playbook']);
});

test('the letter page: the whole letter as in the PDF, two buttons and nothing else; underlines for needs-review notes, Copy text without marks', async () => {
  const hub = await setUp();
  try {
    const reply = await hub.request('GET', `/letters/${DATE}/${hub.slug}`);
    assert.equal(reply.status, 200);
    const html = reply.text;
    // Two buttons, top right; no navigation, no notes list, no version or engine lines, no links.
    assert.deepEqual([...html.matchAll(/<button\b[^>]*>([^<]*)<\/button>/g)].map(match => match[1]), ['Copy', 'Regenerate']);
    assert.equal((html.match(/<button\b/g) || []).length, 2);
    assert.match(html, /<div class="top"><div class="buttons"><button class="btn secondary" id="copy-letter" type="button">Copy<\/button><button class="btn" id="regenerate-letter"/);
    for (const absent of [/<nav\b/, /hub-nav/, /<a\b/, /<aside\b/, /editor-notes/, /letter-foot/, /Engine/, /claude-opus/, /rulesVersion|v1|v2/, /Draft:/, /<textarea/, /<select/, /<input/]) assert.doesNotMatch(html, absent);
    // The letter word for word as letter.md, the text the PDF was rendered from, in the PDF's order.
    const existing = await hub.ctx.letterStore.loadLetter(DATE, hub.slug);
    const parts = parseLetterMarkdown(existing.markdown);
    assert.deepEqual(parts.paragraphs, existing.record.paragraphs);
    assert.deepEqual(sheetText(html), [parts.name, parts.contact, parts.date, parts.salutation, ...parts.paragraphs, parts.closing, parts.signature]);
    // The unverified detail underlines its sentence with the note as the hover text.
    assert.match(html, /<span class="flag" title="unverified detail: the retail inventory dashboard">Second sentence of paragraph 3 names the retail inventory dashboard\.<\/span>/);
    assert.equal((html.match(/class="flag"/g) || []).length, 1);
    // The two notes no sentence carries: one line above the letter, the second behind "+1 More".
    assert.match(html, /<p class="flags-top" id="letter-flags" title="The 35% figure does not appear in the resume or the playbook\nsalutation says Example Corp, body says Example Labs"><span class="first">The 35% figure does not appear in the resume or the playbook<\/span> <span class="more">\+1 More<\/span>/);
    assert.doesNotMatch(html, /how the letter was made/, 'info notes are not shown');
    // Copy: the plain text of the whole letter, the same text the plain-text module builds, without marks.
    const copied = letterPlainText(lettersParts(html), 'top');
    assert.equal(copied, letterPlainText({ ...parts, company: existing.record.company }, 'top'));
    assert.match(copied, /^Jane Doe\n555-0100 · jane\.doe@example\.com\n\nSeptember 15, 2026\n\nDear Example Corp Recruiting Team,\n\nParagraph 1 version 1 /);
    for (const mark of ['flag', '<', 'unverified', '35%', '+1 More']) assert.equal(copied.includes(mark), false, mark);
    // The page script: Copied for 1.5 seconds, Regenerating… while it runs.
    assert.match(html, /copyButton\.textContent = 'Copied';\s*setTimeout\(function \(\) \{ copyButton\.textContent = 'Copy'; \}, 1500\);/);
    assert.match(html, /regenerate\.disabled = true; regenerate\.textContent = 'Regenerating…';/);
  } finally {
    await hub.close();
    await fs.rm(hub.root, { recursive: true, force: true });
  }
});

test('Regenerate: a failure keeps the old letter (page, record, PDF) and answers one plain line; a success replaces it in place', async () => {
  const hub = await setUp();
  try {
    const before = await hub.ctx.letterStore.loadLetter(DATE, hub.slug);
    const pdfPath = path.join(before.directory, before.record.pdfFileName);
    const pdfBefore = await fs.readFile(pdfPath);
    hub.engine.fail = true;
    hub.engine.version = 2;
    const failed = await hub.request('POST', '/letters/regenerate', { date: DATE, slug: hub.slug });
    assert.notEqual(failed.status, 200);
    const reason = JSON.parse(failed.text).error;
    // One line from humanizeEngineError: no JSON, no raw stack.
    assert.match(reason, /^Generation failed \([^)]*\); details in the hub log$/);
    assert.ok(!/[{}\n]|stack/.test(reason), reason);
    const after = await hub.ctx.letterStore.loadLetter(DATE, hub.slug);
    assert.deepEqual(after.record.paragraphs, before.record.paragraphs);
    assert.equal(after.markdown, before.markdown);
    assert.deepEqual(await fs.readFile(pdfPath), pdfBefore);
    assert.match((await hub.request('GET', `/letters/${DATE}/${hub.slug}`)).text, /Paragraph 1 version 1 /, 'the page still shows the old letter');
    assert.match(failed.text, /"error"/);

    hub.engine.fail = false;
    const done = await hub.request('POST', '/letters/regenerate', { date: DATE, slug: hub.slug });
    assert.equal(done.status, 200);
    const reply = JSON.parse(done.text);
    assert.equal(reply.slug, hub.slug);
    assert.match(reply.sheet, /^<article class="sheet" id="letter" data-letter="[^"]+">[\s\S]*Paragraph 1 version 2 [\s\S]*<\/article>$/, 'the new letter, ready to swap in');
    const saved = await hub.ctx.letterStore.loadLetter(DATE, hub.slug);
    assert.match(saved.record.paragraphs[0], /^Paragraph 1 version 2 /);
    assert.equal(saved.record.editorNotes.includes(NOTES[0]), false, 'the new letter carries its own notes');
  } finally {
    await hub.close();
    await fs.rm(hub.root, { recursive: true, force: true });
  }
});
