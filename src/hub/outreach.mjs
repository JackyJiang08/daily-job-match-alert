// Reach Out (2026-11-08): the services behind the Reports page's drawer. Hard limits: nothing here requests,
// fetches, or signs in to linkedin.com, and nothing is ever sent; the hub builds links and text and the owner
// does the rest in the browser. State lives in private/outreach/state.json (src/outreach/store.mjs).
import path from 'node:path';
import { enabledResumeTracks } from '../config.mjs';
import { CANDIDATES_NOTE, candidateSearchStatus, searchCandidates } from '../outreach/candidates.mjs';
import { extractJdContacts } from '../outreach/contacts.mjs';
import { outreachLinks } from '../outreach/links.mjs';
import { connectionNoteLimit } from '../outreach/messages.mjs';
import { contactedLabel, readOutreach, updateOutreach } from '../outreach/store.mjs';
import { findLetterJob, initialShortName, letterCompanyFor } from './letters.mjs';
import { HubInputError } from './services.mjs';
import { outreachPanel } from './outreach-views.mjs';

// A resume the hub stored itself is named "<upload time>-<original name>"; the download uses the original.
const MANAGED_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-/;

export function originalResumeName(file) {
  return path.basename(String(file || '')).replace(MANAGED_PREFIX, '') || 'Resume.pdf';
}

// The recommended track's resume PDF: { available, label, file, fileName, reason }.
export async function resumeForJob(ctx, config, job, tracks = []) {
  const all = enabledResumeTracks(config);
  const track = all.find(item => item.id === job.recommendedTrack) || all.find(item => tracks.some(entry => entry.id === item.id)) || all[0];
  if (!track) return { available: false, reason: 'No enabled resume track' };
  const label = track.label || track.id;
  if (!track.pdf) return { available: false, label, reason: `The ${label} track has no resume PDF configured` };
  try {
    await ctx.io.access(track.pdf);
  } catch {
    return { available: false, label, reason: `The ${label} resume PDF is missing` };
  }
  return { available: true, label, file: track.pdf, fileName: originalResumeName(track.pdf) };
}

async function companyFor(ctx, job) {
  const readiness = await ctx.letterStore.readiness().catch(() => ({ profile: {} }));
  return initialShortName(job, readiness.profile?.companyAliases || []).name || letterCompanyFor(job).name || job.company || '';
}

export async function outreachPanelHtml(ctx, { date, jobId }) {
  const config = await ctx.loadConfig();
  const { job, id, tracks } = await findLetterJob(ctx, date, jobId);
  const company = await companyFor(ctx, job);
  const state = await readOutreach(ctx.root, ctx.io);
  const entry = state.jobs[id] || {};
  const status = await candidateSearchStatus(config, ctx.io);
  const cached = entry.candidates || null;
  const candidates = {
    available: status.available,
    provider: status.provider || null,
    searched: Boolean(cached),
    results: cached?.results || [],
    reason: cached && cached.status !== 'ok' ? cached.reason || `The search did not finish (${cached.status})` : null,
  };
  return outreachPanel({
    date, jobId: id, job, company,
    contacts: extractJdContacts(job.description),
    links: outreachLinks({ company, job }),
    candidates, entry,
    limit: connectionNoteLimit(config),
    resume: await resumeForJob(ctx, config, job, tracks),
    contacted: contactedLabel(entry, config.timeZone || 'America/Chicago'),
  });
}

export async function resumeDownload(ctx, { date, jobId }) {
  const config = await ctx.loadConfig();
  const { job, tracks } = await findLetterJob(ctx, date, jobId);
  const resume = await resumeForJob(ctx, config, job, tracks);
  if (!resume.available) throw new HubInputError(resume.reason);
  return { content: await ctx.io.readFile(resume.file), fileName: resume.fileName };
}

function validJobId(value) {
  const id = String(value || '');
  if (!/^[a-f0-9]{16}$/.test(id)) throw new HubInputError('Invalid job id');
  return id;
}

export async function saveFirstName(ctx, { jobId, firstName }) {
  const name = String(firstName || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  await updateOutreach(ctx.root, validJobId(jobId), entry => { entry.firstName = name; }, { io: ctx.io, now: ctx.now() });
  return { firstName: name };
}

// Mark as Contacted: the date it was ticked (cleared when unticked); the card shows "Contacted Nov 8".
export async function setContacted(ctx, { jobId, contacted }) {
  const config = await ctx.loadConfig();
  const on = contacted === true || contacted === '1' || contacted === 'true' || contacted === 'on';
  const entry = await updateOutreach(ctx.root, validJobId(jobId), item => {
    if (on) item.contactedAt = item.contactedAt || ctx.now().toISOString();
    else delete item.contactedAt;
  }, { io: ctx.io, now: ctx.now() });
  // The Reports render cache keys on the contacted labels (contactedByJob), so the card updates on its own.
  return { contactedAt: entry.contactedAt || null, label: contactedLabel(entry, config.timeZone || 'America/Chicago') };
}

// One candidate search per posting; the result (or why there is none) is kept and shown from then on.
export async function findCandidates(ctx, { date, jobId }) {
  const config = await ctx.loadConfig();
  const { job, id } = await findLetterJob(ctx, date, jobId);
  const state = await readOutreach(ctx.root, ctx.io);
  if (state.jobs[id]?.candidates) return { ...state.jobs[id].candidates, cached: true, note: CANDIDATES_NOTE };
  const result = await searchCandidates({ config, company: await companyFor(ctx, job), io: ctx.io, fetchImpl: ctx.fetchImpl, now: ctx.now() });
  // Off or without a key nothing was asked, and nothing is recorded.
  if (result.status === 'off' || result.status === 'no-key') return { ...result, cached: false, note: CANDIDATES_NOTE };
  const record = { at: ctx.now().toISOString(), provider: result.provider, status: result.status, reason: result.reason || null, results: result.results };
  await updateOutreach(ctx.root, id, entry => { entry.candidates = record; }, { io: ctx.io, now: ctx.now() });
  return { ...record, cached: false, note: CANDIDATES_NOTE };
}

// For the cards: job id → "Contacted Nov 8", and a signature of that map for the render cache key.
export async function contactedByJob(ctx, timeZone) {
  const state = await readOutreach(ctx.root, ctx.io);
  const labels = new Map();
  for (const [id, entry] of Object.entries(state.jobs)) {
    const label = contactedLabel(entry, timeZone);
    if (label) labels.set(id, label);
  }
  return { labels, version: [...labels].map(([id, label]) => `${id}:${label}`).sort().join(',') };
}

// Settings > Cover Letters "Reach Out": the invitation-note limit and the optional candidate search.
export function validateOutreachSettings(form) {
  const limit = Number(form.connectionNoteLimit);
  if (!Number.isInteger(limit) || limit < 100 || limit > 300) throw new HubInputError('Connection note limit must be a whole number from 100 to 300 characters');
  const on = value => value === 'on' || value === 'true' || value === true;
  return { connectionNoteLimit: limit, searchCandidates: on(form.searchCandidates) };
}
