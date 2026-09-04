import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { syncResumes } from '../src/resume-sync.mjs';

function trackConfig(root, sources, overrides = {}) {
  return {
    root,
    resumes: {
      autoRefresh: true,
      pdftotextCommand: '/custom/pdftotext',
      tracks: [
        { id: 'data', label: 'Data', profile: path.join(root, 'resumes', 'data.md'), pdf: sources.data, enabled: true },
        { id: 'llm', label: 'LLM', profile: path.join(root, 'resumes', 'llm.md'), pdf: sources.llm, enabled: true },
        { id: 'agent', label: 'AI Agent', profile: path.join(root, 'resumes', 'agent.md'), pdf: sources.agent, enabled: false },
      ],
      ...overrides,
    },
  };
}

test('refreshes private resume text per enabled track when a source PDF changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-sync-test-'));
  const sources = { data: path.join(root, 'data.pdf'), llm: path.join(root, 'llm.pdf'), agent: path.join(root, 'agent.pdf') };
  await fs.writeFile(sources.data, 'data-v1');
  await fs.writeFile(sources.llm, 'llm-v1');
  // The disabled track's PDF is deliberately missing: it must never be read.
  const config = trackConfig(root, sources);
  const calls = [];
  const runner = async (command, args) => {
    assert.equal(command, '/custom/pdftotext');
    calls.push(args[1]);
    return { stdout: `${path.basename(args[1])}\n${'resume evidence '.repeat(30)}` };
  };

  try {
    const first = await syncResumes(config, { runner });
    assert.deepEqual(first.refreshed, ['data', 'llm']);
    assert.deepEqual(first.skipped, ['agent']);
    assert.equal(calls.length, 2);
    const second = await syncResumes(config, { runner });
    assert.deepEqual(second.unchanged, ['data', 'llm']);
    assert.equal(calls.length, 2);
    await fs.writeFile(sources.llm, 'llm-v2');
    const third = await syncResumes(config, { runner });
    assert.deepEqual(third.refreshed, ['llm']);
    assert.equal(calls.length, 3);
    const llm = await fs.readFile(config.resumes.tracks[1].profile, 'utf8');
    assert.match(llm, /Generated locally from a private PDF/);
    assert.match(llm, /Track: llm/);
    assert.match(llm, /^# LLM resume$/m);
    await assert.rejects(fs.access(config.resumes.tracks[2].profile), 'disabled track must not be extracted');
    const state = JSON.parse(await fs.readFile(path.join(root, 'state', 'resume-sources.json'), 'utf8'));
    assert.deepEqual(Object.keys(state.sources), ['data', 'llm']);
    assert.equal(state.sources.llm.label, 'LLM');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('autoRefresh requires a pdf on every enabled track and does nothing when disabled', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-sync-off-'));
  try {
    const off = await syncResumes(trackConfig(root, {}, { autoRefresh: false }));
    assert.deepEqual(off, { refreshed: [], unchanged: [], skipped: [], enabled: false });
    await assert.rejects(syncResumes(trackConfig(root, {})), /"data" needs a pdf path/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
