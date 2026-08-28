import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseAgeDays, parseSimplifyRows } from '../src/collectors/simplify-github.mjs';
import { collectEmailFiles, parseEml } from '../src/collectors/email-files.mjs';
import { parseCareerOpsHistory } from '../src/collectors/career-ops.mjs';
import { collectHimalaya } from '../src/collectors/himalaya.mjs';

test('parses Simplify HTML tables and carries repeated company names', async () => {
  const fixture = await fs.readFile(new URL('./fixtures/simplify-sample.md', import.meta.url), 'utf8');
  const jobs = parseSimplifyRows(fixture, 'fixture', 'internship');
  assert.equal(jobs.length, 2);
  assert.equal(jobs[1].company, 'Acme Analytics');
  assert.equal(jobs[0].url, 'https://job-boards.greenhouse.io/acme/jobs/123');
});

test('normalizes month and week ages from public lists', () => {
  assert.equal(parseAgeDays('1mo'), 30);
  assert.equal(parseAgeDays('2w'), 14);
});

test('parses alert email links without tracking params', async () => {
  const fixture = await fs.readFile(new URL('./fixtures/sample.eml', import.meta.url), 'utf8');
  const jobs = parseEml(fixture, 'sample.eml');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].source, 'Handshake email alert');
  assert.equal(jobs[0].url, 'https://example.com/jobs/data-analyst');
});

test('imports only recent added career-ops history rows', () => {
  const tsv = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\tfingerprint\tposted_at\n' +
    'https://example.com/1\t2026-08-27\tgreenhouse\tData Analyst\tAcme\tadded\tRemote\t-\t2026-08-27\n' +
    'https://example.com/2\t2026-08-20\tlever\tML Engineer\tOldCo\tadded\tNYC\t-\t2026-08-20\n';
  const jobs = parseCareerOpsHistory(tsv, new Date('2026-08-26T00:00:00Z'));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].source, 'career-ops:greenhouse');
});

test('reads Himalaya messages in preview mode and extracts job links', async () => {
  const calls = [];
  const runner = async (_command, args) => {
    calls.push(args);
    if (args.includes('envelope')) return { stdout: JSON.stringify([{ id: '42', from: { address: 'alerts@wellfound.com' }, subject: 'New Grad Data jobs', date: '2026-08-27T10:00:00Z' }]) };
    return { stdout: 'A role is available: https://example.com/jobs/42?utm_source=wellfound' };
  };
  const jobs = await collectHimalaya({ account: 'personal', folder: 'job-alerts' }, new Date('2026-08-27T00:00:00Z'), runner);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].source, 'Wellfound email alert');
  assert.equal(jobs[0].url, 'https://example.com/jobs/42');
  assert.ok(calls[1].includes('--preview'));
});

test('decodes base64 alert bodies and rejects truncated base64 or undated messages', () => {
  const body = Buffer.from('<p>Apply: https://example.com/jobs/77?utm_source=simplify</p>').toString('base64');
  const headers = 'From: alerts@simplify.jobs\nDate: Thu, 27 Aug 2026 06:00:00 -0500\nSubject: Matches\nContent-Transfer-Encoding: base64\n\n';
  const jobs = parseEml(`${headers}${body}\n`, 'ok.eml');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].url, 'https://example.com/jobs/77');
  assert.equal(jobs[0].source, 'Simplify email alert');
  assert.throws(() => parseEml(`${headers}${body.slice(0, -3)}\n`, 'cut.eml'), /truncated or invalid/);
  assert.throws(() => parseEml('From: a@b.c\nSubject: no date\n\nhttps://example.com/x', 'undated.eml'), /missing Date header/);
  assert.throws(() => parseEml('From: a@b.c\nDate: yesterday-ish\n\nhttps://example.com/x', 'bad-date.eml'), /unparseable Date header/);
});

test('a malformed .eml is skipped with a warning while sibling files still yield jobs', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'email-files-test-'));
  try {
    await fs.copyFile(new URL('./fixtures/sample.eml', import.meta.url), path.join(directory, 'good.eml'));
    await fs.writeFile(path.join(directory, 'broken.eml'), [
      'From: alerts@joinhandshake.com', 'Date: Thu, 27 Aug 2026 08:00:00 -0500', 'Subject: Corrupted',
      'Content-Transfer-Encoding: base64', '', `<html><body>${'x'.repeat(50_000)}</body></html>QUJD`, '',
    ].join('\n'));
    await fs.writeFile(path.join(directory, 'README.txt'), 'ignored');
    const warnings = [];
    const jobs = await collectEmailFiles(directory, { warnings });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].emailFile, 'good.eml');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].source, 'Email files');
    assert.match(warnings[0].message, /Skipped broken\.eml/);
    assert.deepEqual(await collectEmailFiles(directory), jobs, 'omitting the warnings sink still returns the healthy jobs');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a Simplify list that returns 200 with no parsable rows raises a format-change warning', async () => {
  const { collectSimplifyList } = await import('../src/collectors/simplify-github.mjs');
  const warnings = [];
  const empty = await collectSimplifyList({
    url: 'https://example.com/README.md', source: 'SimplifyJobs New Grad', roleType: 'new_grad', warnings,
    fetchImpl: async () => new Response('# New Grad Positions\n\nThe table moved to a JSON file.', { status: 200 }),
  });
  assert.deepEqual(empty, []);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].stage, 'collector');
  assert.equal(warnings[0].source, 'SimplifyJobs New Grad');
  assert.match(warnings[0].message, /no job rows were parsed.*format may have changed/);

  const fixture = await fs.readFile(new URL('./fixtures/simplify-sample.md', import.meta.url), 'utf8');
  const healthyWarnings = [];
  const jobs = await collectSimplifyList({
    url: 'https://example.com/README.md', source: 'SimplifyJobs New Grad', roleType: 'new_grad', warnings: healthyWarnings,
    fetchImpl: async () => new Response(fixture, { status: 200 }),
  });
  assert.equal(jobs.length, 2);
  assert.deepEqual(healthyWarnings, []);
  await assert.rejects(collectSimplifyList({ url: 'x', source: 'S', roleType: 'new_grad', warnings, fetchImpl: async () => new Response('', { status: 503 }) }), /HTTP 503/);
});
