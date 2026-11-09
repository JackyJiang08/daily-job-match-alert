// The v2 letter rules (2026-11-08): availability and the master's plan from config.coverLetter.availability, the
// opening style, the candid paragraph for core gaps (at most three), every automatic check from the outside
// review (part D), the editor's rewrite guard, the DA track rule and "Regenerate With DA Resume", the one-page
// flow without B5, the 7-day repetition hints and Status rates, Settings, and the A/B script. Every engine is a
// fake; the data are placeholders.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { availabilityConflicts, availabilityText, letterRulesSettings, mentionsMasters, normalizeAvailability, postingTermConflict, timelineRuleV2 } from '../src/cover-letter/availability.mjs';
import { autoFix, fixClosing, filterEditorIssues, guardEditorRewrite, postingCasing, runChecks, sharedRun, SCORING_EVIDENCE_NOTE } from '../src/cover-letter/checks.mjs';
import { numberWhitelist, numbersOutside, repeatedMetrics, resumeExperiences } from '../src/cover-letter/evidence.mjs';
import { graduationTerms } from '../src/cover-letter/compose.mjs';
import { LETTER_SCHEMA_V2, buildCondensePromptV2, closingRule, buildCoverLetterPromptV2, buildReviewPromptV2, condenseTarget, coreGaps, letterRulesV2, openingRule, renderPlaybook, v2Context } from '../src/cover-letter/rules-v2.mjs';
import { BATCH_HOURS, CLOSING_LIMIT, THANK_YOU_SENTENCES, batchAvoid, openingShape, pickClosing, recentLetterStats } from '../src/cover-letter/recent.mjs';
import { classifyEditorNotes, reviewBadge } from '../src/cover-letter/notes.mjs';
import { renderLetterPdfV2 } from '../src/cover-letter/pdf.mjs';
import { selectAutoLetters } from '../src/auto-letters.mjs';
import { createHubContext, createHubServer } from '../src/hub/server.mjs';
import { jobIdOf, letterCompanyFor, letterTrackFor } from '../src/hub/letters.mjs';
import { runLettersAb } from '../src/letters-ab.mjs';
import { inlineAssets } from './helpers/report-hub.mjs';

const NOW = '2026-11-08T18:00:00Z';
const GRAD = graduationTerms('2027-05');
const AVAILABILITY = normalizeAvailability({ fullTimeFrom: 'June 2027', springTerm: false, mentionMasters: { internship: true, newGrad: false } }, '2027-05');

const DATA_RESUME = `# Data resume
Jane Doe
EDUCATION
Example University    Aug 2023 – May 2027
Bachelor of Science, Statistics    Cumulative GPA: 3.91/4.00
WORK EXPERIENCE
Example Corp | Data Analyst Intern | Remote                    Sep 2025 – Nov 2025
   Parsed 500K+ nested JSON records with Python and SQL into KPI dashboards
   Built churn models (AUC 0.78) showing low-activity users drove 61% of churn
Northwind Logistics | Data Analyst Intern | Chicago, IL         Jun 2024 – Aug 2024
   Built 4 Power BI dashboards used by 50 managers; cut manual effort 25%
`;
const AGENT_RESUME = `# Agent resume
Jane Doe
Cumulative GPA: 3.91/4.00
WORK EXPERIENCE
Example Corp | Data Analyst Intern | Remote                    Sep 2025 – Nov 2025
   Parsed 500K+ nested JSON records with Python and SQL into KPI dashboards
PROJECTS
Widget Agent (LangGraph, FastAPI)                              Aug 2026
   Built a 10-node LangGraph workflow covered by 319 test cases
`;
const PLAYBOOK = '# Playbook\n- Availability window (hard fact): {{AVAILABILITY}}\n- Evidence: Example Corp churn work (AUC 0.78, 61 percent); a factor of 4,073.\n';

const job = (extra = {}) => ({
  url: 'https://example.com/jobs/1', title: 'Data Analyst Intern', company: 'Example Corp', companySource: 'source', location: 'Remote - US', roleType: 'internship',
  bestScore: 82, scores: { data: 82, agent: 70 }, recommendedTrack: 'data', recommendedResume: 'Data', matchLevel: 'high', semanticReviewed: true,
  reasons: ['Python and SQL dashboards at Example Corp'], gaps: [], blockers: [], description: 'Build dashboards for the analytics team. The internship runs June 1 to August 31, 2027, with 12 weeks of mentoring.', ...extra,
});

const P1 = 'Please consider my application for the Data Analyst Intern role with Example Corp, a remote position. I am a Statistics student at Example University with a 3.91 GPA, completing my bachelor\'s degree in May 2027 with plans to begin a master\'s program in Fall 2027. I am available full time from June 2027. Dashboards only matter when managers change a decision because of them.';
const MIDDLE = [
  'Turning messy records into reliable tables is where I started at Example Corp. I parsed more than 500,000 nested JSON records with Python and SQL into tables behind KPI dashboards. Clean inputs make every later number easier to defend.',
  'Predicting which users leave is the second part of that work. I built churn models with an AUC of 0.78 that showed low-activity users drove 61 percent of churn. The result shaped which users the team contacted first.',
  'Making dashboards people use came next at Northwind Logistics. I built 4 Power BI dashboards that 50 managers relied on and cut manual effort by 25 percent. Adoption is the real measure of a dashboard.',
];
const CLOSE = 'Thank you for your consideration. I would welcome the chance to support the analytics team from June 2027.';
const LETTER = [P1, ...MIDDLE, CLOSE];

const context = (extra = {}) => ({
  job: job(), resumeText: DATA_RESUME, playbook: PLAYBOOK, graduation: GRAD, graduationDate: '2027-05', availability: AVAILABILITY, mastersAllowed: true,
  opening: { forbidden: false }, openingStyle: 'limit-writing-to', candidParagraphIndex: -1, candidGaps: [], coreGaps: [], otherResumes: [AGENT_RESUME], ...extra,
});
const failed = (paragraphs, extra) => runChecks(paragraphs, context(extra)).failures.map(failure => failure.id);

// --------------------------------------------------------------------------------------- availability

test('availability: the rule and the timeline follow the settings for internships and new grad roles, with and without a spring term', () => {
  const internship = availabilityText({ roleType: 'internship', availability: AVAILABILITY, graduation: GRAD });
  assert.match(internship, /Enrolled through May 2027; available full time from June 2027\./);
  assert.match(internship, /Never name, accept, or imply a work term, season, or start date earlier than June 2027/);
  assert.match(internship, /mentions the plan to begin a master's program in Fall 2027/);
  assert.doesNotMatch(internship, /until the master's program begins/, 'no hard-coded end of availability');
  const newGrad = availabilityText({ roleType: 'new_grad', availability: AVAILABILITY, graduation: GRAD });
  assert.match(newGrad, /Do not mention a master's program, graduate school, or any study plan after May 2027\./);
  assert.match(timelineRuleV2('internship', GRAD, AVAILABILITY), /with plans to begin a master's program in Fall 2027/);
  assert.doesNotMatch(timelineRuleV2('new_grad', GRAD, AVAILABILITY), /master/);
  const noMasters = normalizeAvailability({ fullTimeFrom: 'June 2027', mentionMasters: { internship: false, newGrad: false } });
  assert.equal(timelineRuleV2('internship', GRAD, noMasters), 'say you are completing your bachelor\'s degree in May 2027');
  const newGradMasters = normalizeAvailability({ fullTimeFrom: 'June 2027', mentionMasters: { internship: true, newGrad: true } });
  assert.match(availabilityText({ roleType: 'new_grad', availability: newGradMasters, graduation: GRAD }), /master's program in Fall 2027/);
  const spring = normalizeAvailability({ fullTimeFrom: 'June 2027', springTerm: true });
  assert.match(availabilityText({ roleType: 'internship', availability: spring, graduation: GRAD }), /A spring term starting no earlier than January 2027 may be accepted/);

  // The letter check: terms before the availability date; the graduation month itself is fine.
  assert.deepEqual(availabilityConflicts('I graduate in May 2027 and can start in Summer 2027.', { availability: AVAILABILITY, graduation: GRAD }), []);
  assert.deepEqual(availabilityConflicts('I could join during the Spring 2027 co-op or in Fall 2026.', { availability: AVAILABILITY, graduation: GRAD }), ['Spring 2027', 'Fall 2026']);
  assert.deepEqual(availabilityConflicts('I could join during the Spring 2027 co-op.', { availability: spring, graduation: GRAD, graduationDate: '2027-05' }), [], 'a spring term is allowed when the setting says so');
  assert.deepEqual(availabilityConflicts('Starting in January 2027.', { availability: AVAILABILITY, graduation: GRAD }), ['January 2027']);
  assert.deepEqual(failed([P1.replace('I am available full time from June 2027.', 'I am available for the Spring 2027 co-op.'), ...MIDDLE, CLOSE]), ['availability']);
  // The master's plan: allowed for internships here, never in a new grad letter by default.
  assert.equal(mentionsMasters(P1), true);
  assert.deepEqual(failed(LETTER, { mastersAllowed: false }), ['masters']);
  assert.deepEqual(letterRulesSettings({}).availability, { fullTimeFrom: 'June 2027', springTerm: false, mentionMasters: { internship: true, newGrad: false } }, 'the default follows the graduation date');
  assert.equal(letterRulesSettings({}).rulesVersion, 'v1');
});

test('a posting whose own term starts before the availability date is a term conflict: the automatic pass skips it, a spring setting lifts it', () => {
  const coop = job({ title: 'Software Co-op, Spring 2027' });
  assert.deepEqual(postingTermConflict(coop, { availability: AVAILABILITY }), { term: 'Spring 2027', source: 'title' });
  const described = job({ title: 'Engineering Co-op', description: 'About us. This co-op term starts in January 2027 and lasts six months.' });
  assert.deepEqual(postingTermConflict(described, { availability: AVAILABILITY }), { term: 'January 2027', source: 'description' });
  assert.equal(postingTermConflict(job({ description: 'Candidates graduating in December 2026 or May 2027. The internship starts in June 2027.' }), { availability: AVAILABILITY }), null, 'graduation dates are not the term');
  assert.equal(postingTermConflict(job({ description: 'Applications for this Summer 2027 internship open in Fall 2026.' }), { availability: AVAILABILITY }), null, 'the application window is not the term');
  assert.equal(postingTermConflict(coop, { availability: normalizeAvailability({ fullTimeFrom: 'June 2027', springTerm: true }), graduationDate: '2027-05' }), null);
  const companyFor = item => ({ name: item.company, uncertain: false });
  const picked = selectAutoLetters({ matches: [job(), { ...coop, url: 'https://example.com/jobs/2' }], lettersByJob: new Map(), jobIdOf, companyFor, termConflict: item => postingTermConflict(item, { availability: AVAILABILITY }) });
  assert.equal(picked.picked.length, 1);
  assert.equal(picked.skipped.termConflict, 1);
});

// --------------------------------------------------------------------------------------- opening style

test('opening style: "limit-writing-to" allows the opening under 30 percent of the last 7 days and forbids it above; "ban-writing-to" always forbids', () => {
  assert.equal(openingRule({ openingStyle: 'limit-writing-to', writingToShare: 0.2 }).forbidden, false);
  assert.match(openingRule({ openingStyle: 'limit-writing-to', writingToShare: 0.2 }).text, /It may begin with "I am writing to apply for the <role> position at <company>" \(recent letters open that way 20% of the time; the limit is 30%\)/);
  assert.equal(openingRule({ openingStyle: 'limit-writing-to', writingToShare: 0.4 }).forbidden, true);
  assert.match(openingRule({ openingStyle: 'limit-writing-to', writingToShare: 0.4 }).text, /must not begin with "I am writing to" or "I am applying for": recent letters already open with "I am writing to" 40% of the time/);
  assert.equal(openingRule({ openingStyle: 'ban-writing-to', writingToShare: 0 }).forbidden, true);
  const writing = ['I am writing to apply for the Data Analyst Intern role at Example Corp. ' + P1.split('. ').slice(1).join('. '), ...MIDDLE, CLOSE];
  assert.deepEqual(failed(writing, { opening: { forbidden: false } }), [], 'allowed while under the limit');
  assert.deepEqual(failed(writing, { opening: { forbidden: true } }), ['opening'], 'over the limit');
  assert.deepEqual(failed(writing, { openingStyle: 'ban-writing-to' }), ['opening']);
  const applying = ['I am applying for the Data Analyst Intern role at Example Corp. ' + P1.split('. ').slice(1).join('. '), ...MIDDLE, CLOSE];
  assert.deepEqual(failed(applying), ['opening'], '"I am applying for" is never the opening');
});

// --------------------------------------------------------------------------------------- part D checks

test('the automatic checks pass a clean letter and name every rule', () => {
  const result = runChecks(LETTER, context());
  assert.deepEqual(result.failures, []);
  assert.deepEqual(Object.keys(result.results).sort(), ['availability', 'banned-phrases', 'candid', 'closing', 'graduation-once', 'jd-echo', 'masters', 'metric-repeat', 'numbers', 'one-page', 'opening', 'opening-variety', 'principle-openers', 'scenario', 'scoring-evidence', 'symbols', 'title-separators']);
  assert.equal(result.results.closing, null, 'no assigned thank-you sentence');
  assert.equal(result.results['opening-variety'], null, 'no letters earlier tonight');
  assert.equal(result.results['one-page'], null, 'no page count before rendering');
});

test('banned phrases, principle openers, graduation once, JD echo, and metric repetition fail as needs-review notes', () => {
  assert.deepEqual(failed([P1, ...MIDDLE, 'Thank you for considering my application. I would welcome the chance to join from June 2027.']), ['banned-phrases']);
  assert.deepEqual(failed([P1, MIDDLE[0].replace('Clean inputs make every later number easier to defend.', 'My work translates directly to your data.'), ...MIDDLE.slice(1), CLOSE]), ['banned-phrases', 'scenario']);
  assert.deepEqual(failed([P1, MIDDLE[0].replace('Clean inputs', 'I work from the idea that clean inputs'), ...MIDDLE.slice(1), CLOSE]), ['principle-openers']);
  assert.deepEqual(failed([`${P1} I finish in May 2027.`, ...MIDDLE, CLOSE]), ['graduation-once']);
  const echo = job({ description: 'You will build dashboards for the analytics team and present weekly results to leaders.' });
  assert.deepEqual(failed([P1, 'Build dashboards for the analytics team and present weekly results is what I did. ' + MIDDLE[0], ...MIDDLE.slice(1), CLOSE], { job: echo }), ['jd-echo']);
  assert.equal(sharedRun('I build dashboards for the analytics team every week', echo.description), 6);
  assert.equal(sharedRun('I build dashboards for leaders every week', echo.description), 3);
  assert.deepEqual(failed([P1, MIDDLE[0], MIDDLE[1].replace('The result shaped', 'That 61 percent shaped'), MIDDLE[2], CLOSE]), ['metric-repeat']);
  assert.deepEqual(repeatedMetrics('3 backends, 3 layers, 61 percent and 61%'), [{ raw: '61', count: 2 }], 'small counts are not metrics');
  const notes = runChecks([P1, ...MIDDLE, 'Thank you for considering my application. Later.'], context()).notes;
  assert.match(notes[0], /^check failed \(banned-phrases\): /);
  assert.equal(classifyEditorNotes(notes).needsReview.length, 1, 'a failed check needs review');
});

test('symbols and title separators are rewritten before rendering; what cannot be rewritten fails', () => {
  const fixed = autoFix(['Lifted engagement 15% across 500K+ records, ≥85% coverage, Kendall τ 0.956, ρ 0.79; Data Analyst - Remote role.']);
  assert.equal(fixed.paragraphs[0], 'Lifted engagement 15 percent across more than 500,000 records, at least 85 percent coverage, Kendall tau 0.956, rho 0.79; Data Analyst, Remote role.');
  assert.deepEqual(fixed.info, ['auto-fix: wrote K+, ≥, %, τ, ρ out in words', 'auto-fix: rewrote " - " separators as commas']);
  assert.equal(classifyEditorNotes(fixed.info).info.length, 2, 'fixes are info notes');
  assert.deepEqual(failed([P1, MIDDLE[0].replace('Python and SQL', 'Python and SQL ×4,073'), ...MIDDLE.slice(1), CLOSE]), ['symbols']);
  assert.deepEqual(failed([P1.replace('the Data Analyst Intern role', 'the Data Analyst - Intern role'), ...MIDDLE, CLOSE]), ['title-separators']);
});

test('numbers must come from the selected resume, the playbook, or the posting, compared by value', () => {
  const whitelist = numberWhitelist(DATA_RESUME, PLAYBOOK);
  assert.deepEqual(numbersOutside('more than 500,000 records and 500K rows and $500,000+', whitelist), []);
  assert.deepEqual(numbersOutside('an AUC of 0.788', whitelist), ['0.788'], '0.78 and 0.788 differ');
  assert.deepEqual(numbersOutside('a factor of 4,073 by 2027', whitelist), [], 'years are not checked');
  assert.deepEqual(numbersOutside('12 weeks starting June 1', whitelist, job().description), [], 'the posting\'s numbers describe the employer');
  assert.deepEqual(failed([P1, MIDDLE[0].replace('500,000', '750,000'), ...MIDDLE.slice(1), CLOSE]), ['numbers']);
  assert.deepEqual(numbersOutside('GPT-4 and Qwen-2.5 on S3', whitelist), [], 'names with digits are not quantities');
});

test('scoring evidence: reasons that cite an experience only another resume carries need review and point to the DA resume', () => {
  const reasons = job({ reasons: ['Power BI dashboards at Northwind Logistics', 'Python'] });
  const result = runChecks(LETTER, context({ job: reasons, resumeText: AGENT_RESUME, otherResumes: [DATA_RESUME] }));
  assert.deepEqual(result.failures.map(failure => failure.id).filter(id => id === 'scoring-evidence'), ['scoring-evidence']);
  assert.ok(result.notes.some(note => note.includes(SCORING_EVIDENCE_NOTE) && note.includes('Northwind Logistics')));
  assert.deepEqual(resumeExperiences(AGENT_RESUME).map(item => item.name), ['Example Corp', 'Widget Agent']);
});

test('candid paragraph: core gaps need one (reported by index), at most three gaps, and eligibility gaps do not count', () => {
  const gaps = ['No Snowflake or dbt experience', 'No Agile, Scrum, or JIRA experience', 'Internship runs during graduation; confirm eligibility', 'Hybrid role requiring 3 days a week in the office'];
  assert.deepEqual(coreGaps(job({ gaps })), ['No Snowflake or dbt experience', 'No Agile, Scrum, or JIRA experience']);
  assert.deepEqual(failed(LETTER, { coreGaps: coreGaps(job({ gaps })) }), ['candid']);
  const candid = 'I should be straightforward about Snowflake and Agile practice. I would learn Snowflake through its trial and documentation, and my versioned pipeline work is the closest bridge.';
  const withCandid = [P1, ...MIDDLE, candid, CLOSE];
  assert.deepEqual(failed(withCandid, { coreGaps: coreGaps(job({ gaps })), candidParagraphIndex: 4, candidGaps: ['Snowflake', 'Agile'] }), []);
  assert.deepEqual(failed(withCandid, { coreGaps: coreGaps(job({ gaps })), candidParagraphIndex: 4, candidGaps: ['a', 'b', 'c', 'd'] }), ['candid']);
  assert.equal(LETTER_SCHEMA_V2.properties.candidGaps.maxItems, 3);
  assert.ok(LETTER_SCHEMA_V2.required.includes('candidParagraphIndex'));
  const rules = letterRulesV2({ ...v2Context({ job: job({ gaps }), graduation: GRAD, availability: AVAILABILITY }), outreachLimit: 200 });
  assert.match(rules, /Name at most the 3 most important of these items and give each one concrete sentence on how you would learn it or which existing work bridges to it\. Leave the minor items out/);
  assert.match(rules, /No Snowflake or dbt experience; No Agile, Scrum, or JIRA experience\. Include ONE candid paragraph/);
  assert.match(letterRulesV2(v2Context({ job: job(), graduation: GRAD, availability: AVAILABILITY })), /Do NOT add a candid or disclaimer paragraph; return candidParagraphIndex -1 and candidGaps \[\]/);
});

test('editor issues: case-only name mismatches and issues whose quote is not in the draft are set aside; the posting\'s casing names the company', () => {
  const issues = ['salutation says LabCo, body says Labco', 'unverified detail: "clinical review portals"', 'unverified detail: "built dashboards"', 'Paragraph 1 lacks the timeline sentence', 'salutation says Example Corp, body says Sample Labs'];
  const { kept, dropped } = filterEditorIssues(issues, ['I built dashboards for the team.']);
  assert.deepEqual(kept, ['unverified detail: "built dashboards"', 'Paragraph 1 lacks the timeline sentence', 'salutation says Example Corp, body says Sample Labs']);
  assert.deepEqual(dropped, ['salutation says LabCo, body says Labco', 'unverified detail: "clinical review portals"']);
  assert.equal(postingCasing('LabCo', 'Join Labco today. Labco builds tests. LabCo was founded in 1990.'), 'Labco');
  assert.equal(postingCasing('Example Corp', 'Example Corp builds things.'), 'Example Corp');
});

test('an editor rewrite may not add numbers outside the sources or scenario wording: that paragraph keeps the draft', () => {
  const whitelist = numberWhitelist(DATA_RESUME, PLAYBOOK);
  const revised = [P1, MIDDLE[0].replace('500,000', '900,000'), MIDDLE[1].replace('The result', 'This production-grade result'), MIDDLE[2].replace('Adoption is', 'Adoption is still'), CLOSE];
  const guarded = guardEditorRewrite({ draft: LETTER, revised, whitelist, job: job(), resumeText: DATA_RESUME, playbook: PLAYBOOK });
  assert.equal(guarded.paragraphs[1], MIDDLE[0]);
  assert.equal(guarded.paragraphs[2], MIDDLE[1]);
  assert.equal(guarded.paragraphs[3], revised[3], 'a rewrite with no new facts is kept');
  assert.deepEqual(guarded.rejected.map(item => item.index), [1, 2]);
  assert.match(guarded.rejected[0].reason, /numbers not in the sources \(900,000\)/);
});

test('needs-review keeps the card badge until the owner marks the details checked', () => {
  const notes = ['check failed (numbers): numbers not on the selected resume or the playbook: 9'];
  assert.equal(reviewBadge(notes).label, 'Check 1 detail');
  assert.equal(reviewBadge(notes, { cleared: true }), null);
});

test('one page: no B5 fallback; a long PDF is condensed (0.85 of its words, at most 480), then to 450 words, and a PDF still longer needs review', async () => {
  assert.equal(condenseTarget(600, 1), 480);
  assert.equal(condenseTarget(540, 1), 459);
  assert.equal(condenseTarget(540, 2), 450);
  assert.match(buildCondensePromptV2({ paragraphs: ['a'], pages: 2, target: 459 }), /ran to 2 pages; it must fit one page\. Shorten it to at most 459 words/);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'letters-v2-pdf-'));
  try {
    const long = Array.from({ length: 6 }, () => 'word '.repeat(150).trim());
    const letter = { name: 'Jane Doe', contact: '', date: 'November 8, 2026', salutation: 'Dear Example Corp Recruiting Team,', paragraphs: long, closing: 'Sincerely,', signature: 'Jane Doe' };
    const calls = [];
    const step = target => async paragraphs => { calls.push(target); return target === 450 ? ['short body.'] : paragraphs.map(p => p.slice(0, p.length - 50)); };
    const pdf = await renderLetterPdfV2(letter, path.join(dir, 'a.pdf'), { chromeCommand: false, steps: [step(480), step(450)] });
    assert.deepEqual(calls, [480, 450]);
    assert.equal(pdf.pages, 1);
    assert.equal(pdf.layout, 'letter-1in');
    const stuck = await renderLetterPdfV2(letter, path.join(dir, 'b.pdf'), { chromeCommand: false, steps: [] });
    assert.ok(stuck.pages > 1);
    assert.match(stuck.note, /the letter still runs to \d+ pages, trim the body/);
    assert.equal(stuck.layout, 'letter-1in', 'never B5');
    assert.deepEqual(failed(LETTER, { pages: 2 }), ['one-page']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('7-day repetition: overused openings, closings, and experiences go into the next prompt; nothing fails on them', () => {
  const at = '2026-11-07T12:00:00Z';
  const letters = [
    ...Array.from({ length: 4 }, () => ({ createdAt: at, paragraphs: ['I am writing to apply for the Analyst role. More.', 'Example Corp work.', 'Thank you for considering my application. Bye.'] })),
    ...Array.from({ length: 6 }, (_, i) => ({ createdAt: at, paragraphs: [`Opening number ${i} is unique here. More.`, 'Other work.', `Closing ${i}. Bye.`] })),
    { createdAt: '2026-10-01T12:00:00Z', paragraphs: ['Too old to count.'] },
  ];
  const stats = recentLetterStats(letters, { now: new Date(NOW), experiences: resumeExperiences(DATA_RESUME) });
  assert.equal(stats.total, 10);
  assert.equal(stats.topOpening.text, 'I am writing to apply for');
  assert.equal(stats.topOpening.share, 0.4);
  assert.equal(stats.writingToShare, 0.4);
  assert.deepEqual(stats.overusedClosings.map(item => item.text), ['Thank you for considering my application.']);
  assert.deepEqual(stats.experienceShares.find(item => item.name === 'Example Corp'), { name: 'Example Corp', count: 4, share: 0.4 });
  const busy = recentLetterStats(Array.from({ length: 5 }, () => ({ createdAt: at, paragraphs: ['Hello there. More.', 'At Example Corp I built it.', 'Thanks. Bye.'] })), { now: new Date(NOW), experiences: resumeExperiences(DATA_RESUME) });
  const rules = letterRulesV2(v2Context({ job: job(), graduation: GRAD, availability: AVAILABILITY, recent: busy }));
  assert.match(rules, /Recent letters overuse these openings; do not begin with them: "Hello there\."/);
  assert.match(rules, /Recent letters overuse these closing sentences; do not use them: "Thanks\."/);
  assert.match(closingRule(['Thank you for your consideration.']), /^The closing paragraph is exactly two sentences: a thank-you \(vary it, for example "Thank you for reading my application\.", "I appreciate your time and consideration\.", or "Thank you for taking the time to review my application\."; never "Thank you for considering my application\."\)/);
  assert.match(closingRule([]), /for example "Thank you for your consideration\.", "Thank you for reading my application\.", or "I appreciate your time and consideration\."/);
  assert.match(rules, /Recent letters lean on Example Corp \(100% of the last 7 days' letters\)\. When another experience on the RESUME is equally relevant to a responsibility, prefer it/);
});

test('the v2 prompts carry the review\'s edits and the playbook\'s availability; the editor must quote the draft and add no facts', () => {
  const ctx = v2Context({ job: job({ gaps: ['No Tableau experience'] }), graduation: GRAD, availability: AVAILABILITY, outreachLimit: 200 });
  const draft = buildCoverLetterPromptV2({ playbook: PLAYBOOK, samples: [], track: { label: 'Data' }, resumeText: DATA_RESUME, job: job({ gaps: ['No Tableau experience'] }), context: ctx });
  assert.match(draft, /- Availability window \(hard fact\): Enrolled through May 2027; available full time from June 2027\./, 'the playbook token is filled from Settings');
  assert.doesNotMatch(draft, /\{\{AVAILABILITY\}\}/);
  assert.match(draft, /never a phrase of six or more words copied from the posting/);
  assert.match(draft, /never begin it with "I work from", "I work by", or "I believe"/);
  assert.match(draft, /Scenario discipline: describe your own work only with details the RESUME or PLAYBOOK states/);
  assert.match(draft, /never "Thank you for considering my application\."/);
  assert.match(draft, /writing the posting's title without " - " separators/);
  assert.match(draft, /ONE sentence joining degree, school, GPA and the timeline \(say you are completing your bachelor's degree in May 2027 with plans to begin a master's program in Fall 2027\), never two sentences that both state graduation/);
  const review = buildReviewPromptV2({ paragraphs: LETTER, candidParagraphIndex: -1, job: job(), resumeText: DATA_RESUME, playbook: PLAYBOOK, context: ctx, company: 'Example Corp' });
  assert.match(review, /Every issue must quote the exact DRAFT words it refers to, in double quotes/);
  assert.match(review, /rewrite that sentence to state only what the RESUME or PLAYBOOK supports, or delete it/);
  assert.match(review, /Never add a new fact, number, tool, employer, or scenario/);
  assert.match(review, /The name check is case-insensitive/);
  assert.match(review, /flag any work term, season, or start date earlier than June 2027/);
  assert.doesNotMatch(review, /Do NOT remove or rewrite those details/);
  assert.equal(renderPlaybook('a {{AVAILABILITY}} b', { availability: 'X' }), 'a X b');
});

test('closing rotation: at least five thank-you sentences, none assigned above 30 percent of the last 7 days or twice in one night', () => {
  assert.ok(THANK_YOU_SENTENCES.length >= 5);
  assert.equal(new Set(THANK_YOU_SENTENCES.map(text => text.toLowerCase())).size, THANK_YOU_SENTENCES.length);
  assert.equal(CLOSING_LIMIT, 0.3);
  // Three weeks of nightly batches of 6 letters, every letter taking the sentence it is assigned.
  const letters = [];
  const start = Date.parse('2026-11-01T23:00:00Z');
  for (let night = 0; night < 21; night += 1) {
    for (let index = 0; index < 6; index += 1) {
      const now = new Date(start + night * 86_400_000 + index * 600_000);
      const tonight = batchAvoid(letters, { now });
      const { sentence } = pickClosing({ recent: letters, batch: tonight, now });
      assert.ok(!tonight.closings.some(entry => entry.sentence === sentence), `night ${night}, letter ${index}: not used earlier tonight`);
      letters.push({ jobId: `job${night}x${index}`, createdAt: now.toISOString(), paragraphs: ['Opening.', `${sentence} I would welcome a conversation.`] });
      if (night >= 2) {
        const window = letters.filter(letter => Date.parse(letter.createdAt) > now.getTime() - 7 * 86_400_000);
        for (const text of THANK_YOU_SENTENCES) {
          const share = window.filter(letter => letter.paragraphs[1].startsWith(text)).length / window.length;
          assert.ok(share <= CLOSING_LIMIT, `"${text}" is at ${share} on night ${night}`);
        }
      }
    }
  }
  // A sentence the old letters overuse (81 percent) is not assigned until it falls to 30 percent.
  const now = new Date(NOW);
  const old = Array.from({ length: 10 }, (_, index) => ({ createdAt: '2026-11-05T12:00:00Z', paragraphs: ['Hi.', `${index < 8 ? 'Thank you for your consideration.' : 'Thank you for reading my application.'} Bye.`] }));
  const pick = pickClosing({ recent: old, batch: { closings: [] }, now });
  assert.notEqual(pick.sentence, 'Thank you for your consideration.');
  assert.notEqual(pick.sentence, 'Thank you for reading my application.', 'used 20 percent and least used come first');
  assert.equal(pick.shares.find(entry => entry.text === 'Thank you for your consideration.').share, 0.8);
});

test('tonight\'s letters: each later prompt lists the earlier openings and closings, and the checks catch a repeated construction or thank-you', () => {
  assert.equal(BATCH_HOURS, 12);
  const now = new Date(NOW);
  const letters = [
    { jobId: 'a1', jobTitle: 'Data Analyst Intern', company: 'Initech', createdAt: '2026-11-08T17:00:00Z', paragraphs: ['The Data Analyst Intern role at Initech in Austin asks for SQL. More.', 'Work.', 'I appreciate your time and consideration. I hope to join the analytics team in June 2027.'] },
    { jobId: 'a2', jobTitle: 'Analyst', company: 'Old Co', createdAt: '2026-11-07T12:00:00Z', paragraphs: ['Yesterday morning opening. More.', 'Work.', 'Thank you for reading my application. Bye.'] },
    { jobId: 'self', jobTitle: 'Data Analyst Intern', company: 'Example Corp', createdAt: '2026-11-08T17:30:00Z', paragraphs: ['A letter for this very posting. More.', 'Work.', 'Thanks. Bye.'] },
  ];
  const tonight = batchAvoid(letters, { now, jobId: 'self' });
  assert.deepEqual(tonight.openings.map(entry => entry.text), ['The Data Analyst Intern role at Initech in Austin asks for SQL.'], 'older than 12 hours and the posting itself are left out');
  assert.equal(tonight.openings[0].shape, 'the * role at *');
  assert.equal(tonight.closings[0].sentence, 'I appreciate your time and consideration.');
  const closing = pickClosing({ recent: letters, batch: tonight, now }).sentence;
  assert.notEqual(closing, 'I appreciate your time and consideration.');
  const rules = letterRulesV2(v2Context({ job: job(), graduation: GRAD, availability: AVAILABILITY, batch: tonight, closing }));
  assert.match(rules, /Letters written earlier tonight open with these sentences: "The Data Analyst Intern role at Initech in Austin asks for SQL\."\. Your first sentence must use a different construction from every one of them/);
  assert.match(rules, /Letters written earlier tonight close with these paragraphs; write a forward-looking sentence with a different construction and different wording from each: "I appreciate your time and consideration\. I hope to join the analytics team in June 2027\."/);
  assert.match(rules, new RegExp(`a thank-you \\(exactly this sentence, word for word: "${closing.replace(/[.]/g, '\\.')}"`));
  assert.doesNotMatch(letterRulesV2(v2Context({ job: job(), graduation: GRAD, availability: AVAILABILITY })), /earlier tonight/, 'no batch, no list');

  // Same construction with other role and company words: the opening-variety check fails; another construction passes.
  const same = ['The Data Analyst Intern role at Example Corp in Remote calls for clean tables. More.', ...LETTER.slice(1)];
  assert.equal(openingShape(same, { title: 'Data Analyst Intern', company: 'Example Corp' }), 'the * role at *');
  const checked = runChecks(same, context({ batch: tonight, closing: 'Thank you for your consideration.' }));
  assert.equal(checked.results['opening-variety'], false);
  assert.match(checked.notes.join('\n'), /check failed \(opening-variety\): the first sentence has the same construction \("the \* role at \*"\) as tonight's Initech letter/);
  assert.equal(runChecks(LETTER, context({ batch: tonight, closing: 'Thank you for your consideration.' })).results['opening-variety'], true);

  // The assigned thank-you replaces another thank-you sentence; a closing without one fails the closing check.
  const fixed = autoFix(LETTER, { closing: 'I am grateful for your time and attention.' });
  assert.equal(fixed.paragraphs.at(-1), 'I am grateful for your time and attention. I would welcome the chance to support the analytics team from June 2027.');
  assert.match(fixed.info.join('\n'), /auto-fix: the closing starts with this letter's thank-you sentence "I am grateful for your time and attention\." \(it said "Thank you for your consideration\."\)/);
  assert.deepEqual(fixClosing(LETTER, 'Thank you for your consideration.').fixed, false, 'already the assigned sentence');
  const noThanks = [...LETTER.slice(0, -1), 'I look forward to hearing from you. I would welcome the chance to talk.'];
  assert.equal(fixClosing(noThanks, 'Thank you for your consideration.').fixed, false);
  assert.equal(runChecks(noThanks, context({ closing: 'Thank you for your consideration.' })).results.closing, false);
});

// --------------------------------------------------------------------------------------- hub (fake engines)

const PROFILE = { name: 'Jane Doe', phone: '555-0100', email: 'jane.doe@example.com', signatureName: 'Jane Doe' };

async function project({ coverLetter = { rulesVersion: 'v2' }, matches = [job()] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'letters-v2-'));
  await fs.mkdir(path.join(root, 'state'), { recursive: true });
  await fs.writeFile(path.join(root, 'data.md'), DATA_RESUME);
  await fs.writeFile(path.join(root, 'agent.md'), AGENT_RESUME);
  const config = {
    timeZone: 'America/Chicago', semanticMatching: { engine: 'claude', models: { claude: 'fable' } }, preferences: { graduationDate: '2027-05' }, outputDirectory: './out',
    resumes: { autoRefresh: false, tracks: [{ id: 'data', label: 'Data', profile: './data.md', enabled: true }, { id: 'agent', label: 'AI Agent', profile: './agent.md', enabled: true }] },
    coverLetter,
  };
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(config, null, 2));
  const meta = { date: '2026-11-08', applicationDate: '2026-11-08', generatedAt: NOW, lookbackHours: 24, resumeTracks: [{ id: 'data', label: 'Data' }, { id: 'agent', label: 'AI Agent' }], warnings: [], matchCount: matches.length };
  await fs.writeFile(path.join(root, 'state', 'report-payload-2026-11-08.json'), JSON.stringify({ meta, matches, reviewed: matches, complete: true }));
  return root;
}

// drafts: what the draft call returns; editor: (prompt) => output. Every prompt is recorded.
async function hubFor(root, { draft = () => ({ paragraphs: LETTER, shortName: 'Example Corp', candidParagraphIndex: -1, candidGaps: [], connectionNote: 'Hi {First Name}, hello.', followUpMessage: 'Hi {First Name}, thanks.' }), editor = () => ({ issues: [], revised_paragraphs: [], candidParagraphIndex: -1 }), condense = prompt => ({ paragraphs: LETTER }) } = {}) {
  const prompts = [];
  const engineFor = (choice = {}) => ({
    id: choice.engine || 'codex', label: choice.engine || 'codex', model: choice.model || 'gpt-5.6-sol', effort: choice.effort || null,
    async generateText(prompt, options) {
      const kind = prompt.startsWith('EDITOR REVIEW') ? 'editor' : prompt.startsWith('CONDENSE') ? 'condense' : 'draft';
      prompts.push({ kind, prompt, schema: options?.schema });
      const output = kind === 'editor' ? editor(prompt) : kind === 'condense' ? condense(prompt) : draft(prompt);
      return { output, scoringModel: choice.model || 'gpt-5.6-sol', usage: { engine: 'codex', models: [] } };
    },
  });
  const ctx = createHubContext({
    timingLog: () => {}, configPath: path.join(root, 'config.json'), port: 0, now: () => new Date(NOW), homedir: root, chromeCommand: false,
    pidAlive: pid => pid === process.pid, letterEngine: engineFor(),
    describeConnections: async () => ({ claude: { installed: true, connected: true }, codex: { installed: true, connected: true } }),
    renderPdf: async (letter, file) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, '%PDF-1.4 fake'); return { pages: 1, layout: 'letter-1in', renderer: 'fake', paragraphs: letter.paragraphs, condensed: false, note: null }; },
  });
  ctx.makeLetterEngine = engineFor;
  await ctx.letterStore.saveProfileFields(PROFILE);
  await ctx.letterStore.savePlaybook({ filename: 'playbook.md', data: Buffer.from(PLAYBOOK) });
  const server = createHubServer(ctx);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const request = (method, pathname, body = null) => new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}${pathname}`, { method, headers: { host: `127.0.0.1:${port}`, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: inlineAssets(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    // Arrays (the paragraphs) go as repeated fields, as the letter page's form sends them.
    if (body) req.write(new URLSearchParams(Object.entries(body).flatMap(([key, value]) => (Array.isArray(value) ? value.map(item => [key, item]) : [[key, value]]))).toString());
    req.end();
  });
  return { ctx, prompts, request, close: () => new Promise(resolve => server.close(resolve)) };
}

test('v2 in the hub: the v2 prompts, the checks on the saved letter, the posting casing, and the v1 playbook kept for v1', async () => {
  const root = await project();
  const hub = await hubFor(root);
  try {
    const id = jobIdOf(job());
    const draft = JSON.parse((await hub.request('POST', '/letters/generate', { date: '2026-11-08', job: id, company: 'Example Corp' })).text);
    assert.equal(draft.rulesVersion, 'v2');
    assert.deepEqual(draft.rules, { version: 'v2', candidParagraphIndex: -1, candidGaps: [], openingForbidden: false, closingSentence: 'Thank you for your consideration.' }, 'the first letter gets the first thank-you sentence');
    assert.match(hub.prompts[0].prompt, /a thank-you \(exactly this sentence, word for word: "Thank you for your consideration\."/);
    assert.match(hub.prompts[0].prompt, /AVAILABILITY: Enrolled through May 2027/);
    assert.equal(hub.prompts[0].schema.required.includes('candidParagraphIndex'), true);
    assert.equal(hub.prompts[1].kind, 'editor');
    assert.deepEqual(draft.notesNeedReview, []);
    const saved = JSON.parse((await hub.request('POST', '/letters/save', { date: '2026-11-08', job: id, track: 'data', company: draft.company, paragraph: draft.paragraphs, engine: 'codex', model: 'gpt-5.6-sol', editorNotes: JSON.stringify(draft.editorNotes), rules: JSON.stringify(draft.rules) })).text);
    assert.equal(saved.record.rulesVersion, 'v2');
    assert.equal(saved.record.checks.numbers, true);
    assert.equal(saved.record.checks['one-page'], true);
    assert.equal(saved.record.checks.closing, true);
    assert.equal(saved.record.closingSentence, 'Thank you for your consideration.');
    // v1 reads the playbook backup when there is one.
    await fs.writeFile(path.join(root, 'private', 'cover-letter', 'playbook-v1.md'), '# Old playbook v1');
    const config = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ ...config, coverLetter: { rulesVersion: 'v1' } }));
    await hub.request('POST', '/letters/generate', { date: '2026-11-08', job: id, company: 'Example Corp' });
    const v1Prompt = hub.prompts.filter(item => item.kind === 'draft').at(-1).prompt;
    assert.match(v1Prompt, /# Old playbook v1/);
    assert.doesNotMatch(v1Prompt, /AVAILABILITY:/);
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('in the hub, a letter saved earlier tonight is passed to the next letter\'s prompt, and the next one gets another thank-you sentence', async () => {
  const second = job({ url: 'https://example.com/jobs/second', title: 'Data Science Intern' });
  const root = await project({ matches: [job(), second] });
  const hub = await hubFor(root);
  try {
    const first = JSON.parse((await hub.request('POST', '/letters/generate', { date: '2026-11-08', job: jobIdOf(job()), company: 'Example Corp' })).text);
    const saved = await hub.request('POST', '/letters/save', { date: '2026-11-08', job: jobIdOf(job()), track: 'data', company: first.company, paragraph: first.paragraphs, engine: 'codex', model: 'gpt-5.6-sol', editorNotes: JSON.stringify(first.editorNotes), rules: JSON.stringify(first.rules) });
    assert.equal(saved.status, 200);
    const next = JSON.parse((await hub.request('POST', '/letters/generate', { date: '2026-11-08', job: jobIdOf(second), company: 'Example Corp' })).text);
    const prompt = hub.prompts.filter(item => item.kind === 'draft').at(-1).prompt;
    assert.match(prompt, /Letters written earlier tonight open with these sentences: "Please consider my application for the Data Analyst Intern role with Example Corp, a remote position\."/);
    assert.match(prompt, /close with these paragraphs; .*"Thank you for your consideration\. I would welcome the chance to support the analytics team from June 2027\."/);
    assert.equal(first.rules.closingSentence, 'Thank you for your consideration.');
    assert.equal(next.rules.closingSentence, 'Thank you for reading my application.');
    assert.match(next.paragraphs.at(-1), /^Thank you for reading my application\. /);
    assert.match(next.notesNeedReview.join('\n'), /check failed \(opening-variety\)/, 'the fake draft repeats the first letter\'s opening');
    // Regenerating the first posting does not list its own letter.
    await hub.request('POST', '/letters/generate', { date: '2026-11-08', job: jobIdOf(job()), company: 'Example Corp' });
    assert.doesNotMatch(hub.prompts.filter(item => item.kind === 'draft').at(-1).prompt, /Letters written earlier tonight/);
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('v2 editor: unquoted or case-only issues are set aside, unverified details are rewritten, and a rewrite that adds a number keeps the draft paragraph', async () => {
  const root = await project();
  const revised = [P1, MIDDLE[0].replace('500,000', '800,000'), MIDDLE[1], MIDDLE[2], CLOSE];
  const hub = await hubFor(root, { editor: () => ({ issues: ['unverified detail: "Clean inputs make every later number easier to defend"', 'salutation says Example Corp, body says example corp', 'unverified detail: "regulated work"'], revised_paragraphs: revised, candidParagraphIndex: -1 }) });
  try {
    const draft = JSON.parse((await hub.request('POST', '/letters/generate', { date: '2026-11-08', job: jobIdOf(job()), company: 'Example Corp' })).text);
    assert.ok(draft.notesNeedReview.includes('unverified detail: "Clean inputs make every later number easier to defend"'));
    assert.ok(!draft.editorNotes.some(note => /body says example corp|regulated work/.test(note)), 'set aside');
    assert.ok(draft.notesInfo.some(note => /set aside 2 issues/.test(note)));
    assert.equal(draft.paragraphs[1], MIDDLE[0], 'the rewrite that added 800,000 kept the draft paragraph');
    assert.ok(draft.notesNeedReview.some(note => /^check failed \(editor-rewrite\): the editor's rewrite of paragraph 2 added numbers not in the sources \(800,000\)/.test(note)));
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('track rule: a customer support or product role uses the DA resume; reasons citing another resume offer "Regenerate With DA Resume"', async () => {
  assert.deepEqual(letterTrackFor({ title: 'Customer Support AI Intern', recommendedTrack: 'agent' }, [{ id: 'data' }, { id: 'agent' }]), { id: 'data', ruled: true });
  assert.deepEqual(letterTrackFor({ title: 'IT Project & Product Manager', recommendedTrack: 'data' }, [{ id: 'data' }]), { id: 'data', ruled: false });
  assert.deepEqual(letterTrackFor({ title: 'Machine Learning Engineer Intern', recommendedTrack: 'agent' }, [{ id: 'data' }, { id: 'agent' }]), { id: 'agent', ruled: false });
  assert.deepEqual(letterTrackFor({ title: 'Consulting Analyst', recommendedTrack: 'agent' }, [{ id: 'agent' }]), { id: 'agent', ruled: false }, 'no DA track, no rule');
  const support = job({ title: 'Customer Support AI Intern', recommendedTrack: 'agent', reasons: ['Power BI dashboards at Northwind Logistics'] });
  const engineer = job({ url: 'https://example.com/jobs/2', title: 'AI Engineer Intern', recommendedTrack: 'agent', reasons: ['Power BI dashboards at Northwind Logistics'] });
  const root = await project({ matches: [support, engineer] });
  const hub = await hubFor(root);
  try {
    const ruled = JSON.parse((await hub.request('POST', '/letters/generate', { date: '2026-11-08', job: jobIdOf(support), company: 'Example Corp' })).text);
    assert.equal(ruled.track.id, 'data');
    assert.ok(ruled.notesInfo.some(note => /^Track: used the Data resume/.test(note)));
    const cited = JSON.parse((await hub.request('POST', '/letters/generate', { date: '2026-11-08', job: jobIdOf(engineer), company: 'Example Corp' })).text);
    assert.equal(cited.track.id, 'agent');
    assert.ok(cited.notesNeedReview.some(note => note.includes(SCORING_EVIDENCE_NOTE)));
    const saved = JSON.parse((await hub.request('POST', '/letters/save', { date: '2026-11-08', job: jobIdOf(engineer), track: 'agent', company: 'Example Corp', paragraph: cited.paragraphs, engine: 'codex', model: 'gpt-5.6-sol', editorNotes: JSON.stringify(cited.editorNotes), rules: JSON.stringify(cited.rules) })).text);
    const page = (await hub.request('GET', `/letters/2026-11-08/${saved.slug}`)).text;
    assert.match(page, /<button class="btn secondary" id="da-button" type="button" title="[^"]+">Regenerate With DA Resume<\/button>/);
    assert.match(page, /data-da-track="data"/);
    assert.match(page, /daButton\.addEventListener\('click', function \(\) \{ document\.getElementById\('letter-track'\)\.value = panel\.dataset\.daTrack;/);
    // Mark Details Checked clears the card badge.
    assert.match((await hub.request('GET', '/reports/2026-11-08')).text, /data-badge="letter-check"/);
    assert.equal((await hub.request('POST', '/letters/clear-review', { date: '2026-11-08', slug: saved.slug })).status, 200);
    assert.doesNotMatch((await hub.request('GET', '/reports/2026-11-08')).text.split('<script')[0], /data-badge="letter-check"/);
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('v2 saving: a body over 560 words is condensed before the first render with a word target', async () => {
  const root = await project();
  const long = LETTER.map(paragraph => `${paragraph} ${'More plain words here. '.repeat(25)}`);
  const hub = await hubFor(root, { draft: () => ({ paragraphs: long, shortName: 'Example Corp', candidParagraphIndex: -1, candidGaps: [], connectionNote: '', followUpMessage: '' }) });
  try {
    const id = jobIdOf(job());
    const draft = JSON.parse((await hub.request('POST', '/letters/generate', { date: '2026-11-08', job: id, company: 'Example Corp' })).text);
    assert.ok(draft.wordCount > 560);
    const saved = JSON.parse((await hub.request('POST', '/letters/save', { date: '2026-11-08', job: id, track: 'data', company: 'Example Corp', paragraph: draft.paragraphs, editorNotes: JSON.stringify(draft.editorNotes), rules: JSON.stringify(draft.rules) })).text);
    const condense = hub.prompts.find(item => item.kind === 'condense');
    assert.match(condense.prompt, /is longer than the 560 words a one-page letter allows\. Shorten it to at most 480 words/);
    assert.equal(saved.pdf.condensed, true);
    assert.ok(saved.record.wordCount < 560);
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Settings saves the letter rules, the card shows Term Conflict under v2, and Status shows the repetition rates', async () => {
  const coop = job({ url: 'https://example.com/jobs/3', title: 'Data Co-op, Spring 2027' });
  const root = await project({ matches: [job(), coop] });
  const hub = await hubFor(root);
  try {
    const settings = (await hub.request('GET', '/settings?tab=letters')).text;
    assert.match(settings, /<article class="card" id="letter-rules"><h2>Letter Rules<\/h2>/);
    const saved = await hub.request('POST', '/settings/letter-rules', { rulesVersion: 'v2', openingStyle: 'ban-writing-to', fullTimeFrom: 'june 2027', springTerm: '', mastersInternship: 'on' });
    assert.equal(saved.status, 303);
    const config = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
    assert.deepEqual(config.coverLetter, { rulesVersion: 'v2', openingStyle: 'ban-writing-to', availability: { fullTimeFrom: 'June 2027', springTerm: false, mentionMasters: { internship: true, newGrad: false } } });
    assert.match(decodeURIComponent((await hub.request('POST', '/settings/letter-rules', { rulesVersion: 'v3', openingStyle: 'ban-writing-to', fullTimeFrom: 'June 2027' })).headers.location), /Rules version must be v1 or v2/);
    assert.match(decodeURIComponent((await hub.request('POST', '/settings/letter-rules', { rulesVersion: 'v2', openingStyle: 'ban-writing-to', fullTimeFrom: 'soon' })).headers.location), /month and year/);
    const report = (await hub.request('GET', '/reports/2026-11-08')).text;
    assert.match(report, /<span class="badge badge-warn" data-badge="term-conflict" title="The posting(?:'|&#39;)s term \(Spring 2027, from the title\) starts before you are available[^"]*">Term Conflict<\/span>/);
    assert.match(report, /data-oneclick="1"[^>]*data-job="[0-9a-f]{16}">Generate Cover Letter<\/button>/, 'a manual letter stays possible');
    await hub.ctx.letterStore.saveLetter({ date: '2026-11-08', company: 'Example Corp', markdown: '#', meta: { jobId: 'a'.repeat(16), createdAt: NOW, paragraphs: LETTER } });
    const status = (await hub.request('GET', '/status')).text;
    assert.match(status, /<article class="card" id="letter-variety"><h2>Letter Variety<\/h2>/);
    assert.match(status, /<dd id="opening-repetition">100% · "Please consider my application for the"<\/dd>/);
    assert.match(status, /<dd id="closing-repetition">100% · "Thank you for your consideration\."<\/dd>/);
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the A/B script writes new letters next to the old ones with a summary table, saving nothing to the letter store', async () => {
  const root = await project({ matches: [job(), job({ url: 'https://example.com/jobs/4', title: 'Customer Support AI Intern', recommendedTrack: 'agent' })] });
  const hub = await hubFor(root);
  const out = path.join(root, 'private', 'review', 'ab-2026-11-08');
  try {
    const config = await hub.ctx.loadConfig();
    const jobs = [
      { date: '2026-11-08', jobId: jobIdOf(job()), label: 'Example Corp · Data Analyst Intern', old: { paragraphs: ['I am writing to apply for the Data Analyst Intern position at Example Corp in Remote. Spring 2027 works.', ...MIDDLE, 'Thank you for considering my application. Bye.'], editorNotes: ['unverified detail: x', 'Paragraph 1 lacks GPA'], track: 'data', pages: 2 } },
      { date: '2026-11-08', jobId: jobIdOf(job({ url: 'https://example.com/jobs/4' })), label: 'Example Corp · Customer Support AI Intern', old: { paragraphs: LETTER, editorNotes: [], track: 'agent', pages: 1 } },
    ];
    const before = (await hub.ctx.letterStore.listLetters()).length;
    const result = await runLettersAb({ ctx: hub.ctx, config, jobs, outDir: out });
    assert.equal((await hub.ctx.letterStore.listLetters()).length, before, 'nothing saved to the store');
    await assert.rejects(fs.stat(path.join(root, 'private', 'outreach', 'state.json')), 'the Reach Out state is untouched');
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[1].new.track, 'data', 'the track rule applies');
    assert.equal(result.rows[0].old.needsReview, 1);
    assert.equal(result.rows[0].old.checks.availability, false);
    assert.equal(result.rows[0].old.checks['one-page'], false);
    assert.equal(result.rows[0].new.checks.availability, true);
    for (const file of ['index.html', 'summary.md', 'summary.json', 'Example-Corp-Data-Analyst-Intern/old.md', 'Example-Corp-Data-Analyst-Intern/new.md', 'Example-Corp-Data-Analyst-Intern/new.pdf']) await fs.stat(path.join(out, file));
    const summary = await fs.readFile(path.join(out, 'summary.md'), 'utf8');
    assert.match(summary, /\| Posting \| Version \| Track \| Needs-Review \| Unverified \| Words \| Pages \| Opening \|/);
    assert.match(summary, /\| Example Corp · Data Analyst Intern \| old \(v1\) \| data \| 1 \| 1 \| \d+ \| 2 \| (?:pass|FAIL) \|/);
    assert.match(summary, /Totals: needs-review 1 \(old\) → \d+ \(new\)/);
    const drafts = hub.prompts.filter(item => item.kind === 'draft');
    assert.ok(drafts.length === 2);
    // The A/B letters are not saved, so the second is told the first one's opening and closing directly.
    assert.doesNotMatch(drafts[0].prompt, /Letters written earlier tonight/);
    assert.match(drafts[1].prompt, /Letters written earlier tonight open with these sentences: "Please consider my application for the Data Analyst Intern role with Example Corp, a remote position\."/);
    assert.match(drafts[1].prompt, /Letters written earlier tonight close with these paragraphs; write a forward-looking sentence with a different construction and different wording from each: "Thank you for your consideration\. I would welcome/);
    assert.match(drafts[1].prompt, /exactly this sentence, word for word: "Thank you for reading my application\."/, 'the second letter gets the next thank-you sentence');
    assert.match(result.rows[1].new.paragraphs.at(-1), /^Thank you for reading my application\. /, 'the assigned sentence replaced the draft\'s thank-you');
    assert.equal(result.rows[1].new.checks['opening-variety'], false, 'the fake drafts share one opening, which the check catches');
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
