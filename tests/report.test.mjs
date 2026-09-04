import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildHtml, writeReports } from '../src/report.mjs';
import { dateWithOffset } from '../src/utils.mjs';

const job = {
  source: 'fixture', roleType: 'new_grad', postedAt: '2026-08-27T10:00:00Z', discoveredAt: '2026-08-27T12:00:00Z',
  company: 'Acme, Inc.', title: 'Data & AI Analyst', location: 'Remote', scores: { data: 82, ai: 74 },
  bestScore: 82, recommendedTrack: 'data', recommendedResume: 'Data', reasons: ['SQL & Python'], gaps: ['Verify domain knowledge'], blockers: [],
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

test('renders one score chip per resume track from meta, falling back to the row scores for older payloads', () => {
  const tracks = [{ id: 'data', label: 'Data' }, { id: 'llm', label: 'LLM' }, { id: 'agent', label: 'AI Agent' }];
  const threeTrack = { ...job, scores: { data: 82, llm: 64, agent: 91 }, bestScore: 91, recommendedTrack: 'agent', recommendedResume: 'AI Agent' };
  const html = buildHtml([threeTrack], { date: '2026-08-27', lookbackHours: 24, resumeTracks: tracks });
  assert.match(html, /<header>[\s\S]*Resume tracks: Data · LLM · AI Agent[\s\S]*<\/header>/);
  assert.match(html, /<div class="chips"><span>Data 82<\/span><span>LLM 64<\/span><span>AI Agent 91<\/span><span>Use AI Agent<\/span>/);
  assert.doesNotMatch(html, /<span>AI \d+<\/span>/);

  const single = buildHtml([{ ...job, scores: { data: 82 } }], { date: '2026-08-27', lookbackHours: 24, resumeTracks: [{ id: 'data', label: 'Data' }] });
  assert.match(single, /<div class="chips"><span>Data 82<\/span><span>Use Data<\/span>/);
  assert.match(single, /Resume tracks: Data</);

  const legacy = buildHtml([{ ...job, scores: undefined, dataScore: 82, aiScore: 74 }], { date: '2026-08-27', lookbackHours: 24 });
  assert.match(legacy, /<div class="chips"><span>Data 82<\/span><span>AI 74<\/span><span>Use Data<\/span>/);
  assert.match(legacy, /Resume tracks: Data · AI</);
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

test('flags an unverified location with a chip and lists the hard-filter counts in the header', () => {
  const unverified = { ...job, location: 'Remote', gaps: ['Location unverified — confirm US eligibility'], eligibility: { location: { verdict: 'unverified', marker: null }, exclusion: null } };
  const html = buildHtml([unverified], { date: '2026-08-27', lookbackHours: 24, eligibilityExclusions: { location: 2, graduation: 1 } });
  assert.match(html, /<span class="location-unverified">Location unverified<\/span>/);
  assert.match(html, /Location unverified — confirm US eligibility/);
  assert.match(html, /<header>[\s\S]*excluded 3 posting\(s\): 2 outside the United States · 1 outside the graduation window[\s\S]*<\/header>/);

  const verified = buildHtml([{ ...job, eligibility: { location: { verdict: 'us', marker: 'US' }, exclusion: null } }], { date: '2026-08-27', lookbackHours: 24 });
  assert.doesNotMatch(verified, /<span class="location-unverified">/);
  assert.doesNotMatch(verified, /Hard eligibility filter/);
});
