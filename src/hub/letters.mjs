// Hub-side cover-letter flow: locate the posting in a day payload, gather the private material and the
// chosen resume track, run the engine, validate, then assemble, render, and store the letter.
import path from 'node:path';
import { enabledResumeTracks } from '../config.mjs';
import { createEngine, normalizeEngineId, resolveModel } from '../engines/index.mjs';
import { assembleLetter } from '../cover-letter/compose.mjs';
import { condenseCoverLetter, generateCoverLetter } from '../cover-letter/generate.mjs';
import { graduationTerms } from '../cover-letter/compose.mjs';
import { renderLetterPdf } from '../cover-letter/pdf.mjs';
import { LetterInputError } from '../cover-letter/store.mjs';
import { sha256 } from '../utils.mjs';
import { HubInputError, readReportPayload } from './services.mjs';
import { displayCompanyName } from '../posting-fields.mjs';
import { QuotaError, classifyQuotaError, describeQuota, nextLadderModel, normalizeQuotaPolicy } from '../engines/quota.mjs';
import { AuthExpiredError, EngineError, classifyEngineError, engineNotice, humanizeEngineError } from '../engines/engine-errors.mjs';
import { isAcceptableCompanyName, isTrustedSourceName, resolveCompanyName } from '../posting-fields.mjs';
import { renderLetterPdf as renderPdfDefault } from '../cover-letter/pdf.mjs';

export function jobIdOf(job) {
  return job.semanticId || sha256(job.url || '').slice(0, 16);
}

// The company a letter should address: the settled name when the pipeline validated one, otherwise
// the candidate chain over the stored job; `uncertain` means no candidate passed validation.
export function letterCompanyFor(job) {
  const resolved = resolveCompanyName(job);
  if (job?.companySource && !job.companyUncertain && isAcceptableCompanyName(job.company, job.companySource)) return { name: job.company, uncertain: false, source: job.companySource };
  return { name: resolved.name, uncertain: resolved.uncertain || !isAcceptableCompanyName(resolved.name, resolved.source), source: resolved.source };
}

export async function findLetterJob(ctx, date, jobId) {
  const payload = await readReportPayload(ctx, date);
  if (!payload) throw new HubInputError(`No report payload for ${date}`);
  const id = String(jobId || '');
  if (!/^[a-f0-9]{16}$/.test(id)) throw new HubInputError('Invalid job id');
  const job = (payload.matches || []).find(item => jobIdOf(item) === id) || (payload.reviewed || []).find(item => jobIdOf(item) === id);
  if (!job) throw new HubInputError(`Job ${id} is not in the ${date} report`);
  const tracks = Array.isArray(payload.meta?.resumeTracks) && payload.meta.resumeTracks.length ? payload.meta.resumeTracks : Object.keys(job.scores || {}).map(track => ({ id: track, label: track }));
  return { payload, job, id, tracks };
}

export async function resumeTextFor(ctx, config, trackId) {
  const track = enabledResumeTracks(config).find(item => item.id === trackId);
  if (!track) throw new HubInputError(`Resume track "${trackId}" is not enabled in config.json`);
  try {
    return { track: { id: track.id, label: track.label }, text: await ctx.io.readFile(track.profile, 'utf8') };
  } catch {
    throw new HubInputError(`The ${track.label} resume profile has not been extracted yet (${track.profile}); run the nightly sync or npm run resume:sync first`);
  }
}

export function letterEngineFor(ctx, config, { engine: engineOverride = null, model: modelOverride = null } = {}) {
  if (ctx.letterEngine && !engineOverride && !modelOverride) return ctx.letterEngine;
  const semantic = config.semanticMatching || {};
  const engineId = normalizeEngineId(engineOverride || semantic.engine || 'claude') || 'claude';
  if (ctx.letterEngine && ctx.makeLetterEngine) return ctx.makeLetterEngine({ engine: engineId, model: modelOverride || resolveModel(semantic, engineId) });
  return createEngine(engineId, { ...semantic, model: modelOverride || resolveModel(semantic, engineId), allowPlaceholder: true, homedir: ctx.homedir });
}

// Runs one generation attempt; on a model weekly limit it steps down the model ladder once and notes
// it, on any other quota refusal it throws a QuotaError the routes turn into a plain-language reply.
async function withQuotaPolicy(ctx, config, engineChoice, attempt) {
  const policy = normalizeQuotaPolicy(config.semanticMatching?.quotaPolicy);
  const first = letterEngineFor(ctx, config, engineChoice);
  const settle = (engine, outcome) => { if (engine.id === 'claude') ctx.authState?.clear?.(); return outcome; };
  try {
    return settle(first, { result: await attempt(first), engine: first, downgradeNote: null });
  } catch (error) {
    const verdict = classifyEngineError(error, { policy });
    if (verdict?.kind === 'auth_expired') {
      if (first.id === 'claude') ctx.authState?.expire?.(verdict.notice);
      throw error instanceof AuthExpiredError ? error : new AuthExpiredError(verdict.notice, error);
    }
    const quota = classifyQuotaError(error, { policy });
    if (!quota) {
      // Not a quota, not a login: the raw text goes to the hub log, the person sees one short line.
      console.error(`[cover-letter] ${first.id} ${first.model} failed: ${String(error?.raw || error?.stack || error?.message || error)}`);
      throw new EngineError(humanizeEngineError(error, { policy, timeZone: config.timeZone }).message, error);
    }
    ctx.quotaLog?.record?.({ ...quota, at: ctx.now().toISOString(), engine: first.id, model: first.model, source: 'cover-letter', action: 'refused' });
    const next = quota.kind === 'modelWeeklyLimit' ? nextLadderModel(policy, first.model) : null;
    if (next && first.id === 'claude') {
      const fallback = letterEngineFor(ctx, config, { ...engineChoice, engine: first.id, model: next });
      const note = `Generated with ${next}: ${quota.model || first.model} weekly limit`;
      ctx.quotaLog?.record?.({ ...quota, at: ctx.now().toISOString(), engine: first.id, model: first.model, source: 'cover-letter', action: 'downgraded', detail: `switched to ${next}` });
      try {
        return settle(fallback, { result: await attempt(fallback), engine: fallback, downgradeNote: note });
      } catch (secondError) {
        const secondVerdict = classifyEngineError(secondError, { policy });
        if (secondVerdict?.kind === 'auth_expired') { ctx.authState?.expire?.(secondVerdict.notice); throw new AuthExpiredError(secondVerdict.notice, secondError); }
        const again = classifyQuotaError(secondError, { policy });
        if (!again) { console.error(`[cover-letter] ${fallback.id} ${fallback.model} failed: ${String(secondError?.raw || secondError?.stack || secondError?.message || secondError)}`); throw new EngineError(humanizeEngineError(secondError, { policy, timeZone: config.timeZone }).message, secondError); }
        throw new QuotaError(again, secondError);
      }
    }
    throw new QuotaError(quota, error);
  }
}

export async function generateLetter(ctx, { date, jobId, trackId, company, engine: engineChoice = null }) {
  const config = await ctx.loadConfig();
  const readiness = await ctx.letterStore.readiness();
  if (!readiness.ready) throw new HubInputError(`Cover-letter material is incomplete (${readiness.missing.join(', ')}); upload it under Settings first`);
  const { job, id, tracks } = await findLetterJob(ctx, date, jobId);
  const chosenTrack = trackId || job.recommendedTrack || tracks[0]?.id;
  const { track, text } = await resumeTextFor(ctx, config, chosenTrack);
  const { playbook, samples } = await ctx.letterStore.loadMaterial();
  const graduation = graduationTerms(config.preferences?.graduationDate);
  const review = config.coverLetter?.editorReview !== false;
  const engineId = engineChoice ? (normalizeEngineId(engineChoice) || null) : null;
  if (engineChoice && !engineId) throw new HubInputError('Engine must be claude or codex');
  const salutationCompany = String(company || '').trim() || letterCompanyFor(job).name;
  const generated = await withQuotaPolicy(ctx, config, engineId ? { engine: engineId } : {}, engine => generateCoverLetter({ engine, inputs: { playbook, samples, track, resumeText: text, job, graduation, company: salutationCompany }, review, io: ctx.io }));
  const result = generated.downgradeNote ? { ...generated.result, editorNotes: [generated.downgradeNote, ...(generated.result.editorNotes || [])], downgradeNote: generated.downgradeNote } : generated.result;
  return {
    ...result,
    jobId: id,
    date,
    company: salutationCompany || 'Company',
    track,
    tracks,
    job: { title: job.title, company: letterCompanyFor(job).name, location: job.location, roleType: job.roleType },
  };
}

// One click from a job card: draft with the recommended track and the cleaned company name (editor pass
// included), then save and render at once. Returns what the card needs to offer both buttons.
export async function oneClickLetter(ctx, { date, jobId, engine = null }) {
  const { job } = await findLetterJob(ctx, date, jobId);
  const company = letterCompanyFor(job);
  if (company.uncertain) throw new HubInputError(`The company name for this posting is uncertain (${company.name || 'no candidate'}); confirm it in the panel before generating`);
  const draft = await generateLetter(ctx, { date, jobId, trackId: null, company: company.name, engine });
  const saved = await saveLetter(ctx, {
    date, jobId, trackId: draft.track.id, company: draft.company, paragraphs: draft.paragraphs,
    engine: draft.engine, model: draft.model, issues: draft.issues || [], editorNotes: draft.editorNotes || [], samplesUsed: draft.samplesUsed || [],
  });
  return { downloadUrl: saved.downloadUrl, openUrl: `/letters/${date}/${saved.slug}`, pdf: saved.pdf, company: draft.company, track: draft.track, wordCount: saved.wordCount, engine: draft.engine, model: draft.model, downgradeNote: draft.downgradeNote || null };
}

// Persists edited paragraphs, renders the PDF, and records everything needed to reopen or re-download.
export async function saveLetter(ctx, { date, jobId, trackId, company, paragraphs, engine, model, issues = [], editorNotes = [], samplesUsed = [] }) {
  const config = await ctx.loadConfig();
  const { profile } = await ctx.letterStore.readiness();
  if (!String(profile.name || '').trim()) throw new HubInputError('Add your name under Settings before downloading a letter');
  const { job, id, tracks } = await findLetterJob(ctx, date, jobId);
  const track = tracks.find(item => item.id === trackId) || tracks.find(item => item.id === job.recommendedTrack) || tracks[0] || { id: 'unknown', label: 'Unknown' };
  const body = (Array.isArray(paragraphs) ? paragraphs : []).map(item => String(item || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!body.length) throw new HubInputError('The letter body is empty');
  const companyName = String(company || letterCompanyFor(job).name || '').trim();
  // A name the owner typed or confirmed is trusted like a source name; only empty or legal-only names are refused.
  if (!isTrustedSourceName(companyName)) throw new HubInputError(`"${companyName || 'Company'}" is not a usable company name; confirm the company before rendering`);
  const now = ctx.now();
  const timeZone = config.timeZone || 'America/Chicago';
  const letter = assembleLetter({ profile, company: companyName, paragraphs: body, now, timeZone });
  const pdfFileName = ctx.letterStore.fileNameFor(profile, companyName);
  let saved;
  try {
    saved = await ctx.letterStore.saveLetter({ date, company: companyName, markdown: letter.markdown, meta: {
      jobId: id, jobTitle: job.title, jobUrl: job.url, company: companyName, track: track.id, trackLabel: track.label,
      engine: engine || 'unknown', model: model || 'unknown', paragraphs: body, issues, editorNotes, samplesUsed, wordCount: body.join(' ').split(/\s+/).filter(Boolean).length,
      pdfFileName, createdAt: now.toISOString(), timeZone,
    } });
  } catch (error) {
    if (error instanceof LetterInputError) throw new HubInputError(error.message);
    throw error;
  }
  const pdfPath = path.join(saved.directory, pdfFileName);
  // A first render past one page asks the same engine for a 15 percent trim before smaller layouts are tried.
  const letterEngine = letterEngineFor(ctx, config, engine === 'codex' ? { engine: 'codex' } : {});
  const condense = (currentParagraphs, pages) => condenseCoverLetter({ engine: letterEngine, paragraphs: currentParagraphs, pages, io: ctx.io });
  const pdf = await (ctx.renderPdf || renderLetterPdf)(letter, pdfPath, { chromeCommand: ctx.chromeCommand ?? (config.hub?.chromeCommand || null), io: ctx.io, condense });
  const finalParagraphs = Array.isArray(pdf.paragraphs) && pdf.paragraphs.length ? pdf.paragraphs : body;
  const finalLetter = pdf.condensed ? assembleLetter({ profile, company: companyName, paragraphs: finalParagraphs, now, timeZone }) : letter;
  saved.record.paragraphs = finalParagraphs;
  saved.record.wordCount = finalParagraphs.join(' ').split(/\s+/).filter(Boolean).length;
  saved.record.pdf = { pages: pdf.pages, layout: pdf.layout, renderer: pdf.renderer, note: pdf.note, condensed: pdf.condensed === true };
  await ctx.letterStore.saveLetter({ date, company: companyName, markdown: finalLetter.markdown, meta: saved.record });
  return {
    record: saved.record,
    slug: saved.slug,
    downloadUrl: `/letters/${date}/${saved.slug}/${encodeURIComponent(pdfFileName)}`,
    markdownUrl: `/letters/${date}/${saved.slug}/letter.md`,
    pdf: saved.record.pdf,
    paragraphs: finalParagraphs,
    wordCount: saved.record.wordCount,
  };
}

// Rename Company & Re-render: a new salutation and file name for a saved letter, rendered again from the
// stored paragraphs. No engine call; the model's text is untouched.
export async function renameLetter(ctx, { date, slug, company }) {
  const config = await ctx.loadConfig();
  const companyName = String(company || '').trim();
  if (!isTrustedSourceName(companyName)) throw new HubInputError(`"${companyName || ''}" is not a usable company name`);
  const existing = await ctx.letterStore.loadLetter(date, slug);
  if (!existing) throw new HubInputError('Letter not found');
  const { profile } = await ctx.letterStore.readiness();
  const timeZone = existing.record.timeZone || config.timeZone || 'America/Chicago';
  const createdAt = existing.record.createdAt ? new Date(existing.record.createdAt) : ctx.now();
  const letter = assembleLetter({ profile, company: companyName, paragraphs: existing.record.paragraphs || [], now: createdAt, timeZone });
  const pdfFileName = ctx.letterStore.fileNameFor(profile, companyName);
  const renamed = await ctx.letterStore.renameLetter(date, slug, { company: companyName, markdown: letter.markdown, pdfFileName, meta: { renamedFrom: existing.record.company !== companyName ? existing.record.company : existing.record.renamedFrom || null, renamedAt: ctx.now().toISOString() } });
  const pdfPath = path.join(renamed.directory, pdfFileName);
  const pdf = await (ctx.renderPdf || renderPdfDefault)(letter, pdfPath, { chromeCommand: ctx.chromeCommand ?? (config.hub?.chromeCommand || null), io: ctx.io });
  renamed.record.pdf = { pages: pdf.pages, layout: pdf.layout, renderer: pdf.renderer, note: pdf.note, condensed: existing.record.pdf?.condensed === true };
  await ctx.letterStore.saveLetter({ date, company: companyName, markdown: letter.markdown, meta: renamed.record });
  return { record: renamed.record, slug: renamed.slug, openUrl: `/letters/${date}/${renamed.slug}`, downloadUrl: `/letters/${date}/${renamed.slug}/${encodeURIComponent(pdfFileName)}`, pdf: renamed.record.pdf, pdfFileName };
}
