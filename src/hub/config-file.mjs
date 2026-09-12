// Surgical edits to config.json: parse, mutate the object in place, and write it back with the file's
// own indentation. JSON.parse keeps key order, so untouched keys stay where they were and new keys are
// appended. Writes take the pipeline's run lock so they never race the nightly run (which writes state
// and reads config while it holds the same lock).
import fs from 'node:fs/promises';
import path from 'node:path';
import { acquireRunLock, releaseRunLock } from '../lock.mjs';

export class HubLockedError extends Error {
  constructor(pid) {
    super(`The pipeline is running (PID ${pid}); config.json cannot be changed until it finishes`);
    this.name = 'HubLockedError';
    this.code = 'HUB_LOCKED';
    this.pid = pid;
  }
}

export function detectIndent(text) {
  const match = /\n( +)"/.exec(String(text));
  return match ? match[1].length : 2;
}

export async function readConfigFile(configPath, io = fs) {
  const text = await io.readFile(configPath, 'utf8');
  return { text, config: JSON.parse(text), indent: detectIndent(text) };
}

export function lockPathFor(configPath) {
  return path.join(path.dirname(configPath), 'state', '.lock');
}

// mutate(config) edits the parsed object; return false from it to skip the write.
export async function updateConfigFile(configPath, mutate, options = {}) {
  const io = options.fs || fs;
  const lockPath = options.lockPath || lockPathFor(configPath);
  const lock = await acquireRunLock(lockPath, { pidAlive: options.pidAlive, pid: options.pid });
  if (!lock.acquired) throw new HubLockedError(lock.pid);
  try {
    const { config, indent } = await readConfigFile(configPath, io);
    const result = await mutate(config);
    if (result === false) return config;
    const temporary = `${configPath}.hub-${process.pid}.tmp`;
    await io.writeFile(temporary, `${JSON.stringify(config, null, indent)}\n`, { mode: 0o600 });
    await io.rename(temporary, configPath);
    return config;
  } finally {
    await releaseRunLock(lock);
  }
}
