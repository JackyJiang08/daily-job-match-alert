import fs from 'node:fs/promises';
import path from 'node:path';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const [jsonPath, outputPath, verifyFlag] = process.argv.slice(2);
if (!jsonPath || !outputPath) {
  console.error('Usage: node src/report-xlsx.mjs <report-payload.json> <output.xlsx> [--verify]');
  process.exit(2);
}

const payload = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
const jobs = payload.matches || [];
const workbook = Workbook.create();
const summary = workbook.worksheets.add('Run Summary');
const matches = workbook.worksheets.add('Matches');
const setup = workbook.worksheets.add('Notes');

for (const sheet of [summary, matches, setup]) sheet.showGridLines = false;

summary.getRange('A1:F1').merge();
summary.getRange('A1').values = [['Daily Job Match Alert']];
summary.getRange('A1:F1').format = { fill: '#0F766E', font: { bold: true, color: '#FFFFFF', size: 18 }, rowHeight: 34 };
summary.getRange('A3:B8').values = [
  ['Application date', payload.meta.applicationDate || payload.meta.date],
  ['Generated at', payload.meta.generatedAt],
  ['Lookback hours', payload.meta.lookbackHours],
  ['Reviewed jobs', payload.meta.reviewedCount],
  ['High matches', jobs.length],
  ['Minimum score', payload.meta.minimumMatchScore],
];
summary.getRange('A3:A8').format = { fill: '#E2E8F0', font: { bold: true, color: '#334155' } };
summary.getRange('A3:B8').format.borders = { preset: 'outside', style: 'thin', color: '#CBD5E1' };
summary.getRange('B4').format.numberFormat = 'yyyy-mm-dd hh:mm';
summary.getRange('A10:B13').values = [['Role type', 'Count'], ['Internship', null], ['New grad', null], ['Entry level', null]];
summary.getRange('B11').formulas = [[`=COUNTIF('Matches'!$B$2:$B$${Math.max(2, jobs.length + 1)},"internship")`]];
summary.getRange('B12').formulas = [[`=COUNTIF('Matches'!$B$2:$B$${Math.max(2, jobs.length + 1)},"new_grad")`]];
summary.getRange('B13').formulas = [[`=COUNTIF('Matches'!$B$2:$B$${Math.max(2, jobs.length + 1)},"entry_level")`]];
summary.getRange('A10:B10').format = { fill: '#164E63', font: { bold: true, color: '#FFFFFF' } };
summary.getRange('A1:F13').format.wrapText = true;
summary.getRange('A:B').format.columnWidth = 22;

const headers = ['Source', 'Role Type', 'Posted At', 'Discovered At', 'Company', 'Title', 'Location', 'Employment Type', 'Salary', 'Data Score', 'AI Score', 'Best Score', 'Match Level', 'Recommended Resume', 'Why It Matches', 'Gaps / Verify', 'Blockers', 'Full JD', 'Posting Link', 'Freshness Basis'];
matches.getRangeByIndexes(0, 0, 1, headers.length).values = [headers];
matches.getRangeByIndexes(0, 0, 1, headers.length).format = { fill: '#0F766E', font: { bold: true, color: '#FFFFFF' }, rowHeight: 30, wrapText: true };

if (jobs.length) {
  const rows = jobs.map(job => [
    job.source, job.roleType, job.postedAt || '', job.discoveredAt || '', job.company, job.title, job.location,
    job.employmentType || '', job.salary || '', job.dataScore, job.aiScore, null, job.matchLevel || '', null,
    (job.reasons || []).join('; '), (job.gaps || []).join('; '), (job.blockers || []).join('; '),
    String(job.description || '').slice(0, 32700), job.url, job.freshnessBasis,
  ]);
  matches.getRangeByIndexes(1, 0, rows.length, headers.length).values = rows;
  matches.getRange(`C2:D${jobs.length + 1}`).format.numberFormat = 'yyyy-mm-dd hh:mm';
  matches.getRange(`A2:T${jobs.length + 1}`).format.rowHeight = 96;
  for (let row = 2; row <= jobs.length + 1; row++) {
    matches.getRange(`L${row}`).formulas = [[`=MAX(J${row},K${row})`]];
    matches.getRange(`N${row}`).formulas = [[`=IF(J${row}>=K${row},"Data","AI")`]];
  }
  matches.tables.add(`A1:T${jobs.length + 1}`, true, 'JobMatchesTable').style = 'TableStyleMedium2';
  matches.getRange(`J2:L${jobs.length + 1}`).format.numberFormat = '0';
  matches.getRange(`L2:L${jobs.length + 1}`).conditionalFormats.add('colorScale', {
    colors: ['#FEE2E2', '#FEF3C7', '#CCFBF1'], thresholds: ['min', '50%', 'max'],
  });
}
matches.freezePanes.freezeRows(1);
matches.getRange('A:T').format.wrapText = true;
const widths = [19, 13, 18, 18, 22, 38, 22, 17, 18, 11, 10, 11, 13, 18, 42, 38, 28, 72, 55, 24];
widths.forEach((width, index) => { matches.getRangeByIndexes(0, index, Math.max(2, jobs.length + 1), 1).format.columnWidth = width; });

setup.getRange('A1:F1').merge();
setup.getRange('A1').values = [['How to read this report']];
setup.getRange('A1:F1').format = { fill: '#164E63', font: { bold: true, color: '#FFFFFF', size: 16 }, rowHeight: 32 };
setup.getRange('A3:B10').values = [
  ['Field', 'Meaning'],
  ['Data / AI Score', 'Local triage score against the corresponding resume; not a probability of getting an interview.'],
  ['Best Score', 'Higher of the two track scores.'],
  ['Freshness Basis', 'Whether freshness came from an employer date, source age, email receipt, or first discovery.'],
  ['Gaps / Verify', 'Skills or eligibility details that were not found in the selected resume or need manual confirmation.'],
  ['Full JD', 'Complete captured job description used for matching. Excel cells are capped below 32,767 characters.'],
  ['Posting Link', 'Original or final resolved posting URL.'],
  ['Safety', 'This workbook never submits an application.'],
];
setup.getRange('A3:B3').format = { fill: '#0F766E', font: { bold: true, color: '#FFFFFF' } };
setup.getRange('A3:B10').format.wrapText = true;
setup.getRange('A:A').format.columnWidth = 22;
setup.getRange('B:B').format.columnWidth = 70;

if (verifyFlag === '--verify') {
  console.log((await workbook.inspect({ kind: 'table', range: 'Run Summary!A1:B13', include: 'values,formulas', tableMaxRows: 15, tableMaxCols: 5 })).ndjson);
  console.log((await workbook.inspect({ kind: 'table', range: `Matches!A1:T${Math.max(2, jobs.length + 1)}`, include: 'values,formulas', tableMaxRows: 5, tableMaxCols: 20 })).ndjson);
  console.log((await workbook.inspect({ kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A', options: { useRegex: true, maxResults: 100 }, summary: 'final formula error scan' })).ndjson);
  const previewDir = path.join(path.dirname(outputPath), '.verification');
  await fs.mkdir(previewDir, { recursive: true });
  for (const sheetName of ['Run Summary', 'Matches', 'Notes']) {
    const preview = await workbook.render({ sheetName, autoCrop: 'all', scale: 1, format: 'png' });
    await fs.writeFile(path.join(previewDir, `${sheetName.replaceAll(' ', '-')}.png`), new Uint8Array(await preview.arrayBuffer()));
  }
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(outputPath);
