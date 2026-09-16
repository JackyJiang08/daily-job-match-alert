// Drives one engine call (plus one condensing retry) and returns validated paragraphs with the audit
// trail the panel shows: issues, word count, engine, model, attempts.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LETTER_SCHEMA, buildCoverLetterPrompt, validateParagraphs } from './compose.mjs';

function paragraphsFrom(output) {
  if (Array.isArray(output?.paragraphs)) return output.paragraphs;
  if (typeof output === 'string') {
    const start = output.indexOf('{');
    const end = output.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return paragraphsFrom(JSON.parse(output.slice(start, end + 1))); } catch {}
    }
    return output.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean);
  }
  return [];
}

export async function generateCoverLetter({ engine, inputs, io = fs, tempRoot = os.tmpdir() }) {
  const tempDirectory = await io.mkdtemp(path.join(tempRoot, 'daily-job-match-alert-letter-'));
  const attempts = [];
  try {
    let condense = false;
    let result = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const prompt = buildCoverLetterPrompt({ ...inputs, condense });
      const response = await engine.generateText(prompt, { schema: LETTER_SCHEMA, tempDirectory });
      const validation = validateParagraphs(paragraphsFrom(response.output));
      attempts.push({ attempt, wordCount: validation.wordCount, issues: validation.issues.map(issue => issue.kind) });
      result = { ...validation, engine: engine.id, engineLabel: engine.label, model: response.scoringModel || engine.model || 'unknown', attempts };
      if (!validation.tooLong) break;
      condense = true;
    }
    if (result.tooLong) result.issues.push({ kind: 'still-too-long', message: 'Still over the one-page word limit after a condensing retry; trim by hand before downloading' });
    return result;
  } finally {
    await io.rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
  }
}
