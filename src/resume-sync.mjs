import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { enabledResumeTracks } from './config.mjs';

const execFileAsync = promisify(execFile);

function digest(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function normalizeResumeText(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

async function extractPdfText(sourcePath, options = {}) {
  const command = options.pdftotextCommand || 'pdftotext';
  const runner = options.runner || execFileAsync;
  const result = await runner(command, ['-layout', sourcePath, '-'], {
    timeout: Number(options.timeoutMs || 30_000),
    maxBuffer: 10 * 1024 * 1024,
  });
  const text = normalizeResumeText(result.stdout);
  if (text.length < 250) throw new Error(`PDF text extraction produced too little content: ${sourcePath}`);
  return text;
}

function privateMarkdown(track, text, sourceHash) {
  return `<!-- Generated locally from a private PDF. This file is gitignored. Track: ${track.id}. Source SHA-256: ${sourceHash} -->\n# ${track.label} resume\n\n${text}\n`;
}

async function readSyncState(statePath) {
  try {
    return JSON.parse(await fs.readFile(statePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { sources: {} };
    throw error;
  }
}

// Refreshes resumes/<id>.md for every enabled track whose PDF changed since the last run. Disabled
// tracks are skipped entirely; their state entries are left untouched so re-enabling them is cheap.
export async function syncResumes(config, options = {}) {
  const settings = config.resumes;
  if (!settings?.autoRefresh) return { refreshed: [], unchanged: [], skipped: [], enabled: false };

  const statePath = path.join(config.root, 'state', 'resume-sources.json');
  const state = await readSyncState(statePath);
  const refreshed = [];
  const unchanged = [];
  const skipped = (settings.tracks || []).filter(track => track.enabled === false).map(track => track.id);

  for (const track of enabledResumeTracks(config)) {
    const sourcePath = track.pdf;
    if (!sourcePath) throw new Error(`resumes.tracks "${track.id}" needs a pdf path when resumes.autoRefresh is enabled`);
    const source = await fs.readFile(sourcePath);
    const sourceHash = digest(source);
    const destinationPath = track.profile;
    let destinationExists = true;
    try { await fs.access(destinationPath); } catch { destinationExists = false; }
    if (destinationExists && state.sources?.[track.id]?.sha256 === sourceHash) {
      unchanged.push(track.id);
      continue;
    }

    const text = await extractPdfText(sourcePath, {
      ...options,
      pdftotextCommand: options.pdftotextCommand || settings.pdftotextCommand || 'pdftotext',
    });
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.writeFile(destinationPath, privateMarkdown(track, text, sourceHash), { mode: 0o600 });
    state.sources = state.sources || {};
    state.sources[track.id] = {
      sha256: sourceHash,
      label: track.label,
      sourcePath,
      destinationPath,
      refreshedAt: new Date().toISOString(),
    };
    refreshed.push(track.id);
  }

  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  return { refreshed, unchanged, skipped, enabled: true };
}

export { extractPdfText, normalizeResumeText };
