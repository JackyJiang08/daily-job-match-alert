// Letters stored by job ID (2026-11-09): two postings of one company on one date keep two letters, a letter saved under
// its company folder before the change moves to its job ID folder when saved again, and the read-only audit lists the
// postings that lost their letter to the old company folders.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLetterStore } from '../src/cover-letter/store.mjs';
import { auditLetterOverwrites, auditMarkdown } from '../src/letters-audit.mjs';

const DATE = '2026-11-08';
const FIRST = 'aaaaaaaaaaaaaaa1';
const SECOND = 'aaaaaaaaaaaaaaa2';

async function withStore(work) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'letter-store-'));
  let tick = 0;
  const store = createLetterStore({ root, now: () => new Date(Date.parse('2026-11-08T23:00:00Z') + (tick += 1000)) });
  try {
    await work({ root, store, dir: (...parts) => path.join(root, 'private', 'cover-letters', DATE, ...parts) });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const meta = (jobId, extra = {}) => ({ jobId, company: 'Example Corp', jobTitle: `Analyst ${jobId.slice(-1)}`, pdfFileName: 'JaneDoe_Cover_Letter_ExampleCorp.pdf', paragraphs: [`Letter for ${jobId}.`], ...extra });

test('two postings of one company on one date keep two letters with the same file name, each downloadable from its own folder', async () => {
  await withStore(async ({ store, dir }) => {
    const first = await store.saveLetter({ date: DATE, company: 'Example Corp', markdown: 'first', meta: meta(FIRST) });
    await fs.writeFile(path.join(first.directory, 'JaneDoe_Cover_Letter_ExampleCorp.pdf'), '%PDF first');
    const second = await store.saveLetter({ date: DATE, company: 'Example Corp', markdown: 'second', meta: meta(SECOND) });
    await fs.writeFile(path.join(second.directory, 'JaneDoe_Cover_Letter_ExampleCorp.pdf'), '%PDF second');
    assert.deepEqual([first.slug, second.slug], [FIRST, SECOND]);
    assert.equal(first.record.companySlug, 'ExampleCorp');
    assert.deepEqual((await fs.readdir(dir())).sort(), [FIRST, SECOND]);
    const byJob = await store.lettersByJob();
    assert.equal(byJob.get(FIRST).paragraphs[0], `Letter for ${FIRST}.`, 'the first letter survived the second save');
    assert.equal(byJob.get(SECOND).paragraphs[0], `Letter for ${SECOND}.`);
    for (const [id, text] of [[FIRST, '%PDF first'], [SECOND, '%PDF second']]) {
      const file = await store.resolveDownload(DATE, byJob.get(id).slug, 'JaneDoe_Cover_Letter_ExampleCorp.pdf');
      assert.equal(path.basename(file), 'JaneDoe_Cover_Letter_ExampleCorp.pdf');
      assert.equal(await fs.readFile(file, 'utf8'), text);
    }
    // A rename keeps the folder; the other posting's letter is untouched.
    const renamed = await store.renameLetter(DATE, FIRST, { company: 'Example', markdown: 'renamed', pdfFileName: 'JaneDoe_Cover_Letter_Example.pdf', meta: {} });
    assert.equal(renamed.slug, FIRST);
    assert.equal(renamed.record.companySlug, 'Example');
    assert.equal((await store.loadLetter(DATE, SECOND)).markdown, 'second');
    // Saving again under another company name leaves no PDF of the old name.
    await fs.writeFile(path.join(dir(SECOND), 'JaneDoe_Cover_Letter_ExampleCorp.pdf'), '%PDF second');
    await store.saveLetter({ date: DATE, company: 'Example Corporation', markdown: 'again', meta: meta(SECOND, { pdfFileName: 'JaneDoe_Cover_Letter_ExampleCorporation.pdf' }) });
    assert.deepEqual((await fs.readdir(dir(SECOND))).sort(), ['letter.json', 'letter.md']);
  });
});

test('a letter in a company folder from before the change moves to its job ID folder with its PDF when saved again; another posting\'s folder is left alone', async () => {
  await withStore(async ({ store, dir }) => {
    // Two old-style folders: one holds FIRST's letter, the other an unrelated posting's.
    for (const [folder, jobId] of [['ExampleCorp', FIRST], ['Initech', 'bbbbbbbbbbbbbbb1']]) {
      await fs.mkdir(dir(folder), { recursive: true });
      await fs.writeFile(dir(folder, 'letter.json'), JSON.stringify({ ...meta(jobId), savedAt: '2026-11-08T20:00:00Z', createdAt: '2026-11-08T20:00:00Z' }));
      await fs.writeFile(dir(folder, 'letter.md'), 'old');
      await fs.writeFile(dir(folder, 'JaneDoe_Cover_Letter_ExampleCorp.pdf'), '%PDF old');
    }
    assert.equal((await store.lettersByJob()).get(FIRST).slug, 'ExampleCorp', 'old folders are still read');
    assert.ok(await store.loadLetter(DATE, 'ExampleCorp'), 'and opened by their old URL');
    const existing = await store.loadLetter(DATE, 'ExampleCorp');
    await store.saveLetter({ date: DATE, company: 'Example Corp', markdown: 'checked', meta: { ...existing.record, reviewClearedAt: '2026-11-09T00:00:00Z' } });
    assert.deepEqual((await fs.readdir(dir())).sort(), [FIRST, 'Initech'].sort());
    assert.deepEqual((await fs.readdir(dir(FIRST))).sort(), ['JaneDoe_Cover_Letter_ExampleCorp.pdf', 'letter.json', 'letter.md'], 'the PDF moved with it');
    assert.equal((await store.lettersByJob()).get(FIRST).reviewClearedAt, '2026-11-09T00:00:00Z');
    // A rename of an old-style letter also moves it to its job ID folder.
    const renamed = await store.renameLetter(DATE, 'Initech', { company: 'Initech Labs', markdown: 'renamed', pdfFileName: 'JaneDoe_Cover_Letter_InitechLabs.pdf', meta: {} });
    assert.equal(renamed.slug, 'bbbbbbbbbbbbbbb1');
    assert.deepEqual((await fs.readdir(dir())).sort(), [FIRST, 'bbbbbbbbbbbbbbb1'].sort());
  });
});

test('the overwrite audit lists postings whose company folder holds another posting\'s letter, with the evidence per date', () => {
  const job = (id, company, title) => ({ id, company, title, url: `https://example.com/${id}` });
  const letters = [
    { date: '2026-10-28', slug: 'ExampleCorp', jobId: 'k1', company: 'Example Corp', fullName: 'Example Corp', jobTitle: 'Kept', source: 'auto', createdAt: '2026-10-29T01:10:00Z' },
    { date: '2026-10-28', slug: 'Initech', jobId: 'k2', company: 'Initech', jobTitle: 'Only one', source: 'auto', createdAt: '2026-10-29T01:12:00Z' },
    { date: '2026-11-08', slug: 'Globex', jobId: 'k3', company: 'Globex', jobTitle: 'Kept', source: 'manual', createdAt: '2026-11-08T20:00:00Z' },
    { date: '2026-11-08', slug: 'k4', jobId: 'k4', company: 'Umbrella', jobTitle: 'New style', source: 'auto', createdAt: '2026-11-08T20:00:00Z' },
  ];
  const days = [
    { date: '2026-10-28', autoLetters: { startedAt: '2026-10-29T01:00:00Z', finishedAt: '2026-10-29T01:30:00Z', generated: 3 }, matches: [job('k1', 'Example Corp', 'Kept'), job('lost', 'Example Corp', 'Lost'), job('k2', 'Initech', 'Only one'), job('none', 'Hooli', 'No letter, no folder')] },
    { date: '2026-11-08', autoLetters: { startedAt: '2026-11-08T23:00:00Z', finishedAt: '2026-11-08T23:00:00Z', generated: 0 }, matches: [job('k3', 'Globex', 'Kept'), job('maybe', 'Globex', 'Second'), job('reach', 'Globex', 'Reach Out from a letter'), job('k4', 'Umbrella', 'New style'), job('u2', 'Umbrella', 'Other')] },
  ];
  const result = auditLetterOverwrites({ letters, days, outreachJobs: { reach: { messages: { source: 'letter' } } }, jobIdOf: item => item.id, companyFor: item => ({ name: item.company }) });
  assert.deepEqual(result.rows.map(row => [row.date, row.jobId, row.folder, row.keptJobId, row.evidence]), [
    ['2026-10-28', 'lost', 'ExampleCorp', 'k1', 'likely'],
    ['2026-11-08', 'maybe', 'Globex', 'k3', 'unproven'],
    ['2026-11-08', 'reach', 'Globex', 'k3', 'confirmed'],
  ], 'a job ID folder is not a company folder, so Umbrella\'s second posting is not listed');
  assert.deepEqual(result.passes, [{ date: '2026-10-28', generated: 3, kept: 2, shortfall: 1, startedAt: '2026-10-29T01:00:00Z' }]);
  const markdown = auditMarkdown(result);
  assert.match(markdown, /\| 2026-10-28 \| Example Corp · Lost \| lost \| ExampleCorp \(Kept\) \| k1 \| likely \|/);
  assert.match(markdown, /\| 2026-10-28 \| 3 \| 2 \| 1 \| 1 \|/);
  assert.match(markdown, /Total: 3 posting\(s\) listed \(1 confirmed, 1 likely, 0 possible, 1 unproven\)\./);
  assert.match(auditMarkdown({ rows: [], passes: [] }), /No overwritten letters found\.[\s\S]*Every automatic pass on record still has all the letters it generated\./);
});
