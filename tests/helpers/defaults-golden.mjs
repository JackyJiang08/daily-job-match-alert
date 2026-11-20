// The outputs that depend on owner-specific defaults (2026-11-19): the letter prompts (home state, degree,
// graduation, master's plan), the early-career JD signal (class year), the business-role track rule, and the
// local keyword profiles. goldenOutputs() with no new config keys must equal tests/fixtures/defaults/golden.json,
// which was written from the code before these became configurable.
import { buildCoverLetterPrompt, buildReviewPrompt, graduationTerms } from '../../src/cover-letter/compose.mjs';
import { buildCoverLetterPromptV2, buildReviewPromptV2, v2Context } from '../../src/cover-letter/rules-v2.mjs';
import { normalizeAvailability } from '../../src/cover-letter/availability.mjs';
import { detectEarlyCareer } from '../../src/prefilter.mjs';
import { letterTrackFor } from '../../src/hub/letters.mjs';
import { localProfileFor } from '../../src/match.mjs';

const JOBS = [
  { title: 'Data Analyst Intern', company: 'Example Corp', roleType: 'internship', location: 'Chicago, IL', description: 'SQL dashboards.', gaps: ['JD skill not found in resume: dbt'] },
  { title: 'Analyst', company: 'Example Corp', roleType: 'new_grad', location: 'Springfield, Illinois', description: 'Reporting.' },
  { title: 'Analyst', company: 'Other Co', roleType: 'entry_level', location: 'Austin, TX', description: 'Modeling.', gaps: ['Verify sponsorship'] },
  { title: 'ML Engineer', company: 'Other Co', roleType: 'unknown', location: 'Remote', description: 'Models.' },
];
const DESCRIPTIONS = ['Open to the Class of 2027.', 'class of 2028 only', 'Recent graduates welcome', 'Class of 2026', 'No signal here.'];
const TITLES = ['Business Analyst', 'Product Analyst, AI', 'Machine Learning Engineer', 'Operations Associate', 'Strategy Consultant', 'Data Scientist'];

export function goldenOutputs({ preferences = {}, coverLetter = {}, tracks = null } = {}) {
  const out = {};
  for (const graduationDate of [undefined, '2026-12']) {
    const graduation = graduationTerms(graduationDate ?? preferences.graduationDate, preferences);
    JOBS.forEach((job, index) => {
      const base = { playbook: 'PLAYBOOK', samples: [], track: { id: 'data', label: 'Data' }, resumeText: 'RESUME', job, graduation };
      out[`v1:${graduationDate}:${index}:prompt`] = buildCoverLetterPrompt(base);
      out[`v1:${graduationDate}:${index}:review`] = buildReviewPrompt({ paragraphs: ['A.', 'B.'], job, resumeText: 'RESUME', playbook: 'PLAYBOOK', graduation });
      for (const mentionMasters of [{ internship: true, newGrad: false }, { internship: false, newGrad: true }]) {
        const availability = normalizeAvailability({ ...(coverLetter.availability || {}), fullTimeFrom: 'June 2027', mentionMasters }, graduationDate);
        const context = v2Context({ job, graduation, availability, outreachLimit: 200 });
        const key = `v2:${graduationDate}:${index}:${mentionMasters.internship}`;
        out[`${key}:prompt`] = buildCoverLetterPromptV2({ playbook: 'PLAYBOOK {{AVAILABILITY}}', samples: [], track: { id: 'data', label: 'Data' }, resumeText: 'RESUME', job, context });
        out[`${key}:review`] = buildReviewPromptV2({ paragraphs: ['A.', 'B.'], job, resumeText: 'RESUME', playbook: 'PLAYBOOK', context });
      }
    });
  }
  out.earlyCareer = DESCRIPTIONS.map(description => detectEarlyCareer({ title: 'Analyst', description }, preferences));
  const trackSets = tracks ? [tracks] : [[{ id: 'data' }, { id: 'llm' }], [{ id: 'llm' }, { id: 'agent' }]];
  out.trackRule = trackSets.map(set => TITLES.map(title => letterTrackFor({ title, recommendedTrack: set[set.length - 1].id }, set)));
  out.profiles = ['data', 'ai', 'llm', 'agent', 'finance', null].map(id => localProfileFor(id));
  return out;
}
