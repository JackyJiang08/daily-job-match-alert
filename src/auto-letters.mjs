// Cover letters written automatically after the nightly run (and after Run Now). The run writes its report
// (HTML, xlsx, warnings.txt) and releases the run lock first, so letters never delay the report; this phase
// then takes its own lock (state/.letters.lock) and drives the existing cover-letter path (input assembly,
// structure rules, validation, editor review, PDF render, file name) through the hub's letter functions.
//
//   config.coverLetter.autoGenerate { enabled: true, maxPerRun: 8 }
//   Picks: this run's new matches, best score first, skipping postings that already have a letter and
//   postings whose company name is uncertain; at most maxPerRun.
//   Engines: the Cover letter draft and Cover letter editor stage assignments and their fallback chains.
//   A posting whose whole chain fails stops the phase (the rest keep their Generate button) with a warning.
//   Off when the draft stage is the local-only placeholder or the cover-letter material is incomplete.
//
// state/letters-auto.json holds the phase's progress for the hub (cards show "Letter generating…").
import fs from 'node:fs/promises';
import path from 'node:path';
import { acquireRunLock, releaseRunLock } from './lock.mjs';
import { createWarning, errorSummary } from './warnings.mjs';
import { stageAssignments } from './engines/assignments.mjs';
import { readUsage, summarizeUsage, usagePath } from './engines/usage.mjs';
import { canonicalUrl } from './utils.mjs';

export const DEFAULT_AUTO_LETTERS = { enabled: true, maxPerRun: 8 };
export const LETTERS_LOCK = path.join('state', '.letters.lock');
export const LETTERS_STATUS = path.join('state', 'letters-auto.json');

export function autoLetterSettings(config = {}) {
  const raw = config.coverLetter?.autoGenerate || {};
  const max = Number(raw.maxPerRun);
  return { enabled: raw.enabled !== false, maxPerRun: Number.isInteger(max) && max >= 0 ? Math.min(max, 50) : DEFAULT_AUTO_LETTERS.maxPerRun };
}

export function lettersLockPath(root) {
  return path.join(root, LETTERS_LOCK);
}

export function lettersStatusPath(root) {
  return path.join(root, LETTERS_STATUS);
}

export async function readLettersStatus(root, io = fs) {
  try { return JSON.parse(await io.readFile(lettersStatusPath(root), 'utf8')); } catch { return null; }
}

async function writeStatus(root, status, io = fs) {
  const file = lettersStatusPath(root);
  await io.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await io.writeFile(temp, `${JSON.stringify(status, null, 2)}\n`);
  await io.rename(temp, file);
}

// This run's new matches, best score first; postings with a letter, or with an uncertain company, are
// skipped and counted; the rest are capped at max.
export function selectAutoLetters({ matches = [], newMatchUrls = null, lettersByJob = new Map(), max = DEFAULT_AUTO_LETTERS.maxPerRun, jobIdOf, companyFor }) {
  const fresh = new Set((newMatchUrls || []).map(url => canonicalUrl(url) || url));
  const candidates = matches.filter(job => !newMatchUrls || fresh.has(canonicalUrl(job.url) || job.url))
    .sort((a, b) => (Number(b.bestScore) || 0) - (Number(a.bestScore) || 0));
  const picked = [];
  const skipped = { existing: 0, uncertain: 0, overLimit: 0 };
  for (const job of candidates) {
    const id = jobIdOf(job);
    if (lettersByJob.has(id)) { skipped.existing += 1; continue; }
    const company = companyFor(job);
    if (company.uncertain || job.companyUncertain === true) { skipped.uncertain += 1; continue; }
    if (picked.length >= max) { skipped.overLimit += 1; continue; }
    picked.push({ jobId: id, company: company.name, title: job.title || '', bestScore: Number(job.bestScore) || 0 });
  }
  return { picked, skipped };
}

// One pass of automatic letters for `date`. `ctx` is a hub context (tests pass one with fake engines);
// `updateReport(autoLetters)` lets the caller add the outcome to the day's report and payload.
export async function runAutoLetters({ config, date, newMatchUrls = null, ctx, lockOptions = undefined, updateReport = null, warnings = [] }) {
  const settings = autoLetterSettings(config);
  const root = config.root || ctx.root;
  const io = ctx.io || fs;
  if (!settings.enabled || settings.maxPerRun === 0) return { state: 'off', reason: 'automatic cover letters are turned off in Settings' };
  const draftStage = stageAssignments(config).letterDraft;
  if (!draftStage.engine) return { state: 'off', reason: 'scoring is local only, so letters would use the placeholder engine' };
  const readiness = await ctx.letterStore.readiness();
  if (!readiness.ready) return { state: 'off', reason: `cover-letter material is incomplete (${readiness.missing.join(', ')})` };

  const lock = await acquireRunLock(lettersLockPath(root), lockOptions);
  if (!lock.acquired) {
    warnings.push(createWarning('cover letter', 'automatic letters', `skipped: another letters pass (PID ${lock.pid}) holds the letters lock`, 'info'));
    return { state: 'busy', pid: lock.pid };
  }
  const startedAt = ctx.now().toISOString();
  const status = { date, startedAt, finishedAt: null, state: 'running', pid: process.pid, planned: [], current: null, generated: [], failed: [], skipped: { existing: 0, uncertain: 0, overLimit: 0 }, stopReason: null, usage: null };
  try {
    const { readReportPayload } = await import('./hub/services.mjs');
    const { generateLetter, saveLetter, jobIdOf, letterCompanyFor } = await import('./hub/letters.mjs');
    const payload = await readReportPayload(ctx, date);
    const lettersByJob = await ctx.letterStore.lettersByJob().catch(() => new Map());
    const selection = selectAutoLetters({ matches: payload?.matches || [], newMatchUrls, lettersByJob, max: settings.maxPerRun, jobIdOf, companyFor: letterCompanyFor });
    status.planned = selection.picked;
    status.skipped = selection.skipped;
    await writeStatus(root, status, io);
    ctx.usageSource = 'auto-letters';
    for (const item of selection.picked) {
      status.current = item.jobId;
      await writeStatus(root, status, io);
      try {
        const draft = await generateLetter(ctx, { date, jobId: item.jobId, trackId: null, company: item.company, strict: true });
        const saved = await saveLetter(ctx, {
          date, jobId: item.jobId, trackId: draft.track.id, company: draft.company, paragraphs: draft.paragraphs,
          engine: draft.engine, model: draft.model, effort: draft.effort, reviewEngine: draft.reviewEngine, reviewModel: draft.reviewModel, reviewEffort: draft.reviewEffort,
          source: 'auto', issues: draft.issues || [], editorNotes: draft.editorNotes || [], samplesUsed: draft.samplesUsed || [],
        });
        status.generated.push({ jobId: item.jobId, company: draft.company, slug: saved.slug, engine: draft.engine, model: draft.model, effort: draft.effort || null, reviewEngine: draft.reviewEngine || null, reviewModel: draft.reviewModel || null, reviewEffort: draft.reviewEffort || null, editorNotes: (draft.editorNotes || []).length });
      } catch (error) {
        // The draft and editor chains already tried every fallback: stop here, the rest keep their button.
        status.failed.push({ jobId: item.jobId, company: item.company, reason: errorSummary(error, 200) });
        status.stopReason = `stopped after ${item.company} failed: ${errorSummary(error, 160)}`;
        warnings.push(createWarning('cover letter', 'automatic letters', `${status.stopReason}; ${selection.picked.length - status.generated.length - 1} remaining posting(s) keep their Generate Cover Letter button`));
        break;
      }
    }
    status.current = null;
    status.state = status.failed.length ? 'stopped' : 'done';
    status.finishedAt = ctx.now().toISOString();
    const usage = await readUsage(usagePath(root), io).catch(() => ({ entries: [] }));
    status.usage = summarizeUsage(usage.entries.filter(entry => entry.source === 'auto-letters' && String(entry.at) >= startedAt));
    await writeStatus(root, status, io);
    const outcome = autoLetterSummary(status);
    if (typeof updateReport === 'function') await updateReport(outcome).catch(error => warnings.push(createWarning('cover letter', 'automatic letters', `could not add the letters to the report: ${errorSummary(error)}`, 'info')));
    return { state: status.state, ...outcome };
  } catch (error) {
    status.state = 'stopped';
    status.stopReason = errorSummary(error, 200);
    status.finishedAt = ctx.now().toISOString();
    await writeStatus(root, status, io).catch(() => {});
    warnings.push(createWarning('cover letter', 'automatic letters', `the letters pass failed: ${status.stopReason}`));
    return { state: 'stopped', ...autoLetterSummary(status) };
  } finally {
    ctx.usageSource = null;
    await releaseRunLock(lock).catch(() => {});
  }
}

// What the report, Run Details, and Status show about a pass.
export function autoLetterSummary(status) {
  const engines = [...new Set((status.generated || []).map(item => `${item.engine} · ${item.model}${item.effort ? ` (${item.effort})` : ''}`))];
  return {
    date: status.date, startedAt: status.startedAt, finishedAt: status.finishedAt,
    planned: (status.planned || []).length, generated: (status.generated || []).length, failed: (status.failed || []).length,
    skipped: status.skipped || { existing: 0, uncertain: 0, overLimit: 0 }, engines, stopReason: status.stopReason || null,
    usage: status.usage?.total || null,
  };
}
