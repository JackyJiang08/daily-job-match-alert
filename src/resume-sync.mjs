import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
  const label = track === 'data' ? 'Data resume' : 'AI / ML resume';
  return `<!-- Generated locally from a private PDF. This file is gitignored. Source SHA-256: ${sourceHash} -->\n# ${label}\n\n${text}\n`;
}

async function readSyncState(statePath) {
  try {
    return JSON.parse(await fs.readFile(statePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { sources: {} };
    throw error;
  }
}

export async function syncResumes(config, options = {}) {
  const settings = config.resumeSources;
  if (!settings?.autoRefresh) return { refreshed: [], unchanged: [], enabled: false };

  const statePath = path.join(config.root, 'state', 'resume-sources.json');
  const state = await readSyncState(statePath);
  const refreshed = [];
  const unchanged = [];

  for (const track of ['data', 'ai']) {
    const sourcePath = settings[`${track}Pdf`];
    if (!sourcePath) throw new Error(`resumeSources.${track}Pdf is required when autoRefresh is enabled`);
    const source = await fs.readFile(sourcePath);
    const sourceHash = digest(source);
    const destinationPath = config.resumes[track];
    let destinationExists = true;
    try { await fs.access(destinationPath); } catch { destinationExists = false; }
    if (destinationExists && state.sources?.[track]?.sha256 === sourceHash) {
      unchanged.push(track);
      continue;
    }

    const text = await extractPdfText(sourcePath, options);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.writeFile(destinationPath, privateMarkdown(track, text, sourceHash), { mode: 0o600 });
    state.sources = state.sources || {};
    state.sources[track] = {
      sha256: sourceHash,
      sourcePath,
      destinationPath,
      refreshedAt: new Date().toISOString(),
    };
    refreshed.push(track);
  }

  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  return { refreshed, unchanged, enabled: true };
}

export { extractPdfText, normalizeResumeText };
