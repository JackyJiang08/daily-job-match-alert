import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LEGACY_RESUME_CONFIG_NOTICE, enabledResumeTracks, loadConfig, loadResumes, normalizeResumeConfig } from '../src/config.mjs';

async function writeConfig(root, body) {
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(body));
  return configPath;
}

test('normalizes resumes.tracks with defaults, absolute paths, and the enabled flag', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'config-tracks-'));
  try {
    const configPath = await writeConfig(root, {
      resumes: {
        autoRefresh: true,
        pdftotextCommand: '/opt/homebrew/bin/pdftotext',
        tracks: [
          { id: 'data', label: 'Data', pdf: './Data.pdf' },
          { id: 'llm', pdf: '~/Desktop/LLM.pdf', enabled: true },
          { id: 'agent', label: 'AI Agent', profile: './custom/agent-profile.md', enabled: false },
        ],
      },
    });
    const notices = [];
    const config = await loadConfig(configPath, { notify: message => notices.push(message) });
    assert.deepEqual(notices, []);
    assert.equal(config.resumes.legacyLayout, false);
    assert.equal(config.resumes.autoRefresh, true);
    assert.equal(config.resumes.pdftotextCommand, '/opt/homebrew/bin/pdftotext');
    assert.equal(config.resumeSources, undefined);
    assert.deepEqual(config.resumes.tracks.map(track => [track.id, track.label, track.enabled]), [['data', 'Data', true], ['llm', 'Llm', true], ['agent', 'AI Agent', false]]);
    assert.equal(config.resumes.tracks[0].profile, path.join(root, 'resumes', 'data.md'));
    assert.equal(config.resumes.tracks[0].pdf, path.join(root, 'Data.pdf'));
    assert.equal(config.resumes.tracks[1].pdf, path.join(os.homedir(), 'Desktop', 'LLM.pdf'));
    assert.equal(config.resumes.tracks[2].profile, path.join(root, 'custom', 'agent-profile.md'));
    assert.deepEqual(enabledResumeTracks(config).map(track => track.id), ['data', 'llm']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('migrates the legacy resumes + resumeSources layout in memory and prints an upgrade notice', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'config-legacy-'));
  try {
    const configPath = await writeConfig(root, {
      resumes: { data: './resumes/data.md', ai: './resumes/ai.md' },
      resumeSources: { autoRefresh: true, pdftotextCommand: '/opt/homebrew/bin/pdftotext', dataPdf: '~/Desktop/DA.pdf', aiPdf: '~/Desktop/AI.pdf' },
    });
    const notices = [];
    const config = await loadConfig(configPath, { notify: message => notices.push(message) });
    assert.deepEqual(notices, [LEGACY_RESUME_CONFIG_NOTICE]);
    assert.equal(config.resumes.legacyLayout, true);
    assert.equal(config.resumes.autoRefresh, true);
    assert.equal(config.resumes.pdftotextCommand, '/opt/homebrew/bin/pdftotext');
    assert.deepEqual(config.resumes.tracks.map(track => ({ id: track.id, label: track.label, enabled: track.enabled })), [
      { id: 'data', label: 'Data', enabled: true },
      { id: 'ai', label: 'AI', enabled: true },
    ]);
    assert.equal(config.resumes.tracks[0].profile, path.join(root, 'resumes', 'data.md'));
    assert.equal(config.resumes.tracks[1].pdf, path.join(os.homedir(), 'Desktop', 'AI.pdf'));
    assert.equal(config.resumeSources, undefined);

    // Legacy without resumeSources: profiles only, autoRefresh off.
    const plain = normalizeResumeConfig({ resumes: { data: './d.md', ai: './a.md' } }, root, { notify: () => {} });
    assert.equal(plain.autoRefresh, false);
    assert.deepEqual(plain.tracks.map(track => track.pdf), [null, null]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('missing, empty, or fully disabled tracks are a fatal configuration error', () => {
  const silent = { notify: () => {} };
  assert.throws(() => normalizeResumeConfig({}, '/tmp', silent), /at least one enabled resume track/);
  assert.throws(() => normalizeResumeConfig({ resumes: { tracks: [] } }, '/tmp', silent), /at least one enabled resume track/);
  assert.throws(() => normalizeResumeConfig({ resumes: { tracks: [{ id: 'data', enabled: false }, { id: 'ai', enabled: false }] } }, '/tmp', silent), /all tracks are missing or disabled/);
  assert.throws(() => normalizeResumeConfig({ resumes: { tracks: [{ id: 'data' }, { id: 'data' }] } }, '/tmp', silent), /duplicate id "data"/);
  assert.throws(() => normalizeResumeConfig({ resumes: { tracks: [{ id: 'bad id!' }] } }, '/tmp', silent), /is invalid/);
  assert.throws(() => normalizeResumeConfig({ resumes: { tracks: ['data'] } }, '/tmp', silent), /must be an object/);
  const single = normalizeResumeConfig({ resumes: { tracks: [{ id: 'data' }] } }, '/tmp', silent);
  assert.deepEqual(single.tracks.map(track => [track.id, track.label, track.enabled]), [['data', 'Data', true]]);
});

test('loadResumes returns enabled tracks in order with their text and rejects placeholders', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'config-load-'));
  try {
    const fixtures = new URL('./fixtures/', import.meta.url);
    await fs.mkdir(path.join(root, 'resumes'));
    await fs.copyFile(new URL('data-resume.md', fixtures), path.join(root, 'resumes', 'data.md'));
    await fs.copyFile(new URL('llm-resume.md', fixtures), path.join(root, 'resumes', 'llm.md'));
    await fs.writeFile(path.join(root, 'resumes', 'agent.md'), '# AI Agent resume placeholder\nReplace this file.');
    const configPath = await writeConfig(root, { resumes: { tracks: [{ id: 'llm', label: 'LLM' }, { id: 'data' }, { id: 'agent', label: 'AI Agent', enabled: false }] } });
    const config = await loadConfig(configPath);
    const resumes = await loadResumes(config);
    assert.deepEqual(resumes.map(track => [track.id, track.label]), [['llm', 'LLM'], ['data', 'Data']]);
    assert.match(resumes[0].text, /LLM Resume/);

    const enabledPlaceholder = await loadConfig(await writeConfig(root, { resumes: { tracks: [{ id: 'data' }, { id: 'agent', label: 'AI Agent' }] } }));
    await assert.rejects(loadResumes(enabledPlaceholder), /AI Agent resume \(agent\) is still a placeholder/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
