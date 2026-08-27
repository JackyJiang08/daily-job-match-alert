import assert from 'node:assert/strict';
import test from 'node:test';
import { enrichJob } from '../src/enrich.mjs';

test('extracts full JSON-LD JD, employment type, and salary', async () => {
  const posting = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: 'Machine Learning Engineer Intern',
    description: `<p>${'Build and evaluate PyTorch and RAG systems. '.repeat(12)}</p>`,
    datePosted: '2026-08-27',
    employmentType: ['INTERN', 'FULL_TIME'],
    jobLocationType: 'TELECOMMUTE',
    hiringOrganization: { name: 'Acme AI' },
    baseSalary: { currency: 'USD', value: { minValue: 45, maxValue: 55, unitText: 'HOUR' } },
  };
  const fetchImpl = async () => new Response(`<script type="application/ld+json">${JSON.stringify(posting)}</script>`, {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
  const job = await enrichJob({ url: 'https://example.com/job/1', title: '', company: '', location: '', description: '' }, {}, fetchImpl);
  assert.equal(job.company, 'Acme AI');
  assert.equal(job.employmentType, 'INTERN / FULL_TIME');
  assert.equal(job.salary, 'USD 45–55 HOUR');
  assert.ok(job.description.length > 200);
});
