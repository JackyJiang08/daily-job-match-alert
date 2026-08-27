import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCsv, buildHtml } from '../src/report.mjs';

const job = {
  source: 'fixture', roleType: 'new_grad', postedAt: '2026-08-27T10:00:00Z', discoveredAt: '2026-08-27T12:00:00Z',
  company: 'Acme, Inc.', title: 'Data & AI Analyst', location: 'Remote', dataScore: 82, aiScore: 74,
  bestScore: 82, recommendedResume: 'Data', reasons: ['SQL & Python'], gaps: ['Verify domain knowledge'], blockers: [],
  url: 'https://example.com/jobs/1', freshnessBasis: 'jobposting_date_posted',
};

test('CSV output quotes commas and preserves posting links', () => {
  const csv = buildCsv([job]);
  assert.match(csv, /"Acme, Inc\."/);
  assert.match(csv, /https:\/\/example\.com\/jobs\/1/);
});

test('HTML output escapes remote content and includes the original link', () => {
  const html = buildHtml([{ ...job, title: '<script>alert(1)</script>' }], { date: '2026-08-27', lookbackHours: 24 });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /https:\/\/example\.com\/jobs\/1/);
});
