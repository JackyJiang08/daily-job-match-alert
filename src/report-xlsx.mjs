import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { warningText } from './warnings.mjs';

const [jsonPath, outputPath, verifyFlag] = process.argv.slice(2);
if (!jsonPath || !outputPath) {
  console.error('Usage: node src/report-xlsx.mjs <report-payload.json> <output.xlsx> [--verify]');
  process.exit(2);
}

const COLORS = {
  teal: 'FF0F766E',
  darkTeal: 'FF164E63',
  white: 'FFFFFFFF',
  slate: 'FF334155',
  lightSlate: 'FFE2E8F0',
  border: 'FFCBD5E1',
  red: 'FFFEE2E2',
  yellow: 'FFFEF3C7',
  green: 'FFCCFBF1',
  orange: 'FFEA580C',
  lightOrange: 'FFFFF7ED',
  orangeText: 'FF7C2D12',
};

const thinBorder = { style: 'thin', color: { argb: COLORS.border } };

function asDate(value) {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed;
}

function styleMergedTitle(sheet, range, title, fill, size, height) {
  sheet.mergeCells(range);
  const cell = sheet.getCell(range.split(':')[0]);
  cell.value = title;
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  cell.font = { bold: true, color: { argb: COLORS.white }, size };
  cell.alignment = { vertical: 'middle', wrapText: true };
  sheet.getRow(cell.row).height = height;
}

function applyOutsideBorder(sheet, startRow, startColumn, endRow, endColumn) {
  for (let row = startRow; row <= endRow; row++) {
    for (let column = startColumn; column <= endColumn; column++) {
      const cell = sheet.getCell(row, column);
      cell.border = {
        ...(row === startRow ? { top: thinBorder } : {}),
        ...(row === endRow ? { bottom: thinBorder } : {}),
        ...(column === startColumn ? { left: thinBorder } : {}),
        ...(column === endColumn ? { right: thinBorder } : {}),
      };
    }
  }
}

function roleCount(jobs, roleType) {
  return jobs.filter(job => job.roleType === roleType).length;
}

function verifyNoFormulaErrorStrings(workbook) {
  for (const sheet of workbook.worksheets) {
    sheet.eachRow({ includeEmpty: true }, row => {
      row.eachCell({ includeEmpty: true }, cell => {
        assert.doesNotMatch(
          JSON.stringify(cell.value ?? ''),
          /#REF!|#NAME\?/i,
          `${sheet.name}!${cell.address} contains a formula error string`,
        );
      });
    });
  }
}

async function verifyWorkbook(filePath, expectedMatchCount) {
  const verification = new ExcelJS.Workbook();
  await verification.xlsx.readFile(filePath);
  for (const sheetName of ['Run Summary', 'Matches', 'Notes']) {
    assert.ok(verification.getWorksheet(sheetName), `Missing worksheet: ${sheetName}`);
  }
  assert.equal(
    verification.getWorksheet('Matches').actualRowCount,
    expectedMatchCount + 1,
    'Matches row count does not equal header plus payload matches',
  );
  verifyNoFormulaErrorStrings(verification);
}

const payload = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
const jobs = payload.matches || [];
const workbook = new ExcelJS.Workbook();
workbook.creator = 'Daily Job Match Alert';
workbook.created = asDate(payload.meta?.generatedAt) || new Date();
workbook.calcProperties.fullCalcOnLoad = true;

const summary = workbook.addWorksheet('Run Summary', { views: [{ showGridLines: false }] });
const matches = workbook.addWorksheet('Matches', { views: [{ state: 'frozen', ySplit: 1, showGridLines: false }] });
const notes = workbook.addWorksheet('Notes', { views: [{ showGridLines: false }] });

styleMergedTitle(summary, 'A1:F1', 'Daily Job Match Alert', COLORS.teal, 18, 34);
const summaryValues = [
  ['Application date', payload.meta.applicationDate || payload.meta.date],
  ['Generated at', asDate(payload.meta.generatedAt)],
  ['Lookback hours', payload.meta.lookbackHours],
  ['Reviewed jobs', payload.meta.reviewedCount],
  ['High matches', jobs.length],
  ['Minimum score', payload.meta.minimumMatchScore],
];
summaryValues.forEach((values, index) => {
  const row = index + 3;
  summary.getCell(row, 1).value = values[0];
  summary.getCell(row, 2).value = values[1];
  summary.getCell(row, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.lightSlate } };
  summary.getCell(row, 1).font = { bold: true, color: { argb: COLORS.slate } };
});
applyOutsideBorder(summary, 3, 1, 8, 2);
summary.getCell('B4').numFmt = 'yyyy-mm-dd hh:mm';

summary.addRows([
  [],
  ['Role type', 'Count'],
  ['Internship', { formula: `COUNTIF('Matches'!$B$2:$B$${Math.max(2, jobs.length + 1)},"internship")`, result: roleCount(jobs, 'internship') }],
  ['New grad', { formula: `COUNTIF('Matches'!$B$2:$B$${Math.max(2, jobs.length + 1)},"new_grad")`, result: roleCount(jobs, 'new_grad') }],
  ['Entry level', { formula: `COUNTIF('Matches'!$B$2:$B$${Math.max(2, jobs.length + 1)},"entry_level")`, result: roleCount(jobs, 'entry_level') }],
]);
summary.getRow(10).eachCell(cell => {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.darkTeal } };
  cell.font = { bold: true, color: { argb: COLORS.white } };
});
for (const column of ['A', 'B']) summary.getColumn(column).width = 22;
for (let row = 1; row <= 13; row++) {
  for (let column = 1; column <= 6; column++) summary.getCell(row, column).alignment = { vertical: 'top', wrapText: true };
}

styleMergedTitle(summary, 'A15:F15', 'Warnings', COLORS.orange, 13, 26);
const warnings = payload.meta.warnings || [];
const warningLines = warnings.length ? warnings.map(warningText) : ['None'];
warningLines.forEach((warning, index) => {
  const row = index + 16;
  summary.mergeCells(row, 1, row, 6);
  const cell = summary.getCell(row, 1);
  cell.value = warning;
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.lightOrange } };
  cell.font = { color: { argb: COLORS.orangeText } };
  cell.alignment = { vertical: 'top', wrapText: true };
  summary.getRow(row).height = Math.min(96, Math.max(36, 18 * Math.ceil(String(warning).length / 100)));
});
for (const column of ['C', 'D', 'E', 'F']) summary.getColumn(column).width = 12;

const headers = ['Source', 'Role Type', 'Posted At', 'Discovered At', 'Company', 'Title', 'Location', 'Employment Type', 'Salary', 'Data Score', 'AI Score', 'Best Score', 'Match Level', 'Recommended Resume', 'Why It Matches', 'Gaps / Verify', 'Blockers', 'Full JD', 'Posting Link', 'Freshness Basis'];
const rows = jobs.map(job => [
  job.source,
  job.roleType,
  asDate(job.postedAt),
  asDate(job.discoveredAt),
  job.company,
  job.title,
  job.location,
  job.employmentType || '',
  job.salary || '',
  job.dataScore,
  job.aiScore,
  null,
  job.matchLevel || '',
  null,
  (job.reasons || []).join('; '),
  (job.gaps || []).join('; '),
  (job.blockers || []).join('; '),
  String(job.description || '').slice(0, 32700),
  job.url,
  job.freshnessBasis,
]);

if (jobs.length) {
  matches.addTable({
    name: 'JobMatchesTable',
    ref: 'A1',
    headerRow: true,
    style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: headers.map(name => ({ name })),
    rows,
  });
} else {
  matches.addRow(headers);
}

matches.getRow(1).eachCell(cell => {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.teal } };
  cell.font = { bold: true, color: { argb: COLORS.white } };
  cell.alignment = { vertical: 'middle', wrapText: true };
});
matches.getRow(1).height = 30;

for (let index = 0; index < jobs.length; index++) {
  const rowNumber = index + 2;
  const dataScore = Number(jobs[index].dataScore || 0);
  const aiScore = Number(jobs[index].aiScore || 0);
  matches.getCell(rowNumber, 12).value = { formula: `MAX(J${rowNumber},K${rowNumber})`, result: Math.max(dataScore, aiScore) };
  matches.getCell(rowNumber, 14).value = { formula: `IF(J${rowNumber}>=K${rowNumber},"Data","AI")`, result: dataScore >= aiScore ? 'Data' : 'AI' };
  matches.getRow(rowNumber).height = 96;
  for (let column = 1; column <= headers.length; column++) {
    matches.getCell(rowNumber, column).alignment = { vertical: 'top', wrapText: true };
  }
  for (const column of [3, 4]) matches.getCell(rowNumber, column).numFmt = 'yyyy-mm-dd hh:mm';
  for (const column of [10, 11, 12]) matches.getCell(rowNumber, column).numFmt = '0';
}

if (jobs.length) {
  matches.addConditionalFormatting({
    ref: `L2:L${jobs.length + 1}`,
    rules: [{
      type: 'colorScale',
      cfvo: [{ type: 'min' }, { type: 'percentile', value: 50 }, { type: 'max' }],
      color: [{ argb: COLORS.red }, { argb: COLORS.yellow }, { argb: COLORS.green }],
    }],
  });
}

const widths = [19, 13, 18, 18, 22, 38, 22, 17, 18, 11, 10, 11, 13, 18, 42, 38, 28, 72, 55, 24];
widths.forEach((width, index) => {
  matches.getColumn(index + 1).width = width;
});

styleMergedTitle(notes, 'A1:F1', 'How to read this report', COLORS.darkTeal, 16, 32);
const noteRows = [
  ['Field', 'Meaning'],
  ['Warnings', 'Source, enrichment, or subscription failures that were downgraded so the nightly report could still be generated.'],
  ['Data / AI Score', 'Local triage score against the corresponding resume; not a probability of getting an interview.'],
  ['Best Score', 'Higher of the two track scores.'],
  ['Match Level', 'High/medium/low/reject from subscription review. Unreviewed means the local score was retained because semantic review was unavailable.'],
  ['Freshness Basis', 'Whether freshness came from an employer date, source age, email receipt, or first discovery.'],
  ['Gaps / Verify', 'Skills or eligibility details that were not found in the selected resume or need manual confirmation.'],
  ['Full JD', 'Complete captured job description used for matching. Excel cells are capped below 32,767 characters.'],
  ['Posting Link', 'Original or final resolved posting URL.'],
  ['Safety', 'This workbook never submits an application.'],
];
noteRows.forEach((values, index) => {
  const row = index + 3;
  notes.getCell(row, 1).value = values[0];
  notes.getCell(row, 2).value = values[1];
  for (const column of [1, 2]) notes.getCell(row, column).alignment = { vertical: 'top', wrapText: true };
});
notes.getRow(3).eachCell(cell => {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.teal } };
  cell.font = { bold: true, color: { argb: COLORS.white } };
});
notes.getColumn('A').width = 22;
notes.getColumn('B').width = 70;

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await workbook.xlsx.writeFile(outputPath);

if (verifyFlag === '--verify') await verifyWorkbook(outputPath, jobs.length);

console.log(outputPath);
