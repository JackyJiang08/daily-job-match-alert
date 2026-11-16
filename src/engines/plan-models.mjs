// Models a Claude plan bills to usage credits instead of the plan's own allowance. On Pro, Fable is charged to
// paid usage credits from the first call (Anthropic's plan notes); this project runs on subscription
// allowances only, so on Pro every task's chain skips Fable before any call: scoring starts at the next
// ladder step (Opus), the weekly-limit ladder starts at Opus, and letter / prescreen chains drop it. The
// config file is never rewritten: planAdjustedConfig returns a copy for the run, and paidCreditStages names
// the Settings rows whose configured chain still lists Fable. Back on Max, nothing is skipped.
import { DEFAULT_CATALOG, ENGINE_PROVIDER, PROVIDER_ENGINE, canonicalModelId, findModel, normalizeCatalog } from './catalog.mjs';
import { resolveModel } from './index.mjs';
import { normalizeQuotaPolicy } from './quota.mjs';
import { planView } from './plans.mjs';

// plan → registry aliases whose calls are billed to usage credits on it.
export const PAID_CREDIT_ALIASES = { pro: ['fable'] };
export const PAID_CREDIT_WARNING = 'Fable Uses Paid Credits On Pro';
const REPLACEMENT_ALIAS = 'opus';

export function paidCreditModel(model, plan, catalog = DEFAULT_CATALOG) {
  const aliases = PAID_CREDIT_ALIASES[String(plan || '').toLowerCase()];
  if (!aliases || !model) return false;
  const entry = findModel(catalog, model, 'anthropic');
  if (entry) return aliases.includes(entry.alias) || aliases.some(alias => entry.id.toLowerCase().startsWith(`claude-${alias}-`));
  const name = String(model).trim().toLowerCase();
  return aliases.some(alias => name === alias || name.startsWith(`claude-${alias}-`));
}

// The registry ids a plan bills to usage credits (for the skip lists of the scoring and letter ladders).
export function paidCreditModels(plan, catalog = DEFAULT_CATALOG) {
  return catalog.filter(entry => entry.provider === 'anthropic' && paidCreditModel(entry.id, plan, catalog)).map(entry => entry.id);
}

// The Claude plan in effect: Settings' manual plan, the scheduled change once its date is reached, else the
// plan the CLI last reported.
export function claudePlanOf(config = {}, { detected = null, now = new Date() } = {}) {
  return planView('claude', { detected, config, now, timeZone: config.timeZone || 'America/Chicago' }).plan;
}

function chainOf(stage) {
  return stage?.engine ? [stage.model, ...(stage.fallback || [])] : [];
}

// A copy of the config whose scoring model, model ladder, and task assignments skip what the plan bills to
// usage credits; the same object when nothing is skipped.
export function planAdjustedConfig(config = {}, plan = null) {
  const catalog = normalizeCatalog(config);
  const paid = id => paidCreditModel(id, plan, catalog);
  if (!PAID_CREDIT_ALIASES[String(plan || '').toLowerCase()]) return config;
  const replacement = canonicalModelId(REPLACEMENT_ALIAS, 'anthropic', catalog);
  const semantic = { ...(config.semanticMatching || {}) };
  const ladder = normalizeQuotaPolicy({ ...(semantic.quotaPolicy || {}), catalog }).modelLadder.filter(id => !paid(id));
  const modelLadder = ladder.length ? ladder : [replacement];
  semantic.quotaPolicy = { ...(semantic.quotaPolicy || {}), modelLadder };
  if (paid(resolveModel({ ...semantic, catalog }, 'claude'))) semantic.models = { ...(semantic.models || {}), claude: modelLadder[0] };
  const raw = config.models?.assignments;
  let assignments = raw;
  if (raw && typeof raw === 'object') {
    assignments = {};
    for (const [stage, value] of Object.entries(raw)) {
      const steps = Array.isArray(value?.fallback) ? value.fallback : null;
      const primaryPaid = ENGINE_PROVIDER[String(value?.engine || '').toLowerCase()] === 'anthropic' && paid(value?.model);
      const fallback = (steps || []).filter(id => !paid(id));
      if (!primaryPaid) { assignments[stage] = steps && fallback.length !== steps.length ? { ...value, fallback } : value; continue; }
      // The stage's own model is billed: its first fallback (or Opus) takes its place.
      const next = fallback.length ? fallback[0] : replacement;
      const entry = findModel(catalog, next);
      const engine = entry ? PROVIDER_ENGINE[entry.provider] : 'claude';
      assignments[stage] = { ...value, engine, model: entry?.id || next, effort: engine === 'codex' ? value.effort ?? null : null, fallback: fallback.slice(fallback.length ? 1 : 0) };
    }
  }
  return { ...config, semanticMatching: semantic, ...(raw ? { models: { ...config.models, assignments } } : {}) };
}

// The Settings rows (stage keys of src/engines/assignments.mjs, plus 'ladder' for the weekly-limit ladder)
// whose configured chain lists a model the plan bills to usage credits.
export function paidCreditStages(assignments, ladder, plan, catalog = DEFAULT_CATALOG) {
  if (!PAID_CREDIT_ALIASES[String(plan || '').toLowerCase()]) return [];
  const out = [];
  for (const [stage, value] of Object.entries(assignments || {})) {
    if (value?.linked) continue;
    if (chainOf(value).some(id => paidCreditModel(id, plan, catalog))) out.push(stage);
  }
  if ((ladder || []).some(id => paidCreditModel(id, plan, catalog))) out.push('ladder');
  return out;
}
