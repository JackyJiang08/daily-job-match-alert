import assert from 'node:assert/strict';
import test from 'node:test';
import { LOCATION_UNVERIFIED_GAP, annotateEligibility, assessEligibility, assessGraduationWindow, assessLocation, summarizeExclusions } from '../src/eligibility.mjs';
import { evaluateJob, isEligible } from '../src/match.mjs';

const resumes = {
  data: 'Data analyst with Python SQL Tableau Excel pandas statistics experimentation and data visualization experience.',
  ai: 'Machine learning engineer with Python PyTorch transformers LLM RAG NLP Docker and AWS experience.',
};
const preferences = { roleTypes: ['internship', 'new_grad', 'entry_level'], maxYearsExperience: 3, remoteOkay: true, locations: ['Remote'], graduationDate: '2027-05' };
const description = 'Use SQL, Python, Tableau, statistics, experimentation, and data visualization to support product decisions. '.repeat(4);

function fallbackJob(overrides = {}) {
  const evaluated = evaluateJob({
    title: 'Data Analyst - New Grad', company: 'Acme', location: 'Remote', description, url: 'https://example.com/job', source: 'fixture', ...overrides,
  }, resumes, preferences);
  return { ...evaluated, matchLevel: 'unreviewed', scoringEngine: 'local_fallback', semanticReviewed: false };
}
const fallbackConfig = { preferences, minimumMatchScore: 1, semanticMatching: { engine: 'claude_subscription', acceptedMatchLevels: ['high'] } };

test('location verdicts: explicit non-US markers exclude, US markers pass, US always wins over a non-US marker', () => {
  for (const location of ['Remote – Canada', 'Toronto, ON', 'London', 'Bengaluru, India', 'Remote - Europe', 'Mexico City', 'Remote in Australia', 'Berlin, Germany', 'Remote (UK)']) {
    assert.equal(assessLocation(location).verdict, 'non_us', location);
  }
  for (const location of ['Remote - US', 'Remote (US)', 'United States', 'USA', 'New York, NY', 'Champaign, IL', 'Georgia', 'Washington, D.C.', 'Vancouver, WA', 'London, KY', 'Paris, TX', 'Austin, TX / Toronto', 'Remote in USA', 'Dublin, OH']) {
    assert.equal(assessLocation(location).verdict, 'us', location);
  }
  for (const location of ['Remote', '', '   ', 'Multiple Locations', 'Remote or Hybrid']) {
    assert.equal(assessLocation(location).verdict, 'unverified', JSON.stringify(location));
  }
  assert.equal(assessLocation('Remote in us').verdict, 'unverified', 'lower-case "us" is an ordinary word, not a country marker');
});

test('graduation window: unambiguous early cohorts exclude, ambiguous or compatible wording passes', () => {
  const excluded = [
    'Class of 2026 only.',
    'Must be graduating by December 2026.',
    'Expected graduation date must be on or before June 2026.',
    'Graduation date between December 2025 and December 2026.',
    'Candidates must be able to work full-time starting January 2027.',
    'Graduate by fall 2026 with a degree in statistics.',
    'graduating by 2026',
  ];
  for (const text of excluded) assert.equal(assessGraduationWindow(text, '2027-05', 'new_grad').excluded, true, text);
  const allowed = [
    'Class of 2026 or 2027 welcome.',
    'class of 2026/2027',
    'Graduating by May 2027.',
    'graduating by 2027',
    'graduate by spring 2027',
    'graduating before June 2027',
    'Graduating by Dec. 2026 or later.',
    'able to start full-time employment in June 2027',
    'This is a full-time role starting in January 2027.',
    'We hired 40 graduates in 2026.',
    'Expected graduation: December 2026.',
    'Bachelor degree graduating by 2027, 0-2 years of experience.',
  ];
  for (const text of allowed) assert.equal(assessGraduationWindow(text, '2027-05', 'new_grad').excluded, false, text);
  assert.equal(assessGraduationWindow('must be able to work full-time starting September 2026', '2027-05', 'internship').excluded, false, 'internships may run full-time hours before graduation');
  assert.deepEqual(assessGraduationWindow('class of 2026', undefined), { excluded: false, skipped: true, reason: null });
});

test('isEligible enforces the hard filters for locally fallbacked jobs, regardless of the scoring engine', () => {
  assert.equal(isEligible(fallbackJob(), fallbackConfig), true, 'baseline fallback job clears the threshold');
  assert.equal(isEligible(fallbackJob({ location: 'Remote – Canada' }), fallbackConfig), false);
  assert.equal(isEligible(fallbackJob({ description: `${description} Class of 2026 only.` }), fallbackConfig), false);
  assert.equal(isEligible(fallbackJob({ location: 'Remote – Canada' }), { ...fallbackConfig, semanticMatching: { engine: 'local_only' } }), false);
  const reviewedHigh = { ...fallbackJob({ location: 'Toronto, ON' }), matchLevel: 'high', semanticReviewed: true, scoringEngine: 'claude_subscription' };
  assert.equal(isEligible(reviewedHigh, fallbackConfig), false, 'even a high semantic match cannot override a non-US location');
});

test('annotateEligibility records the assessment and adds the location gap only when unverified', () => {
  const remote = annotateEligibility({ ...fallbackJob({ location: 'Remote' }), gaps: ['JD skill not found in resume: dbt'] }, preferences);
  assert.equal(remote.eligibility.location.verdict, 'unverified');
  assert.deepEqual(remote.gaps, ['JD skill not found in resume: dbt', LOCATION_UNVERIFIED_GAP]);
  assert.equal(remote.eligibility.exclusion, null);

  const empty = annotateEligibility(fallbackJob({ location: '' }), preferences);
  assert.ok(empty.gaps.includes(LOCATION_UNVERIFIED_GAP));

  const us = annotateEligibility({ ...fallbackJob({ location: 'Chicago, IL' }), gaps: [LOCATION_UNVERIFIED_GAP] }, preferences);
  assert.equal(us.eligibility.location.verdict, 'us');
  assert.deepEqual(us.gaps, []);

  const canada = annotateEligibility(fallbackJob({ location: 'Remote – Canada' }), preferences);
  assert.equal(canada.eligibility.exclusion.kind, 'location');
  assert.match(canada.eligibility.exclusion.reason, /Canada/);
  const cohort = annotateEligibility(fallbackJob({ description: `${description} Class of 2026 only.` }), preferences);
  assert.equal(cohort.eligibility.exclusion.kind, 'graduation');

  const summary = summarizeExclusions([remote, us, canada, cohort]);
  assert.deepEqual(summary.counts, { location: 1, graduation: 1 });
  assert.equal(summary.total, 2);
  assert.equal(summary.examples.length, 2);
  assert.match(summary.examples[0], /^Acme — Data Analyst - New Grad: location outside the United States/);
  assert.deepEqual(assessEligibility({ location: 'Remote', title: '', description: '' }, {}).exclusion, null);
});
