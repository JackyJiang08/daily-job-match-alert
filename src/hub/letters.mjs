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

export function jobIdOf(job) {
  return job.semanticId || sha256(job.url || '').slice(0, 16);
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

export function letterEngineFor(ctx, config) {
  if (ctx.letterEngine) return ctx.letterEngine;
  const semantic = config.semanticMatching || {};
  const engineId = normalizeEngineId(semantic.engine || 'claude') || 'claude';
  return createEngine(engineId, { ...semantic, model: resolveModel(semantic, engineId), allowPlaceholder: true, homedir: ctx.homedir });
}

export async function generateLetter(ctx, { date, jobId, trackId, company }) {
  const config = await ctx.loadConfig();
  const readiness = await ctx.letterStore.readiness();
  if (!readiness.ready) throw new HubInputError(`Cover-letter material is incomplete (${readiness.missing.join(', ')}); upload it under Settings first`);
  const { job, id, tracks } = await findLetterJob(ctx, date, jobId);
  const chosenTrack = trackId || job.recommendedTrack || tracks[0]?.id;
  const { track, text } = await resumeTextFor(ctx, config, chosenTrack);
  const { playbook, samples } = await ctx.letterStore.loadMaterial();
  const engine = letterEngineFor(ctx, config);
  const graduation = graduationTerms(config.preferences?.graduationDate);
  const review = config.coverLetter?.editorReview !== false;
  const result = await generateCoverLetter({ engine, inputs: { playbook, samples, track, resumeText: text, job, graduation }, review, io: ctx.io });
  return {
    ...result,
    jobId: id,
    date,
    company: String(company || displayCompanyName(job) || '').trim() || 'Company',
    track,
    tracks,
    job: { title: job.title, company: displayCompanyName(job), location: job.location, roleType: job.roleType },
  };
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
  const companyName = String(company || displayCompanyName(job) || '').trim() || 'Company';
  const now = ctx.now();
  const timeZone = config.timeZone || 'America/Chicago';
  const letter = assembleLetter({ profile, company: companyName, paragraphs: body, now, timeZone });
  const pdfFileName = ctx.letterStore.fileNameFor(config.coverLetter?.fileNameTemplate, profile, companyName);
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
  const letterEngine = letterEngineFor(ctx, config);
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
