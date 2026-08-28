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

test('writes and re-reads the ExcelJS workbook with formulas, formatting, and capped JD text', async () => {
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
      reviewedCount: 1,
      minimumMatchScore: 70,
      warnings: [{ stage: 'llm', source: 'claude_subscription', message: 'batch fallback' }],
    },
    matches: [{
      source: 'fixture', roleType: 'new_grad', postedAt: '2026-08-27T15:00:00.000Z', discoveredAt: '2026-08-27T20:00:00.000Z',
      company: 'Acme', title: 'Data Analyst', location: 'Remote - US', employmentType: 'FULL_TIME', salary: '',
      dataScore: 88, aiScore: 74, matchLevel: 'unreviewed', scoringEngine: 'local_fallback', reasons: ['SQL'], gaps: [], blockers: [],
      description: 'x'.repeat(40_000), url: 'https://example.com/jobs/42', freshnessBasis: 'jobposting_date_posted',
    }],
  };

  try {
    await fs.writeFile(payloadPath, JSON.stringify(payload));
    await execFileAsync(process.execPath, [builderPath, payloadPath, outputPath, '--verify']);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['Run Summary', 'Matches', 'Notes']);
    const matches = workbook.getWorksheet('Matches');
    assert.equal(matches.actualRowCount, 2);
    assert.equal(matches.getCell('L2').value.formula, 'MAX(J2,K2)');
    assert.equal(matches.getCell('N2').value.formula, 'IF(J2>=K2,"Data","AI")');
    assert.equal(matches.getCell('M2').value, 'unreviewed');
    assert.equal(String(matches.getCell('R2').value).length, 32700);
    assert.equal(matches.conditionalFormattings[0].ref, 'L2:L2');
    assert.equal(matches.views[0].ySplit, 1);
    const summary = workbook.getWorksheet('Run Summary');
    assert.equal(summary.getCell('A15').value, 'Warnings');
    assert.match(summary.getCell('A16').value, /batch fallback/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
