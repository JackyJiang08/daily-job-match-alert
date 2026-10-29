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
const FIXED_HEADERS_BEFORE = ['Company', 'Title', 'Location', 'Role Type', 'Posted At', 'Freshness'];
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
      matchLevel: 'high', semanticReviewed: true, scoringEngine: 'claude_subscription', scoringModel: 'claude-fable-5', reasons: ['SQL'], gaps: [], blockers: [],
      description: 'x'.repeat(40_000), url: 'https://www.example.com/jobs/42?utm=1', freshnessBasis: 'jobposting_date_posted',
    }, {
      source: 'fixture', roleType: 'internship', postedAt: '2026-08-27T16:00:00.000Z', discoveredAt: '2026-08-27T20:00:00.000Z',
      company: 'Beta', title: 'Agent Intern', location: 'Boston, MA · Johnston, RI · Columbus, OH', scores: { data: 60, llm: 85, agent: 91 }, bestScore: 91,
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
    assert.equal(matches.actualColumnCount, 13);
    assert.equal(matches.getCell('A2').value, 'Acme');
    assert.equal(matches.getCell('D2').value, 'new_grad');
    assert.equal(matches.getCell('C3').value, 'Boston, MA · Johnston, RI · Columbus, OH', 'the Location column prints the joined list verbatim');
    assert.deepEqual([matches.getCell('G2').value, matches.getCell('H2').value, matches.getCell('I2').value], [88, 74, 88]);
    assert.deepEqual([matches.getCell('G3').value, matches.getCell('H3').value, matches.getCell('I3').value], [60, 85, 91]);
    assert.equal(matches.getCell('J2').value.formula, 'CHOOSE(MATCH(MAX(G2:I2),G2:I2,0),"Data","LLM","AI Agent")');
    assert.equal(matches.getCell('J2').value.result, 'Data', 'a tie resolves to the earlier configured track');
    assert.equal(matches.getCell('J3').value.result, 'AI Agent');
    assert.equal(matches.getCell('K2').value, 'SQL');
    assert.equal(matches.getCell('K3').value, 'Tool use; Evaluation loops');
    assert.equal(matches.getCell('L3').value, 'Verify sponsorship');
    assert.deepEqual(
      { text: matches.getCell('M2').value.text, hyperlink: matches.getCell('M2').value.hyperlink },
      { text: 'example.com', hyperlink: 'https://www.example.com/jobs/42?utm=1' },
    );
    assert.equal(matches.getCell('M3').value.text, 'jobs.beta.io');
    assert.equal(matches.getCell('N2').value, null);
    assert.doesNotMatch(JSON.stringify(matches.getRow(2).values), /xxxxxxxxxx/);
    assert.equal(matches.getRow(2).height, undefined);
    assert.equal(matches.getCell('K2').alignment.wrapText, true);
    assert.equal(matches.getCell('L2').alignment.wrapText, true);
    assert.equal(matches.getColumn('K').width, 45);
    assert.equal(matches.getColumn('L').width, 45);
    assert.equal(matches.conditionalFormattings[0].ref, 'G2:I3', 'the three-color scale spans every score column');
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
    assert.equal(summaryRows.Warnings, '1 (see warnings.txt beside this workbook)');
    const warningCell = [];
    workbook.getWorksheet('Run Summary').eachRow(row => { if (/batch fallback/.test(String(row.getCell(1).value))) warningCell.push(row.getCell(1).value); });
    assert.equal(warningCell.length, 0, 'individual warning lines belong to warnings.txt, not the workbook');

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

test('postings no model reviewed leave the Matches sheet for a Not Reviewed sheet, also from an older payload that kept them among its matches', async () => {
  const meta = { date: '2026-10-28', applicationDate: '2026-10-28', generatedAt: '2026-10-28T01:00:00.000Z', timeZone: 'America/Chicago', resumeTracks: [{ id: 'data', label: 'Data' }], warnings: [], scoringModel: 'claude-fable-5' };
  const base = { title: 'Analyst', location: 'Remote - US', roleType: 'new_grad', recommendedTrack: 'data', reasons: ['x'], gaps: ['Verify SQL depth'], postedAt: '2026-10-27T18:00:00.000Z' };
  const reviewedJob = { ...base, company: 'Example Corp', url: 'https://example.com/reviewed', scores: { data: 84 }, bestScore: 84, matchLevel: 'high', semanticReviewed: true, scoringEngine: 'claude', scoringModel: 'claude-fable-5' };
  const legacy = { ...base, company: 'Legacy Co', url: 'https://example.com/legacy', scores: { data: 71 }, bestScore: 71, matchLevel: 'unreviewed', semanticReviewed: false, scoringEngine: 'local_fallback' };
  const notMatched = { ...base, company: 'Other Co', url: 'https://example.com/other', scores: { data: 40 }, bestScore: 40, matchLevel: 'unreviewed', semanticReviewed: false, scoringEngine: 'local_fallback' };
  const { workbook, directory } = await buildWorkbook({ meta, matches: [reviewedJob, legacy], reviewed: [reviewedJob, legacy, notMatched] }, 'not-reviewed');
  try {
    assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['Run Summary', 'Matches', 'Not Reviewed', 'Notes']);
    const matches = workbook.getWorksheet('Matches');
    assert.equal(matches.actualRowCount, 2, 'only the reviewed posting is a match');
    assert.equal(matches.getCell('A2').value, 'Example Corp');
    const sheet = workbook.getWorksheet('Not Reviewed');
    assert.deepEqual(headersOf(sheet), ['Company', 'Title', 'Location', 'Role Type', 'Posted At', 'Local Data Score', 'Gaps / Verify', 'Posting Link']);
    assert.deepEqual([sheet.getCell('A2').value, sheet.getCell('F2').value, sheet.getCell('A3').value, sheet.getCell('F3').value], ['Legacy Co', 71, 'Other Co', 40], 'best local score first');
    assert.equal(sheet.getCell('H2').value.hyperlink, 'https://example.com/legacy');
    const summaryRows = summaryRowsOf(workbook);
    assert.equal(summaryRows['High matches'], 1);
    assert.equal(summaryRows['Not reviewed by a model'], '2 (engine unavailable; see the Not Reviewed sheet)');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Posted At keeps the time for precise sources and writes "Aug 26 (date only)" for day-level ones; Freshness says which', async () => {
  const meta = { date: '2026-08-27', applicationDate: '2026-08-27', generatedAt: '2026-08-27T01:00:00.000Z', timeZone: 'America/Chicago', resumeTracks: [{ id: 'data', label: 'Data' }], warnings: [], scoringModel: 'local_only' };
  const base = { title: 'Analyst', location: 'Remote', roleType: 'new_grad', scores: { data: 80 }, bestScore: 80, recommendedTrack: 'data', reasons: ['x'], gaps: [], url: 'https://example.com/1' };
  const payload = { meta, matches: [
    { ...base, company: 'Acme', postedAt: '2026-08-27T01:15:00.000Z', freshnessBasis: 'greenhouse_updated_at' },
    { ...base, company: '100000 Motorola Solutions, Inc.', url: 'https://motorola.wd5.myworkdayjobs.com/Careers/job/x', enrichment: 'workday_cxs', postedAt: '2026-08-27T01:00:00.000Z', freshnessBasis: 'workday_posted_on' },
  ], reviewed: [] };
  const { workbook, directory } = await buildWorkbook(payload, 'posted-at');
  try {
    const sheet = workbook.getWorksheet('Matches');
    const postedColumn = 5;
    assert.equal(sheet.getCell(2, postedColumn).numFmt, 'yyyy-mm-dd hh:mm');
    assert.equal(sheet.getCell(2, postedColumn).value.toISOString(), '2026-08-27T01:15:00.000Z');
    assert.equal(sheet.getCell(3, postedColumn).value, 'Aug 26 (date only)', 'a day-level source is the local calendar day in America/Chicago, never 00:00');
    assert.equal(sheet.getCell(2, postedColumn + 1).value, 'posted today');
    assert.equal(sheet.getCell(3, postedColumn + 1).value, 'date only');
    assert.equal(sheet.getCell(3, 1).value, 'Motorola Solutions', 'the Workday entity name is cleaned in the workbook too');
    let note = '';
    workbook.getWorksheet('Notes').eachRow(row => { if (String(row.getCell(1).value) === 'Posted At') note = String(row.getCell(2).value); });
    assert.match(note, /date only/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a single enabled track yields an 11-column sheet and a disabled track never appears', async () => {
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
    assert.equal(matches.actualColumnCount, 11);
    assert.equal(matches.getCell('G2').value, 77);
    assert.equal(matches.getCell('H2').value.formula, 'CHOOSE(MATCH(MAX(G2:G2),G2:G2,0),"LLM")');
    assert.equal(matches.getCell('H2').value.result, 'LLM');
    assert.equal(matches.getCell('K2').value.hyperlink, 'https://www.example.com/jobs/llm');
    assert.equal(matches.conditionalFormattings[0].ref, 'G2:G2');
    assert.doesNotMatch(headersOf(matches).join('|'), /Data Score|AI Score|AI Agent Score/);
    assert.equal(summaryRowsOf(workbook)['Resume tracks'], 'LLM');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a payload written before tracks existed still renders the 12-column Data / AI layout', async () => {
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
    assert.equal(matches.actualColumnCount, 12);
    assert.deepEqual([matches.getCell('G2').value, matches.getCell('H2').value], [60, 91]);
    assert.equal(matches.getCell('I2').value.formula, 'CHOOSE(MATCH(MAX(G2:H2),G2:H2,0),"Data","AI")');
    assert.equal(matches.getCell('I2').value.result, 'AI');
    assert.equal(matches.getCell('L2').value.hyperlink, 'https://www.example.com/jobs/legacy');
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
    assert.equal(matches.getCell('M1').value, 'Posting Link');
    const summaryRows = summaryRowsOf(workbook);
    assert.equal(summaryRows['Scoring model'], 'unknown');
    assert.equal(summaryRows['Resume tracks'], 'Data, LLM, AI Agent');
    assert.equal(summaryRows.Warnings, 'None');
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
    assert.equal(workbook.getWorksheet('Matches').getCell('K2').value, 'JD skill not found in resume: dbt; Location unverified — confirm US eligibility');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Run Summary breaks the run down by scoring model, deferred, prefiltered out, and expired, beside the last-90-days total', async () => {
  const runCounts = { scoredByModel: [{ label: 'claude · claude-opus-5-5', count: 9 }, { label: 'codex · gpt-5.6-sol', count: 3 }], localScores: 2, deferred: { budget: 4, quota: 96 }, prefilteredOut: { title: 30, location: 5 }, expired: 7 };
  const payload = {
    meta: { applicationDate: '2026-10-07', date: '2026-10-07', generatedAt: '2026-10-08T01:00:00Z', lookbackHours: 24, reviewedCount: 57, reviewedInRun: 12, reviewedLast90Days: 3480, runCounts, minimumMatchScore: 60, scoringModel: 'local_only', resumeTracks: [{ id: 'data', label: 'Data' }], warnings: [] },
    matches: [], reviewed: [],
  };
  const { workbook, directory } = await buildWorkbook(payload, 'run-counts');
  try {
    const rows = summaryRowsOf(workbook);
    assert.equal(rows['Scored by model (this run)'], 'claude · claude-opus-5-5: 9; codex · gpt-5.6-sol: 3; local scores (unreviewed): 2');
    assert.equal(rows.Deferred, 100);
    assert.equal(rows['Prefiltered out'], 35);
    assert.equal(rows.Expired, 7);
    assert.equal(rows['Reviewed (last 90 days)'], 3480);
    assert.equal(Object.hasOwn(rows, 'Reviewed jobs (this run)'), false, 'the old single count is gone');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
  const legacy = await buildWorkbook({ ...payload, meta: { ...payload.meta, runCounts: undefined, reviewedLast90Days: undefined } }, 'run-counts-legacy');
  try {
    const rows = summaryRowsOf(legacy.workbook);
    assert.deepEqual([rows['Scored by model (this run)'], rows.Deferred, rows['Prefiltered out'], rows.Expired, rows['Reviewed (last 90 days)']], ['not recorded', 'not recorded', 'not recorded', 'not recorded', 'not recorded'], 'an older payload says so instead of guessing');
  } finally {
    await fs.rm(legacy.directory, { recursive: true, force: true });
  }
});
