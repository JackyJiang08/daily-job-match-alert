// Drives the engine calls for one letter: the draft, an optional editor-review pass (same engine), and,
// when the rendered PDF spills past one page, a condensing pass. Returns validated paragraphs with the
// audit trail the panel shows: issues, editor notes, word count, engine, model, samples used.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LETTER_SCHEMA, REVIEW_SCHEMA, buildCondensePrompt, buildCoverLetterPrompt, buildReviewPrompt, selectSamples, validateParagraphs } from './compose.mjs';

export function paragraphsFrom(output, key = 'paragraphs') {
  if (Array.isArray(output?.[key])) return output[key];
  if (typeof output === 'string') {
    const start = output.indexOf('{');
    const end = output.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return paragraphsFrom(JSON.parse(output.slice(start, end + 1)), key); } catch {}
    }
    return output.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean);
  }
  return [];
}

function issuesFrom(output) {
  const list = Array.isArray(output?.issues) ? output.issues : [];
  return list.map(item => String(item?.message ?? item ?? '').trim()).filter(Boolean);
}

async function withTempDirectory(io, tempRoot, work) {
  const tempDirectory = await io.mkdtemp(path.join(tempRoot, 'daily-job-match-alert-letter-'));
  try {
    return await work(tempDirectory);
  } finally {
    await io.rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

// Editor pass: adopt the revised body only when the editor raised issues and returned a usable body.
export async function reviewCoverLetter({ engine, paragraphs, inputs, tempDirectory }) {
  const prompt = buildReviewPrompt({ paragraphs, job: inputs.job, resumeText: inputs.resumeText, playbook: inputs.playbook, graduation: inputs.graduation });
  const response = await engine.generateText(prompt, { schema: REVIEW_SCHEMA, tempDirectory });
  const notes = issuesFrom(response.output);
  const revised = validateParagraphs(paragraphsFrom(response.output, 'revised_paragraphs'));
  const adopted = notes.length > 0 && revised.ok && revised.paragraphs.length > 0;
  return { notes, adopted, paragraphs: adopted ? revised.paragraphs : paragraphs, revisionIssues: adopted ? revised.issues : [], model: response.scoringModel || null };
}

export async function generateCoverLetter({ engine, inputs, review = true, io = fs, tempRoot = os.tmpdir() }) {
  const samples = selectSamples(inputs.samples || [], inputs.track?.id || null);
  return withTempDirectory(io, tempRoot, async tempDirectory => {
    const prompt = buildCoverLetterPrompt({ ...inputs, samples });
    const response = await engine.generateText(prompt, { schema: LETTER_SCHEMA, tempDirectory });
    const draft = validateParagraphs(paragraphsFrom(response.output));
    let paragraphs = draft.paragraphs;
    let issues = draft.issues;
    let editorNotes = [];
    let reviewed = false;
    let revisionAdopted = false;
    if (review && draft.ok) {
      const edited = await reviewCoverLetter({ engine, paragraphs, inputs, tempDirectory });
      reviewed = true;
      editorNotes = edited.notes;
      if (edited.adopted) {
        revisionAdopted = true;
        paragraphs = edited.paragraphs;
        const recheck = validateParagraphs(paragraphs);
        issues = [...edited.revisionIssues, ...recheck.issues.filter(issue => !['bullet', 'dash'].includes(issue.kind))];
      }
    }
    const words = validateParagraphs(paragraphs).wordCount;
    return {
      paragraphs, issues, wordCount: words, ok: draft.ok,
      engine: engine.id, engineLabel: engine.label, model: response.scoringModel || engine.model || 'unknown',
      reviewed, editorNotes, revisionAdopted,
      samplesUsed: samples.map(sample => ({ name: sample.originalName || sample.file, track: sample.track || null })),
    };
  });
}

// Condensing pass used by the PDF renderer when the first render runs past one page.
export async function condenseCoverLetter({ engine, paragraphs, pages, io = fs, tempRoot = os.tmpdir() }) {
  return withTempDirectory(io, tempRoot, async tempDirectory => {
    const response = await engine.generateText(buildCondensePrompt({ paragraphs, pages }), { schema: LETTER_SCHEMA, tempDirectory });
    const condensed = validateParagraphs(paragraphsFrom(response.output));
    if (!condensed.ok || condensed.paragraphs.length === 0) return null;
    return condensed.paragraphs;
  });
}
