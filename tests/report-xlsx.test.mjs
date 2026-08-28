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

test('writes and re-reads the ExcelJS workbook with 11 compact columns, hyperlinks, and formatting', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xlsx-report-test-'));
  const payloadPath = path.join(directory, 'payload.json');
  const outputPath = path.join(directory, 'report.xlsx');
  const builderPath = fileURLToPath(new URL('../src/report-xlsx.mjs', import.meta.url));
  const payload = {
    meta: {
      applicationDate: '2026-08-28',
      date: '2026-08-28',
      generatedAt: '2026-08-27T20:00:00.000-05:00',
      lookbackHours: 24,
      reviewedCount: 2,
      minimumMatchScore: 70,
      scoringModel: 'claude-fable-5',
      warnings: [{ stage: 'llm', source: 'claude_subscription', message: 'batch fallback' }],
    },
    matches: [{
      source: 'fixture', roleType: 'new_grad', postedAt: '2026-08-27T15:00:00.000Z', discoveredAt: '2026-08-27T20:00:00.000Z',
      company: 'Acme', title: 'Data Analyst', location: 'Remote - US', employmentType: 'FULL_TIME', salary: '',
      dataScore: 88, aiScore: 74, matchLevel: 'unreviewed', scoringEngine: 'local_fallback', reasons: ['SQL'], gaps: [], blockers: [],
      description: 'x'.repeat(40_000), url: 'https://www.example.com/jobs/42?utm=1', freshnessBasis: 'jobposting_date_posted',
    }, {
      source: 'fixture', roleType: 'internship', postedAt: '2026-08-27T16:00:00.000Z', discoveredAt: '2026-08-27T20:00:00.000Z',
      company: 'Beta', title: 'ML Intern', location: 'Remote - US', dataScore: 60, aiScore: 91, matchLevel: 'high',
      scoringEngine: 'claude_subscription', scoringModel: 'claude-fable-5', reasons: ['PyTorch', 'Experiment tracking'],
      gaps: ['Verify sponsorship'], blockers: [], description: 'Train models.', url: 'https://jobs.beta.io/ml-intern', freshnessBasis: 'jobposting_date_posted',
    }],
  };

  try {
    await fs.writeFile(payloadPath, JSON.stringify(payload));
    await execFileAsync(process.execPath, [builderPath, payloadPath, outputPath, '--verify']);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['Run Summary', 'Matches', 'Notes']);

    const matches = workbook.getWorksheet('Matches');
    assert.equal(matches.actualRowCount, 3);
    const headers = [];
    matches.getRow(1).eachCell(cell => headers.push(cell.value));
    assert.deepEqual(headers, [
      'Company', 'Title', 'Location', 'Role Type', 'Posted At', 'Data Score', 'AI Score',
      'Recommended Resume', 'Why It Matches', 'Gaps / Verify', 'Posting Link',
    ]);
    assert.equal(matches.actualColumnCount, 11);
    assert.equal(matches.getCell('A2').value, 'Acme');
    assert.equal(matches.getCell('D2').value, 'new_grad');
    assert.equal(matches.getCell('H2').value.formula, 'IF(F2>=G2,"Data","AI")');
    assert.equal(matches.getCell('H2').value.result, 'Data');
    assert.equal(matches.getCell('H3').value.result, 'AI');
    assert.equal(matches.getCell('I2').value, '[unreviewed] SQL');
    assert.equal(matches.getCell('I3').value, 'PyTorch; Experiment tracking');
    assert.equal(matches.getCell('J3').value, 'Verify sponsorship');
    assert.deepEqual(
      { text: matches.getCell('K2').value.text, hyperlink: matches.getCell('K2').value.hyperlink },
      { text: 'example.com', hyperlink: 'https://www.example.com/jobs/42?utm=1' },
    );
    assert.equal(matches.getCell('K3').value.text, 'jobs.beta.io');
    assert.equal(matches.getCell('L2').value, null);
    assert.doesNotMatch(JSON.stringify(matches.getRow(2).values), /xxxxxxxxxx/);
    assert.equal(matches.getRow(2).height, undefined);
    assert.equal(matches.getCell('I2').alignment.wrapText, true);
    assert.equal(matches.getCell('J2').alignment.wrapText, true);
    assert.equal(matches.getColumn('I').width, 45);
    assert.equal(matches.getColumn('J').width, 45);
    assert.equal(matches.conditionalFormattings[0].ref, 'F2:G3');
    assert.equal(matches.conditionalFormattings[0].rules[0].type, 'colorScale');
    assert.equal(matches.views[0].ySplit, 1);
    assert.equal(matches.views[0].state, 'frozen');
    assert.equal(matches.getTable('JobMatchesTable')?.name, 'JobMatchesTable');

    const summary = workbook.getWorksheet('Run Summary');
    const summaryRows = {};
    summary.eachRow(row => { if (typeof row.getCell(1).value === 'string') summaryRows[row.getCell(1).value] = row.getCell(2).value; });
    assert.equal(summaryRows['Scoring model'], 'claude-fable-5');
    assert.equal(summaryRows['High matches'], 2);
    assert.equal(summaryRows.Internship.formula, "COUNTIF('Matches'!$D$2:$D$3,\"internship\")");
    assert.equal(summaryRows.Internship.result, 1);
    assert.ok(Object.keys(summaryRows).includes('Warnings'));
    const warningCell = [];
    summary.eachRow(row => { if (/batch fallback/.test(String(row.getCell(1).value))) warningCell.push(row.getCell(1).value); });
    assert.equal(warningCell.length, 1);

    const notes = workbook.getWorksheet('Notes');
    const noteFields = [];
    notes.eachRow(row => noteFields.push(row.getCell(1).value));
    assert.ok(noteFields.includes('Why It Matches'));
    assert.ok(noteFields.includes('Posting Link'));
    assert.ok(noteFields.includes('Scoring model'));
    assert.ok(!noteFields.includes('Full JD'));
    assert.ok(!noteFields.includes('Match Level'));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('an empty match list still writes the 11-column header and passes --verify', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xlsx-report-empty-'));
  const payloadPath = path.join(directory, 'payload.json');
  const outputPath = path.join(directory, 'report.xlsx');
  const builderPath = fileURLToPath(new URL('../src/report-xlsx.mjs', import.meta.url));
  try {
    await fs.writeFile(payloadPath, JSON.stringify({
      meta: { applicationDate: '2026-08-28', date: '2026-08-28', generatedAt: '2026-08-27T20:00:00.000-05:00', lookbackHours: 24, reviewedCount: 0, minimumMatchScore: 70, warnings: [] },
      matches: [],
    }));
    await execFileAsync(process.execPath, [builderPath, payloadPath, outputPath, '--verify']);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    const matches = workbook.getWorksheet('Matches');
    assert.equal(matches.actualRowCount, 1);
    assert.equal(matches.getCell('K1').value, 'Posting Link');
    const summary = workbook.getWorksheet('Run Summary');
    let scoringModel;
    summary.eachRow(row => { if (row.getCell(1).value === 'Scoring model') scoringModel = row.getCell(2).value; });
    assert.equal(scoringModel, 'unknown');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
