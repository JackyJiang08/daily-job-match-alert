import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeState } from './state.mjs';

const MAX_SUCCESS_AGE_HOURS = 26;

function arg(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

async function readState(file) {
  try {
    return normalizeState(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return { seen: {} };
    console.warn(`Catch-up could not read state and will run defensively: ${error.message}`);
    return { seen: {} };
  }
}

export function shouldRunCatchup(state, now = new Date(), maximumAgeHours = MAX_SUCCESS_AGE_HOURS) {
  const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(nowTime)) throw new Error('Catch-up time must be a valid date');
  const lastSuccess = state?.lastSuccessfulRun ? new Date(state.lastSuccessfulRun).getTime() : Number.NaN;
  if (!Number.isFinite(lastSuccess)) return true;
  return nowTime - lastSuccess > Number(maximumAgeHours) * 60 * 60 * 1000;
}

function runNode(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: options.cwd, env: options.env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ code });
      else reject(new Error(`Catch-up run exited with code ${code}`));
    });
  });
}

export async function runCatchup(options = {}) {
  const argv = options.argv || process.argv;
  const configPath = path.resolve(options.configPath || arg(argv, '--config', 'config.json'));
  const nowValue = options.now || arg(argv, '--now', new Date().toISOString());
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  if (Number.isNaN(now.getTime())) throw new Error('--now must be a valid ISO date');
  const projectDirectory = path.dirname(configPath);
  const statePath = path.join(projectDirectory, 'state', 'state.json');
  const state = await (options.readState || readState)(statePath);
  if (!shouldRunCatchup(state, now, options.maximumAgeHours ?? MAX_SUCCESS_AGE_HOURS)) {
    console.log(`Catch-up skipped: last successful run was ${state.lastSuccessfulRun} (within ${options.maximumAgeHours ?? MAX_SUCCESS_AGE_HOURS} hours).`);
    return { ran: false, statePath };
  }

  const indexPath = fileURLToPath(new URL('./index.mjs', import.meta.url));
  const runArgs = [indexPath, '--config', configPath, '--now', now.toISOString()];
  await (options.runner || runNode)(runArgs, { cwd: projectDirectory, env: process.env });
  return { ran: true, statePath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCatchup().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

export { MAX_SUCCESS_AGE_HOURS };
