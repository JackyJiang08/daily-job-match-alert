// Crash-safe writes and reads for the JSON files under state/ and private/.
//
//   writeFileAtomic   writes a temporary file in the same directory, fsyncs it, and renames it over the target,
//                     so a reader (or the next run after a crash or power loss) finds either the old file or the
//                     new one, never half of one. With `backups: N` the file being replaced is kept first as
//                     <file>.1 … <file>.N (newest first; a hard link, so a 90 MB state.json costs no copy).
//   writeJsonAtomic   the same for a JSON value.
//   readJsonWithBackups
//                     parses the file; when it does not parse, falls back to the newest backup that does
//                     (<file>.1, .2, .3). With `restore: true` the broken file is moved aside to
//                     <file>.corrupt-<time> (only the newest one is kept) and the backup copied into place, so
//                     the next write rotates good generations only.
//
// `io` is node:fs/promises or a test double. A double without open() is written with writeFile + rename (no
// fsync); one without rename() is written in place.
import fs from 'node:fs/promises';
import path from 'node:path';

export const STATE_BACKUP_GENERATIONS = 3;

export function backupPath(file, generation) {
  return `${file}.${generation}`;
}

function temporaryPath(file) {
  return `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`;
}

async function exists(io, file) {
  try { await io.stat(file); return true; } catch { return false; }
}

// <file>.N-1 → <file>.N … <file> → <file>.1. The current file stays in place (linked, or copied when the
// file system or the test double cannot link), so there is no moment without it.
export async function rotateBackups(file, generations, io = fs) {
  if (!generations || !(await exists(io, file))) return false;
  for (let generation = generations; generation > 1; generation -= 1) {
    const from = backupPath(file, generation - 1);
    if (await exists(io, from)) await io.rename(from, backupPath(file, generation));
  }
  const first = backupPath(file, 1);
  await io.rm?.(first, { force: true });
  try {
    if (typeof io.link !== 'function') throw new Error('no link');
    await io.link(file, first);
  } catch {
    await io.copyFile(file, first);
  }
  return true;
}

async function syncDirectory(io, directory) {
  if (typeof io.open !== 'function') return;
  let handle;
  try {
    handle = await io.open(directory, 'r');
    await handle.sync();
  } catch {} finally {
    await handle?.close().catch(() => {});
  }
}

export async function writeFileAtomic(file, data, { io = fs, mode, backups = 0 } = {}) {
  await io.mkdir(path.dirname(file), { recursive: true });
  if (typeof io.rename !== 'function') {
    await io.writeFile(file, data, mode != null ? { mode } : undefined);
    return { file, bytes: Buffer.byteLength(data) };
  }
  const temp = temporaryPath(file);
  try {
    if (typeof io.open === 'function') {
      const handle = await io.open(temp, 'w', mode ?? 0o644);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      await io.writeFile(temp, data, mode != null ? { mode } : undefined);
    }
    // A backup that cannot be kept never blocks the write itself.
    if (backups) await rotateBackups(file, backups, io).catch(error => console.warn(`Could not keep a backup of ${path.basename(file)}: ${describeError(error)}`));
    await io.rename(temp, file);
  } catch (error) {
    await io.rm?.(temp, { force: true }).catch(() => {});
    throw error;
  }
  await syncDirectory(io, path.dirname(file));
  return { file, bytes: Buffer.byteLength(data) };
}

// Temporary files a killed writer left behind (<name>.<pid>.<time>.<random>.tmp) older than `olderThanMs`;
// the run calls it at startup under the run lock. Returns the names removed.
export async function sweepTemporaryFiles(directory, { io = fs, now = new Date(), olderThanMs = 10 * 60_000 } = {}) {
  const removed = [];
  for (const name of await io.readdir(directory).catch(() => [])) {
    if (!/\.\d+\.\d+(\.[0-9a-f]+)?\.tmp$/.test(name)) continue;
    const file = path.join(directory, name);
    const info = await io.stat(file).catch(() => null);
    if (!info || now.getTime() - info.mtimeMs < olderThanMs) continue;
    await io.rm(file, { force: true }).catch(() => {});
    removed.push(name);
  }
  return removed;
}

export function jsonText(value, indent = 2) {
  return `${JSON.stringify(value, null, indent || undefined)}\n`;
}

export async function writeJsonAtomic(file, value, { indent = 2, ...options } = {}) {
  return writeFileAtomic(file, jsonText(value, indent), options);
}

function describeError(error) {
  return String(error?.message || error).replace(/\s+/g, ' ').slice(0, 200);
}

async function moveAside(file, now, io) {
  const directory = path.dirname(file);
  const base = path.basename(file);
  const names = await io.readdir(directory).catch(() => []);
  for (const name of names) if (name.startsWith(`${base}.corrupt-`)) await io.rm(path.join(directory, name), { force: true }).catch(() => {});
  const target = `${file}.corrupt-${now.toISOString().replace(/[:.]/g, '-')}`;
  await io.rename(file, target);
  return target;
}

// { value, missing, restored } where restored is null or { from, generation, at (the backup's mtime),
// error (why the file did not parse), quarantined (where the broken file went), none (no backup parsed) }.
// A missing file is { value: fallback, missing: true } (no backup is consulted: a removed state starts
// over, and the seen-count check in src/state-integrity.mjs reports it). With no readable backup the value
// is `fallback` and restored.none is true.
export async function readJsonWithBackups(file, { io = fs, generations = STATE_BACKUP_GENERATIONS, restore = false, now = new Date(), fallback = null } = {}) {
  let text;
  try { text = await io.readFile(file, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return { value: fallback, missing: true, restored: null };
    throw error;
  }
  try {
    return { value: JSON.parse(text), missing: false, restored: null };
  } catch (parseError) {
    let found = null;
    for (let generation = 1; generation <= generations; generation += 1) {
      const candidate = backupPath(file, generation);
      try {
        const backupText = await io.readFile(candidate, 'utf8');
        const value = JSON.parse(backupText);
        const info = await io.stat(candidate).catch(() => null);
        found = { value, backupText, from: candidate, generation, at: info ? new Date(info.mtimeMs).toISOString() : null };
        break;
      } catch {}
    }
    const restored = { from: found?.from || null, generation: found?.generation || null, at: found?.at || null, error: describeError(parseError), quarantined: null, none: !found };
    if (restore) {
      try {
        restored.quarantined = await moveAside(file, now, io);
        if (found) await writeFileAtomic(file, found.backupText, { io });
      } catch {}
    }
    return { value: found ? found.value : fallback, missing: false, restored };
  }
}
