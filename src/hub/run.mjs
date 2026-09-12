// "Run Now": starts the pipeline as a child process with the manual trigger, honors the run lock, and
// keeps a bounded log tail for the Status page to poll. One run at a time per hub process.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isPidAlive } from '../lock.mjs';

const TAIL_LINES = 50;
const KEEP_RUNS = 20;

export async function readLockStatus(lockPath, pidAlive = isPidAlive, io = fs) {
  let raw;
  try {
    raw = await io.readFile(lockPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { locked: false, pid: null, stale: false };
    throw error;
  }
  const pid = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return { locked: false, pid: null, stale: true };
  const alive = pidAlive(pid);
  return { locked: alive, pid, stale: !alive };
}

function tailOf(text, lines = TAIL_LINES) {
  return text.split(/\r?\n/).filter(Boolean).slice(-lines);
}

export function createRunManager(options) {
  const {
    root, configPath, hubDirectory,
    spawn = nodeSpawn, io = fs, now = () => new Date(), pidAlive = isPidAlive,
    nodeBinary = process.execPath, onFinished = null,
  } = options;
  const lockPath = options.lockPath || path.join(root, 'state', '.lock');
  const entrypoint = options.entrypoint || fileURLToPath(new URL('../index.mjs', import.meta.url));
  let current = null;
  let output = '';

  function snapshot() {
    if (!current) return { running: false, startedAt: null, finishedAt: null, exitCode: null, pid: null, logPath: null, tail: [], matchCount: null, error: null };
    return { ...current, tail: tailOf(output) };
  }

  async function availability() {
    if (current?.running) return { available: false, reason: `A manual run started at ${current.startedAt} is still in progress` };
    const lock = await readLockStatus(lockPath, pidAlive, io);
    if (lock.locked) return { available: false, reason: `The pipeline is already running (PID ${lock.pid}); the lock file ${lockPath} is held`, lockedBy: lock.pid };
    return { available: true, reason: null };
  }

  async function start() {
    const gate = await availability();
    if (!gate.available) {
      const error = new Error(gate.reason);
      error.code = 'RUN_UNAVAILABLE';
      throw error;
    }
    const startedAt = now().toISOString();
    const logDirectory = path.join(hubDirectory, 'logs');
    await io.mkdir(logDirectory, { recursive: true });
    const logPath = path.join(logDirectory, `run-${startedAt.replace(/[:.]/g, '-')}.log`);
    output = '';
    const child = spawn(nodeBinary, [entrypoint, '--config', configPath], {
      cwd: root,
      env: { ...process.env, DAILY_JOB_MATCH_ALERT_TRIGGER: 'manual' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    current = { running: true, startedAt, finishedAt: null, exitCode: null, pid: child.pid ?? null, logPath, matchCount: null, error: null, trigger: 'manual' };
    let stdout = '';
    const append = chunk => {
      const text = chunk.toString('utf8');
      output = (output + text).slice(-200_000);
      io.appendFile(logPath, text).catch(() => {});
    };
    child.stdout?.on('data', chunk => { stdout = (stdout + chunk.toString('utf8')).slice(-400_000); append(chunk); });
    child.stderr?.on('data', append);
    const finish = async (code, error) => {
      if (!current?.running) return;
      current.running = false;
      current.finishedAt = now().toISOString();
      current.exitCode = code;
      current.error = error ? String(error.message || error) : null;
      const jsonStart = stdout.indexOf('\n{');
      if (jsonStart >= 0) {
        try { current.matchCount = Number(JSON.parse(stdout.slice(jsonStart + 1)).meta?.matchCount ?? null); } catch {}
      }
      await recordRun({ ...current, tail: undefined });
      if (onFinished) await onFinished(snapshot());
    };
    child.on('error', error => { finish(null, error).catch(() => {}); });
    child.on('close', code => { finish(code, null).catch(() => {}); });
    return snapshot();
  }

  async function recordRun(entry) {
    const file = path.join(hubDirectory, 'runs.json');
    let runs = [];
    try { runs = JSON.parse(await io.readFile(file, 'utf8')); } catch {}
    if (!Array.isArray(runs)) runs = [];
    runs.unshift(entry);
    await io.mkdir(hubDirectory, { recursive: true });
    await io.writeFile(file, `${JSON.stringify(runs.slice(0, KEEP_RUNS), null, 2)}\n`, { mode: 0o600 });
  }

  async function history() {
    try {
      const runs = JSON.parse(await io.readFile(path.join(hubDirectory, 'runs.json'), 'utf8'));
      return Array.isArray(runs) ? runs : [];
    } catch {
      return [];
    }
  }

  return { start, status: snapshot, availability, history, lockPath };
}
