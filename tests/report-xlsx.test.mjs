import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import ExcelJS from 'exceljs';

const execFileAsync = promisify(execFile);
const builderPath = fileURLToPath(new URL('../src/report-xlsx.mjs', import.meta.url));
const FIXED_HEADERS_BEFORE = ['Company', 'Title', 'Location', 'Role Type', 'Posted At'];
const FIXED_HEADERS_AFTER = ['Recommended Resume', 'Why It Matches', 'Gaps / Verify', 'Posting Link'];

function expectedHeaders(labels) {
  return [...FIXED_HEADERS_BEFORE, ...labels.map(label => `${label} Score`), ...FIXED_HEADERS_AFTER];
}

async function buildWorkbook(payload, name) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `xlsx-${name}-`));
  const payloadPath = path.join(directory, 'payload.json');
  const outputPath = path.join(directory, 'report.xlsx');
  await fs.writeFile(payloadPath, JSON.stringify(payload));
  await execFileAsync(process.execPath, [builderPath, payloadPath, outputPath, '--verify']);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(outputPath);
  return { workbook, directory };
}

function headersOf(sheet) {
  const headers = [];
  sheet.getRow(1).eachCell(cell => headers.push(cell.value));
  return headers;
}

function summaryRowsOf(workbook) {
  const rows = {};
  workbook.getWorksheet('Run Summary').eachRow(row => { if (typeof row.getCell(1).value === 'string') rows[row.getCell(1).value] = row.getCell(2).value; });
  return rows;
}

const threeTracks = [{ id: 'data', label: 'Data' }, { id: 'llm', label: 'LLM' }, { id: 'agent', label: 'AI Agent' }];

test('writes and re-reads the ExcelJS workbook with one score column per enabled track, hyperlinks, and formatting', async () => {
  const payload = {
    meta: {
      applicationDate: '2026-08-28',
      date: '2026-08-28',
      generatedAt: '2026-08-27T20:00:00.000-05:00',
      lookbackHours: 24,
      reviewedCount: 2,
      minimumMatchScore: 70,
      scoringModel: 'claude-fable-5',
      resumeTracks: threeTracks,
      warnings: [{ stage: 'llm', source: 'claude_subscription', message: 'batch fallback' }],
    },
    matches: [{
      source: 'fixture', roleType: 'new_grad', postedAt: '2026-08-27T15:00:00.000Z', discoveredAt: '2026-08-27T20:00:00.000Z',
      company: 'Acme', title: 'Data Analyst', location: 'Remote - US', employmentType: 'FULL_TIME', salary: '',
      scores: { data: 88, llm: 74, agent: 88 }, bestScore: 88, recommendedTrack: 'data', recommendedResume: 'Data',
      matchLevel: 'unreviewed', scoringEngine: 'local_fallback', reasons: ['SQL'], gaps: [], blockers: [],
      description: 'x'.repeat(40_000), url: 'https://www.example.com/jobs/42?utm=1', freshnessBasis: 'jobposting_date_posted',
    }, {
      source: 'fixture', roleType: 'internship', postedAt: '2026-08-27T16:00:00.000Z', discoveredAt: '2026-08-27T20:00:00.000Z',
      company: 'Beta', title: 'Agent Intern', location: 'Remote - US', scores: { data: 60, llm: 85, agent: 91 }, bestScore: 91,
      recommendedTrack: 'agent', recommendedResume: 'AI Agent', matchLevel: 'high',
      scoringEngine: 'claude_subscription', scoringModel: 'claude-fable-5', reasons: ['Tool use', 'Evaluation loops'],
      gaps: ['Verify sponsorship'], blockers: [], description: 'Build agents.', url: 'https://jobs.beta.io/agent-intern', freshnessBasis: 'jobposting_date_posted',
    }],
  };
  const { workbook, directory } = await buildWorkbook(payload, 'three-tracks');
  try {
    assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['Run Summary', 'Matches', 'Notes']);

    const matches = workbook.getWorksheet('Matches');
    assert.equal(matches.actualRowCount, 3);
    assert.deepEqual(headersOf(matches), expectedHeaders(['Data', 'LLM', 'AI Agent']));
    assert.equal(matches.actualColumnCount, 12);
    assert.equal(matches.getCell('A2').value, 'Acme');
    assert.equal(matches.getCell('D2').value, 'new_grad');
    assert.deepEqual([matches.getCell('F2').value, matches.getCell('G2').value, matches.getCell('H2').value], [88, 74, 88]);
    assert.deepEqual([matches.getCell('F3').value, matches.getCell('G3').value, matches.getCell('H3').value], [60, 85, 91]);
    assert.equal(matches.getCell('I2').value.formula, 'CHOOSE(MATCH(MAX(F2:H2),F2:H2,0),"Data","LLM","AI Agent")');
    assert.equal(matches.getCell('I2').value.result, 'Data', 'a tie resolves to the earlier configured track');
    assert.equal(matches.getCell('I3').value.result, 'AI Agent');
    assert.equal(matches.getCell('J2').value, '[unreviewed] SQL');
    assert.equal(matches.getCell('J3').value, 'Tool use; Evaluation loops');
    assert.equal(matches.getCell('K3').value, 'Verify sponsorship');
    assert.deepEqual(
      { text: matches.getCell('L2').value.text, hyperlink: matches.getCell('L2').value.hyperlink },
      { text: 'example.com', hyperlink: 'https://www.example.com/jobs/42?utm=1' },
    );
    assert.equal(matches.getCell('L3').value.text, 'jobs.beta.io');
    assert.equal(matches.getCell('M2').value, null);
    assert.doesNotMatch(JSON.stringify(matches.getRow(2).values), /xxxxxxxxxx/);
    assert.equal(matches.getRow(2).height, undefined);
    assert.equal(matches.getCell('J2').alignment.wrapText, true);
    assert.equal(matches.getCell('K2').alignment.wrapText, true);
    assert.equal(matches.getColumn('J').width, 45);
    assert.equal(matches.getColumn('K').width, 45);
    assert.equal(matches.conditionalFormattings[0].ref, 'F2:H3', 'the three-color scale spans every score column');
    assert.equal(matches.conditionalFormattings[0].rules[0].type, 'colorScale');
    assert.equal(matches.views[0].ySplit, 1);
    assert.equal(matches.views[0].state, 'frozen');
    assert.equal(matches.getTable('JobMatchesTable')?.name, 'JobMatchesTable');

    const summaryRows = summaryRowsOf(workbook);
    assert.equal(summaryRows['Scoring model'], 'claude-fable-5');
    assert.equal(summaryRows['Resume tracks'], 'Data, LLM, AI Agent');
    assert.equal(summaryRows['High matches'], 2);
    assert.equal(summaryRows.Internship.formula, "COUNTIF('Matches'!$D$2:$D$3,\"internship\")");
    assert.equal(summaryRows.Internship.result, 1);
    assert.ok(Object.keys(summaryRows).includes('Warnings'));
    const warningCell = [];
    workbook.getWorksheet('Run Summary').eachRow(row => { if (/batch fallback/.test(String(row.getCell(1).value))) warningCell.push(row.getCell(1).value); });
    assert.equal(warningCell.length, 1);

    const notes = workbook.getWorksheet('Notes');
    const noteFields = [];
    notes.eachRow(row => noteFields.push(row.getCell(1).value));
    assert.ok(noteFields.includes('Why It Matches'));
    assert.ok(noteFields.includes('Posting Link'));
    assert.ok(noteFields.includes('Scoring model'));
    assert.ok(noteFields.includes('Resume tracks'));
    assert.ok(noteFields.includes('Data Score / LLM Score / AI Agent Score'));
    assert.ok(!noteFields.includes('Full JD'));
    assert.ok(!noteFields.includes('Match Level'));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a single enabled track yields a 10-column sheet and a disabled track never appears', async () => {
  const payload = {
    meta: {
      applicationDate: '2026-08-28', date: '2026-08-28', generatedAt: '2026-08-27T20:00:00.000-05:00', lookbackHours: 24,
      reviewedCount: 1, minimumMatchScore: 70, scoringModel: 'local_only', resumeTracks: [{ id: 'llm', label: 'LLM' }], warnings: [],
    },
    matches: [{
      source: 'fixture', roleType: 'new_grad', postedAt: '2026-08-27T15:00:00.000Z', company: 'Acme', title: 'LLM Engineer', location: 'Remote - US',
      scores: { llm: 77 }, bestScore: 77, recommendedTrack: 'llm', recommendedResume: 'LLM', matchLevel: 'high', reasons: ['RAG'], gaps: [], blockers: [],
      description: 'Build.', url: 'https://www.example.com/jobs/llm', freshnessBasis: 'jobposting_date_posted',
    }],
  };
  const { workbook, directory } = await buildWorkbook(payload, 'single-track');
  try {
    const matches = workbook.getWorksheet('Matches');
    assert.deepEqual(headersOf(matches), expectedHeaders(['LLM']));
    assert.equal(matches.actualColumnCount, 10);
    assert.equal(matches.getCell('F2').value, 77);
    assert.equal(matches.getCell('G2').value.formula, 'CHOOSE(MATCH(MAX(F2:F2),F2:F2,0),"LLM")');
    assert.equal(matches.getCell('G2').value.result, 'LLM');
    assert.equal(matches.getCell('J2').value.hyperlink, 'https://www.example.com/jobs/llm');
    assert.equal(matches.conditionalFormattings[0].ref, 'F2:F2');
    assert.doesNotMatch(headersOf(matches).join('|'), /Data Score|AI Score|AI Agent Score/);
    assert.equal(summaryRowsOf(workbook)['Resume tracks'], 'LLM');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a payload written before tracks existed still renders the 11-column Data / AI layout', async () => {
  const payload = {
    meta: { applicationDate: '2026-08-28', date: '2026-08-28', generatedAt: '2026-08-27T20:00:00.000-05:00', lookbackHours: 24, reviewedCount: 1, minimumMatchScore: 70, scoringModel: 'none', warnings: [] },
    matches: [{
      source: 'fixture', roleType: 'new_grad', postedAt: '2026-08-27T15:00:00.000Z', company: 'Acme', title: 'Data Analyst', location: 'Remote - US',
      dataScore: 60, aiScore: 91, bestScore: 91, recommendedResume: 'AI', matchLevel: 'high', reasons: ['SQL'], gaps: [], blockers: [],
      description: 'Analyze.', url: 'https://www.example.com/jobs/legacy', freshnessBasis: 'jobposting_date_posted',
    }],
  };
  const { workbook, directory } = await buildWorkbook(payload, 'legacy');
  try {
    const matches = workbook.getWorksheet('Matches');
    assert.deepEqual(headersOf(matches), expectedHeaders(['Data', 'AI']));
    assert.equal(matches.actualColumnCount, 11);
    assert.deepEqual([matches.getCell('F2').value, matches.getCell('G2').value], [60, 91]);
    assert.equal(matches.getCell('H2').value.formula, 'CHOOSE(MATCH(MAX(F2:G2),F2:G2,0),"Data","AI")');
    assert.equal(matches.getCell('H2').value.result, 'AI');
    assert.equal(matches.getCell('K2').value.hyperlink, 'https://www.example.com/jobs/legacy');
    assert.equal(summaryRowsOf(workbook)['Resume tracks'], 'Data, AI');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('an empty match list still writes the dynamic header and passes --verify', async () => {
  const { workbook, directory } = await buildWorkbook({
    meta: { applicationDate: '2026-08-28', date: '2026-08-28', generatedAt: '2026-08-27T20:00:00.000-05:00', lookbackHours: 24, reviewedCount: 0, minimumMatchScore: 70, resumeTracks: threeTracks, warnings: [] },
    matches: [],
  }, 'empty');
  try {
    const matches = workbook.getWorksheet('Matches');
    assert.equal(matches.actualRowCount, 1);
    assert.deepEqual(headersOf(matches), expectedHeaders(['Data', 'LLM', 'AI Agent']));
    assert.equal(matches.getCell('L1').value, 'Posting Link');
    const summaryRows = summaryRowsOf(workbook);
    assert.equal(summaryRows['Scoring model'], 'unknown');
    assert.equal(summaryRows['Resume tracks'], 'Data, LLM, AI Agent');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Run Summary lists the hard-filter exclusion counts and the Gaps column carries the location note', async () => {
  const payload = {
    meta: { applicationDate: '2026-08-28', date: '2026-08-28', generatedAt: '2026-08-27T20:00:00.000-05:00', lookbackHours: 24, reviewedCount: 4, minimumMatchScore: 70, scoringModel: 'local_only', resumeTracks: [{ id: 'data', label: 'Data' }, { id: 'ai', label: 'AI' }], warnings: [], eligibilityExclusions: { location: 2, graduation: 1 } },
    matches: [{
      source: 'fixture', roleType: 'new_grad', postedAt: '2026-08-27T15:00:00.000Z', company: 'Acme', title: 'Data Analyst', location: 'Remote',
      scores: { data: 88, ai: 74 }, bestScore: 88, recommendedTrack: 'data', recommendedResume: 'Data', matchLevel: 'high', reasons: ['SQL'], gaps: ['JD skill not found in resume: dbt', 'Location unverified — confirm US eligibility'], blockers: [],
      description: 'Analyze.', url: 'https://www.example.com/jobs/42', freshnessBasis: 'jobposting_date_posted',
    }],
  };
  const { workbook, directory } = await buildWorkbook(payload, 'exclusions');
  try {
    const summaryRows = summaryRowsOf(workbook);
    assert.equal(summaryRows['Excluded: location outside US'], 2);
    assert.equal(summaryRows['Excluded: graduation window'], 1);
    assert.equal(workbook.getWorksheet('Matches').getCell('J2').value, 'JD skill not found in resume: dbt; Location unverified — confirm US eligibility');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
