import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeState } from './state.mjs';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function readState(file) {
  try {
    return normalizeState(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return { seen: {} };
    console.warn(`launchd dispatcher could not read state and will run defensively: ${error.message}`);
    return { seen: {} };
  }
}

export function launchdTrigger(options = {}) {
  const requested = options.requested || 'auto';
  if (requested === 'scheduled' || requested === 'catchup') return requested;
  if (requested !== 'auto') throw new Error(`Unknown launchd trigger mode: ${requested}`);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const scheduled = new Date(now);
  scheduled.setHours(Number(options.hour ?? 20), Number(options.minute ?? 0), 0, 0);
  const lastSuccess = options.lastSuccessfulRun ? new Date(options.lastSuccessfulRun).getTime() : Number.NaN;
  return now >= scheduled && (!Number.isFinite(lastSuccess) || lastSuccess < scheduled.getTime())
    ? 'scheduled'
    : 'catchup';
}

function runNode(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: options.cwd, env: options.env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`launchd ${options.trigger} run exited with code ${code}`));
    });
  });
}

export async function dispatchLaunchd(options = {}) {
  const configPath = path.resolve(options.configPath || arg('--config', 'config.json'));
  const projectDirectory = path.dirname(configPath);
  const state = await (options.readState || readState)(path.join(projectDirectory, 'state', 'state.json'));
  const trigger = launchdTrigger({
    requested: options.requested || process.env.DAILY_JOB_MATCH_ALERT_TRIGGER || 'auto',
    now: options.now || new Date(),
    hour: options.hour ?? process.env.DAILY_JOB_MATCH_ALERT_SCHEDULE_HOUR ?? 20,
    minute: options.minute ?? process.env.DAILY_JOB_MATCH_ALERT_SCHEDULE_MINUTE ?? 0,
    lastSuccessfulRun: state.lastSuccessfulRun,
  });
  const entrypoint = fileURLToPath(new URL(trigger === 'scheduled' ? './index.mjs' : './catchup.mjs', import.meta.url));
  console.log(`[${new Date().toISOString()}] launchd trigger: ${trigger}`);
  await (options.runner || runNode)([entrypoint, '--config', configPath], {
    cwd: projectDirectory,
    env: { ...process.env, DAILY_JOB_MATCH_ALERT_TRIGGER: trigger },
    trigger,
  });
  return trigger;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  dispatchLaunchd().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
