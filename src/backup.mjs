// Dated zip backups of what cannot be rebuilt: private/, state/ (without the day payloads, logs, the
// payload backups, and the rolling state.json.N copies), and config.json.
//
//   Where      config.backup.directory (a leading ~ is the home directory, a relative path is from the
//              project), default ~/Library/Application Support/daily-job-match-alert/backups.
//   When       `npm run backup` any time; after every scheduled (or catch-up) run once per local day
//              (autoBackupAfterRun, src/index.mjs main; config.backup.auto false turns it off). The newest
//              BACKUP_KEEP (7) are kept.
//   Restore    `npm run restore -- <zip>` (src/backup-cli.mjs): every file in the zip is written back
//              atomically under the run lock, after a "-pre-restore" backup of the current files.
// Each zip holds backup-manifest.json ({ version, app, createdAt, files: [{ path, size }] }).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createZip, readZip } from './zip.mjs';
import { STATE_BACKUP_GENERATIONS, writeFileAtomic } from './json-file.mjs';
import { acquireRunLock, releaseRunLock } from './lock.mjs';
import { DEFAULT_TIME_ZONE, localDate } from './time-format.mjs';

export const BACKUP_KEEP = 7;
export const BACKUP_VERSION = 1;
export const BACKUP_PREFIX = 'daily-job-match-alert-backup-';
export const BACKUP_FILE_PATTERN = /^daily-job-match-alert-backup-(\d{4}-\d{2}-\d{2})-(\d{6})(-pre-restore)?\.zip$/;
export const MANIFEST_NAME = 'backup-manifest.json';
// Triggers that count as the night's run (src/index.mjs meta.trigger).
export const NIGHTLY_TRIGGERS = ['scheduled', 'catchup', 'auto_catchup'];
const PAYLOAD_NAME = /^report-payload-\d{4}-\d{2}-\d{2}\.json(\.gz)?$/;
// Files whose replaced copy a restore keeps as <file>.1 (src/json-file.mjs).
const ROTATED = new Set(['state/state.json', 'state/ats-boards.json']);

export function defaultBackupDirectory(home = os.homedir()) {
  return path.join(home, 'Library', 'Application Support', 'daily-job-match-alert', 'backups');
}

export function resolveBackupDirectory(config, { home = os.homedir() } = {}) {
  const configured = typeof config?.backup?.directory === 'string' ? config.backup.directory.trim() : '';
  if (!configured) return defaultBackupDirectory(home);
  if (configured === '~' || configured.startsWith('~/')) return path.join(home, configured.slice(2));
  return path.isAbsolute(configured) ? configured : path.resolve(config.root || '.', configured);
}

// Whether a project-relative path (forward slashes) goes into a backup.
export function isBackedUp(relative) {
  if (relative === 'config.json') return true;
  const parts = relative.split('/');
  if (!['private', 'state'].includes(parts[0]) || parts.length < 2) return false;
  const name = parts.at(-1);
  if (parts.includes('logs') || name.endsWith('.log')) return false;
  if (parts[0] === 'state' && parts[1] === 'backups') return false;
  if (parts[0] === 'state' && parts.length === 2 && PAYLOAD_NAME.test(name)) return false;
  if (name === '.DS_Store' || name.endsWith('.tmp') || name.endsWith('.lock') || /\.json\.\d+$/.test(name) || /\.corrupt-/.test(name)) return false;
  return true;
}

async function walk(root, relative, io, files) {
  let entries = [];
  try { entries = await io.readdir(path.join(root, relative), { withFileTypes: true }); } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (child === 'state/backups' || entry.name === 'logs') continue;
      await walk(root, child, io, files);
    } else if (entry.isFile() && isBackedUp(child)) {
      files.push(child);
    }
  }
}

// Project-relative paths (sorted) of every file a backup holds.
export async function collectBackupFiles(root, io = fs) {
  const files = [];
  try { await io.stat(path.join(root, 'config.json')); files.push('config.json'); } catch {}
  await walk(root, 'private', io, files);
  await walk(root, 'state', io, files);
  return files.sort();
}

function localStamp(now, timeZone = DEFAULT_TIME_ZONE) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(part => [part.type, part.value]));
  return `${localDate(now, timeZone)}-${parts.hour}${parts.minute}${parts.second}`;
}

// [{ name, file, bytes, modifiedAt, date, preRestore }] newest first.
export async function listBackups(directory, io = fs) {
  let names = [];
  try { names = await io.readdir(directory); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const backups = [];
  for (const name of names) {
    const match = BACKUP_FILE_PATTERN.exec(name);
    if (!match) continue;
    const info = await io.stat(path.join(directory, name)).catch(() => null);
    if (!info) continue;
    backups.push({ name, file: path.join(directory, name), bytes: info.size, modifiedAt: new Date(info.mtimeMs).toISOString(), date: match[1], preRestore: Boolean(match[3]) });
  }
  return backups.sort((a, b) => b.name.slice(BACKUP_PREFIX.length, BACKUP_PREFIX.length + 17).localeCompare(a.name.slice(BACKUP_PREFIX.length, BACKUP_PREFIX.length + 17)) || b.modifiedAt.localeCompare(a.modifiedAt));
}

export async function pruneBackups(directory, keep = BACKUP_KEEP, io = fs) {
  const removed = [];
  for (const backup of (await listBackups(directory, io)).slice(Math.max(1, keep))) {
    await io.rm(backup.file, { force: true });
    removed.push(backup.name);
  }
  return removed;
}

// { file, name, bytes, files, removed }
export async function createBackup(config, { now = new Date(), io = fs, directory = null, home, keep = BACKUP_KEEP, label = '' } = {}) {
  const root = config.root;
  const target = directory || resolveBackupDirectory(config, { home });
  const entries = [];
  const listed = [];
  for (const relative of await collectBackupFiles(root, io)) {
    const file = path.join(root, relative);
    let data;
    let info;
    try {
      [data, info] = await Promise.all([io.readFile(file), io.stat(file)]);
    } catch (error) {
      // A file removed between the listing and the read (a letter renamed meanwhile) is simply left out.
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    entries.push({ name: relative, data, mode: info.mode & 0o7777, mtime: new Date(info.mtimeMs) });
    listed.push({ path: relative, size: data.length });
  }
  const manifest = { version: BACKUP_VERSION, app: 'daily-job-match-alert', createdAt: now.toISOString(), files: listed };
  entries.unshift({ name: MANIFEST_NAME, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), mode: 0o600, mtime: now });
  const archive = await createZip(entries);
  const name = `${BACKUP_PREFIX}${localStamp(now, config.timeZone || DEFAULT_TIME_ZONE)}${label}.zip`;
  const file = path.join(target, name);
  await writeFileAtomic(file, archive, { io, mode: 0o600 });
  const removed = await pruneBackups(target, keep, io);
  return { file, name, directory: target, bytes: archive.length, files: listed.length, removed };
}

function assertRestorable(name) {
  if (name === MANIFEST_NAME) return false;
  const parts = name.split('/');
  if (name.includes('\\') || path.isAbsolute(name) || parts.some(part => part === '..' || part === '.' || part === '')) throw new Error(`refusing to restore ${JSON.stringify(name)}: not a plain project path`);
  if (name !== 'config.json' && !['private', 'state'].includes(parts[0])) throw new Error(`refusing to restore ${JSON.stringify(name)}: only config.json, private/, and state/ are restored`);
  return true;
}

// { manifest, entries } of a backup zip; throws when it is not one.
export async function readBackup(file, io = fs) {
  const entries = await readZip(await io.readFile(file));
  const manifestEntry = entries.find(entry => entry.name === MANIFEST_NAME);
  if (!manifestEntry) throw new Error(`${path.basename(file)} is not a Daily Job Match Alert backup (no ${MANIFEST_NAME})`);
  const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  if (manifest?.app !== 'daily-job-match-alert') throw new Error(`${path.basename(file)} is not a Daily Job Match Alert backup`);
  const files = entries.filter(entry => assertRestorable(entry.name));
  return { manifest, entries: files };
}

// Writes every file of the backup back into the project (atomically; state.json and ats-boards.json keep
// the copy they replace as .1). Files not in the backup are left alone. The caller holds the run lock.
export async function restoreFiles(config, file, { io = fs } = {}) {
  const { manifest, entries } = await readBackup(file, io);
  for (const entry of entries) {
    await writeFileAtomic(path.join(config.root, ...entry.name.split('/')), entry.data, { io, mode: entry.mode, backups: ROTATED.has(entry.name) ? STATE_BACKUP_GENERATIONS : 0 });
  }
  return { manifest, restored: entries.map(entry => entry.name) };
}

// The restore command: run lock, a pre-restore backup of the current files, then restoreFiles.
export async function restoreBackup(config, file, { io = fs, now = new Date(), directory = null, home, lockOptions } = {}) {
  await readBackup(file, io);
  const lock = await acquireRunLock(path.join(config.root, 'state', '.lock'), lockOptions);
  if (!lock.acquired) return { skipped: true, pid: lock.pid };
  try {
    const safety = await createBackup(config, { now, io, directory, home, label: '-pre-restore' });
    const result = await restoreFiles(config, file, { io });
    return { ...result, preRestore: safety };
  } finally {
    await releaseRunLock(lock).catch(() => {});
  }
}

// After a run (src/index.mjs main): one backup per local day, after the scheduled or catch-up run only, so
// Run Now, the demo, and tests never add one. Takes the run lock (skips when a run holds it).
export async function autoBackupAfterRun(config, { trigger, now = new Date(), io = fs, directory = null, home, lockOptions } = {}) {
  if (config.backup?.auto === false) return { skipped: 'off' };
  if (!NIGHTLY_TRIGGERS.includes(trigger)) return { skipped: 'trigger' };
  const target = directory || resolveBackupDirectory(config, { home });
  const today = localDate(now, config.timeZone);
  if ((await listBackups(target, io)).some(backup => !backup.preRestore && backup.date === today)) return { skipped: 'done today' };
  const lock = await acquireRunLock(path.join(config.root, 'state', '.lock'), lockOptions);
  if (!lock.acquired) return { skipped: 'locked', pid: lock.pid };
  try {
    return await createBackup(config, { now, io, directory: target });
  } finally {
    await releaseRunLock(lock).catch(() => {});
  }
}
