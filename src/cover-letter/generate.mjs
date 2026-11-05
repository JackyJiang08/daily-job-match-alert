// Drives the engine calls for one letter: the draft, an optional editor-review pass (same engine), and,
// when the rendered PDF spills past one page, a condensing pass. Returns validated paragraphs with the
// audit trail the panel shows: issues, editor notes, word count, engine, model, samples used.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BODY_SCHEMA, LETTER_SCHEMA, REVIEW_SCHEMA, buildCondensePrompt, buildCoverLetterPrompt, buildReviewPrompt, selectSamples, validateParagraphs } from './compose.mjs';
import { resolveShortName } from './short-name.mjs';

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

// The draft's "shortName", from a parsed object or a JSON string.
export function shortNameFrom(output) {
  if (typeof output?.shortName === 'string') return output.shortName;
  if (typeof output === 'string') {
    const start = output.indexOf('{');
    const end = output.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return shortNameFrom(JSON.parse(output.slice(start, end + 1))); } catch {}
    }
  }
  return null;
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
  const prompt = buildReviewPrompt({ paragraphs, job: inputs.job, resumeText: inputs.resumeText, playbook: inputs.playbook, graduation: inputs.graduation, company: inputs.company || null });
  const response = await engine.generateText(prompt, { schema: REVIEW_SCHEMA, tempDirectory });
  const notes = issuesFrom(response.output);
  const revised = validateParagraphs(paragraphsFrom(response.output, 'revised_paragraphs'));
  const adopted = notes.length > 0 && revised.ok && revised.paragraphs.length > 0;
  return { notes, adopted, paragraphs: adopted ? revised.paragraphs : paragraphs, revisionIssues: adopted ? revised.issues : [], model: response.scoringModel || null };
}

// The editor pass may use its own engines (the Cover letter editor stage and its fallback chain): each is
// tried in order, and a step that fails hands over to the next with a note naming both. Without a list
// the draft's engine also edits.
async function reviewWithChain({ engines, paragraphs, inputs, tempDirectory }) {
  const notes = [];
  let lastError = null;
  for (let index = 0; index < engines.length; index += 1) {
    const engine = engines[index];
    try {
      const edited = await reviewCoverLetter({ engine, paragraphs, inputs, tempDirectory });
      return { ...edited, engine, handoffNotes: notes };
    } catch (error) {
      lastError = error;
      const next = engines[index + 1];
      if (!next) break;
      notes.push(`Editor: ${engine.model || engine.id} failed (${String(error?.notice || error?.message || error).split('\n')[0].slice(0, 120)}); reviewed with ${next.model || next.id}`);
    }
  }
  throw lastError;
}

// inputs.naming = { chainName, aliases, fixed }: the candidate chain's company name, the owner's alias
// table, and a short name the owner typed. An alias or a typed name is given to the model up front; otherwise
// the model's shortName is checked (short-name.mjs) and the cleaned chain name stands in when it fails.
export async function generateCoverLetter({ engine, reviewEngines = null, inputs, review = true, io = fs, tempRoot = os.tmpdir() }) {
  const samples = selectSamples(inputs.samples || [], inputs.track?.id || null);
  const naming = { chainName: inputs.naming?.chainName ?? inputs.company ?? '', aliases: inputs.naming?.aliases || [], fixed: inputs.naming ? inputs.naming.fixed || null : inputs.company || null };
  const preset = resolveShortName({ job: inputs.job, ...naming });
  const presetName = preset.source === 'owner' || preset.source === 'alias' ? preset.name : null;
  return withTempDirectory(io, tempRoot, async tempDirectory => {
    const prompt = buildCoverLetterPrompt({ ...inputs, samples, shortName: presetName });
    const response = await engine.generateText(prompt, { schema: LETTER_SCHEMA, tempDirectory });
    const draft = validateParagraphs(paragraphsFrom(response.output));
    const modelShortName = shortNameFrom(response.output);
    const shortName = presetName ? { ...preset, modelValue: modelShortName } : { ...resolveShortName({ job: inputs.job, ...naming, modelShortName }), modelValue: modelShortName };
    let paragraphs = draft.paragraphs;
    let issues = draft.issues;
    // A refused short name may still stand in the body; the owner checks the mentions.
    if (shortName.rejected && paragraphs.some(paragraph => paragraph.includes(shortName.rejected.value))) {
      issues = [...issues, { kind: 'short-name', message: `The body calls the company "${shortName.rejected.value}" (${shortName.rejected.reason}); the salutation and file name use "${shortName.name}"` }];
    }
    const company = shortName.name;
    let editorNotes = [];
    let reviewed = false;
    let revisionAdopted = false;
    let reviewModel = null;
    let reviewEngineId = null;
    let reviewEffort = null;
    let handoffNotes = [];
    if (review && draft.ok) {
      const edited = await reviewWithChain({ engines: reviewEngines?.length ? reviewEngines : [engine], paragraphs, inputs: { ...inputs, company }, tempDirectory });
      reviewed = true;
      editorNotes = edited.notes;
      handoffNotes = edited.handoffNotes;
      reviewModel = edited.model || edited.engine?.model || null;
      reviewEngineId = edited.engine?.id || null;
      reviewEffort = edited.engine?.effort || null;
      if (edited.adopted) {
        revisionAdopted = true;
        paragraphs = edited.paragraphs;
        const recheck = validateParagraphs(paragraphs);
        issues = [...edited.revisionIssues, ...recheck.issues.filter(issue => !['bullet', 'dash'].includes(issue.kind)), ...issues.filter(issue => issue.kind === 'short-name')];
      }
    }
    const words = validateParagraphs(paragraphs).wordCount;
    return {
      paragraphs, issues, wordCount: words, ok: draft.ok,
      company, shortName: { name: shortName.name, source: shortName.source, fallback: shortName.fallback, modelValue: shortName.modelValue || null, rejected: shortName.rejected || null },
      engine: engine.id, engineLabel: engine.label, model: response.scoringModel || engine.model || 'unknown', effort: engine.effort || null,
      reviewed, editorNotes: [...handoffNotes, ...editorNotes], revisionAdopted,
      reviewEngine: reviewEngineId, reviewModel, reviewEffort,
      samplesUsed: samples.map(sample => ({ name: sample.originalName || sample.file, track: sample.track || null })),
    };
  });
}

// Condensing pass used by the PDF renderer when the first render runs past one page.
export async function condenseCoverLetter({ engine, paragraphs, pages, io = fs, tempRoot = os.tmpdir() }) {
  return withTempDirectory(io, tempRoot, async tempDirectory => {
    const response = await engine.generateText(buildCondensePrompt({ paragraphs, pages }), { schema: BODY_SCHEMA, tempDirectory });
    const condensed = validateParagraphs(paragraphsFrom(response.output));
    if (!condensed.ok || condensed.paragraphs.length === 0) return null;
    return condensed.paragraphs;
  });
}
