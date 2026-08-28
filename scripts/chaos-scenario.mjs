// One chaos scenario: build an isolated config under <workRoot>/<scenario>, run src/index.mjs
// against it, and assert that the Desktop-equivalent output folder still holds a usable report.
//
//   node scripts/chaos-scenario.mjs <baseline|offline|llm-down|bad-input|xlsx-recovery> <workRoot>
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
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
const EXPECTED_HEADERS = [
  'Company', 'Title', 'Location', 'Role Type', 'Posted At', 'Data Score', 'AI Score',
  'Recommended Resume', 'Why It Matches', 'Gaps / Verify', 'Posting Link',
];

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
      data: path.join(directory, 'data-resume.md'),
      ai: path.join(directory, 'ai-resume.md'),
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
      simplifyInternships: { enabled: false },
      simplifyNewGrad: { enabled: false },
      emailFiles: { enabled: true, directory: path.join(directory, 'intake') },
      himalaya: { enabled: false },
      careerOps: { enabled: false },
    },
    network: { fetchDescriptions: false, concurrency: 2, timeoutMs: 2000 },
  };
}

async function prepareDirectory(name) {
  const directory = path.join(workRoot, name);
  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(path.join(directory, 'intake'), { recursive: true });
  await fs.mkdir(path.join(directory, 'output'), { recursive: true });
  await fs.copyFile(path.join(fixturesDirectory, 'data-resume.md'), path.join(directory, 'data-resume.md'));
  await fs.copyFile(path.join(fixturesDirectory, 'ai-resume.md'), path.join(directory, 'ai-resume.md'));
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

async function runPipeline(configPath, now = NOW) {
  const env = { ...process.env };
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
    assert.ok(run.summary.meta.matchCount >= 1, 'baseline produced no matches');
    assert.ok(artifacts.xlsxPath, 'baseline did not write the xlsx');
    const { sheet, headers } = await readMatches(artifacts.xlsxPath);
    assert.deepEqual(headers, EXPECTED_HEADERS);
    assert.equal(sheet.actualRowCount, run.summary.meta.matchCount + 1);
    assert.ok(sheet.getCell(2, 11).value?.hyperlink, 'posting link is not a hyperlink cell');
    assert.equal(run.summary.meta.scoringModel, 'local_only');
    return `${run.summary.meta.matchCount} match(es), 11-column xlsx, no warnings`;
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
    assert.match(artifacts.html, /Pipeline warnings/);
    assert.match(artifacts.html, /SimplifyJobs Summer Internships/);
    return `${failedSources.length} collector failure(s) + enrichment failure disclosed, HTML still written`;
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
    const cards = (artifacts.html.match(/<article class="job">/g) || []).length;
    const unreviewed = (artifacts.html.match(/Match level: unreviewed/g) || []).length;
    assert.equal(cards, run.summary.meta.matchCount);
    assert.equal(unreviewed, cards, `${cards} job card(s) but only ${unreviewed} labeled unreviewed`);
    assert.doesNotMatch(artifacts.html, /Match level: high/);
    assert.equal(run.summary.meta.scoringModel, 'none');
    if (artifacts.xlsxPath) {
      const { sheet } = await readMatches(artifacts.xlsxPath);
      for (let row = 2; row <= sheet.actualRowCount; row++) {
        assert.match(String(sheet.getCell(row, 9).value), /^\[unreviewed\]/, `xlsx row ${row} lacks the [unreviewed] prefix`);
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
    assert.match(artifacts.html, /Skipped corrupted\.eml/);
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
