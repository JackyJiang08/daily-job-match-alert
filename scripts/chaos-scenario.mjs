// One chaos scenario: build an isolated config under <workRoot>/<scenario>, run src/index.mjs
// against it, and assert that the Desktop-equivalent output folder still holds a usable report.
//
//   node scripts/chaos-scenario.mjs <baseline|offline|llm-down|bad-input|xlsx-recovery|ats-500|review-cap|fable-weekly-limit|account-limit> <workRoot>
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ExcelJS from 'exceljs';

const execFileAsync = promisify(execFile);
const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDirectory = path.join(projectDirectory, 'tests', 'fixtures');
const [scenarioName, workRootArgument] = process.argv.slice(2);

// Fixed clock: 07:00 America/Chicago, so the application date equals the run date and the
// fixture emails dated 2026-08-27 morning fall inside the 24-hour lookback.
const NOW = '2026-08-27T12:00:00Z';
// Port 9 (discard) has no listener on developer machines or CI runners, so every request is
// refused immediately without changing any system network setting.
const DEAD_ORIGIN = 'http://127.0.0.1:9';
// Resume tracks used by every scenario; the xlsx grows one "<label> Score" column per enabled track.
const TRACKS = [
  { id: 'data', label: 'Data', file: 'data-resume.md' },
  { id: 'ai', label: 'AI', file: 'ai-resume.md' },
  { id: 'agent', label: 'AI Agent', file: 'agent-resume.md' },
];
const EXPECTED_HEADERS = [
  'Company', 'Title', 'Location', 'Role Type', 'Posted At',
  ...TRACKS.map(track => `${track.label} Score`),
  'Recommended Resume', 'Why It Matches', 'Gaps / Verify', 'Posting Link',
];
const LINK_COLUMN = EXPECTED_HEADERS.indexOf('Posting Link') + 1;
const WHY_COLUMN = EXPECTED_HEADERS.indexOf('Why It Matches') + 1;

if (!scenarioName || !workRootArgument) {
  console.error('Usage: node scripts/chaos-scenario.mjs <scenario> <workRoot>');
  process.exit(2);
}
const workRoot = path.resolve(workRootArgument);

function baseConfig(directory) {
  return {
    lookbackHours: 24,
    timeZone: 'America/Chicago',
    reportDateOffsetDays: 1,
    minimumMatchScore: 20,
    requireFullDescription: true,
    minimumDescriptionCharacters: 200,
    semanticMatching: { engine: 'local_only' },
    reports: { xlsx: { enabled: true, required: false } },
    outputDirectory: path.join(directory, 'output'),
    resumes: {
      autoRefresh: false,
      tracks: TRACKS.map(track => ({ id: track.id, label: track.label, profile: path.join(directory, track.file), enabled: true })),
    },
    preferences: {
      roleTypes: ['internship', 'new_grad', 'entry_level'],
      locations: ['Remote'],
      remoteOkay: true,
      maxYearsExperience: 3,
      needsSponsorship: null,
      graduationDate: '2027-05',
      excludeTitleTerms: ['senior', 'staff', 'principal', 'manager', 'director', 'lead'],
    },
    sources: {
      githubLists: { enabled: false }, hackerNewsHiring: { enabled: false }, remoteOk: { enabled: false }, 
      simplifyInternships: { enabled: false },
      simplifyNewGrad: { enabled: false },
      emailFiles: { enabled: true, directory: path.join(directory, 'intake') },
      himalaya: { enabled: false },
      careerOps: { enabled: false },
      atsBoards: { enabled: true, boards: [] },
    },
    network: { fetchDescriptions: false, concurrency: 2, timeoutMs: 2000 },
  };
}

async function prepareDirectory(name) {
  const directory = path.join(workRoot, name);
  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(path.join(directory, 'intake'), { recursive: true });
  await fs.mkdir(path.join(directory, 'output'), { recursive: true });
  for (const track of TRACKS) await fs.copyFile(path.join(fixturesDirectory, track.file), path.join(directory, track.file));
  return directory;
}

async function addFixtureEmail(directory, name, transform = text => text) {
  const source = await fs.readFile(path.join(fixturesDirectory, name), 'utf8');
  await fs.writeFile(path.join(directory, 'intake', name), transform(source));
}

function malformedEmail() {
  const nestedHtml = '<html><body><div><table><tr><td><html><body><p>nested</p></body></html></td></tr></table></div></body></html>';
  const longLine = 'A'.repeat(300_000);
  // Valid-looking base64 alphabet, but cut mid-quantum so the declared encoding cannot be honored.
  const truncatedBase64 = Buffer.from(`${nestedHtml}${longLine}https://example.com/jobs/hidden`).toString('base64').slice(0, -3);
  return [
    'From: alerts@joinhandshake.com',
    'Date: Thu, 27 Aug 2026 08:00:00 -0500',
    'Subject: Corrupted alert',
    'Content-Type: text/html',
    'Content-Transfer-Encoding: base64',
    '',
    truncatedBase64,
    '',
  ].join('\n');
}

async function writeConfig(directory, config) {
  assert.ok(config.outputDirectory.startsWith(workRoot), 'chaos config must only write inside the temporary work root');
  const configPath = path.join(directory, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

async function runPipeline(configPath, now = NOW, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  for (const key of Object.keys(env)) {
    if (/^(?:ANTHROPIC_|AWS_)/.test(key) || ['OPENAI_API_KEY', 'CLAUDE_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUD_ML_REGION'].includes(key)) delete env[key];
  }
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    ({ stdout, stderr } = await execFileAsync(process.execPath, [path.join(projectDirectory, 'src', 'index.mjs'), '--config', configPath, '--now', now], {
      cwd: projectDirectory,
      env,
      timeout: 5 * 60 * 1000,
      maxBuffer: 32 * 1024 * 1024,
    }));
  } catch (error) {
    stdout = error.stdout || '';
    stderr = error.stderr || '';
    exitCode = typeof error.code === 'number' ? error.code : 1;
  }
  const jsonStart = stdout.indexOf('{');
  assert.ok(jsonStart >= 0, `pipeline printed no JSON summary (exit ${exitCode}). stderr: ${stderr.slice(-1500)}`);
  const summary = JSON.parse(stdout.slice(jsonStart));
  return { summary, exitCode, stderr };
}

async function exists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function assertDesktopArtifacts(config, run) {
  const { summary, exitCode } = run;
  const runDirectory = path.join(config.outputDirectory, summary.meta.date);
  assert.ok(await exists(runDirectory), `missing application-date folder ${runDirectory}`);
  const htmlPath = path.join(runDirectory, `Daily Job Match Alert - ${summary.meta.date}.html`);
  const xlsxPath = path.join(runDirectory, `Daily Job Match Alert - ${summary.meta.date}.xlsx`);
  const markerPath = path.join(runDirectory, 'XLSX-FAILED.txt');
  assert.ok(await exists(htmlPath), `missing HTML report ${htmlPath}`);
  const html = await fs.readFile(htmlPath, 'utf8');
  assert.ok(html.length > 500 && /<\/html>/.test(html), 'HTML report is empty or truncated');
  const warnings = summary.meta.warnings || [];
  if (await exists(xlsxPath)) {
    assert.equal(exitCode, 0, `xlsx exists but the pipeline exited ${exitCode}`);
  } else {
    const disclosed = (await exists(markerPath)) || warnings.some(warning => /xlsx/i.test(`${warning.source} ${warning.message}`));
    assert.ok(disclosed, 'xlsx is missing without XLSX-FAILED.txt or an XLSX warning');
  }
  assert.ok(await exists(path.join(path.dirname(config.outputDirectory), 'state', 'state.json')), 'state.json was not written inside the temporary root');
  return { html, xlsxPath: (await exists(xlsxPath)) ? xlsxPath : null, warnings };
}

async function readWarningsFile(config, run) {
  const file = path.join(config.outputDirectory, run.summary.meta.date, 'warnings.txt');
  return (await exists(file)) ? fs.readFile(file, 'utf8') : null;
}

async function readMatches(xlsxPath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(xlsxPath);
  const sheet = workbook.getWorksheet('Matches');
  const headers = [];
  sheet.getRow(1).eachCell(cell => headers.push(String(cell.value)));
  return { sheet, headers };
}

function warningLines(warnings) {
  return warnings.map(warning => `[${warning.stage} / ${warning.source}] ${warning.message}`);
}

const scenarios = {
  async baseline() {
    const directory = await prepareDirectory('baseline');
    await addFixtureEmail(directory, 'demo-new-grad-alert.eml');
    await addFixtureEmail(directory, 'sample.eml');
    const config = baseConfig(directory);
    const run = await runPipeline(await writeConfig(directory, config));
    const artifacts = await assertDesktopArtifacts(config, run);
    assert.equal(run.exitCode, 0, `baseline exited ${run.exitCode}`);
    assert.deepEqual(artifacts.warnings, [], `baseline produced warnings: ${warningLines(artifacts.warnings).join(' | ')}`);
    assert.equal(await readWarningsFile(config, run), null, 'a warning-free run must not write warnings.txt');
    assert.match(artifacts.html, /<p class="sub">August 27, 2026 · \d+ match/);
    assert.ok(run.summary.meta.matchCount >= 1, 'baseline produced no matches');
    assert.ok(artifacts.xlsxPath, 'baseline did not write the xlsx');
    const { sheet, headers } = await readMatches(artifacts.xlsxPath);
    assert.deepEqual(headers, EXPECTED_HEADERS);
    assert.equal(sheet.actualRowCount, run.summary.meta.matchCount + 1);
    assert.ok(sheet.getCell(2, LINK_COLUMN).value?.hyperlink, 'posting link is not a hyperlink cell');
    assert.equal(run.summary.meta.scoringModel, 'local_only');
    assert.deepEqual(run.summary.meta.resumeTracks, TRACKS.map(track => ({ id: track.id, label: track.label })));
    return `${run.summary.meta.matchCount} match(es), ${EXPECTED_HEADERS.length}-column xlsx (${TRACKS.length} tracks), no warnings`;
  },

  async offline() {
    const directory = await prepareDirectory('offline');
    await addFixtureEmail(directory, 'demo-new-grad-alert.eml', text => text.replace('https://www.example.com', DEAD_ORIGIN));
    const config = baseConfig(directory);
    config.sources.simplifyInternships = { enabled: true, url: `${DEAD_ORIGIN}/internships.md` };
    config.sources.simplifyNewGrad = { enabled: true, url: `${DEAD_ORIGIN}/new-grad.md` };
    config.network = { fetchDescriptions: true, concurrency: 2, timeoutMs: 2000 };
    const run = await runPipeline(await writeConfig(directory, config));
    const artifacts = await assertDesktopArtifacts(config, run);
    assert.equal(run.exitCode, 0, `offline run exited ${run.exitCode}`);
    const failedSources = artifacts.warnings.filter(warning => warning.stage === 'collector').map(warning => warning.source);
    for (const source of ['SimplifyJobs Summer Internships', 'SimplifyJobs New Grad']) {
      assert.ok(failedSources.includes(source), `no collector warning for ${source}: ${warningLines(artifacts.warnings).join(' | ')}`);
    }
    assert.ok(
      artifacts.warnings.some(warning => warning.stage === 'enrichment'),
      `no enrichment warning for the unreachable posting: ${warningLines(artifacts.warnings).join(' | ')}`,
    );
    assert.doesNotMatch(artifacts.html, /Pipeline warnings/);
    assert.match(artifacts.html, /\d+ pipeline warning\(s\), see warnings\.txt beside this file/);
    const warningsText = await readWarningsFile(config, run);
    assert.ok(warningsText, 'warnings.txt is missing although the run produced warnings');
    assert.match(warningsText, /^Daily Job Match Alert — 2026-08-27 — \d+ warnings?\n/);
    assert.match(warningsText, /^\[collector \/ SimplifyJobs Summer Internships\] /m);
    assert.equal(warningsText.trim().split('\n').length - 1, artifacts.warnings.length, 'warnings.txt must carry one line per warning');
    return `${failedSources.length} collector failure(s) + enrichment failure disclosed in warnings.txt, HTML still written`;
  },

  async 'llm-down'() {
    const directory = await prepareDirectory('llm-down');
    await addFixtureEmail(directory, 'demo-new-grad-alert.eml');
    const config = baseConfig(directory);
    config.semanticMatching = {
      engine: 'claude_subscription',
      claudeCommand: '/usr/bin/false',
      model: 'fable',
      required: true,
      batchSize: 6,
      acceptedMatchLevels: ['high'],
      timeoutMs: 30_000,
    };
    const run = await runPipeline(await writeConfig(directory, config));
    const artifacts = await assertDesktopArtifacts(config, run);
    assert.equal(run.exitCode, 0, `llm-down run exited ${run.exitCode}`);
    assert.ok(run.summary.meta.matchCount >= 1, 'no jobs reached the report through the local fallback');
    assert.ok(
      artifacts.warnings.some(warning => warning.stage === 'llm' && /local fallback/.test(warning.message)),
      `no llm fallback warning: ${warningLines(artifacts.warnings).join(' | ')}`,
    );
    const cards = (artifacts.html.match(/<article class="job"/g) || []).length;
    const unreviewed = (artifacts.html.match(/data-badge="unreviewed"/g) || []).length;
    assert.equal(cards, run.summary.meta.matchCount);
    assert.equal(unreviewed, cards, `${cards} job card(s) but only ${unreviewed} carry the unreviewed badge`);
    assert.match(artifacts.html, /kept local scores because semantic review was unavailable/);
    assert.equal(run.summary.meta.scoringModel, 'none');
    if (artifacts.xlsxPath) {
      const { sheet } = await readMatches(artifacts.xlsxPath);
      for (let row = 2; row <= sheet.actualRowCount; row++) {
        assert.match(String(sheet.getCell(row, WHY_COLUMN).value), /^\[unreviewed\]/, `xlsx row ${row} lacks the [unreviewed] prefix`);
      }
    }
    return `${cards} job(s) all unreviewed, llm warning disclosed, scoring model "none"`;
  },

  async 'bad-input'() {
    const directory = await prepareDirectory('bad-input');
    await addFixtureEmail(directory, 'demo-new-grad-alert.eml');
    await fs.writeFile(path.join(directory, 'intake', 'corrupted.eml'), malformedEmail());
    await fs.writeFile(path.join(directory, 'intake', 'notes.txt'), 'not an email');
    const config = baseConfig(directory);
    const run = await runPipeline(await writeConfig(directory, config));
    const artifacts = await assertDesktopArtifacts(config, run);
    assert.equal(run.exitCode, 0, `bad-input run exited ${run.exitCode}`);
    const skipped = artifacts.warnings.filter(warning => warning.source === 'Email files' && /Skipped corrupted\.eml/.test(warning.message));
    assert.equal(skipped.length, 1, `expected one skip warning for corrupted.eml: ${warningLines(artifacts.warnings).join(' | ')}`);
    assert.ok(run.summary.meta.matchCount >= 1, 'the well-formed email next to the corrupted one did not survive');
    assert.doesNotMatch(artifacts.html, /Skipped corrupted\.eml/);
    assert.match(await readWarningsFile(config, run) || '', /^\[collector \/ Email files\] .*Skipped corrupted\.eml/m);
    return `corrupted.eml skipped with warning, ${run.summary.meta.matchCount} match(es) from the healthy email`;
  },
  async 'xlsx-recovery'() {
    const directory = await prepareDirectory('xlsx-recovery');
    await addFixtureEmail(directory, 'demo-new-grad-alert.eml');
    const config = baseConfig(directory);
    const configPath = await writeConfig(directory, config);
    const runDirectory = path.join(config.outputDirectory, '2026-08-27');
    const xlsxPath = path.join(runDirectory, 'Daily Job Match Alert - 2026-08-27.xlsx');
    const statePath = path.join(directory, 'state', 'state.json');
    const payloadPath = path.join(directory, 'state', 'report-payload-2026-08-27.json');
    // A directory squatting on the workbook name makes only the xlsx step fail.
    await fs.mkdir(xlsxPath, { recursive: true });
    const failed = await runPipeline(configPath);
    await fs.rm(xlsxPath, { recursive: true, force: true });
    const failedArtifacts = await assertDesktopArtifacts(config, failed);
    assert.equal(failed.exitCode, 1, `xlsx failure should exit 1, got ${failed.exitCode}`);
    assert.equal(failedArtifacts.xlsxPath, null);
    assert.ok(await exists(path.join(runDirectory, 'XLSX-FAILED.txt')), 'missing XLSX-FAILED.txt marker');
    assert.ok(await exists(payloadPath), 'failed run left no report-payload-2026-08-27.json');
    assert.equal(JSON.parse(await fs.readFile(payloadPath, 'utf8')).complete, false, 'day payload should stay incomplete after the xlsx failure');
    const failedState = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert.equal(failedState.lastSuccessfulRun, undefined, 'lastSuccessfulRun was recorded despite the xlsx failure');
    assert.ok(failed.summary.meta.matchCount >= 1, 'the failed run produced no matches to carry forward');

    const recovered = await runPipeline(configPath, '2026-08-27T13:00:00Z');
    const artifacts = await assertDesktopArtifacts(config, recovered);
    assert.equal(recovered.exitCode, 0, `recovery run exited ${recovered.exitCode}`);
    assert.ok(artifacts.xlsxPath, 'recovery run did not rebuild the xlsx');
    assert.equal(JSON.parse(await fs.readFile(payloadPath, 'utf8')).complete, true, 'day payload was not marked complete');
    assert.equal(await exists(path.join(runDirectory, 'XLSX-FAILED.txt')), false, 'XLSX-FAILED.txt was not cleared');
    const recoveredState = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert.equal(recoveredState.lastSuccessfulRun, '2026-08-27T13:00:00.000Z');
    assert.equal(recovered.summary.meta.runsToday, 2, 'second run should be update #2 of the day');
    assert.equal(recovered.summary.meta.newThisRun, 0, 'the rerun should not have re-scored anything');
    assert.equal(recovered.summary.meta.matchCount, failed.summary.meta.matchCount, 'carried matches were lost in the same-day rerun');
    const { sheet, headers } = await readMatches(artifacts.xlsxPath);
    assert.deepEqual(headers, EXPECTED_HEADERS);
    assert.equal(sheet.actualRowCount, failed.summary.meta.matchCount + 1);
    assert.match(artifacts.html, /Daily update #2/);
    assert.ok(
      !artifacts.warnings.some(warning => warning.source === 'XLSX'),
      `the rebuilt report still carries the xlsx failure warning: ${warningLines(artifacts.warnings).join(' | ')}`,
    );
    return `xlsx failure kept ${failed.summary.meta.matchCount} match(es) in the day payload; next run rebuilt HTML + xlsx as update #2 and recorded lastSuccessfulRun`;
  },
};

// A public ATS board whose API answers 500 every time: the board is warned about and counted as one
// failure, the email-sourced posting still reaches the report, and nothing goes dormant on night one.
scenarios['ats-500'] = async function atsFiveHundred() {
  const directory = await prepareDirectory('ats-500');
  await addFixtureEmail(directory, 'demo-new-grad-alert.eml');
  const hits = [];
  const server = http.createServer((request, response) => {
    hits.push(request.url);
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end('{"error":"upstream exploded"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const config = baseConfig(directory);
    config.sources.atsBoards = { enabled: true, boards: [{ key: 'greenhouse:chaosco', company: 'Chaos Co', apiUrl: `http://127.0.0.1:${port}/v1/boards/chaosco/jobs?content=true` }] };
    const run = await runPipeline(await writeConfig(directory, config));
    const artifacts = await assertDesktopArtifacts(config, run);
    assert.equal(run.exitCode, 0, `ats-500 run exited ${run.exitCode}`);
    assert.deepEqual(hits, ['/v1/boards/chaosco/jobs?content=true'], 'the board was polled exactly once');
    const warning = artifacts.warnings.find(item => item.stage === 'collector' && item.source === 'Greenhouse · Chaos Co');
    assert.ok(warning, `no collector warning for the failing board: ${warningLines(artifacts.warnings).join(' | ')}`);
    assert.match(warning.message, /HTTP 500 \(failure 1 in a row\); the other sources were not affected/);
    assert.ok(run.summary.meta.matchCount >= 1, 'the email-sourced posting did not survive the board failure');
    const registry = JSON.parse(await fs.readFile(path.join(directory, 'state', 'ats-boards.json'), 'utf8'));
    const board = registry.boards['greenhouse:chaosco'];
    assert.equal(board.consecutiveFailures, 1);
    assert.equal(board.dormant, false);
    assert.equal(board.baselinedAt, null, 'a failed first poll is not a baseline');
    assert.equal(board.lastError, 'HTTP 500');
    const stats = run.summary.meta.sourceCounts || [];
    assert.ok(stats.some(stat => stat.name === 'Greenhouse · Chaos Co' && stat.ok === false), 'the per-source counts do not record the failure');
    assert.ok(stats.some(stat => stat.name === 'Email files' && stat.ok === true && stat.count >= 1));
    assert.match(artifacts.html, /Greenhouse · Chaos Co: failed \(HTTP 500\)/, 'Run Details does not list the failed board');
    assert.match(await readWarningsFile(config, run) || '', /^\[collector \/ Greenhouse · Chaos Co\] HTTP 500/m);
    return `board failure isolated (1 warning, consecutiveFailures=1, not dormant), ${run.summary.meta.matchCount} match(es) from the healthy email`;
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
};

// More local candidates than semanticMatching.maxReviewedPerRun allows: the surplus is deferred (not
// seen), disclosed as an info line, and reviewed first on the next run.
scenarios['review-cap'] = async function reviewCap() {
  const directory = await prepareDirectory('review-cap');
  await addFixtureEmail(directory, 'demo-new-grad-alert.eml');
  await addFixtureEmail(directory, 'sample.eml');
  const config = baseConfig(directory);
  config.semanticMatching = { engine: 'local_only', maxReviewedPerRun: 1 };
  const configPath = await writeConfig(directory, config);
  const first = await runPipeline(configPath);
  const artifacts = await assertDesktopArtifacts(config, first);
  assert.equal(first.exitCode, 0, `review-cap run exited ${first.exitCode}`);
  assert.equal(first.summary.meta.maxReviewedPerRun, 1);
  assert.ok(first.summary.meta.candidateCount >= 2, `expected at least two local candidates, got ${first.summary.meta.candidateCount}`);
  assert.equal(first.summary.meta.reviewedThisRun, 1);
  assert.equal(first.summary.meta.deferredCount, first.summary.meta.candidateCount - 1);
  const deferral = artifacts.warnings.find(item => item.source === 'review budget');
  assert.ok(deferral, `no review budget warning: ${warningLines(artifacts.warnings).join(' | ')}`);
  assert.equal(deferral.level, 'info');
  assert.match(deferral.message, /^deferred \d+ postings to the next run \(review limit 1 per run\)/);
  assert.match(artifacts.html, /Review budget<\/dt><dd>\d+ candidates · 1 reviewed · \d+ deferred \(limit 1 per run\)/);
  const state = JSON.parse(await fs.readFile(path.join(directory, 'state', 'state.json'), 'utf8'));
  const deferredUrls = Object.values(state.deferred || {}).map(entry => entry.url);
  assert.equal(deferredUrls.length, first.summary.meta.deferredCount, 'every deferred posting is recorded');
  for (const url of deferredUrls) assert.ok(!Object.values(state.seen).some(entry => entry.url === url), `${url} was deferred but marked seen`);

  const second = await runPipeline(configPath, '2026-08-27T13:00:00Z');
  assert.equal(second.exitCode, 0, `second review-cap run exited ${second.exitCode}`);
  assert.equal(second.summary.meta.reviewedThisRun, 1, 'the deferred posting is reviewed on the next run');
  assert.equal(second.summary.meta.candidateCount, first.summary.meta.deferredCount, 'only the deferred posting(s) come back; the reviewed one is seen');
  const later = JSON.parse(await fs.readFile(path.join(directory, 'state', 'state.json'), 'utf8'));
  assert.equal(Object.keys(later.deferred || {}).length, Math.max(0, first.summary.meta.deferredCount - 1));
  return `${first.summary.meta.candidateCount} candidates, 1 reviewed, ${first.summary.meta.deferredCount} deferred (not seen); next run reviewed the deferred posting first`;
};

// The stand-in CLI (scripts/chaos/fake-claude.sh) refuses --model fable with the recorded Fable weekly
// notice and scores with any other model: the run must step down to opus, keep every posting, audit the
// switch as an info line, and never write a MODEL MISMATCH warning.
scenarios['fable-weekly-limit'] = async function fableWeeklyLimit() {
  const directory = await prepareDirectory('fable-weekly-limit');
  await addFixtureEmail(directory, 'demo-new-grad-alert.eml');
  const config = baseConfig(directory);
  config.semanticMatching = { engine: 'claude', claudeCommand: path.join(projectDirectory, 'scripts', 'chaos', 'fake-claude.sh'), models: { claude: 'fable' }, required: true, batchSize: 6, acceptedMatchLevels: ['high'], timeoutMs: 30_000, quotaPolicy: { modelLadder: ['fable', 'opus'] } };
  const run = await runPipeline(await writeConfig(directory, config), NOW, { FAKE_CLAUDE_MODE: 'fable-weekly-limit' });
  const artifacts = await assertDesktopArtifacts(config, run);
  assert.equal(run.exitCode, 0, `fable-weekly-limit run exited ${run.exitCode}`);
  assert.ok(run.summary.meta.matchCount >= 1, 'the posting was not scored after the downgrade');
  assert.equal(run.summary.meta.scoringModel, 'claude-opus-5', 'opus scored the run');
  assert.equal(run.summary.meta.quota.effectiveModel, 'opus');
  assert.equal(run.summary.meta.quota.deferredByQuota, 0);
  assert.deepEqual(run.summary.meta.quota.events.map(event => [event.kind, event.action, event.detail]), [['modelWeeklyLimit', 'downgraded', 'switched to opus']]);
  assert.ok(!artifacts.warnings.some(warning => /MODEL MISMATCH/.test(warning.message)), `a strategic downgrade must not be a mismatch: ${warningLines(artifacts.warnings).join(' | ')}`);
  const audit = artifacts.warnings.find(warning => warning.level === 'info' && /scored by opus: fable weekly limit/.test(warning.message));
  assert.ok(audit, `no audit line for the downgrade: ${warningLines(artifacts.warnings).join(' | ')}`);
  assert.match(artifacts.html, /Subscription quota<\/dt><dd>1 event\(s\) · scored by claude · opus/);
  assert.doesNotMatch(artifacts.html, /data-banner="quota"/, 'a downgrade needs no banner');
  assert.doesNotMatch(artifacts.html, /data-badge="unreviewed"/, 'nothing fell back to local scores');
  return `Fable refused, run scored by opus (${run.summary.meta.matchCount} match(es)), info audit line, no mismatch warning`;
};

// Every scoring call is refused with the recorded weekly account notice: the report is still written with
// a banner, and every candidate waits in the deferral queue instead of being lost or marked unreviewed.
scenarios['account-limit'] = async function accountLimit() {
  const directory = await prepareDirectory('account-limit');
  await addFixtureEmail(directory, 'demo-new-grad-alert.eml');
  const config = baseConfig(directory);
  config.semanticMatching = { engine: 'claude', claudeCommand: path.join(projectDirectory, 'scripts', 'chaos', 'fake-claude.sh'), models: { claude: 'fable' }, required: true, batchSize: 6, acceptedMatchLevels: ['high'], timeoutMs: 30_000 };
  const run = await runPipeline(await writeConfig(directory, config), NOW, { FAKE_CLAUDE_MODE: 'account-limit' });
  const artifacts = await assertDesktopArtifacts(config, run);
  assert.equal(run.exitCode, 0, `account-limit run exited ${run.exitCode}`);
  assert.equal(run.summary.meta.matchCount, 0, 'nothing was scored, so nothing is a match');
  assert.ok(run.summary.meta.candidateCount >= 1, 'the fixture must yield at least one candidate');
  assert.equal(run.summary.meta.quota.deferredByQuota, run.summary.meta.candidateCount, 'every candidate is deferred');
  assert.deepEqual(run.summary.meta.quota.events.map(event => [event.kind, event.action]), [['accountWeeklyLimit', 'deferred']]);
  assert.match(artifacts.html, /<div class="banner" data-banner="quota">Claude subscription weekly account limit reached; expected to reset [^<]*; \d+ posting\(s\) were deferred to the next run and are not lost<\/div>/);
  assert.doesNotMatch(artifacts.html, /data-badge="unreviewed"/, 'a refused posting is deferred, never unreviewed');
  const state = JSON.parse(await fs.readFile(path.join(directory, 'state', 'state.json'), 'utf8'));
  const deferred = Object.values(state.deferred || {});
  assert.equal(deferred.length, run.summary.meta.candidateCount, 'the deferral queue holds every refused posting');
  for (const entry of deferred) assert.ok(!Object.values(state.seen).some(seen => seen.url === entry.url), `${entry.url} was deferred but marked seen`);
  assert.match(await readWarningsFile(config, run) || '', /^\[llm \/ claude\] info: Claude subscription weekly account limit reached/m);
  return `all ${run.summary.meta.candidateCount} candidate(s) deferred, banner shown, report still written`;
};

const scenario = scenarios[scenarioName];
if (!scenario) {
  console.error(`Unknown chaos scenario: ${scenarioName}. Known: ${Object.keys(scenarios).join(', ')}`);
  process.exit(2);
}

try {
  const detail = await scenario();
  console.log(`PASS ${scenarioName}: ${detail}`);
} catch (error) {
  console.error(`FAIL ${scenarioName}: ${error.message}`);
  process.exitCode = 1;
}
