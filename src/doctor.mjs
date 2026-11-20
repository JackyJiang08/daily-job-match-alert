// npm run doctor: one line per check, ✓ or ✗ with how to fix it (2026-11-19). It reads config.json and looks
// for files and commands; it writes nothing and calls no engine beyond the CLIs' own login status.
//   Node version, config.json, the claude and codex logins, pdftotext, the resume texts, the playbook, and
//   the nightly LaunchAgent.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enabledResumeTracks, loadConfig } from './config.mjs';
import { homeStateOf } from './candidate-profile.mjs';

export const MINIMUM_NODE_MAJOR = 20;
export const LAUNCH_AGENT = 'com.dailyjobmatchalert.daily.plist';

function runCommand(command, args) {
  return new Promise(resolve => {
    execFile(command, args, { timeout: 15_000 }, (error, stdout, stderr) => resolve({ ok: !error || error.code === 99, output: `${stdout || ''}${stderr || ''}`, missing: error?.code === 'ENOENT' }));
  });
}

function check(ok, title, detail, fix = null, { required = true } = {}) {
  return { ok: Boolean(ok), required, title, detail, fix };
}

export async function runDoctor({ root = process.cwd(), configPath = path.join(root, 'config.json'), nodeVersion = process.versions.node, describeConnections = null, run = runCommand, io = fs, homedir = os.homedir() } = {}) {
  const checks = [];
  const major = Number(String(nodeVersion).split('.')[0]);
  checks.push(check(major >= MINIMUM_NODE_MAJOR, 'Node.js', `version ${nodeVersion}`, `install Node.js ${MINIMUM_NODE_MAJOR} or later (brew install node)`));

  let config = null;
  try {
    config = await loadConfig(configPath, { notify: () => {} });
    const problems = [];
    if (config.timeZone) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: config.timeZone }); } catch { problems.push(`unknown timeZone "${config.timeZone}"`); }
    }
    const graduation = config.preferences?.graduationDate;
    if (graduation != null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(graduation))) problems.push('preferences.graduationDate must be YYYY-MM');
    const home = config.preferences?.homeState;
    if (home && !homeStateOf(config.preferences)) problems.push(`preferences.homeState "${home}" is not a US state`);
    checks.push(check(!problems.length, 'config.json', problems.length ? problems.join('; ') : `${enabledResumeTracks(config).length} resume track(s), time zone ${config.timeZone || 'America/Chicago (default)'}`, 'fix the fields named here (docs/configuration.md)'));
  } catch (error) {
    const missing = error.code === 'ENOENT';
    checks.push(check(false, 'config.json', missing ? 'not found' : error.message, missing ? 'run npm run setup' : 'fix the JSON or the field named here (docs/configuration.md)'));
  }

  const connections = describeConnections ? await describeConnections(config).catch(() => null) : null;
  const engineLine = (title, entry) => check(entry?.connected, title, entry?.connected ? (entry.detail || 'signed in') : entry?.installed ? (entry.reason || 'not signed in') : 'not installed', entry?.hint || null, { required: false });
  const claude = engineLine('Claude Code CLI', connections?.claude);
  const codex = engineLine('Codex CLI', connections?.codex);
  checks.push(claude, codex);
  checks.push(check(claude.ok || codex.ok, 'Scoring engine', claude.ok || codex.ok ? 'at least one subscription CLI is signed in' : 'neither CLI is signed in', 'sign in to one of the two CLIs above'));

  const pdftotext = config?.resumes?.pdftotextCommand || 'pdftotext';
  const probe = await run(pdftotext, ['-v']);
  checks.push(check(!probe.missing, 'pdftotext', probe.missing ? 'not found' : (probe.output.split('\n')[0] || 'found'), 'brew install poppler', { required: false }));

  if (config) {
    for (const track of enabledResumeTracks(config)) {
      const size = await io.stat(track.profile).then(info => info.size, () => 0);
      checks.push(check(size >= 250, `Resume: ${track.label}`, size ? `${size} characters of text` : 'no resume text yet', track.pdf ? 'npm run resume:sync' : 'upload the PDF in the hub under Resumes', { required: false }));
    }
    const playbook = path.join(config.root, 'private', 'cover-letter', 'playbook.md');
    checks.push(check(await io.stat(playbook).then(() => true, () => false), 'Cover letter playbook', 'private/cover-letter/playbook.md', 'copy cover-letter/playbook.example.md there, or upload one under Settings > Cover Letters', { required: false }));
  }

  const agent = path.join(homedir, 'Library', 'LaunchAgents', LAUNCH_AGENT);
  const plist = await io.readFile(agent, 'utf8').catch(() => null);
  const hour = /<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/.exec(plist || '')?.[1];
  const minute = /<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/.exec(plist || '')?.[1];
  checks.push(check(Boolean(plist), 'Nightly schedule', plist ? `installed${hour != null ? `, ${hour.padStart(2, '0')}:${String(minute || 0).padStart(2, '0')}` : ''}` : 'LaunchAgent not installed', 'zsh scripts/install-launchd.sh 18 0', { required: false }));

  const ok = checks.every(item => item.ok || !item.required);
  return { ok, checks };
}

export function doctorText({ checks }) {
  return checks.map(item => `${item.ok ? '✓' : '✗'} ${item.title}: ${item.detail}${item.ok || !item.fix ? '' : `. Fix: ${item.fix}`}`).join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { describeConnections } = await import('./engines/index.mjs');
  const at = process.argv.indexOf('--config');
  const configPath = path.resolve(at > 0 ? process.argv[at + 1] : 'config.json');
  const result = await runDoctor({ root: path.dirname(configPath), configPath, describeConnections: config => describeConnections({ claudeCommand: config?.semanticMatching?.claudeCommand, codexCommand: config?.semanticMatching?.codexCommand }) });
  console.log(doctorText(result));
  process.exitCode = result.ok ? 0 : 1;
}
