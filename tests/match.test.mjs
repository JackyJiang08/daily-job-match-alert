import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateJob, isEligible } from '../src/match.mjs';

const resumes = {
  data: 'Data analyst with Python SQL Tableau Excel pandas statistics experimentation and data visualization experience.',
  ai: 'Machine learning engineer with Python PyTorch transformers LLM RAG NLP Docker and AWS experience.',
};
const preferences = { roleTypes: ['internship', 'new_grad', 'entry_level'], maxYearsExperience: 3, remoteOkay: true, locations: ['Remote'] };

test('recommends the AI resume for an ML role', () => {
  const job = evaluateJob({ title: 'Machine Learning Engineer - New Grad', company: 'Acme', location: 'Remote', description: 'Build NLP systems with Python, PyTorch, transformers and Docker.', url: 'https://example.com/ml', source: 'fixture' }, resumes, preferences);
  assert.equal(job.roleType, 'new_grad');
  assert.equal(job.recommendedResume, 'AI');
  assert.ok(job.aiScore > job.dataScore);
});

test('blocks roles above the configured experience ceiling', () => {
  const job = evaluateJob({ title: 'Data Scientist', company: 'Acme', location: 'Remote', description: 'Requires at least 5 years of experience with SQL and Python.', url: 'https://example.com/data', source: 'fixture' }, resumes, preferences);
  assert.ok(job.blockers.length > 0);
  assert.equal(isEligible(job, { preferences, minimumMatchScore: 1 }), false);
});

test('treats a non-senior Data title without a stated year minimum as entry level', () => {
  const job = evaluateJob({ title: 'Data Analyst', company: 'Acme', location: 'Remote', description: 'Use SQL, Python, Tableau, and experimentation to support product decisions.', url: 'https://example.com/analyst', source: 'fixture' }, resumes, preferences);
  assert.equal(job.roleType, 'entry_level');
  assert.equal(isEligible(job, { preferences, minimumMatchScore: 20, requireFullDescription: false, semanticMatching: { engine: 'local_only' } }), true);
});

test('does not accept an unrelated software role on generic tool overlap alone', () => {
  const job = evaluateJob({ title: 'Software Engineer', company: 'Acme', location: 'Remote', description: 'Use Python, Docker, AWS and Kubernetes to build backend services.', url: 'https://example.com/swe', source: 'fixture' }, resumes, preferences);
  assert.equal(isEligible(job, { preferences: { ...preferences, roleTypes: [...preferences.roleTypes, 'unknown'] }, minimumMatchScore: 1 }), false);
});

test('requires a substantive JD before a role enters the high-match report', () => {
  const job = evaluateJob({ title: 'Data Analyst', company: 'Acme', location: 'Remote', description: 'SQL and Python.', url: 'https://example.com/short', source: 'fixture' }, resumes, preferences);
  assert.equal(isEligible(job, { preferences, minimumMatchScore: 1, semanticMatching: { engine: 'local_only' } }), false);
});
