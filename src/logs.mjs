import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dateWithOffset } from './utils.mjs';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

export async function prepareDailyLog(logDirectory, now = new Date(), retentionCount = 30) {
  await fs.mkdir(logDirectory, { recursive: true });
  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const logPath = path.join(logDirectory, `daily-${dateWithOffset(now, localTimeZone, 0)}.log`);
  await fs.appendFile(logPath, '');
  const names = (await fs.readdir(logDirectory))
    .filter(name => /^daily-\d{4}-\d{2}-\d{2}\.log$/.test(name))
    .sort()
    .reverse();
  await Promise.all(names.slice(Number(retentionCount)).map(name => fs.rm(path.join(logDirectory, name), { force: true })));
  return logPath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.resolve(arg('--directory', 'state/logs'));
  prepareDailyLog(directory).then(logPath => console.log(logPath)).catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
