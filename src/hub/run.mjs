// "Run Now": starts the pipeline as a child process with the manual trigger, honors the run lock, and
// keeps a bounded log tail for the Status page to poll. One run at a time per hub process.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { caffeinated } from '../caffeinate.mjs';
import { isPidAlive } from '../lock.mjs';
import { writeJsonAtomic } from '../json-file.mjs';

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
    nodeBinary = process.execPath, onFinished = null, platform = process.platform,
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

  // trigger: 'manual' for Run Now, 'auto_catchup' for the network catch-up (src/hub/auto-catchup.mjs).
  async function start({ trigger = 'manual' } = {}) {
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
    // Under `caffeinate -i` on macOS, as the nightly run is, so the Mac stays awake until the run ends.
    const launch = caffeinated(nodeBinary, [entrypoint, '--config', configPath], { platform });
    const child = spawn(launch.command, launch.args, {
      cwd: root,
      env: { ...process.env, DAILY_JOB_MATCH_ALERT_TRIGGER: trigger },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    current = { running: true, startedAt, finishedAt: null, exitCode: null, pid: child.pid ?? null, logPath, matchCount: null, error: null, trigger };
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
    await writeJsonAtomic(file, runs.slice(0, KEEP_RUNS), { io, mode: 0o600 });
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
