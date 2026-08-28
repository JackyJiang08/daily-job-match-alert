import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildHtml, writeReports } from '../src/report.mjs';
import { dateWithOffset } from '../src/utils.mjs';

const job = {
  source: 'fixture', roleType: 'new_grad', postedAt: '2026-08-27T10:00:00Z', discoveredAt: '2026-08-27T12:00:00Z',
  company: 'Acme, Inc.', title: 'Data & AI Analyst', location: 'Remote', dataScore: 82, aiScore: 74,
  bestScore: 82, recommendedResume: 'Data', reasons: ['SQL & Python'], gaps: ['Verify domain knowledge'], blockers: [],
  matchLevel: 'high', employmentType: 'FULL_TIME', salary: 'USD 90000–110000 YEAR',
  description: 'Use SQL, Python, and experimentation to help product teams make data-informed decisions.',
  url: 'https://example.com/jobs/1', freshnessBasis: 'jobposting_date_posted',
};

test('HTML output escapes remote content and includes the original link', () => {
  const html = buildHtml([{ ...job, title: '<script>alert(1)</script>' }], { date: '2026-08-27', lookbackHours: 24 });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /https:\/\/example\.com\/jobs\/1/);
  assert.match(html, /Full captured JD/);
  assert.doesNotMatch(html, /Pipeline warnings/);
});

test('renders pipeline warnings and clearly labels unreviewed jobs', () => {
  const html = buildHtml([{ ...job, matchLevel: 'unreviewed', scoringEngine: 'local_fallback' }], {
    date: '2026-08-27',
    lookbackHours: 24,
    warnings: [{ stage: 'collector', source: 'Job board', message: 'network unavailable' }],
  });
  assert.match(html, /Pipeline warnings/);
  assert.match(html, /collector \/ Job board/);
  assert.match(html, /network unavailable/);
  assert.match(html, /Match level: unreviewed/);
});

test('shows the scoring model in the header only when meta provides one', () => {
  const withModel = buildHtml([job], { date: '2026-08-27', lookbackHours: 24, scoringModel: 'claude-fable-5' });
  assert.match(withModel, /<header>[\s\S]*scored by claude-fable-5[\s\S]*<\/header>/);
  const withoutModel = buildHtml([job], { date: '2026-08-27', lookbackHours: 24 });
  assert.doesNotMatch(withoutModel, /scored by/);
  const escaped = buildHtml([job], { date: '2026-08-27', lookbackHours: 24, scoringModel: '<b>x</b>' });
  assert.doesNotMatch(escaped, /<b>x<\/b>/);
});

test('uses the next Central Time calendar date for the application folder', () => {
  assert.equal(dateWithOffset(new Date('2026-08-28T01:00:00Z'), 'America/Chicago', 1), '2026-08-28');
});

test('writes only a dated HTML report plus a temporary XLSX payload', async () => {
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'report-output-test-'));
  const date = '2026-08-28';
  const runDirectory = path.join(outputDirectory, date);
  await fs.mkdir(runDirectory, { recursive: true });
  await fs.writeFile(path.join(outputDirectory, 'latest.html'), 'legacy');
  await fs.writeFile(path.join(runDirectory, 'daily-job-match-alert.csv'), 'legacy');
  try {
    const paths = await writeReports([job], [job], { date, applicationDate: date, lookbackHours: 24 }, outputDirectory);
    assert.deepEqual(await fs.readdir(runDirectory), [`Daily Job Match Alert - ${date}.html`]);
    assert.equal(await fs.stat(paths.payloadPath).then(() => true), true);
    await assert.rejects(fs.access(path.join(outputDirectory, 'latest.html')));
    await fs.rm(paths.temporaryDirectory, { recursive: true, force: true });
  } finally {
    await fs.rm(outputDirectory, { recursive: true, force: true });
  }
});
