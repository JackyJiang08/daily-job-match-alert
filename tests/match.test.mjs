import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateJob, isEligible, localProfileFor } from '../src/match.mjs';

const resumes = {
  data: 'Data analyst with Python SQL Tableau Excel pandas statistics experimentation and data visualization experience.',
  ai: 'Machine learning engineer with Python PyTorch transformers LLM RAG NLP Docker and AWS experience.',
};
const preferences = { roleTypes: ['internship', 'new_grad', 'entry_level'], maxYearsExperience: 3, remoteOkay: true, locations: ['Remote'] };

test('recommends the AI resume for an ML role', () => {
  const job = evaluateJob({ title: 'Machine Learning Engineer - New Grad', company: 'Acme', location: 'Remote', description: 'Build NLP systems with Python, PyTorch, transformers and Docker.', url: 'https://example.com/ml', source: 'fixture' }, resumes, preferences);
  assert.equal(job.roleType, 'new_grad');
  assert.equal(job.recommendedResume, 'AI');
  assert.equal(job.recommendedTrack, 'ai');
  assert.ok(job.scores.ai > job.scores.data);
  assert.equal(job.bestScore, job.scores.ai);
  assert.deepEqual(Object.keys(job.scoreDetails), ['data', 'ai']);
});

test('scores every enabled track by id, labels the winner, and breaks ties by configured order', () => {
  const tracks = [
    { id: 'llm', label: 'LLM', text: 'LLM engineer with Python PyTorch transformers LLM RAG embeddings fine-tuning and evaluation experience.' },
    { id: 'agent', label: 'AI Agent', text: 'Agent engineer with Python LLM tool use function calling MCP LangGraph orchestration and evaluation experience.' },
    { id: 'data', label: 'Data', text: 'Data analyst with Python SQL Tableau Excel pandas statistics experimentation and data visualization experience.' },
  ];
  const job = evaluateJob({ title: 'AI Agent Engineer - New Grad', company: 'Acme', location: 'Remote', description: 'Build LLM agents with tool use, function calling, MCP, LangGraph, RAG, and evaluation loops in Python.', url: 'https://example.com/agent', source: 'fixture' }, tracks, preferences);
  assert.deepEqual(Object.keys(job.scores), ['llm', 'agent', 'data']);
  assert.equal(job.recommendedTrack, 'agent');
  assert.equal(job.recommendedResume, 'AI Agent');
  assert.equal(job.bestScore, Math.max(...Object.values(job.scores)));
  assert.equal(job.dataScore, undefined);
  assert.equal(job.aiScore, undefined);

  // Identical resumes under two ids score identically; the first configured track wins the tie.
  const twin = [
    { id: 'second', label: 'Second', text: tracks[0].text },
    { id: 'first', label: 'First', text: tracks[0].text },
  ];
  const tie = evaluateJob({ title: 'LLM Engineer', company: 'Acme', location: 'Remote', description: 'Fine-tune transformers and build RAG pipelines in Python.', url: 'https://example.com/tie', source: 'fixture' }, twin, preferences);
  assert.equal(tie.scores.second, tie.scores.first);
  assert.equal(tie.recommendedResume, 'Second');
});

test('a single enabled track still produces a full evaluation', () => {
  const job = evaluateJob({ title: 'Data Analyst - New Grad', company: 'Acme', location: 'Remote', description: 'Use SQL, Python, Tableau, statistics, experimentation, and data visualization to support product decisions. '.repeat(4), url: 'https://example.com/single', source: 'fixture' }, [{ id: 'data', label: 'Data', text: resumes.data }], preferences);
  assert.deepEqual(Object.keys(job.scores), ['data']);
  assert.equal(job.recommendedResume, 'Data');
  assert.equal(job.bestScore, job.scores.data);
  assert.equal(isEligible(job, { preferences, minimumMatchScore: 20, semanticMatching: { engine: 'local_only' } }), true);
});

test('unknown track ids fall back to the union keyword profile', () => {
  assert.equal(localProfileFor('data').title.includes('data analyst'), true);
  assert.equal(localProfileFor('llm').skills.includes('fine-tuning'), true);
  const union = localProfileFor('robotics');
  assert.ok(union.title.includes('data analyst') && union.title.includes('ai agent'));
  const job = evaluateJob({ title: 'Data Analyst', company: 'Acme', location: 'Remote', description: 'Use SQL, Python, Tableau, and experimentation to support product decisions.', url: 'https://example.com/custom', source: 'fixture' }, [{ id: 'robotics', label: 'Robotics', text: resumes.data }], preferences);
  assert.equal(job.scoreDetails.robotics.roleRelevance, 25);
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

test('keeps an unreviewed local fallback when its local score clears the threshold', () => {
  const evaluated = evaluateJob({
    title: 'Data Analyst - New Grad', company: 'Acme', location: 'Remote',
    description: 'Use SQL, Python, Tableau, statistics, experimentation, and data visualization to support product decisions. '.repeat(4),
    url: 'https://example.com/unreviewed', source: 'fixture',
  }, resumes, preferences);
  const job = { ...evaluated, matchLevel: 'unreviewed', scoringEngine: 'local_fallback', semanticReviewed: false };
  assert.equal(isEligible(job, {
    preferences,
    minimumMatchScore: job.bestScore,
    semanticMatching: { engine: 'claude_subscription', acceptedMatchLevels: ['high'] },
  }), true);
  assert.equal(isEligible(job, {
    preferences,
    minimumMatchScore: job.bestScore + 1,
    semanticMatching: { engine: 'claude_subscription', acceptedMatchLevels: ['high'] },
  }), false);
});
