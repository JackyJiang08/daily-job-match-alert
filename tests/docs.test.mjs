// The README and docs/ (2026-11-19): the README stays short and fits GitHub's column (at most 120 lines, at most
// 80 characters a line apart from badges and link definitions), keeps its fixed sections, and names no person
// or local path (the public repository URL and the CI badge are allowed); each doc keeps lines to 100 characters and opens with a short summary; every
// relative link and image in the Markdown files points at a file that exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = file => fs.readFile(path.join(ROOT, file), 'utf8');
const DOCS = ['pipeline', 'sources', 'hub', 'cover-letters', 'outreach', 'configuration', 'troubleshooting'].map(name => `docs/${name}.md`);
// What would identify the owner, read from package.json at run time (so no test spells it out): the words of
// the author's name, the GitHub account in the repository URL, an email address, and a home-folder path.
async function personalPattern() {
  const pkg = JSON.parse(await read('package.json'));
  const words = String(pkg.author || '').split(/[^A-Za-z]+/).filter(word => word.length >= 3);
  const owner = /github\.com\/([^/]+)\//.exec(pkg.repository?.url || '')?.[1];
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp([...words, ...(owner ? [owner] : [])].map(item => `\\b${escape(item)}\\b`).concat(['[\\w.+-]+@[\\w-]+\\.[\\w.]+', '/Users/(?!me\\b)\\w']).join('|'), 'i');
}
const width = line => [...line].length;

test('README: at most 120 lines and 80 characters a line (badges and link definitions exempt)', async () => {
  const lines = (await read('README.md')).replace(/\n$/, '').split('\n');
  assert.ok(lines.length <= 120, `${lines.length} lines`);
  const exempt = line => /^\s*!?\[!\[|^\s*!\[[^\]]*\]\(https:\/\/img\.shields\.io|^\s*\[[^\]]+\]:\s/.test(line);
  const wide = lines.map((line, index) => ({ line, number: index + 1 })).filter(({ line }) => !exempt(line) && width(line) > 80);
  assert.deepEqual(wide.map(({ number, line }) => `${number}: ${line}`), []);
});

test('README: title, one sentence, the badges (CI among them), no screenshot, and the fixed sections in order', async () => {
  const text = await read('README.md');
  assert.match(text, /^<div align="center">\n\n# Daily Job Match Alert\n\n[^\n#]+\n/);
  assert.equal((text.match(/img\.shields\.io/g) || []).length, 3);
  assert.match(text, /\[!\[CI\]\(https:\/\/github\.com\/[^)]+\/actions\/workflows\/ci\.yml\/badge\.svg\)\]/);
  assert.doesNotMatch(text, /!\[[^\]]*\]\((?!https:\/\/(img\.shields\.io|github\.com\/[^)]+\/badge\.svg))/, 'no screenshot or other image');
  const headings = [...text.matchAll(/^## (.+)$/gm)].map(match => match[1]);
  assert.deepEqual(headings, ['How It Works', 'Quick Start', 'Make It Yours', 'What You Get', 'Privacy', 'Docs']);
  const section = name => text.split(`## ${name}\n`)[1].split('\n## ')[0];
  const flow = section('How It Works');
  assert.match(flow, /```mermaid\nflowchart LR\n/);
  const nodes = [...flow.matchAll(/\["([^<"]+)<br\/>([^"]+)"\]/g)].map(match => [match[1], match[2]]);
  assert.deepEqual(nodes.map(([name]) => name), ['Collect', 'Filter', 'Score', 'Report', 'CoverLetter', 'Message']);
  for (const [, words] of nodes) assert.ok(words.split(/\s+/).length <= 3, words);
  const commands = section('Quick Start').split('```bash\n')[1].split('```')[0].trim().replace(/ \\\n\s*/g, ' ').split('\n');
  assert.ok(commands.length <= 5);
  assert.deepEqual(commands.map(command => command.split(' ').slice(0, 2).join(' ')), ['git clone', 'npm ci', 'npm run', 'npm run', 'zsh scripts/install-launchd.sh']);
  assert.match(commands[0], /^git clone https:\/\/github\.com\/[^ ]+\.git && cd daily-job-match-alert$/);
  const rows = section('Make It Yours').split('\n').filter(line => line.startsWith('|')).slice(2).map(line => line.split('|')[1].trim());
  assert.deepEqual(rows, ['Resumes', 'Roles', 'Schedule']);
  assert.ok(section('What You Get').split('\n').filter(line => line.startsWith('- ')).length <= 5);
  assert.equal(section('Privacy').split('\n').filter(line => line.startsWith('- ')).length, 3);
  const links = [...section('Docs').matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]);
  assert.deepEqual(links, DOCS, 'the Docs list is exactly the seven docs');
});

test('no personal details in the README, docs/, the setup guide, the checklist, or the playbook example', async () => {
  const PERSONAL = await personalPattern();
  assert.ok(PERSONAL.source.split('|').length >= 3, 'the pattern names the author and the account');
  for (const file of ['README.md', ...DOCS, 'SETUP.zh-CN.md', 'VERIFICATION.md', 'CONTRIBUTING.md', 'SECURITY.md', 'cover-letter/playbook.example.md', 'config.example.json']) {
    // The public repository URL (clone commands, the CI badge) is allowed; anything else naming the owner is not.
    const allowed = line => line.replace(/https:\/\/github\.com\/[^/\s)]+\/daily-job-match-alert(\.git|\/actions\/workflows\/ci\.yml(\/badge\.svg)?)?/g, '');
    const hit = (await read(file)).split('\n').map((line, index) => [index + 1, line]).filter(([, line]) => PERSONAL.test(allowed(line)));
    assert.deepEqual(hit, [], file);
  }
});

test('docs/: lines of at most 100 characters and a summary of at most three lines under the title', async () => {
  for (const file of DOCS) {
    const lines = (await read(file)).split('\n');
    assert.match(lines[0], /^# \S/, `${file} title`);
    assert.equal(lines[1], '', file);
    const summary = lines.slice(2, lines.indexOf('', 2));
    assert.ok(summary.length >= 1 && summary.length <= 3, `${file}: ${summary.length} summary lines`);
    assert.ok(summary.every(line => !line.startsWith('#') && !line.startsWith('- ')), file);
    const long = lines.map((line, index) => [index + 1, line]).filter(([, line]) => width(line) > 100);
    assert.deepEqual(long, [], file);
  }
});

async function markdownFiles() {
  const files = ['README.md', 'SETUP.zh-CN.md', 'VERIFICATION.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CLAUDE.md', ...DOCS, 'cover-letter/playbook.example.md'];
  return files;
}

test('every relative link and image in the Markdown files resolves to a file in the repository', async () => {
  const broken = [];
  for (const file of await markdownFiles()) {
    const text = (await read(file)).replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    for (const [, target] of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const resolved = path.resolve(ROOT, path.dirname(file), decodeURIComponent(target.split('#')[0]));
      if (!resolved.startsWith(ROOT) || !await fs.stat(resolved).then(() => true, () => false)) broken.push(`${file}: ${target}`);
    }
  }
  assert.deepEqual(broken, []);
  assert.equal(await fs.stat(path.join(ROOT, 'docs/images')).then(() => true, () => false), false, 'no image folder');
});
