// Hub-side cover-letter flow: locate the posting in a day payload, gather the private material and the
// chosen resume track, run the engine, validate, then assemble, render, and store the letter.
import { classifyEditorNotes, reviewBadge } from '../cover-letter/notes.mjs';
import { STAGE_LABELS, stageAssignments, stageChain } from '../engines/assignments.mjs';
import { normalizeCatalog } from '../engines/catalog.mjs';
import path from 'node:path';
import { enabledResumeTracks } from '../config.mjs';
import { createEngine, normalizeEngineId, resolveModel } from '../engines/index.mjs';
import { assembleLetter } from '../cover-letter/compose.mjs';
import { condenseCoverLetter, generateCoverLetter } from '../cover-letter/generate.mjs';
import { graduationTerms } from '../cover-letter/compose.mjs';
import { renderLetterPdf } from '../cover-letter/pdf.mjs';
import { LetterInputError } from '../cover-letter/store.mjs';
import { sha256 } from '../utils.mjs';
import { HubInputError, configuredCliCommands, currentPlans, markModelUnavailableInHub, modelAvailabilityView, readReportPayload, updateAvailabilityInHub } from './services.mjs';
import { firstAvailableModel, markModelUsed, markWeeklyLimit, nextAvailableModel } from '../engines/model-availability.mjs';
import { planLabel } from '../engines/quota.mjs';
import { appendUsage, usageEntries, usagePath } from '../engines/usage.mjs';
import { appendQuotaNotices, quotaNoticesPath } from '../engines/quota-notices.mjs';
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

// Cover-letter calls report their token usage like nightly reviews do: the editor pass as "editor", the
// draft and the condensing pass as "letter".
function withUsageRecording(ctx, engine) {
  if (!engine || typeof engine.generateText !== 'function' || engine.recordsUsage) return engine;
  const wrapped = Object.create(engine);
  wrapped.recordsUsage = true;
  wrapped.generateText = async (prompt, context) => {
    const response = await engine.generateText(prompt, context);
    if (response?.usage?.parseEmpty) console.error(`[cover-letter] usage parse empty: a successful ${engine.id} call returned no readable modelUsage; it is not counted in the usage log`);
    await updateAvailabilityInHub(ctx, record => markModelUsed(record, engine.model, { resolvedId: response?.scoringModel || null, at: ctx.now().toISOString() })).catch(error => console.error(`[cover-letter] could not record model availability: ${error?.message || error}`));
    if (response?.usage?.models?.length) {
      const purpose = String(prompt || '').startsWith('EDITOR REVIEW') ? 'editor' : 'letter';
      const entries = usageEntries(response.usage, { purpose, at: ctx.now().toISOString(), source: ctx.usageSource || 'hub' });
      await appendUsage(usagePath(ctx.root), entries, { now: ctx.now(), io: ctx.io }).catch(error => console.error(`[cover-letter] could not record usage: ${error?.message || error}`));
    }
    return response;
  };
  return wrapped;
}

export function letterEngineFor(ctx, config, choice = {}) {
  return withUsageRecording(ctx, buildLetterEngine(ctx, config, choice));
}

// A test hub (ctx.letterEngine set) never builds a real engine: it gets ctx.makeLetterEngine's fake for the
// choice, or the one fixed fake. The stage's effort reaches Codex as its reasoning effort.
function buildLetterEngine(ctx, config, { engine: engineOverride = null, model: modelOverride = null, effort = null } = {}) {
  if (ctx.letterEngine && !engineOverride && !modelOverride) return ctx.letterEngine;
  const semantic = config.semanticMatching || {};
  const engineId = normalizeEngineId(engineOverride || semantic.engine || 'claude') || 'claude';
  const model = modelOverride || resolveModel(semantic, engineId);
  if (ctx.letterEngine) return ctx.makeLetterEngine ? ctx.makeLetterEngine({ engine: engineId, model, effort }) : ctx.letterEngine;
  return createEngine(engineId, { ...semantic, model, reasoningEffort: engineId === 'codex' ? effort : null, allowPlaceholder: true, homedir: ctx.homedir });
}

async function codexConnected(ctx, config) {
  try {
    const status = await ctx.connections.status({ commands: configuredCliCommands(config) });
    return status?.codex?.connected === true;
  } catch {
    return false;
  }
}

// The engines a letter stage will try, in order: its assignment, then its fallback chain. Codex steps drop
// out while Codex is not connected (the note goes to Editor notes). A config that scores with local_only
// and names no letter assignment keeps the placeholder engine ({} = the legacy default).
export async function letterStagePlan(ctx, config, stage, override = null) {
  const assignments = stageAssignments(config);
  const assignment = assignments[stage];
  const label = STAGE_LABELS[stage];
  let entries;
  if (override === 'codex') entries = [{ engine: 'codex', model: assignment?.engine === 'codex' ? assignment.model : resolveModel(config.semanticMatching || {}, 'codex'), effort: assignment?.engine === 'codex' ? assignment.effort : null }];
  else if (override === 'claude') entries = [{ engine: 'claude', model: resolveModel(config.semanticMatching || {}, 'claude'), effort: null }];
  else entries = assignment?.engine ? stageChain(assignment, normalizeCatalog(config)) : [{}];
  const notes = [];
  if (entries.some(entry => entry.engine === 'codex') && !(await codexConnected(ctx, config))) {
    const usable = entries.filter(entry => entry.engine !== 'codex');
    if (usable.length) {
      notes.push(`${label}: Codex is not connected; used ${usable[0].model} from the fallback chain`);
      entries = usable;
    }
  }
  return { stage, entries, notes };
}

// Runs the draft through each entry of its chain: a Claude entry gets the quota policy (ladder, limits); a
// failure hands over to the next entry with a note. A login or input problem stops at once.
async function withStageChain(ctx, config, plan, attempt) {
  const notes = [];
  let lastError = null;
  for (let index = 0; index < plan.entries.length; index += 1) {
    const entry = plan.entries[index];
    try {
      const outcome = await withQuotaPolicy(ctx, config, entry, attempt);
      return { ...outcome, chainNotes: notes };
    } catch (error) {
      lastError = error;
      const next = plan.entries[index + 1];
      if (!next || error instanceof AuthExpiredError || error instanceof HubInputError || error?.status === 400) throw error;
      notes.push(`${STAGE_LABELS[plan.stage]}: ${entry.model || entry.engine} failed (${String(error?.message || error).split('\n')[0].slice(0, 120)}); used ${next.model}`);
    }
  }
  throw lastError;
}

// Runs one generation attempt; on a model weekly limit it steps down the model ladder once and notes
// it, on any other quota refusal it throws a QuotaError the routes turn into a plain-language reply.
const WEEKLY_QUOTA_KINDS = new Set(['ambiguousWeeklyLimit', 'modelWeeklyLimit', 'accountWeeklyLimit']);

async function recordQuotaNotice(ctx, entry) {
  await appendQuotaNotices(quotaNoticesPath(ctx.root), [{ at: ctx.now().toISOString(), source: 'cover-letter', ...entry }], { now: ctx.now(), io: ctx.io })
    .catch(error => console.error(`[cover-letter] could not record the quota notice: ${error?.message || error}`));
}

async function withQuotaPolicy(ctx, config, engineChoice, attempt) {
  const policy = normalizeQuotaPolicy(config.semanticMatching?.quotaPolicy);
  const plans = await currentPlans(ctx, config);
  const availability = await modelAvailabilityView(ctx, plans.claude).catch(() => ({ unavailable: [] }));
  const configured = letterEngineFor(ctx, config, engineChoice);
  // A model the plan refused earlier, or whose weekly limit has not reset, is skipped before the first
  // call; the note names the step taken.
  const limited = availability.limited || [];
  const skipped = [...availability.unavailable, ...limited];
  const startModel = configured.id === 'claude' ? firstAvailableModel(configured.model, policy.modelLadder, skipped) : configured.model;
  const first = startModel === configured.model ? configured : letterEngineFor(ctx, config, { ...engineChoice, engine: configured.id, model: startModel });
  const startNote = startModel === configured.model ? null
    : limited.includes(configured.model) && !availability.unavailable.includes(configured.model) ? `Generated with ${startModel}: ${configured.model} weekly limit`
      : `Generated with ${startModel}: ${configured.model} unavailable on ${planLabel(plans.claude)}`;
  const settle = (engine, outcome) => { if (engine.id === 'claude') ctx.authState?.clear?.(); return outcome; };
  try {
    return settle(first, { result: await attempt(first), engine: first, downgradeNote: startNote });
  } catch (error) {
    const verdict = classifyEngineError(error, { policy });
    if (verdict?.kind === 'model_unavailable' && first.id === 'claude') {
      await markModelUnavailableInHub(ctx, first.model, { plan: plans.claude, notice: verdict.notice, at: ctx.now().toISOString(), kind: verdict.reason || 'not_on_plan' }).catch(() => {});
      ctx.quotaLog?.record?.({ kind: 'model_unavailable', model: first.model, plan: plans.claude, at: ctx.now().toISOString(), engine: first.id, source: 'cover-letter', action: 'downgraded' });
      const next = nextAvailableModel(policy.modelLadder, first.model, [...availability.unavailable, first.model]);
      if (next) {
        const fallback = letterEngineFor(ctx, config, { ...engineChoice, engine: first.id, model: next });
        const note = `Generated with ${next}: ${first.model} unavailable on ${planLabel(plans.claude)}`;
        try {
          return settle(fallback, { result: await attempt(fallback), engine: fallback, downgradeNote: note });
        } catch (secondError) {
          const again = classifyEngineError(secondError, { policy });
          if (again?.kind === 'model_unavailable') { await markModelUnavailableInHub(ctx, next, { plan: plans.claude, notice: again.notice, at: ctx.now().toISOString(), kind: again.reason || 'not_on_plan' }).catch(() => {}); }
          throw new EngineError(humanizeEngineError(Object.assign(secondError, { plan: plans.claude }), { policy, timeZone: config.timeZone }).message, secondError, again?.kind || 'engine_error');
        }
      }
      throw new EngineError(humanizeEngineError(Object.assign(error, { plan: plans.claude }), { policy, timeZone: config.timeZone }).message, error, 'model_unavailable');
    }
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
    await recordQuotaNotice(ctx, { kind: quota.kind, model: quota.model || first.model, engine: first.id, action: 'refused', text: quota.message });
    if (quota.kind === 'modelWeeklyLimit') await updateAvailabilityInHub(ctx, record => markWeeklyLimit(record, quota.model || first.model, { at: ctx.now().toISOString(), resetsAt: quota.resetsAt, notice: quota.message })).catch(() => {});
    // The same rule as the nightly run: a named model limit steps down the ladder; a weekly notice that
    // names no model is settled by asking the next model, and only a second refusal is the account limit.
    const weekly = quota.kind === 'modelWeeklyLimit' || quota.kind === 'ambiguousWeeklyLimit';
    const next = weekly && first.id === 'claude' ? nextAvailableModel(policy.modelLadder, first.model, [...skipped, first.model]) : null;
    if (next) {
      const fallback = letterEngineFor(ctx, config, { ...engineChoice, engine: first.id, model: next });
      const limitedModel = quota.kind === 'modelWeeklyLimit' ? quota.model || first.model : first.model;
      const note = `Generated with ${next}: ${limitedModel} weekly limit`;
      try {
        const result = await attempt(fallback);
        if (quota.kind === 'ambiguousWeeklyLimit') {
          const resetsAt = quota.resetsAt || null;
          await updateAvailabilityInHub(ctx, record => markWeeklyLimit(record, first.model, { at: ctx.now().toISOString(), resetsAt, notice: quota.message })).catch(() => {});
          await recordQuotaNotice(ctx, { kind: 'modelWeeklyLimit', model: first.model, engine: first.id, action: 'settled', text: `${quota.message} (no model named; ${next} answered)` });
        }
        ctx.quotaLog?.record?.({ ...quota, kind: 'modelWeeklyLimit', model: limitedModel, at: ctx.now().toISOString(), engine: first.id, source: 'cover-letter', action: 'downgraded', detail: `switched to ${next}` });
        return settle(fallback, { result, engine: fallback, downgradeNote: note });
      } catch (secondError) {
        const secondVerdict = classifyEngineError(secondError, { policy });
        if (secondVerdict?.kind === 'auth_expired') { ctx.authState?.expire?.(secondVerdict.notice); throw new AuthExpiredError(secondVerdict.notice, secondError); }
        const again = classifyQuotaError(secondError, { policy });
        if (!again) { console.error(`[cover-letter] ${fallback.id} ${fallback.model} failed: ${String(secondError?.raw || secondError?.stack || secondError?.message || secondError)}`); throw new EngineError(humanizeEngineError(secondError, { policy, timeZone: config.timeZone }).message, secondError); }
        await recordQuotaNotice(ctx, { kind: again.kind, model: again.model || fallback.model, engine: fallback.id, action: 'refused', text: again.message });
        // Two models refused for a weekly window: the account itself is out.
        const settled = WEEKLY_QUOTA_KINDS.has(again.kind) ? { ...again, kind: 'accountWeeklyLimit', model: null } : again;
        ctx.quotaLog?.record?.({ ...settled, at: ctx.now().toISOString(), engine: fallback.id, source: 'cover-letter', action: 'refused' });
        throw new QuotaError(settled, secondError);
      }
    }
    // No other model to ask: an ambiguous notice cannot be told apart from the account limit.
    if (quota.kind === 'ambiguousWeeklyLimit') throw new QuotaError({ ...quota, kind: 'accountWeeklyLimit', model: null }, error);
    throw new QuotaError(quota, error);
  }
}

// strict (automatic letters): a draft that does not parse into a valid letter counts as a failure of that
// chain step, so the next step is tried; the manual panel keeps such a draft for editing.
export async function generateLetter(ctx, { date, jobId, trackId, company, engine: engineChoice = null, strict = false }) {
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
  // Draft and editor run on their own stage assignments (Settings → Task assignments).
  const draftPlan = await letterStagePlan(ctx, config, 'letterDraft', engineId);
  const editorPlan = review ? await letterStagePlan(ctx, config, 'letterEditor') : null;
  // An editor stage with no assignment of its own (the local_only placeholder) reviews with whichever engine
  // wrote the draft, including a ladder step it moved to.
  const reviewEngines = editorPlan && editorPlan.entries.some(entry => entry.engine) ? editorPlan.entries.map(entry => letterEngineFor(ctx, config, entry)) : null;
  const generated = await withStageChain(ctx, config, draftPlan, async engine => {
    const result = await generateCoverLetter({ engine, reviewEngines, inputs: { playbook, samples, track, resumeText: text, job, graduation, company: salutationCompany }, review, io: ctx.io });
    if (strict && (!result.ok || !result.paragraphs?.length)) throw new Error(`the draft from ${engine.model || engine.id} did not parse into a letter (${(result.issues || []).map(issue => issue.message || issue.kind || issue).slice(0, 2).join('; ') || 'no paragraphs'})`);
    return result;
  });
  const leading = [...draftPlan.notes, ...(editorPlan?.notes || []), ...generated.chainNotes, ...(generated.downgradeNote ? [generated.downgradeNote] : [])];
  const result = { ...generated.result, editorNotes: [...leading, ...(generated.result.editorNotes || [])], ...(generated.downgradeNote ? { downgradeNote: generated.downgradeNote } : {}) };
  const levels = classifyEditorNotes(result.editorNotes);
  return {
    ...result,
    notesNeedReview: levels.needsReview,
    notesInfo: levels.info,
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
    engine: draft.engine, model: draft.model, effort: draft.effort, reviewEngine: draft.reviewEngine, reviewModel: draft.reviewModel, reviewEffort: draft.reviewEffort,
    issues: draft.issues || [], editorNotes: draft.editorNotes || [], samplesUsed: draft.samplesUsed || [],
  });
  return { downloadUrl: saved.downloadUrl, openUrl: `/letters/${date}/${saved.slug}`, pdf: saved.pdf, company: draft.company, track: draft.track, wordCount: saved.wordCount, engine: draft.engine, model: draft.model, downgradeNote: draft.downgradeNote || null, checkBadge: reviewBadge(draft.editorNotes || []) };
}

// Persists edited paragraphs, renders the PDF, and records everything needed to reopen or re-download.
export async function saveLetter(ctx, { date, jobId, trackId, company, paragraphs, engine, model, effort = null, reviewEngine = null, reviewModel = null, reviewEffort = null, source = 'manual', issues = [], editorNotes = [], samplesUsed = [] }) {
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
      engine: engine || 'unknown', model: model || 'unknown', effort: effort || null, reviewEngine: reviewEngine || null, reviewModel: reviewModel || null, reviewEffort: reviewEffort || null, source,
      paragraphs: body, issues, editorNotes, samplesUsed, wordCount: body.join(' ').split(/\s+/).filter(Boolean).length,
      pdfFileName, createdAt: now.toISOString(), timeZone,
    } });
  } catch (error) {
    if (error instanceof LetterInputError) throw new HubInputError(error.message);
    throw error;
  }
  const pdfPath = path.join(saved.directory, pdfFileName);
  // A first render past one page asks the same engine for a 15 percent trim before smaller layouts are tried.
  const condensePlan = await letterStagePlan(ctx, config, 'letterDraft', engine === 'codex' ? 'codex' : null);
  const letterEngine = letterEngineFor(ctx, config, condensePlan.entries[0] || {});
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
