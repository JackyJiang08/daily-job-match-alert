// Which engine, model, and reasoning effort each task stage uses, and what it falls back to.
//
//   scoring       semanticMatching.engine / models / reasoningEffort; its fallback chain is the model
//                 ladder (quotaPolicy.modelLadder after the scoring model) plus, at the end, the Codex
//                 model when quotaPolicy.fallbackEngine is "codex" (a weekly account limit hands over).
//   supplemental  linked to scoring (the same call path re-asks for omitted ids).
//   letterDraft   config.models.assignments.letterDraft { engine, model, effort, fallback: [ids] }
//   letterEditor  config.models.assignments.letterEditor (same shape)
//   prescreen     reserved: local title and location rules, no model.
//
// Letter defaults: draft codex / gpt-5.6-sol / medium, editor codex / gpt-5.6-sol / high, both falling back
// to the Claude ladder's Opus step. A config that scores with local_only and names no letter assignment
// keeps the labelled placeholder engine, so demos and tests never call a model.
import { DEFAULT_CATALOG, DEFAULT_LETTER_FALLBACK_ALIAS, ENGINE_PROVIDER, PROVIDER_ENGINE, canonicalModelId, defaultModelId, findModel, normalizeCatalog } from './catalog.mjs';
import { normalizeEngineId, resolveModel } from './index.mjs';
import { normalizeQuotaPolicy } from './quota.mjs';
import { modelKey } from './model-availability.mjs';

export const STAGES = ['scoring', 'supplemental', 'letterDraft', 'letterEditor', 'prescreen'];
export const LETTER_STAGES = ['letterDraft', 'letterEditor'];
export const STAGE_LABELS = { scoring: 'Scoring', supplemental: 'Supplemental', letterDraft: 'Cover letter draft', letterEditor: 'Cover letter editor', prescreen: 'Prescreen' };
const DEFAULT_LETTER_EFFORTS = { letterDraft: 'medium', letterEditor: 'high' };

export function defaultLetterAssignment(stage, catalog = DEFAULT_CATALOG) {
  return { engine: 'codex', model: defaultModelId('codex', catalog), effort: DEFAULT_LETTER_EFFORTS[stage], fallback: [canonicalModelId(DEFAULT_LETTER_FALLBACK_ALIAS, 'anthropic', catalog)] };
}

function effortFor(engine, model, effort, catalog) {
  if (engine !== 'codex' || !effort) return null;
  const entry = findModel(catalog, model, 'openai');
  const value = String(effort).toLowerCase();
  return !entry?.efforts || entry.efforts.includes(value) ? value : null;
}

// Registry ids in order, without repeats, without the stage's own model.
function cleanFallback(list, primary, catalog) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const entry = findModel(catalog, item);
    if (!entry || modelKey(entry.id) === modelKey(primary) || out.includes(entry.id)) continue;
    out.push(entry.id);
  }
  return out;
}

function normalizeLetter(raw, stage, catalog) {
  const fallbackDefault = defaultLetterAssignment(stage, catalog);
  const engine = normalizeEngineId(raw?.engine);
  if (engine !== 'claude' && engine !== 'codex') return { ...fallbackDefault, source: 'default' };
  const provider = ENGINE_PROVIDER[engine];
  const model = findModel(catalog, raw?.model, provider)?.id || canonicalModelId(raw?.model, provider, catalog) || defaultModelId(engine, catalog);
  return { engine, model, effort: effortFor(engine, model, raw?.effort, catalog), fallback: cleanFallback(raw?.fallback ?? fallbackDefault.fallback, model, catalog), source: 'config' };
}

// Every stage, normalized; older configs (no models.assignments) migrate to the defaults above.
export function stageAssignments(config = {}) {
  const catalog = normalizeCatalog(config);
  const semantic = { ...(config.semanticMatching || {}), catalog };
  const scoringEngineRaw = normalizeEngineId(semantic.engine || 'claude');
  const localOnly = scoringEngineRaw === 'local_only';
  const scoringEngine = scoringEngineRaw === 'codex' ? 'codex' : localOnly ? 'local_only' : 'claude';
  const policy = normalizeQuotaPolicy({ ...(semantic.quotaPolicy || {}), catalog });
  const scoringModel = scoringEngine === 'local_only' ? null : resolveModel(semantic, scoringEngine);
  const ladder = policy.modelLadder;
  const ladderAfter = scoringEngine !== 'claude' ? [] : ladder.some(id => modelKey(id) === modelKey(scoringModel)) ? ladder.slice(ladder.findIndex(id => modelKey(id) === modelKey(scoringModel)) + 1) : ladder.filter(id => modelKey(id) !== modelKey(scoringModel));
  const codexModel = resolveModel(semantic, 'codex');
  const scoring = {
    engine: scoringEngine, model: scoringModel, effort: effortFor(scoringEngine, scoringModel, semantic.reasoningEffort, catalog),
    fallback: [...ladderAfter, ...(scoringEngine === 'claude' && policy.fallbackEngine === 'codex' && codexModel ? [codexModel] : [])],
    source: 'config',
  };
  const raw = config.models?.assignments || {};
  const letter = stage => (raw[stage] ? normalizeLetter(raw[stage], stage, catalog) : localOnly ? { engine: null, model: null, effort: null, fallback: [], source: 'placeholder' } : { ...defaultLetterAssignment(stage, catalog), source: 'default' });
  return {
    scoring,
    supplemental: { ...scoring, linked: 'scoring' },
    letterDraft: letter('letterDraft'),
    letterEditor: letter('letterEditor'),
    prescreen: { engine: null, model: null, effort: null, fallback: [], reserved: true },
  };
}

// [{ engine, model, effort }] for a stage: the assignment, then its fallback models (each on its own
// provider's engine, at the CLI's default effort).
export function stageChain(assignment, catalog = DEFAULT_CATALOG) {
  if (!assignment?.engine) return [];
  return [
    { engine: assignment.engine, model: assignment.model, effort: assignment.effort || null },
    ...(assignment.fallback || []).map(id => {
      const entry = findModel(catalog, id);
      return { engine: entry ? PROVIDER_ENGINE[entry.provider] : 'claude', model: entry?.id || id, effort: null };
    }),
  ];
}

// Validates a letter stage from the Settings form; returns { value, errors }.
export function validateLetterAssignment(stage, form, { catalog = DEFAULT_CATALOG } = {}) {
  const errors = [];
  const label = STAGE_LABELS[stage];
  const engine = normalizeEngineId(form.engine);
  if (engine !== 'claude' && engine !== 'codex') errors.push(`${label}: engine must be claude or codex`);
  const provider = ENGINE_PROVIDER[engine];
  const entry = provider ? findModel(catalog, form.model, provider) : null;
  if (provider && !entry) errors.push(`${label}: ${form.model || 'the model'} is not a ${engine === 'codex' ? 'ChatGPT' : 'Claude'} model in the registry`);
  const effort = form.effort ? String(form.effort).toLowerCase() : null;
  if (effort && engine !== 'codex') errors.push(`${label}: reasoning effort applies to Codex models only`);
  if (effort && entry?.efforts && !entry.efforts.includes(effort)) errors.push(`${label}: ${entry.id} accepts the efforts ${entry.efforts.join(', ')}`);
  const fallback = [];
  for (const item of [].concat(form.fallback ?? []).map(String).filter(Boolean)) {
    const step = findModel(catalog, item);
    if (!step) { errors.push(`${label}: ${item} is not in the model registry`); continue; }
    if (entry && step.id === entry.id) { errors.push(`${label}: ${step.id} is already the stage's model`); continue; }
    if (fallback.includes(step.id)) { errors.push(`${label}: ${step.id} appears twice in the fallback chain`); continue; }
    fallback.push(step.id);
  }
  return { value: { engine, model: entry?.id || null, effort: engine === 'codex' ? effort : null, fallback }, errors };
}
