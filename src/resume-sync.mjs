import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { enabledResumeTracks } from './config.mjs';
import { createWarning, errorSummary } from './warnings.mjs';

const execFileAsync = promisify(execFile);

// iCloud "Optimize Mac Storage" evicts local copies of Desktop/Documents files and leaves a cloud-only
// placeholder. Reading such a placeholder fails with errno -11 (reported by Node as
// "Unknown system error -11" or EAGAIN) or yields an empty buffer for a file whose size is not zero.
// `brctl download` asks the iCloud daemon to materialize the file again; the read is then retried
// every ICLOUD_RETRY_INTERVAL_MS for up to ICLOUD_MAXIMUM_WAIT_MS.
const ICLOUD_RETRY_INTERVAL_MS = 2_000;
const ICLOUD_MAXIMUM_WAIT_MS = 60_000;
const ICLOUD_EVICTED_ERRNO = -11;

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

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export function isCloudEvictionError(error) {
  if (!error) return false;
  if (error.code === 'EAGAIN' || Number(error.errno) === ICLOUD_EVICTED_ERRNO) return true;
  return /unknown system error -11\b/i.test(String(error.message || ''));
}

class CloudEvictedError extends Error {
  constructor(sourcePath, cause) {
    super(cause ? errorSummary(cause) : `read returned no bytes although ${sourcePath} is not empty`);
    this.name = 'CloudEvictedError';
    this.cause = cause;
  }
}

// Reads the PDF once; a cloud-only placeholder surfaces as CloudEvictedError, anything else propagates.
async function readSourceOnce(sourcePath, readFile, stat) {
  let buffer;
  try {
    buffer = await readFile(sourcePath);
  } catch (error) {
    if (isCloudEvictionError(error)) throw new CloudEvictedError(sourcePath, error);
    throw error;
  }
  if (buffer.length === 0) {
    const info = await stat(sourcePath);
    if (info.size > 0) throw new CloudEvictedError(sourcePath, null);
  }
  return buffer;
}

export function cloudRecoveryFailureMessage(track, sourcePath, cause) {
  return `${track.label} 简历文件被 iCloud 移至云端且自动下载失败，请在 Finder 中右键该文件选择“立即下载”，或将简历移出 iCloud 同步目录。文件：${sourcePath}${cause ? `（最后一次读取错误：${errorSummary(cause, 200)}）` : ''}`;
}

export function cloudRecoveredMessage(track) {
  return `${track.label} 简历曾被 iCloud 云端化，已自动取回`;
}

// Reads a track's PDF, recovering it from iCloud when the local copy was evicted. Returns the bytes
// plus whether a recovery happened. Off macOS, or when brctl is not installed, the original read
// error is rethrown untouched so behavior matches a plain missing or unreadable file.
export async function readResumeSource(track, sourcePath, options = {}) {
  const readFile = options.readFile || fs.readFile;
  const stat = options.stat || fs.stat;
  const runner = options.runner || execFileAsync;
  const platform = options.platform || process.platform;
  const sleep = options.sleep || wait;
  const retryIntervalMs = Number(options.icloudRetryIntervalMs || ICLOUD_RETRY_INTERVAL_MS);
  const maximumWaitMs = Number(options.icloudMaximumWaitMs || ICLOUD_MAXIMUM_WAIT_MS);

  let evicted;
  try {
    return { buffer: await readSourceOnce(sourcePath, readFile, stat), recovered: false };
  } catch (error) {
    if (!(error instanceof CloudEvictedError)) throw error;
    evicted = error;
  }
  const original = evicted.cause || evicted;
  if (platform !== 'darwin') throw original;

  const brctl = options.brctlCommand || 'brctl';
  try {
    await runner(brctl, ['download', sourcePath], { timeout: 30_000 });
  } catch (error) {
    // No brctl at all (non-mac shell, CI image): the recovery mechanism does not apply.
    if (error?.code === 'ENOENT') throw original;
    // brctl exists but complained; the download request is usually still queued, so keep polling.
  }

  const attempts = Math.max(1, Math.ceil(maximumWaitMs / retryIntervalMs));
  let lastError = evicted;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await sleep(retryIntervalMs);
    try {
      return { buffer: await readSourceOnce(sourcePath, readFile, stat), recovered: true };
    } catch (error) {
      if (!(error instanceof CloudEvictedError)) throw error;
      lastError = error;
    }
  }
  const failure = new Error(cloudRecoveryFailureMessage(track, sourcePath, lastError.cause));
  failure.code = 'ICLOUD_EVICTED';
  failure.cause = lastError.cause || lastError;
  throw failure;
}

// Refreshes resumes/<id>.md for every enabled track whose PDF changed since the last run. Disabled
// tracks are skipped entirely; their state entries are left untouched so re-enabling them is cheap.
// Info-level warnings (for example an iCloud recovery) are pushed to options.warnings when given
// and always returned under `warnings`.
export async function syncResumes(config, options = {}) {
  const settings = config.resumes;
  const warnings = [];
  const addWarning = warning => {
    warnings.push(warning);
    if (Array.isArray(options.warnings)) options.warnings.push(warning);
  };
  if (!settings?.autoRefresh) return { refreshed: [], unchanged: [], skipped: [], recovered: [], warnings, enabled: false };

  const statePath = path.join(config.root, 'state', 'resume-sources.json');
  const state = await readSyncState(statePath);
  const refreshed = [];
  const unchanged = [];
  const recovered = [];
  const skipped = (settings.tracks || []).filter(track => track.enabled === false).map(track => track.id);

  for (const track of enabledResumeTracks(config)) {
    const sourcePath = track.pdf;
    if (!sourcePath) throw new Error(`resumes.tracks "${track.id}" needs a pdf path when resumes.autoRefresh is enabled`);
    const read = await readResumeSource(track, sourcePath, options);
    if (read.recovered) {
      recovered.push(track.id);
      addWarning(createWarning('resume', `${track.label} resume`, cloudRecoveredMessage(track), 'info'));
    }
    const sourceHash = digest(read.buffer);
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
  return { refreshed, unchanged, skipped, recovered, warnings, enabled: true };
}

export { extractPdfText, normalizeResumeText, ICLOUD_MAXIMUM_WAIT_MS, ICLOUD_RETRY_INTERVAL_MS };
