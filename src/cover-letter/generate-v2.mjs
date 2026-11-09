// The v2 letter flow (config.coverLetter.rulesVersion "v2"): the v2 draft prompt (candid paragraph reported back),
// the v2 editor (issues must quote the draft; unverified details are rewritten, and a rewrite that adds a number
// outside the sources or new scenario wording keeps the draft's paragraph), automatic fixes, and the checks of
// src/cover-letter/checks.mjs. Same return shape as generateCoverLetter (generate.mjs) plus rulesVersion,
// candidParagraphIndex, candidGaps, and checks.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { selectSamples, validateParagraphs, BODY_SCHEMA } from './compose.mjs';
import { resolveShortName } from './short-name.mjs';
import { outreachFrom } from '../outreach/messages.mjs';
import { LETTER_SCHEMA_V2, REVIEW_SCHEMA_V2, buildCondensePromptV2, buildCoverLetterPromptV2, buildReviewPromptV2, condenseTarget } from './rules-v2.mjs';
import { autoFix, filterEditorIssues, guardEditorRewrite, postingCasing, runChecks } from './checks.mjs';
import { numberWhitelist } from './evidence.mjs';
import { paragraphsFrom, shortNameFrom } from './generate.mjs';

function fieldFrom(output, key) {
  if (output && typeof output === 'object' && key in output) return output[key];
  if (typeof output === 'string') {
    const start = output.indexOf('{');
    const end = output.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return fieldFrom(JSON.parse(output.slice(start, end + 1)), key); } catch {}
    }
  }
  return undefined;
}

function candidIndex(value, count) {
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 && index < count ? index : -1;
}

async function withTempDirectory(io, tempRoot, work) {
  const tempDirectory = await io.mkdtemp(path.join(tempRoot, 'daily-job-match-alert-letter-'));
  try {
    return await work(tempDirectory);
  } finally {
    await io.rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

export async function reviewCoverLetterV2({ engine, paragraphs, candidParagraphIndex, inputs, tempDirectory }) {
  const context = inputs.rules.context;
  const prompt = buildReviewPromptV2({ paragraphs, candidParagraphIndex, job: inputs.job, resumeText: inputs.resumeText, playbook: inputs.playbook, context, company: inputs.company || null });
  const response = await engine.generateText(prompt, { schema: REVIEW_SCHEMA_V2, tempDirectory });
  const raw = (Array.isArray(fieldFrom(response.output, 'issues')) ? fieldFrom(response.output, 'issues') : []).map(item => String(item?.message ?? item ?? '').trim()).filter(Boolean);
  const { kept, dropped } = filterEditorIssues(raw, paragraphs);
  const revised = validateParagraphs(paragraphsFrom(response.output, 'revised_paragraphs'));
  const info = dropped.length ? [`Editor: set aside ${dropped.length} issue${dropped.length === 1 ? '' : 's'} that did not quote the draft or differed only in capitalization`] : [];
  if (!(kept.length > 0 && revised.ok && revised.paragraphs.length > 0)) {
    return { notes: kept, info, adopted: false, paragraphs, candidParagraphIndex, rejections: [], model: response.scoringModel || null };
  }
  const whitelist = numberWhitelist(inputs.resumeText, inputs.playbook);
  const guarded = guardEditorRewrite({ draft: paragraphs, revised: revised.paragraphs, whitelist, job: inputs.job, resumeText: inputs.resumeText, playbook: inputs.playbook });
  const rejections = guarded.rejected.map(item => `check failed (editor-rewrite): the editor's rewrite of ${item.index >= 0 ? `paragraph ${item.index + 1}` : 'the body'} added ${item.reason}; the draft's wording was kept`);
  const index = guarded.paragraphs === paragraphs ? candidParagraphIndex : candidIndex(fieldFrom(response.output, 'candidParagraphIndex'), guarded.paragraphs.length);
  return { notes: kept, info, adopted: true, paragraphs: guarded.paragraphs, candidParagraphIndex: index, rejections, revisionIssues: revised.issues, model: response.scoringModel || null };
}

async function reviewWithChainV2({ engines, paragraphs, candidParagraphIndex, inputs, tempDirectory }) {
  const handoff = [];
  let lastError = null;
  for (let index = 0; index < engines.length; index += 1) {
    const engine = engines[index];
    try {
      return { ...(await reviewCoverLetterV2({ engine, paragraphs, candidParagraphIndex, inputs, tempDirectory })), engine, handoffNotes: handoff };
    } catch (error) {
      lastError = error;
      const next = engines[index + 1];
      if (!next) break;
      handoff.push(`Editor: ${engine.model || engine.id} failed (${String(error?.notice || error?.message || error).split('\n')[0].slice(0, 120)}); reviewed with ${next.model || next.id}`);
    }
  }
  throw lastError;
}

// The checks for a body as it stands, with the context the draft returned.
export function checkLetter(paragraphs, inputs, extra = {}) {
  const context = inputs.rules.context;
  return runChecks(paragraphs, {
    job: inputs.job, resumeText: inputs.resumeText, playbook: inputs.playbook, graduation: context.graduation, graduationDate: inputs.rules.graduationDate || null,
    availability: context.availability, mastersAllowed: context.mastersAllowed, opening: context.opening, openingStyle: inputs.rules.openingStyle,
    coreGaps: context.gaps, otherResumes: inputs.rules.otherResumes || [], ...extra,
  });
}

// inputs: as generateCoverLetter, plus rules { version: 'v2', context (v2Context), openingStyle, otherResumes,
// graduationDate }.
export async function generateCoverLetterV2({ engine, reviewEngines = null, inputs, review = true, io = fs, tempRoot = os.tmpdir() }) {
  const samples = selectSamples(inputs.samples || [], inputs.track?.id || null);
  const naming = { chainName: inputs.naming?.chainName ?? inputs.company ?? '', aliases: inputs.naming?.aliases || [], fixed: inputs.naming ? inputs.naming.fixed || null : inputs.company || null };
  const preset = resolveShortName({ job: inputs.job, ...naming });
  const presetName = preset.source === 'owner' || preset.source === 'alias' ? preset.name : null;
  const context = { ...inputs.rules.context, shortName: presetName };
  const rulesInputs = { ...inputs, rules: { ...inputs.rules, context } };
  return withTempDirectory(io, tempRoot, async tempDirectory => {
    const prompt = buildCoverLetterPromptV2({ playbook: inputs.playbook, samples, track: inputs.track, resumeText: inputs.resumeText, job: inputs.job, context });
    const response = await engine.generateText(prompt, { schema: LETTER_SCHEMA_V2, tempDirectory });
    const draft = validateParagraphs(paragraphsFrom(response.output));
    let candidParagraphIndex = candidIndex(fieldFrom(response.output, 'candidParagraphIndex'), draft.paragraphs.length);
    const candidGaps = (Array.isArray(fieldFrom(response.output, 'candidGaps')) ? fieldFrom(response.output, 'candidGaps') : []).map(String);
    const modelShortName = shortNameFrom(response.output);
    const resolved = presetName ? { ...preset, modelValue: modelShortName } : { ...resolveShortName({ job: inputs.job, ...naming, modelShortName }), modelValue: modelShortName };
    // The salutation follows the posting's own casing of the name ("Examplecorp" when the posting writes it so).
    const posting = [inputs.job?.title, inputs.job?.description].filter(Boolean).join('\n');
    const shortName = resolved.source === 'owner' ? resolved : { ...resolved, name: postingCasing(resolved.name, posting) };
    let paragraphs = draft.paragraphs;
    let issues = draft.issues;
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
    if (review && draft.ok) {
      const edited = await reviewWithChainV2({ engines: reviewEngines?.length ? reviewEngines : [engine], paragraphs, candidParagraphIndex, inputs: { ...rulesInputs, company }, tempDirectory });
      reviewed = true;
      editorNotes = [...edited.handoffNotes, ...edited.notes, ...edited.info, ...edited.rejections];
      reviewModel = edited.model || edited.engine?.model || null;
      reviewEngineId = edited.engine?.id || null;
      reviewEffort = edited.engine?.effort || null;
      if (edited.adopted) {
        revisionAdopted = true;
        paragraphs = edited.paragraphs;
        candidParagraphIndex = edited.candidParagraphIndex;
        const recheck = validateParagraphs(paragraphs);
        issues = [...(edited.revisionIssues || []), ...recheck.issues.filter(issue => !['bullet', 'dash'].includes(issue.kind)), ...issues.filter(issue => issue.kind === 'short-name')];
      }
    }
    const fixed = autoFix(paragraphs);
    paragraphs = fixed.paragraphs;
    const checks = checkLetter(paragraphs, rulesInputs, { candidParagraphIndex, candidGaps });
    const words = validateParagraphs(paragraphs).wordCount;
    const outreach = outreachFrom(response.output, { limit: inputs.outreachLimit });
    return {
      paragraphs, issues, wordCount: words, ok: draft.ok, outreach,
      company, shortName: { name: shortName.name, source: shortName.source, fallback: shortName.fallback, modelValue: shortName.modelValue || null, rejected: shortName.rejected || null },
      engine: engine.id, engineLabel: engine.label, model: response.scoringModel || engine.model || 'unknown', effort: engine.effort || null,
      reviewed, editorNotes: [...editorNotes, ...fixed.info, ...checks.notes], revisionAdopted,
      reviewEngine: reviewEngineId, reviewModel, reviewEffort,
      samplesUsed: samples.map(sample => ({ name: sample.originalName || sample.file, track: sample.track || null })),
      rulesVersion: 'v2', candidParagraphIndex, candidGaps, checks: checks.results,
      openingForbidden: context.opening.forbidden,
    };
  });
}

// v2 condensing: to a word target (condenseTarget), validated, with the automatic fixes applied again.
export async function condenseCoverLetterV2({ engine, paragraphs, pages = null, target, io = fs, tempRoot = os.tmpdir() }) {
  return withTempDirectory(io, tempRoot, async tempDirectory => {
    const response = await engine.generateText(buildCondensePromptV2({ paragraphs, pages, target }), { schema: BODY_SCHEMA, tempDirectory });
    const condensed = validateParagraphs(paragraphsFrom(response.output));
    if (!condensed.ok || condensed.paragraphs.length === 0) return null;
    return autoFix(condensed.paragraphs).paragraphs;
  });
}

export { condenseTarget };
