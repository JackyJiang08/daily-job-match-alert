// npm run backup                  zip private/, state/ (no payloads or logs), and config.json into the backup
//                                 directory (src/backup.mjs), keeping the newest seven
// npm run restore -- <zip>        write a backup's files back into the project (after a pre-restore backup)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { createBackup, listBackups, resolveBackupDirectory, restoreBackup } from './backup.mjs';
import { formatBytes } from './hub/report-timing.mjs';

function arg(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

// The first argument after the command that is neither a flag nor a flag's value.
function positional(argv) {
  const rest = argv.slice(3);
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--config') { index += 1; continue; }
    if (!rest[index].startsWith('--')) return rest[index];
  }
  return null;
}

export async function main(argv = process.argv, { now = new Date(), log = line => console.log(line), home } = {}) {
  const command = argv[2];
  const config = await loadConfig(arg(argv, '--config', 'config.json'), { notify: () => {} });
  const directory = resolveBackupDirectory(config, { home });
  if (command === 'backup') {
    const result = await createBackup(config, { now, directory });
    log(`Backed up ${result.files} file(s) to ${result.file} (${formatBytes(result.bytes)}).`);
    if (result.removed.length) log(`Removed older backups: ${result.removed.join(', ')}`);
    return result;
  }
  if (command === 'restore') {
    const file = positional(argv);
    if (!file) {
      const available = await listBackups(directory);
      log(`Usage: npm run restore -- <zip>\n${available.length ? `Backups in ${directory}:\n${available.map(item => `  ${item.file}  ${formatBytes(item.bytes)}`).join('\n')}` : `No backups in ${directory} yet.`}`);
      return { usage: true };
    }
    const result = await restoreBackup(config, path.resolve(file), { now, directory });
    if (result.skipped) {
      log(`A run is in progress (PID ${result.pid}); try again when it finishes.`);
      return result;
    }
    log(`Restored ${result.restored.length} file(s) from ${path.basename(file)} (backup of ${result.manifest.createdAt}).`);
    log(`The files it replaced were saved first to ${result.preRestore.file}.`);
    log('Restart the hub so it reads the restored files: npm run hub:restart');
    return result;
  }
  throw new Error(`Unknown command ${JSON.stringify(command)}: use backup or restore`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
