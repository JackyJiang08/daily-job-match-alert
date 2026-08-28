import fs from 'node:fs/promises';
import path from 'node:path';

export function isPidAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') return true;
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function lockOwner(lockPath) {
  try {
    const raw = await fs.readFile(lockPath, 'utf8');
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function acquireRunLock(lockPath, options = {}) {
  const pid = Number(options.pid ?? process.pid);
  const pidAlive = options.pidAlive || (candidate => isPidAlive(candidate, options.kill));
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      try {
        await handle.writeFile(`${pid}\n`);
      } finally {
        await handle.close();
      }
      return { acquired: true, pid, lockPath };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const ownerPid = await lockOwner(lockPath);
      if (ownerPid && pidAlive(ownerPid)) {
        return { acquired: false, pid: ownerPid, lockPath };
      }
      try {
        await fs.rm(lockPath);
      } catch (removeError) {
        if (removeError?.code !== 'ENOENT') throw removeError;
      }
    }
  }
  throw new Error(`Could not acquire run lock after removing a stale lock: ${lockPath}`);
}

export async function releaseRunLock(lock) {
  if (!lock?.acquired) return;
  const ownerPid = await lockOwner(lock.lockPath);
  if (ownerPid !== lock.pid) return;
  await fs.rm(lock.lockPath, { force: true });
}
