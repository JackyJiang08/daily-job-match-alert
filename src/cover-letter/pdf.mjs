// Renders the assembled letter to a one-page PDF. Prefers a local Chrome/Chromium headless print (Letter,
// Times New Roman 11pt, 1 inch margins); falls back to pdfkit (built-in Times-Roman). If the first render
// spills to a second page it retries on B5, then with 0.8 inch margins, and reports what it had to do.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { htmlEscape } from '../utils.mjs';

export const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];
const LAYOUTS = [
  { id: 'letter-1in', size: 'Letter', margin: 1, note: null },
  { id: 'b5-1in', size: 'B5', margin: 1, note: 'Rendered on B5 because the letter did not fit one Letter page' },
  { id: 'b5-0.8in', size: 'B5', margin: 0.8, note: 'Rendered on B5 with 0.8 inch margins because the letter still ran long' },
];
const PAGE_POINTS = { Letter: [612, 792], B5: [498.9, 708.66] };

export function letterHtml(letter, layout = LAYOUTS[0]) {
  const paragraphs = letter.paragraphs.map(paragraph => `<p>${htmlEscape(paragraph)}</p>`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${htmlEscape(letter.name)} cover letter</title>
<style>
@page { size: ${layout.size}; margin: ${layout.margin}in; }
html, body { margin: 0; padding: 0; }
body { font-family: "Times New Roman", Times, serif; font-size: 11pt; line-height: 1.35; color: #000; }
header { text-align: center; margin-bottom: 14pt; }
header .name { font-size: 16pt; font-weight: bold; margin: 0 0 3pt; }
header .contact { font-size: 11pt; margin: 0; }
p { margin: 0 0 10pt; text-align: left; }
header p { text-align: center; }
p.date, p.salutation { margin-bottom: 10pt; }
p.closing { margin-top: 10pt; margin-bottom: 18pt; }
p.signature { margin: 0; }
</style></head><body>
<header><p class="name">${htmlEscape(letter.name)}</p>${letter.contact ? `<p class="contact">${htmlEscape(letter.contact)}</p>` : ''}</header>
<p class="date">${htmlEscape(letter.date)}</p>
<p class="salutation">${htmlEscape(letter.salutation)}</p>
${paragraphs}
<p class="closing">${htmlEscape(letter.closing)}</p>
<p class="signature">${htmlEscape(letter.signature)}</p>
</body></html>`;
}

// Page count from the PDF's own structures: the /Pages tree count, else the number of /Page objects.
export function countPdfPages(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('latin1') : String(buffer);
  let best = 0;
  for (const match of text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/g)) best = Math.max(best, Number(match[1]));
  if (best) return best;
  const pages = text.match(/\/Type\s*\/Page\b(?!s)/g);
  return pages ? pages.length : 0;
}

async function findChrome(configured, io) {
  const candidates = [configured, ...CHROME_CANDIDATES].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await io.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function runChrome(command, args, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr = [];
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Chrome print-to-pdf timed out')); }, 60_000);
    child.stderr?.on('data', chunk => stderr.push(chunk));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Chrome exited ${code}: ${Buffer.concat(stderr).toString('utf8').slice(-500)}`));
    });
  });
}

async function renderWithChrome(chrome, letter, layout, outputPath, { io, spawnImpl, tempRoot }) {
  const directory = await io.mkdtemp(path.join(tempRoot, 'daily-job-match-alert-pdf-'));
  try {
    const htmlPath = path.join(directory, 'letter.html');
    await io.writeFile(htmlPath, letterHtml(letter, layout));
    await runChrome(chrome, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--no-margins', `--print-to-pdf=${outputPath}`, `file://${htmlPath}`], spawnImpl);
    return await io.readFile(outputPath);
  } finally {
    await io.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function renderWithPdfkit(letter, layout, outputPath, io) {
  const { default: PDFDocument } = await import('pdfkit');
  const [width, height] = PAGE_POINTS[layout.size] || PAGE_POINTS.Letter;
  const margin = layout.margin * 72;
  const document = new PDFDocument({ size: [width, height], margin, bufferPages: true, info: { Title: `${letter.name} cover letter` } });
  const chunks = [];
  document.on('data', chunk => chunks.push(chunk));
  const done = new Promise(resolve => document.on('end', resolve));
  document.font('Times-Bold').fontSize(16).text(letter.name, { align: 'center' });
  if (letter.contact) document.font('Times-Roman').fontSize(11).text(letter.contact, { align: 'center' });
  document.moveDown(1.2);
  document.font('Times-Roman').fontSize(11).text(letter.date);
  document.moveDown(0.9);
  document.text(letter.salutation);
  document.moveDown(0.9);
  for (const paragraph of letter.paragraphs) {
    document.text(paragraph, { lineGap: 2 });
    document.moveDown(0.9);
  }
  document.text(letter.closing);
  document.moveDown(1.6);
  document.text(letter.signature);
  const pages = document.bufferedPageRange().count;
  document.end();
  await done;
  const buffer = Buffer.concat(chunks);
  await io.writeFile(outputPath, buffer);
  return { buffer, pages };
}

// Returns { path, pages, layout, renderer, note }. `chromeCommand: false` forces the pdfkit path.
export async function renderLetterPdf(letter, outputPath, options = {}) {
  const io = options.io || fs;
  const spawnImpl = options.spawn || spawn;
  const tempRoot = options.tempRoot || os.tmpdir();
  const chrome = options.chromeCommand === false ? null : await findChrome(options.chromeCommand || null, io);
  await io.mkdir(path.dirname(outputPath), { recursive: true });
  let last = null;
  for (const layout of LAYOUTS) {
    let pages;
    let renderer;
    if (chrome) {
      try {
        const buffer = await renderWithChrome(chrome, letter, layout, outputPath, { io, spawnImpl, tempRoot });
        pages = countPdfPages(buffer);
        renderer = 'chrome';
      } catch (error) {
        if (options.strictChrome) throw error;
        const fallback = await renderWithPdfkit(letter, layout, outputPath, io);
        pages = fallback.pages;
        renderer = 'pdfkit';
      }
    } else {
      const fallback = await renderWithPdfkit(letter, layout, outputPath, io);
      pages = fallback.pages;
      renderer = 'pdfkit';
    }
    last = { path: outputPath, pages, layout: layout.id, renderer, note: layout.note };
    if (pages <= 1) return last;
  }
  return { ...last, note: `${last.note ? `${last.note}; ` : ''}the letter still runs to ${last.pages} pages, trim the body` };
}

export { LAYOUTS as PDF_LAYOUTS };
