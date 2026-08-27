import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { parseAgeDays, parseSimplifyRows } from '../src/collectors/simplify-github.mjs';
import { parseEml } from '../src/collectors/email-files.mjs';
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
