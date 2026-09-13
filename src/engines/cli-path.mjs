// Finds a subscription CLI binary. launchd jobs run with PATH=/usr/bin:/bin, so a CLI installed by npm,
// Homebrew, or nvm is invisible unless config names it or we look in the usual user locations too.
// Resolution order: the configured path (absolute or ~-relative) when it exists, then every PATH entry,
// then the extra directories below. A miss never throws: the caller still gets the configured name so the
// spawn fails with the same ENOENT it always did.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const EXTRA_BIN_DIRECTORIES = ['~/.local/bin', '/opt/homebrew/bin', '/usr/local/bin', '~/.npm-global/bin', '~/.nvm/versions/node/*/bin'];
export const INSTALL_HINTS = { claude: 'npm i -g @anthropic-ai/claude-code@latest', codex: 'npm i -g @openai/codex' };

function expandHome(value, homedir) {
  if (value === '~') return homedir;
  if (value.startsWith('~/')) return path.join(homedir, value.slice(2));
  return value;
}

async function isExecutable(io, file) {
  try {
    const info = await io.stat(file);
    if (!info.isFile()) return false;
    await io.access(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function expandGlobDirectories(pattern, io) {
  const star = pattern.indexOf('*');
  if (star < 0) return [pattern];
  const parent = pattern.slice(0, star).replace(/\/$/, '');
  const suffix = pattern.slice(star + 1);
  let names = [];
  try { names = await io.readdir(parent); } catch { return []; }
  // Newest node version first, so a freshly installed CLI wins over a stale one.
  return names.sort().reverse().map(name => path.join(parent, name + suffix));
}

export async function candidateDirectories(env = process.env, homedir = os.homedir(), io = fs, extraDirectories = EXTRA_BIN_DIRECTORIES) {
  const fromPath = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  const extra = [];
  for (const entry of extraDirectories) extra.push(...await expandGlobDirectories(expandHome(entry, homedir), io));
  const seen = new Set();
  const ordered = [];
  for (const directory of [...fromPath, ...extra]) {
    if (!seen.has(directory)) { seen.add(directory); ordered.push(directory); }
  }
  return { fromPath: new Set(fromPath), directories: ordered };
}

export async function resolveCliCommand(name, configuredPath = null, options = {}) {
  const io = options.io || fs;
  const env = options.env || process.env;
  const homedir = options.homedir || os.homedir();
  const configured = configuredPath ? String(configuredPath).trim() : '';
  const searched = [];
  let configuredMissing = false;
  // A configured path that points somewhere (absolute, ~/…, or ./…) is used as-is when it exists; when it
  // does not, the lookup continues but the result says so, so the hub can show the stale setting.
  if (configured && /[\\/]/.test(configured)) {
    const absolute = path.resolve(expandHome(configured, homedir));
    searched.push(absolute);
    if (await isExecutable(io, absolute)) return { found: true, command: absolute, source: 'config', configured, configuredMissing, searched };
    configuredMissing = true;
  }
  const binary = configured && !/[\\/]/.test(configured) ? configured : name;
  const { fromPath, directories } = await candidateDirectories(env, homedir, io, options.extraDirectories || EXTRA_BIN_DIRECTORIES);
  for (const directory of directories) {
    const candidate = path.join(directory, binary);
    searched.push(candidate);
    if (await isExecutable(io, candidate)) {
      return { found: true, command: candidate, source: fromPath.has(directory) ? 'path' : 'extra', configured, configuredMissing, searched };
    }
  }
  return { found: false, command: configured || name, source: 'missing', configured, configuredMissing, searched, hint: INSTALL_HINTS[name] || null };
}

// PATH for launchd jobs: the same extra directories, expanded for the given home.
export function launchdPath(homedir = os.homedir()) {
  return [`${homedir}/.local/bin`, `${homedir}/.npm-global/bin`, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':');
}

// PATH for a CLI child process: the caller's PATH plus the standard user directories, so a CLI found
// outside PATH (or an npm wrapper script that needs `node`) still runs under launchd.
export function withCliPath(env = process.env, homedir = os.homedir()) {
  const current = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  const extras = launchdPath(homedir).split(path.delimiter);
  const merged = [...current];
  for (const directory of extras) if (!merged.includes(directory)) merged.push(directory);
  return { ...env, PATH: merged.join(path.delimiter) };
}
