import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { syncResumes } from '../src/resume-sync.mjs';

test('refreshes private resume text when a source PDF changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-sync-test-'));
  const sources = { data: path.join(root, 'data.pdf'), ai: path.join(root, 'ai.pdf') };
  await fs.writeFile(sources.data, 'data-v1');
  await fs.writeFile(sources.ai, 'ai-v1');
  const config = {
    root,
    resumes: { data: path.join(root, 'resumes', 'data.md'), ai: path.join(root, 'resumes', 'ai.md') },
    resumeSources: { autoRefresh: true, pdftotextCommand: '/custom/pdftotext', dataPdf: sources.data, aiPdf: sources.ai },
  };
  const calls = [];
  const runner = async (command, args) => {
    assert.equal(command, '/custom/pdftotext');
    calls.push(args[1]);
    return { stdout: `${path.basename(args[1])}\n${'resume evidence '.repeat(30)}` };
  };

  try {
    const first = await syncResumes(config, { runner });
    assert.deepEqual(first.refreshed, ['data', 'ai']);
    assert.equal(calls.length, 2);
    const second = await syncResumes(config, { runner });
    assert.deepEqual(second.unchanged, ['data', 'ai']);
    assert.equal(calls.length, 2);
    await fs.writeFile(sources.ai, 'ai-v2');
    const third = await syncResumes(config, { runner });
    assert.deepEqual(third.refreshed, ['ai']);
    assert.equal(calls.length, 3);
    assert.match(await fs.readFile(config.resumes.ai, 'utf8'), /Generated locally from a private PDF/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
