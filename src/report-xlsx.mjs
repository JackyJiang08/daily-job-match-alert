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
  link: 'FF1D4ED8',
};

// Matches sheet layout. Column letters are referenced by formulas and conditional formatting below.
const MATCH_COLUMNS = [
  { header: 'Company', width: 22 },
  { header: 'Title', width: 38 },
  { header: 'Location', width: 22 },
  { header: 'Role Type', width: 13 },
  { header: 'Posted At', width: 18 },
  { header: 'Data Score', width: 11 },
  { header: 'AI Score', width: 10 },
  { header: 'Recommended Resume', width: 18 },
  { header: 'Why It Matches', width: 45, wrap: true },
  { header: 'Gaps / Verify', width: 45, wrap: true },
  { header: 'Posting Link', width: 30 },
];
const MATCH_HEADERS = MATCH_COLUMNS.map(column => column.header);
const COLUMN = Object.fromEntries(MATCH_HEADERS.map((header, index) => [header, index + 1]));
const ROLE_TYPE_LETTER = 'D';
const DATA_SCORE_LETTER = 'F';
const AI_SCORE_LETTER = 'G';
const UNREVIEWED_PREFIX = '[unreviewed]';

const thinBorder = { style: 'thin', color: { argb: COLORS.border } };

function asDate(value) {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed;
}

function linkCell(url) {
  const href = String(url || '').trim();
  if (!href) return '';
  let text = href;
  try {
    text = new URL(href).hostname.replace(/^www\./, '') || href;
  } catch {
    return href;
  }
  return { text, hyperlink: href, tooltip: href };
}

function whyItMatches(job) {
  const reasons = (job.reasons || []).join('; ');
  if (job.matchLevel !== 'unreviewed') return reasons;
  return reasons ? `${UNREVIEWED_PREFIX} ${reasons}` : UNREVIEWED_PREFIX;
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
  const matchesSheet = verification.getWorksheet('Matches');
  assert.equal(
    matchesSheet.actualRowCount,
    expectedMatchCount + 1,
    'Matches row count does not equal header plus payload matches',
  );
  const headerRow = matchesSheet.getRow(1);
  const actualHeaders = [];
  headerRow.eachCell({ includeEmpty: false }, cell => actualHeaders.push(String(cell.value)));
  assert.deepEqual(actualHeaders, MATCH_HEADERS, 'Matches header row does not match the expected 11 columns');
  for (let row = 2; row <= expectedMatchCount + 1; row++) {
    const link = matchesSheet.getCell(row, COLUMN['Posting Link']).value;
    assert.ok(link && typeof link === 'object' && link.hyperlink, `Matches!K${row} is not a hyperlink cell`);
  }
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
  ['Update today', `#${Number(payload.meta.runsToday || 1)}`],
  ['Last updated at', asDate(payload.meta.lastUpdatedAt || payload.meta.generatedAt)],
  ['Lookback hours', payload.meta.lookbackHours],
  ['Reviewed jobs', payload.meta.reviewedCount],
  ['High matches', jobs.length],
  ['Excluded: location outside US', Number(payload.meta.eligibilityExclusions?.location || 0)],
  ['Excluded: graduation window', Number(payload.meta.eligibilityExclusions?.graduation || 0)],
  ['Minimum score', payload.meta.minimumMatchScore],
  ['Scoring model', payload.meta.scoringModel || 'unknown'],
];
const summaryStartRow = 3;
summaryValues.forEach((values, index) => {
  const row = summaryStartRow + index;
  summary.getCell(row, 1).value = values[0];
  summary.getCell(row, 2).value = values[1];
  summary.getCell(row, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.lightSlate } };
  summary.getCell(row, 1).font = { bold: true, color: { argb: COLORS.slate } };
  if (values[1] instanceof Date) summary.getCell(row, 2).numFmt = 'yyyy-mm-dd hh:mm';
});
const summaryEndRow = summaryStartRow + summaryValues.length - 1;
applyOutsideBorder(summary, summaryStartRow, 1, summaryEndRow, 2);

const roleTypeHeaderRow = summaryEndRow + 2;
const roleTypeRange = `'Matches'!$${ROLE_TYPE_LETTER}$2:$${ROLE_TYPE_LETTER}$${Math.max(2, jobs.length + 1)}`;
summary.addRows([
  [],
  ['Role type', 'Count'],
  ['Internship', { formula: `COUNTIF(${roleTypeRange},"internship")`, result: roleCount(jobs, 'internship') }],
  ['New grad', { formula: `COUNTIF(${roleTypeRange},"new_grad")`, result: roleCount(jobs, 'new_grad') }],
  ['Entry level', { formula: `COUNTIF(${roleTypeRange},"entry_level")`, result: roleCount(jobs, 'entry_level') }],
]);
summary.getRow(roleTypeHeaderRow).eachCell(cell => {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.darkTeal } };
  cell.font = { bold: true, color: { argb: COLORS.white } };
});
const roleTypeEndRow = roleTypeHeaderRow + 3;
for (const column of ['A', 'B']) summary.getColumn(column).width = 22;
for (let row = 1; row <= roleTypeEndRow; row++) {
  for (let column = 1; column <= 6; column++) summary.getCell(row, column).alignment = { vertical: 'top', wrapText: true };
}

const warningsTitleRow = roleTypeEndRow + 2;
styleMergedTitle(summary, `A${warningsTitleRow}:F${warningsTitleRow}`, 'Warnings', COLORS.orange, 13, 26);
const warnings = payload.meta.warnings || [];
const warningLines = warnings.length ? warnings.map(warningText) : ['None'];
warningLines.forEach((warning, index) => {
  const row = warningsTitleRow + 1 + index;
  summary.mergeCells(row, 1, row, 6);
  const cell = summary.getCell(row, 1);
  cell.value = warning;
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.lightOrange } };
  cell.font = { color: { argb: COLORS.orangeText } };
  cell.alignment = { vertical: 'top', wrapText: true };
  summary.getRow(row).height = Math.min(96, Math.max(36, 18 * Math.ceil(String(warning).length / 100)));
});
for (const column of ['C', 'D', 'E', 'F']) summary.getColumn(column).width = 12;

const rows = jobs.map(job => [
  job.company,
  job.title,
  job.location,
  job.roleType,
  asDate(job.postedAt),
  job.dataScore,
  job.aiScore,
  null,
  whyItMatches(job),
  (job.gaps || []).join('; '),
  linkCell(job.url),
]);

if (jobs.length) {
  matches.addTable({
    name: 'JobMatchesTable',
    ref: 'A1',
    headerRow: true,
    style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: MATCH_HEADERS.map(name => ({ name })),
    rows,
  });
} else {
  matches.addRow(MATCH_HEADERS);
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
  matches.getCell(rowNumber, COLUMN['Recommended Resume']).value = {
    formula: `IF(${DATA_SCORE_LETTER}${rowNumber}>=${AI_SCORE_LETTER}${rowNumber},"Data","AI")`,
    result: dataScore >= aiScore ? 'Data' : 'AI',
  };
  MATCH_COLUMNS.forEach((column, columnIndex) => {
    matches.getCell(rowNumber, columnIndex + 1).alignment = { vertical: 'top', wrapText: Boolean(column.wrap) };
  });
  matches.getCell(rowNumber, COLUMN['Posted At']).numFmt = 'yyyy-mm-dd hh:mm';
  for (const header of ['Data Score', 'AI Score']) matches.getCell(rowNumber, COLUMN[header]).numFmt = '0';
  const link = matches.getCell(rowNumber, COLUMN['Posting Link']);
  if (link.value && typeof link.value === 'object') link.font = { color: { argb: COLORS.link }, underline: true };
}

if (jobs.length) {
  matches.addConditionalFormatting({
    ref: `${DATA_SCORE_LETTER}2:${AI_SCORE_LETTER}${jobs.length + 1}`,
    rules: [{
      type: 'colorScale',
      cfvo: [{ type: 'min' }, { type: 'percentile', value: 50 }, { type: 'max' }],
      color: [{ argb: COLORS.red }, { argb: COLORS.yellow }, { argb: COLORS.green }],
    }],
  });
}

MATCH_COLUMNS.forEach((column, index) => {
  matches.getColumn(index + 1).width = column.width;
});

styleMergedTitle(notes, 'A1:F1', 'How to read this report', COLORS.darkTeal, 16, 32);
const noteRows = [
  ['Field', 'Meaning'],
  ['Warnings', 'Source, enrichment, subscription, or model-configuration issues that were downgraded so the nightly report could still be generated.'],
  ['Scoring model', 'Model reported by the subscription CLI for semantic review. "unknown" means the CLI output did not identify a model; "local_only" or "none" means no subscription review happened.'],
  ['Data / AI Score', 'Fit score against the corresponding resume from subscription review, or the local triage score for unreviewed rows; not a probability of getting an interview.'],
  ['Recommended Resume', 'Whichever track scored higher for this posting.'],
  ['Why It Matches', 'Matched evidence from the review. A leading [unreviewed] tag means semantic review was unavailable and the local score was retained; verify the fit manually.'],
  ['Gaps / Verify', 'Skills or eligibility details that were not found in the selected resume or need manual confirmation. "Location unverified" means the posting only says Remote or gives no location; confirm it permits work from the United States.'],
  ['Update today', 'How many runs have contributed to this application date. Every run merges its findings into the day\'s stored payload and re-renders the whole report, so a later run never shrinks it.'],
  ['Excluded rows', 'Postings removed by the deterministic eligibility rules before scoring mattered: a location outside the United States, or cohort wording (class of, graduate by, full-time start) that is incompatible with the configured graduation date. They never appear in Matches.'],
  ['Posting Link', 'Clickable link to the original or final resolved posting; the cell shows the domain and the hyperlink carries the full URL.'],
  ['HTML report', 'The full captured JD, salary, employment type, source, discovery time, and freshness basis stay in the companion HTML file.'],
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
