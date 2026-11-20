// Making a clone someone else's hub (2026-11-19): owner-specific defaults became config keys whose absence keeps
// the old output word for word (tests/fixtures/defaults/golden.json was written by the code before the change),
// npm run setup writes a new config and never overwrites a file, npm run doctor reports one line per check,
// and an empty hub shows the three first-run steps.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { GENERIC_PROMPT_EXAMPLES, PROMPT_EXAMPLES_FILE, loadPromptExamples, normalizePromptExamples } from '../src/cover-letter/prompt-examples.mjs';
import { goldenOutputs } from './helpers/defaults-golden.mjs';
import { buildCoverLetterPrompt, graduationTerms } from '../src/cover-letter/compose.mjs';
import { buildCoverLetterPromptV2, v2Context } from '../src/cover-letter/rules-v2.mjs';
import { normalizeAvailability } from '../src/cover-letter/availability.mjs';
import { createLetterStore } from '../src/cover-letter/store.mjs';
import { detectEarlyCareer } from '../src/prefilter.mjs';
import { businessRoleTrack, letterTrackFor } from '../src/hub/letters.mjs';
import { localProfileFor } from '../src/match.mjs';
import { homeStateOf, letterProfile } from '../src/candidate-profile.mjs';
import { sampleTrackLabels, TRACK_LABELS } from '../src/hub/letter-views.mjs';
import { onboardingSteps, reportsPage } from '../src/hub/views.mjs';
import { EXISTS_MESSAGE, buildConfig, parseRoleAnswer, runSetup, trackIdOf } from '../src/setup.mjs';
import { doctorText, runDoctor } from '../src/doctor.mjs';
import { loadConfig } from '../src/config.mjs';
import { prepareReportProject, startReportHub } from './helpers/report-hub.mjs';

const GOLDEN = new URL('./fixtures/defaults/golden-generic.json', import.meta.url);
// sha256 of each output as the code wrote it before the example numbers became generic (the owner's own
// numbers, kept only as hashes); private/cover-letter/prompt-examples.json must reproduce them.
const ORIGINAL_HASHES = new URL('./fixtures/defaults/golden-original.sha256.json', import.meta.url);
const ROOT = new URL('..', import.meta.url).pathname;
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('with none of the new keys and no prompt-examples file, every owner-specific output matches the generic baseline', async () => {
  const want = JSON.parse(await fs.readFile(GOLDEN, 'utf8'));
  const got = JSON.parse(JSON.stringify(goldenOutputs()));
  assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort());
  for (const key of Object.keys(want)) assert.deepEqual(got[key], want[key], key);
  // The same with an empty preferences object passed through graduationTerms, as the hub does.
  assert.deepEqual(JSON.parse(JSON.stringify(goldenOutputs({ preferences: {} }))), want);
  // graduationTerms still serializes as before (the profile is not enumerable).
  assert.deepEqual(graduationTerms('2026-12', { homeState: 'NY' }), { month: 'December 2026', nextFall: 'Fall 2027', year: 2026 });
  const hashes = JSON.parse(await fs.readFile(ORIGINAL_HASHES, 'utf8'));
  assert.deepEqual(Object.keys(hashes).sort(), Object.keys(want).sort());
});

test('prompt examples change only the example spots: any examples give the generic text with those values in place', async () => {
  const generic = JSON.stringify(goldenOutputs());
  const custom = { gpa: '9.99', proseNumbers: ['A1 units', 'B2 units', 'C3 units', 'D4 units'], sameValue: ['E5+', 'E5,000'], differentValue: ['F6', 'F6.6'] };
  let expected = generic;
  const pairs = [
    ...GENERIC_PROMPT_EXAMPLES.proseNumbers.map((item, index) => [item, custom.proseNumbers[index]]),
    [`(${GENERIC_PROMPT_EXAMPLES.sameValue[0]} and ${GENERIC_PROMPT_EXAMPLES.sameValue[1]} match; ${GENERIC_PROMPT_EXAMPLES.differentValue[0]} and ${GENERIC_PROMPT_EXAMPLES.differentValue[1]} do not)`, '(E5+ and E5,000 match; F6 and F6.6 do not)'],
    [`with a ${GENERIC_PROMPT_EXAMPLES.gpa} GPA`, 'with a 9.99 GPA'], [`${GENERIC_PROMPT_EXAMPLES.gpa}/4.00`, '9.99/4.00'], [`${GENERIC_PROMPT_EXAMPLES.gpa} out of 4.0`, '9.99 out of 4.0'],
  ];
  for (const [from, to] of pairs) {
    assert.ok(expected.includes(from), from);
    expected = expected.split(from).join(to);
  }
  assert.equal(JSON.stringify(goldenOutputs({ examples: custom })), expected);
  // The loader: a missing or broken file gives the generic examples; a partial one fills the rest.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'examples-'));
  try {
    assert.deepEqual(await loadPromptExamples(root), normalizePromptExamples());
    await fs.mkdir(path.join(root, 'private', 'cover-letter'), { recursive: true });
    await fs.writeFile(path.join(root, PROMPT_EXAMPLES_FILE), '{ not json');
    assert.deepEqual(await loadPromptExamples(root), normalizePromptExamples());
    await fs.writeFile(path.join(root, PROMPT_EXAMPLES_FILE), JSON.stringify({ gpa: '9.99', sameValue: ['one'] }));
    assert.deepEqual(await loadPromptExamples(root), { ...normalizePromptExamples(), gpa: '9.99' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("with the owner's private/cover-letter/prompt-examples.json, every output is word for word the one from before", async t => {
  const file = path.join(ROOT, PROMPT_EXAMPLES_FILE);
  if (!await fs.stat(file).then(() => true, () => false)) {
    t.skip('no private/cover-letter/prompt-examples.json in this checkout (a fresh clone or CI)');
    return;
  }
  const hashes = JSON.parse(await fs.readFile(ORIGINAL_HASHES, 'utf8'));
  const got = JSON.parse(JSON.stringify(goldenOutputs({ examples: await loadPromptExamples(ROOT) })));
  const differ = Object.keys(hashes).filter(key => sha(got[key]) !== hashes[key]);
  assert.deepEqual(differ, []);
});

const JOB = state => ({ title: 'Analyst', company: 'Example Corp', roleType: 'internship', location: state, description: 'Reporting.' });
const PROMPT = (job, preferences) => buildCoverLetterPrompt({ playbook: 'P', samples: [], track: { id: 't', label: 'T' }, resumeText: 'R', job, graduation: graduationTerms('2027-05', preferences) });

test('preferences.homeState: the in-state sentence follows the configured state; "" turns it off', () => {
  assert.deepEqual(homeStateOf({}).code, 'IL', 'default Illinois');
  assert.equal(homeStateOf({ homeState: 'new york' }).code, 'NY');
  assert.equal(homeStateOf({ homeState: '' }), null);
  assert.match(PROMPT(JOB('Buffalo, NY'), { homeState: 'NY' }), /because the role is in New York, add that you are in state/);
  assert.doesNotMatch(PROMPT(JOB('Chicago, IL'), { homeState: 'NY' }), /in state/);
  assert.doesNotMatch(PROMPT(JOB('Chicago, IL'), { homeState: '' }), /in state/);
  assert.match(PROMPT(JOB('Chicago, IL'), {}), /because the role is in Illinois/);
  const graduation = graduationTerms('2027-05', { homeState: 'TX' });
  const availability = normalizeAvailability({}, '2027-05');
  const v2 = buildCoverLetterPromptV2({ playbook: 'P', samples: [], track: { id: 't', label: 'T' }, resumeText: 'R', job: JOB('Austin, TX'), context: v2Context({ job: JOB('Austin, TX'), graduation, availability }) });
  assert.match(v2, /because the role is in Texas, add that you are in state/);
});

test('preferences.degree and plannedProgram set the internship timeline; "" drops the further-study plan', () => {
  assert.deepEqual(letterProfile({}), { home: homeStateOf({}), degree: "bachelor's degree", plannedProgram: "a master's program" });
  assert.match(PROMPT(JOB('Remote'), { degree: 'associate degree', plannedProgram: 'a bachelor\'s program' }), /completing your associate degree in May 2027 with plans to begin a bachelor's program in Fall 2027/);
  assert.match(PROMPT(JOB('Remote'), { plannedProgram: '' }), /say you are completing your bachelor's degree in May 2027\./);
  const graduation = graduationTerms('2027-05', { plannedProgram: '' });
  const availability = normalizeAvailability({ mentionMasters: { internship: true, newGrad: true } }, '2027-05');
  const context = v2Context({ job: JOB('Remote'), graduation, availability });
  assert.equal(context.mastersAllowed, false, 'no planned program, nothing to mention');
  assert.doesNotMatch(buildCoverLetterPromptV2({ playbook: 'P {{AVAILABILITY}}', samples: [], track: { id: 't', label: 'T' }, resumeText: 'R', job: JOB('Remote'), context }), /plans to begin|plan to begin/);
});

test('preferences.cohortYear: the early-career JD signal looks for that class', () => {
  assert.equal(detectEarlyCareer({ title: 'Analyst', description: 'Class of 2027' }).level, 'new_grad');
  assert.equal(detectEarlyCareer({ title: 'Analyst', description: 'Class of 2028' }, { cohortYear: 2028 }).signal, 'analyst; JD: Class of 2028');
  assert.equal(detectEarlyCareer({ title: 'Analyst', description: 'Class of 2027' }, { cohortYear: 2028 }).level, 'entry_level');
});

test('coverLetter.businessRoleTrack: the track business roles take, its button label, or no rule at all', () => {
  assert.deepEqual(businessRoleTrack({}), { id: 'data', label: 'DA' });
  assert.deepEqual(businessRoleTrack({ coverLetter: { businessRoleTrack: null } }), { id: null, label: null });
  assert.deepEqual(businessRoleTrack({ coverLetter: { businessRoleTrack: 'ops' }, resumes: { tracks: [{ id: 'ops', label: 'Operations' }] } }), { id: 'ops', label: 'Operations' });
  const tracks = [{ id: 'ops' }, { id: 'ml' }];
  assert.deepEqual(letterTrackFor({ title: 'Business Analyst', recommendedTrack: 'ml' }, tracks, 'ops'), { id: 'ops', ruled: true });
  assert.deepEqual(letterTrackFor({ title: 'Business Analyst', recommendedTrack: 'ml' }, tracks, null), { id: 'ml', ruled: false });
});

test('coverLetter.sampleTracks and resumes.tracks[].keywords replace the built-in track names and keyword lists', async () => {
  assert.equal(sampleTrackLabels({}), TRACK_LABELS);
  assert.deepEqual(sampleTrackLabels({ coverLetter: { sampleTracks: ['ops', 'ML'] }, resumes: { tracks: [{ id: 'ops', label: 'Operations' }] } }), { ops: 'Operations', ml: 'ml' });
  assert.deepEqual(localProfileFor('finance', { title: ['Financial Analyst'], skills: ['Excel'] }), { title: ['financial analyst'], skills: ['excel'] });
  assert.equal(localProfileFor('data', null), localProfileFor('data'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'samples-'));
  try {
    const store = createLetterStore({ root });
    const saved = await store.saveSample({ filename: 'one.txt', data: Buffer.from('Dear team, '.repeat(30)) }, { track: 'ops', allowed: ['ops'] });
    assert.equal(saved.track, 'ops');
    const untagged = await store.saveSample({ filename: 'two.txt', data: Buffer.from('Dear team, '.repeat(30)) }, { track: 'ops' });
    assert.equal(untagged.track, null, 'the default list is data, llm and agent');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  // The keywords pass through the config loader only when present.
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'keywords-'));
  try {
    await fs.writeFile(path.join(project, 'config.json'), JSON.stringify({ resumes: { tracks: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', keywords: { title: ['x'] } }] } }));
    const config = await loadConfig(path.join(project, 'config.json'));
    assert.equal('keywords' in config.resumes.tracks[0], false);
    assert.deepEqual(config.resumes.tracks[1].keywords, { title: ['x'] });
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------------ setup

function answers(lines) {
  const input = new PassThrough();
  input.end(`${lines.join('\n')}\n`);
  return input;
}

function sink() {
  const output = new PassThrough();
  let text = '';
  output.on('data', chunk => { text += chunk; });
  return { output, text: () => text };
}

async function listing(directory) {
  const out = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true, recursive: true })) if (entry.isFile()) out.push(path.relative(directory, path.join(entry.parentPath || entry.path, entry.name)));
  return out.sort();
}

const CONNECTIONS = async () => ({ claude: { installed: true, connected: false, hint: 'claude auth login --claudeai' }, codex: { installed: true, connected: true } });
const FULL = ['Jane Doe', 'Example State University', '2027-05', 'ny', '', '1, 4, sports analytics', '2', '2', 'Data Analyst', '', 'Product', '~/nowhere/resume.pdf', '07:30'];

test('npm run setup: a full run writes config.json and the private files; the config reflects the answers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-'));
  try {
    const { output, text } = sink();
    const result = await runSetup({ root, input: answers(FULL), output, describeConnections: CONNECTIONS, defaultTimeZone: 'America/New_York' });
    assert.equal(result.stopped, false);
    assert.deepEqual(result.written.sort(), ['config.json', 'private/cover-letter/playbook.md', 'private/cover-letter/profile.json']);
    const config = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
    assert.equal(config.timeZone, 'America/New_York');
    assert.equal(config.preferences.homeState, 'NY');
    assert.equal(config.preferences.graduationDate, '2027-05');
    assert.equal(config.preferences.cohortYear, 2027);
    assert.deepEqual(config.preferences.roleTypes, ['new_grad', 'entry_level']);
    assert.deepEqual(config.preferences.targetRoleFamilies, ['data', 'product management', 'sports analytics']);
    assert.ok(config.preferences.titleFamilies.includes('sports analytics') && config.preferences.titleFamilies.includes('product manager'));
    assert.deepEqual(config.resumes.tracks, [{ id: 'data-analyst', label: 'Data Analyst', enabled: true }, { id: 'product', label: 'Product', pdf: '~/nowhere/resume.pdf', enabled: true }]);
    assert.deepEqual(config.coverLetter.sampleTracks, ['data-analyst', 'product']);
    assert.equal(config.coverLetter.businessRoleTrack, null);
    assert.equal(config.coverLetter.availability.fullTimeFrom, 'June 2027');
    assert.equal(config.semanticMatching.engine, 'codex', 'Claude is signed out and Codex is signed in');
    assert.deepEqual(config.outreach.profile.schools, ['Example State University']);
    assert.deepEqual(config.plans.claude, {}, 'no scheduled plan change from the example');
    assert.ok(config.sources.searchDiscovery.queries.every(query => query.endsWith('2027')));
    assert.match(text(), /✗ Claude Code: not signed in\. Run: claude auth login --claudeai/);
    assert.match(text(), /✓ Codex: signed in/);
    assert.match(text(), /zsh scripts\/install-launchd\.sh 7 30/);
    assert.match(text(), /That file was not found/);
    const loaded = await loadConfig(path.join(root, 'config.json'), { notify: () => {} });
    assert.equal(loaded.resumes.tracks.length, 2, 'the written config loads');
    const playbook = await fs.readFile(path.join(root, 'private', 'cover-letter', 'playbook.md'), 'utf8');
    assert.equal(playbook, await fs.readFile(path.join(ROOT, 'cover-letter', 'playbook.example.md'), 'utf8'));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'private', 'cover-letter', 'profile.json'), 'utf8')).name, 'Jane Doe');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('npm run setup never overwrites: an existing config.json stops it; --force-new needs a new path and keeps existing private files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-keep-'));
  try {
    await fs.writeFile(path.join(root, 'config.json'), '{"mine":true}\n');
    await fs.mkdir(path.join(root, 'private', 'cover-letter'), { recursive: true });
    await fs.writeFile(path.join(root, 'private', 'cover-letter', 'playbook.md'), 'MY PLAYBOOK');
    const before = await listing(root);
    const first = sink();
    const stopped = await runSetup({ root, input: answers(FULL), output: first.output, describeConnections: CONNECTIONS });
    assert.equal(first.text(), `${EXISTS_MESSAGE}\n`);
    assert.equal(stopped.stopped, true);
    const second = sink();
    await runSetup({ root, argv: ['--force-new'], input: answers(FULL), output: second.output, describeConnections: CONNECTIONS });
    assert.equal(second.text(), 'config.json already exists, nothing changed\n', '--force-new still refuses an existing target');
    assert.deepEqual(await listing(root), before);
    assert.equal(await fs.readFile(path.join(root, 'config.json'), 'utf8'), '{"mine":true}\n');

    const third = sink();
    const result = await runSetup({ root, argv: ['--force-new', '--config', 'other.json'], input: answers(FULL), output: third.output, describeConnections: CONNECTIONS });
    assert.deepEqual(result.written.sort(), ['other.json', 'private/cover-letter/profile.json']);
    assert.deepEqual(result.skipped, ['private/cover-letter/playbook.md']);
    assert.equal(await fs.readFile(path.join(root, 'private', 'cover-letter', 'playbook.md'), 'utf8'), 'MY PLAYBOOK');
    assert.equal(await fs.readFile(path.join(root, 'config.json'), 'utf8'), '{"mine":true}\n');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('npm run setup: input that ends early writes nothing; bad answers are asked again', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-short-'));
  try {
    const { output, text } = sink();
    const result = await runSetup({ root, input: answers(['Jane Doe', '', '2027/05', '2027-13']), output, describeConnections: CONNECTIONS });
    assert.equal(result.stopped, true);
    assert.deepEqual(await listing(root), []);
    assert.equal(text().match(/Write it as YYYY-MM\./g).length, 2);
    assert.match(text(), /nothing was written/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('setup helpers: track ids, the role answer, and the config built from the example', async () => {
  assert.equal(trackIdOf('AI Agent'), 'ai-agent');
  assert.equal(trackIdOf('Data', ['data']), 'data-2');
  assert.equal(trackIdOf('2nd'), 't2nd');
  assert.deepEqual(parseRoleAnswer('2, 2, Quant Research, 9'), { families: ['AI/ML'], keywords: ['Quant Research', '9'] });
  const example = JSON.parse(await fs.readFile(path.join(ROOT, 'config.example.json'), 'utf8'));
  const config = buildConfig(example, { name: 'A', school: '', graduationDate: '2026-12', homeState: '', timeZone: 'UTC', families: [], keywords: [], roleTypes: ['internship'], tracks: [{ id: 'a', label: 'A', pdf: '' }], engine: 'claude' });
  assert.deepEqual(config.preferences.targetRoleFamilies, ['data', 'AI/ML', 'software', 'product management', 'consulting/strategy'], 'no answer keeps every family');
  assert.equal(config.coverLetter.availability.fullTimeFrom, 'January 2027');
  assert.ok(config.preferences.prefilterExcludeOverrides.includes('2026') && !config.preferences.prefilterExcludeOverrides.includes('2027'));
  assert.equal(config.resumes.autoRefresh, false);
  assert.equal(config.outreach.profile, undefined);
});

// ----------------------------------------------------------------------------------------------- doctor

test('npm run doctor: one line per check with a fix for each failure; nothing is written', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doctor-'));
  try {
    const run = async () => ({ ok: false, missing: true, output: '' });
    const none = await runDoctor({ root, nodeVersion: '18.19.0', run, homedir: root, describeConnections: async () => ({ claude: { installed: false, hint: 'npm i -g @anthropic-ai/claude-code@latest' }, codex: { installed: true, connected: false, hint: 'codex login', reason: 'not signed in' } }) });
    const text = doctorText(none);
    assert.equal(none.ok, false);
    assert.match(text, /^✗ Node\.js: version 18\.19\.0\. Fix: install Node\.js 20 or later/m);
    assert.match(text, /^✗ config\.json: not found\. Fix: run npm run setup$/m);
    assert.match(text, /^✗ Claude Code CLI: not installed\. Fix: npm i -g @anthropic-ai\/claude-code@latest$/m);
    assert.match(text, /^✗ Codex CLI: not signed in\. Fix: codex login$/m);
    assert.match(text, /^✗ pdftotext: not found\. Fix: brew install poppler$/m);
    assert.match(text, /^✗ Nightly schedule: LaunchAgent not installed\. Fix: zsh scripts\/install-launchd\.sh 18 0$/m);
    assert.deepEqual(await listing(root), [], 'the doctor writes nothing');

    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ timeZone: 'America/New_York', preferences: { graduationDate: '2027-05', homeState: 'NY' }, resumes: { tracks: [{ id: 'a', label: 'Analyst' }] } }));
    await fs.mkdir(path.join(root, 'resumes'), { recursive: true });
    await fs.writeFile(path.join(root, 'resumes', 'a.md'), 'x'.repeat(400));
    await fs.mkdir(path.join(root, 'Library', 'LaunchAgents'), { recursive: true });
    await fs.writeFile(path.join(root, 'Library', 'LaunchAgents', 'com.dailyjobmatchalert.daily.plist'), '<dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>5</integer></dict>');
    const good = await runDoctor({ root, nodeVersion: '22.1.0', run: async () => ({ ok: true, output: 'pdftotext version 24.02.0\n' }), homedir: root, describeConnections: async () => ({ claude: { installed: true, connected: true, detail: 'Claude · Pro · claude.ai' }, codex: { installed: false, hint: 'npm i -g @openai/codex' } }) });
    assert.equal(good.ok, true, 'Codex is optional when Claude is signed in');
    const lines = doctorText(good);
    assert.match(lines, /^✓ config\.json: 1 resume track\(s\), time zone America\/New_York$/m);
    assert.match(lines, /^✓ Resume: Analyst: 400 characters of text$/m);
    assert.match(lines, /^✓ Nightly schedule: installed, 07:05$/m);
    assert.match(lines, /^✗ Cover letter playbook: .*Fix: copy cover-letter\/playbook\.example\.md there/m);

    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ timeZone: 'Mars/Base', preferences: { graduationDate: '2027-5', homeState: 'ZZ' }, resumes: { tracks: [{ id: 'a' }] } }));
    const bad = doctorText(await runDoctor({ root, run, homedir: root }));
    assert.match(bad, /✗ config\.json: unknown timeZone "Mars\/Base"; preferences\.graduationDate must be YYYY-MM; preferences\.homeState "ZZ" is not a US state/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------- first-run steps

test('an empty Reports page shows Upload Resumes, Choose Roles and Run Now; any report hides them', async () => {
  const html = onboardingSteps({ resumesReady: true });
  assert.match(html, /<h2>Get Started<\/h2>/);
  assert.match(html, /data-step="resumes" data-done="1"><span class="onboard-num" aria-hidden="true">✓<\/span>[\s\S]*?<a class="btn secondary" href="\/resumes">Upload Resumes<\/a>/);
  assert.match(html, /data-step="roles"><span class="onboard-num" aria-hidden="true">2<\/span>[\s\S]*?href="\/settings\?tab=pipeline#role-scope">Choose Roles<\/a>/);
  assert.match(html, /data-step="run">[\s\S]*?href="\/status#run-card">Run Now<\/a>/);
  assert.doesNotMatch(reportsPage({ dates: [{ date: '2026-10-17', matchCount: 1 }], selected: null, reportBody: null, timeZone: 'UTC', onboarding: {} }), /onboarding/);

  const root = await prepareReportProject();
  for (const name of await fs.readdir(path.join(root, 'state'))) if (name.startsWith('report-payload-')) await fs.rm(path.join(root, 'state', name));
  const empty = await startReportHub(root);
  try {
    const page = (await empty.request('/reports')).text;
    assert.match(page, /id="onboarding"/);
    assert.match(page, /data-step="roles"><span class="onboard-num" aria-hidden="true">2<\/span>/, 'the fixture config chose no roles');
    assert.match((await empty.request('/settings?tab=pipeline')).text, /<fieldset class="group" id="role-scope">/);
  } finally {
    await empty.close();
    await fs.rm(root, { recursive: true, force: true });
  }
  const full = await prepareReportProject();
  const hub = await startReportHub(full);
  try {
    assert.doesNotMatch((await hub.request('/reports')).text, /onboarding|Get Started/);
  } finally {
    await hub.close();
    await fs.rm(full, { recursive: true, force: true });
  }
});
