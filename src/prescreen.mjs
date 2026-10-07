// Two-step scoring: a cheap prescreen (the Prescreen stage: default Codex gpt-5.6-luna at low effort) scores
// every local candidate from its title, company, location, role type, the first 1,500 characters of the JD,
// and the resume digests, 25 per call; the final review then sees only what it needs. The final review's
// model, rubric, and thresholds are untouched.
//
//   config.prescreen { enabled: true, threshold: 55, shadowRuns: 3, enforce: false, batchSize: 25 }
//   Shadow mode (until shadowRuns successful nights have passed AND the owner enables it in Settings):
//   scores are computed and recorded, nothing is dropped, and the run counts how many final high matches
//   the threshold would have dropped (prescreen recall).
//   Enforced: postings at or above the threshold go on to the review budget ordered by prescreen score;
//   those below are marked seen (prescreened_out), never deferred, and listed in Run Details.
//   Any prescreen failure (login, limit, parse) falls back to the local order for the whole run.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWarning, errorSummary } from './warnings.mjs';
import { sha256 } from './utils.mjs';
import { STAGE_LABELS, stageAssignments } from './engines/assignments.mjs';
import { createEngine } from './engines/index.mjs';
import { usageEntries } from './engines/usage.mjs';
import { ensureDigests } from './resume-digest.mjs';
import { clearDeferred, markJobSeen } from './state.mjs';
import { isSemanticCandidate } from './subscription-match.mjs';

export const DEFAULT_PRESCREEN = { enabled: true, threshold: 55, shadowRuns: 3, enforce: false, batchSize: 25 };
export const JD_CHARACTERS = 1500;
const HISTORY_RUNS = 14;

export function prescreenSettings(config = {}) {
  const raw = config.prescreen && typeof config.prescreen === 'object' ? config.prescreen : {};
  const number = (value, fallback, min, max) => (Number.isFinite(Number(value)) && Number(value) >= min && Number(value) <= max ? Number(value) : fallback);
  return {
    enabled: raw.enabled !== false,
    threshold: number(raw.threshold, DEFAULT_PRESCREEN.threshold, 0, 100),
    shadowRuns: Math.round(number(raw.shadowRuns, DEFAULT_PRESCREEN.shadowRuns, 0, 30)),
    enforce: raw.enforce === true,
    batchSize: Math.round(number(raw.batchSize, DEFAULT_PRESCREEN.batchSize, 1, 50)),
  };
}

// 'enforced' only when the owner switched it on and the shadow nights are done; 'shadow' otherwise.
export function prescreenMode(settings, state = {}) {
  const done = Number(state.prescreen?.shadowRunsDone || 0);
  return settings.enforce && done >= settings.shadowRuns ? 'enforced' : 'shadow';
}

export function prescreenSchema(trackIds) {
  return {
    type: 'object', additionalProperties: false, required: ['results'],
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['id', 'prescreenScore', 'bestTrack'],
          properties: { id: { type: 'string' }, prescreenScore: { type: 'integer', minimum: 0, maximum: 100 }, bestTrack: { type: 'string', enum: trackIds } },
        },
      },
    },
  };
}

export function buildPrescreenPrompt(batch, tracks, digests) {
  const resumes = tracks.map(track => `### ${track.id} (${track.label})\n${digests[track.id] || '(no digest)'}`).join('\n\n');
  const jobs = batch.map(job => ({
    id: job.semanticId, title: job.title || '', company: job.company || '', location: job.location || '', roleType: job.roleType || 'unknown',
    description: String(job.description || '').replace(/\s+/g, ' ').slice(0, JD_CHARACTERS),
  }));
  return [
    'PRESCREEN. Rate how well each posting fits the candidate, from 0 to 100, as a quick first pass before a careful review.',
    'Use only the resume digests below. 80+ = clearly worth a full review; 55-79 = plausible; below 55 = unlikely (wrong field, too senior, or unrelated skills).',
    'Return exactly one result per posting id, with the best-fitting track id.',
    `Resume digests (track ids: ${tracks.map(track => track.id).join(', ')}):`,
    resumes,
    'Postings (JSON):',
    JSON.stringify({ jobs }, null, 2),
  ].join('\n\n');
}

function chunks(items, size) {
  const out = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

// Scores the candidates. Any failed batch (login, limit, unparseable reply) ends the prescreen for the run:
// { ok: false, error } and the caller keeps the local order. On success: { ok: true, scores: Map }.
export async function runPrescreen(candidates, { engine, tracks, digests, batchSize = DEFAULT_PRESCREEN.batchSize, recordUsage = null, io = fs }) {
  const trackIds = tracks.map(track => track.id);
  const schema = prescreenSchema(trackIds);
  const scores = new Map();
  const temp = await io.mkdtemp(path.join(os.tmpdir(), 'daily-job-match-alert-prescreen-'));
  try {
    await engine.verifyAuth?.();
    for (const batch of chunks(candidates, batchSize)) {
      const response = await engine.reviewBatch(buildPrescreenPrompt(batch, tracks, digests), schema, { tempDirectory: temp });
      if (typeof recordUsage === 'function' && response?.usage) recordUsage('prescreen', response.usage, { model: engine.model, scoringModel: response.scoringModel || null });
      const wanted = new Set(batch.map(job => job.semanticId));
      const results = Array.isArray(response?.results) ? response.results : null;
      if (!results) throw new Error('the prescreen reply has no results array');
      for (const item of results) {
        const id = String(item?.id || '');
        const score = Number(item?.prescreenScore);
        if (!wanted.has(id) || !Number.isFinite(score)) continue;
        scores.set(id, { score: Math.max(0, Math.min(100, Math.round(score))), track: trackIds.includes(item.bestTrack) ? item.bestTrack : null });
      }
      const missing = batch.filter(job => !scores.has(job.semanticId)).length;
      if (missing === batch.length) throw new Error(`the prescreen reply scored none of the ${batch.length} postings in a batch`);
    }
    return { ok: true, scores, model: engine.model };
  } catch (error) {
    return { ok: false, error, scores };
  } finally {
    await io.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

export function semanticIdOf(job) {
  return sha256(job.url).slice(0, 16);
}

// Annotates the jobs with their prescreen score; in enforced mode splits them into passed and dropped. A
// posting the prescreen did not score passes (it is never dropped for a missing answer).
export function applyPrescreen(jobs, scores, { threshold, mode }) {
  const annotated = jobs.map(job => {
    const entry = scores.get(semanticIdOf(job));
    return entry ? { ...job, prescreenScore: entry.score, prescreenTrack: entry.track } : job;
  });
  if (mode !== 'enforced') return { jobs: annotated, dropped: [] };
  const dropped = annotated.filter(job => Number.isFinite(job.prescreenScore) && job.prescreenScore < threshold);
  const droppedSet = new Set(dropped);
  return { jobs: annotated.filter(job => !droppedSet.has(job)), dropped };
}

// Final matches the threshold would have dropped (shadow mode): recall = kept / final matches.
export function prescreenRecall(matches, threshold) {
  const scored = matches.filter(job => Number.isFinite(job.prescreenScore));
  const lost = scored.filter(job => job.prescreenScore < threshold);
  return { finalMatches: scored.length, lost: lost.length, recall: scored.length ? (scored.length - lost.length) / scored.length : null, lostTitles: lost.map(job => ({ title: job.title || '', company: job.company || '', score: job.prescreenScore })) };
}

// Counts a successful shadow night (a same-day rerun does not count twice) and keeps the last 14 in state.prescreen.history.
export function recordPrescreenRun(state, entry) {
  state.prescreen = state.prescreen && typeof state.prescreen === 'object' ? state.prescreen : {};
  const previous = Array.isArray(state.prescreen.history) ? state.prescreen.history : [];
  const countedToday = previous.some(item => item.date === entry.date && item.ok && item.mode === 'shadow');
  if (entry.ok && entry.mode === 'shadow' && !countedToday) state.prescreen.shadowRunsDone = Number(state.prescreen.shadowRunsDone || 0) + 1;
  const history = previous.filter(item => item.date !== entry.date);
  history.push(entry);
  history.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  state.prescreen.history = history.slice(-HISTORY_RUNS);
  return state.prescreen;
}

export function prescreenFailureWarning(error) {
  return createWarning('llm', 'prescreen', `the prescreen failed (${errorSummary(error, 160)}); this run used the local order for the review budget and dropped nothing`);
}

function defaultMakeEngine(assignment, config) {
  return createEngine(assignment.engine, { ...(config.semanticMatching || {}), model: assignment.model, reasoningEffort: assignment.engine === 'codex' ? assignment.effort : null });
}

// The nightly stage, between the local evaluation and the review budget. Returns the jobs that go on to
// the budget, the postings it dropped (enforced mode only, already marked seen), the usage entries, and
// the summary for meta.prescreen. `options.makeEngine(assignment)` lets tests and chaos inject an engine.
export async function prescreenStage(jobs, { config, state, resumes, tracks, date, now = new Date(), warnings = [], makeEngine = null, io = fs } = {}) {
  const settings = prescreenSettings(config);
  const assignment = stageAssignments(config).prescreen;
  const base = { enabled: settings.enabled, threshold: settings.threshold, shadowRuns: settings.shadowRuns, shadowRunsDone: Number(state.prescreen?.shadowRunsDone || 0), enforce: settings.enforce };
  const candidates = jobs.filter(isSemanticCandidate).map(job => ({ ...job, semanticId: semanticIdOf(job) }));
  if (!settings.enabled || !assignment?.engine) return { jobs, dropped: [], usage: [], meta: { ...base, status: 'off', reason: settings.enabled ? 'no prescreen model (local_only scoring)' : 'turned off in Settings', candidates: candidates.length } };
  const mode = prescreenMode(settings, state);
  if (!candidates.length) return { jobs, dropped: [], usage: [], meta: { ...base, status: 'idle', mode, candidates: 0, engine: assignment.engine, model: assignment.model } };
  const usage = [];
  const recordUsage = (purpose, value) => usage.push(...usageEntries(value, { purpose, at: new Date().toISOString(), source: 'nightly' }));
  let result;
  try {
    const { digests } = await ensureDigests(config.root, resumes, { io });
    const engine = (makeEngine || (value => defaultMakeEngine(value, config)))(assignment);
    result = await runPrescreen(candidates, { engine, tracks, digests, batchSize: settings.batchSize, recordUsage, io });
  } catch (error) {
    result = { ok: false, error, scores: new Map() };
  }
  const describe = { engine: assignment.engine, model: assignment.model, effort: assignment.effort || null, label: STAGE_LABELS.prescreen };
  if (!result.ok) {
    warnings.push(prescreenFailureWarning(result.error));
    recordPrescreenRun(state, { date, at: now.toISOString(), mode, ok: false, candidates: candidates.length, error: errorSummary(result.error, 200) });
    return { jobs, dropped: [], usage, meta: { ...base, ...describe, status: 'failed', mode, candidates: candidates.length, scored: 0, error: errorSummary(result.error, 200) } };
  }
  const applied = applyPrescreen(jobs, result.scores, { threshold: settings.threshold, mode });
  const at = now.toISOString();
  for (const job of applied.dropped) { clearDeferred(state, job); markJobSeen(state, { ...job, enrichment: 'prescreened_out' }, at); }
  const scoredJobs = applied.jobs.concat(applied.dropped).filter(job => Number.isFinite(job.prescreenScore));
  const wouldDrop = scoredJobs.filter(job => job.prescreenScore < settings.threshold).length;
  return {
    jobs: applied.jobs, dropped: applied.dropped, usage,
    meta: {
      ...base, ...describe, status: 'ok', mode, candidates: candidates.length, scored: result.scores.size,
      passed: candidates.length - wouldDrop, wouldDrop, droppedCount: applied.dropped.length,
      dropped: applied.dropped.map(job => ({ url: job.url, title: job.title || '', company: job.company || '', score: job.prescreenScore })).sort((a, b) => b.score - a.score),
    },
  };
}

// After the final review: the shadow statistics, written into state (one entry per night) and meta.
export function finishPrescreen(meta, state, { matches, date, now = new Date() }) {
  if (!meta || !['ok', 'failed'].includes(meta.status)) return meta;
  if (meta.status === 'failed') return { ...meta, shadowRunsDone: Number(state.prescreen?.shadowRunsDone || 0) };
  const recall = prescreenRecall(matches, meta.threshold);
  const out = { ...meta, finalMatches: recall.finalMatches, lost: recall.lost, recall: recall.recall, lostTitles: recall.lostTitles };
  recordPrescreenRun(state, { date, at: now.toISOString(), mode: meta.mode, ok: true, candidates: meta.candidates, scored: meta.scored, passed: meta.passed, dropped: meta.droppedCount, finalMatches: recall.finalMatches, lost: recall.lost, recall: recall.recall });
  out.shadowRunsDone = Number(state.prescreen.shadowRunsDone || 0);
  out.readyToEnforce = out.mode === 'shadow' && out.shadowRunsDone >= meta.shadowRuns;
  return out;
}

// For Settings and Status: the mode, the shadow progress, and the recall over the recorded nights.
export function prescreenOverview(config = {}, state = {}) {
  const settings = prescreenSettings(config);
  const history = Array.isArray(state.prescreen?.history) ? state.prescreen.history : [];
  const done = Number(state.prescreen?.shadowRunsDone || 0);
  const shadowNights = history.filter(item => item.ok && item.mode === 'shadow');
  const finalMatches = shadowNights.reduce((sum, item) => sum + Number(item.finalMatches || 0), 0);
  const lost = shadowNights.reduce((sum, item) => sum + Number(item.lost || 0), 0);
  return {
    ...settings, shadowRunsDone: done, mode: settings.enabled ? prescreenMode(settings, state) : 'off',
    canEnforce: done >= settings.shadowRuns, finalMatches, lost, recall: finalMatches ? (finalMatches - lost) / finalMatches : null,
    last: history[history.length - 1] || null, history,
  };
}

export { describePrescreen, funnelText, recallText } from './prescreen-text.mjs';
