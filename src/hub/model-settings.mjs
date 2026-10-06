// The data behind the subscription and model part of Settings: one card per subscription (connection,
// plan and its source, a scheduled change, CLI path and version, seven days of usage), the registry's
// models per provider with a live status, which task stage uses each model, and every stage's fallback
// chain. Built from what the hub already keeps: the connection probes, state/model-availability.json,
// state/usage.json, and config.json. Nothing here calls a model.
import { ENGINE_PROVIDER, PROVIDER_ENGINE, PROVIDER_LABELS, findModel, normalizeCatalog, providerModels } from '../engines/catalog.mjs';
import { modelKey, modelStatus } from '../engines/model-availability.mjs';
import { normalizeQuotaPolicy, planLabel } from '../engines/quota.mjs';
import { planView } from '../engines/plans.mjs';
import { formatLocalDateTime } from '../time-format.mjs';
import { usageWindow } from '../engines/usage.mjs';

export const STATUS_LABELS = {
  available: 'Available', not_verified: 'Not verified', weekly_limit: 'Weekly limit', not_on_plan: 'Not on plan', unknown_model: 'Unknown model',
};
export const STATUS_TONES = { available: 'good', not_verified: 'muted', weekly_limit: 'warn', not_on_plan: 'bad', unknown_model: 'bad' };
const BLOCKING = new Set(['not_on_plan', 'unknown_model', 'weekly_limit']);

// "Weekly limit until Oct 8, 2026, 9:00 AM" when the CLI gave a reset time, else "since <when it was seen>".
export function statusText(status, timeZone, plan = null) {
  const label = STATUS_LABELS[status.state] || status.state;
  if (status.state === 'weekly_limit') return status.resetsAt ? `${label} until ${formatLocalDateTime(status.resetsAt, timeZone)}` : `${label} since ${formatLocalDateTime(status.at, timeZone)}`;
  if (status.state === 'not_on_plan') return `${label}${status.plan || plan ? ` (${planLabel(status.plan || plan)})` : ''}`;
  return label;
}

function step(catalog, record, id, { now, timeZone, note = null } = {}) {
  const entry = findModel(catalog, id);
  const status = modelStatus(record, id, { now });
  return { id: entry?.id || id, alias: entry?.alias || null, status, blocked: BLOCKING.has(status.state), reason: BLOCKING.has(status.state) ? statusText(status, timeZone) : null, note };
}

// Scoring, Supplemental, Cover letter draft, Cover letter editor, and the reserved Prescreen row.
export function assignmentRows({ settings, catalog, record, policy, now, timeZone }) {
  const engine = settings.engine;
  const model = settings.models?.[engine] || null;
  const effort = engine === 'codex' ? settings.reasoningEffort || null : null;
  const ladder = policy.modelLadder || [];
  const ladderAfter = model && ladder.some(item => modelKey(item) === modelKey(model)) ? ladder.slice(ladder.findIndex(item => modelKey(item) === modelKey(model)) + 1) : ladder.filter(item => modelKey(item) !== modelKey(model));
  const codexModel = settings.models?.codex || null;
  const scoringChain = engine === 'claude'
    ? [step(catalog, record, model, { now, timeZone }), ...ladderAfter.map(id => step(catalog, record, id, { now, timeZone, note: 'weekly limit or not on plan' })), ...(settings.fallbackEngine === 'codex' && codexModel ? [step(catalog, record, codexModel, { now, timeZone, note: 'Codex, on a weekly account limit' })] : [])]
    : [step(catalog, record, model, { now, timeZone })];
  const letterChain = engine === 'claude'
    ? [step(catalog, record, model, { now, timeZone }), ...ladderAfter.map(id => step(catalog, record, id, { now, timeZone, note: 'weekly limit or not on plan' })), ...(codexModel ? [step(catalog, record, codexModel, { now, timeZone, note: 'Codex, on request (Generate with Codex)' })] : [])]
    : [step(catalog, record, model, { now, timeZone })];
  return [
    { stage: 'scoring', label: 'Scoring', engine, model, effort, chain: scoringChain, editable: true },
    { stage: 'supplemental', label: 'Supplemental', engine, model, effort, chain: scoringChain, note: 'Same engine and model as Scoring (ids the first pass omitted)' },
    { stage: 'letterDraft', label: 'Cover letter draft', engine, model, effort, chain: letterChain },
    { stage: 'letterEditor', label: 'Cover letter editor', engine, model, effort, chain: letterChain, off: settings.editorReview === false, note: settings.editorReview === false ? 'Editor review is off' : null },
    { stage: 'prescreen', label: 'Prescreen', engine: null, model: null, effort: null, chain: [], reserved: true, note: 'Local title and location rules; no model (reserved for a future model step)' },
  ];
}

function usageFor(usage, engine) {
  if (!usage?.entries) return null;
  const window = usageWindow({ entries: usage.entries.filter(entry => entry.engine === engine) }, usage.options);
  return window.total.calls ? window : null;
}

// Everything the subscription and model sections render.
export function modelSettingsView({ config = {}, settings, connections = null, record, usage = null, now = new Date(), timeZone = 'America/Chicago' }) {
  const catalog = normalizeCatalog(config);
  const policy = normalizeQuotaPolicy({ ...(config.semanticMatching?.quotaPolicy || {}), catalog });
  const rows = assignmentRows({ settings, catalog, record, policy, now, timeZone });
  // A model is "used by" a stage when it is the stage's model or a step of its fallback chain.
  const usedBy = id => rows.filter(row => !row.reserved && !row.off && row.chain.some(item => modelKey(item.id) === modelKey(id)))
    .map(row => ({ stage: row.label, primary: modelKey(row.model) === modelKey(id) }));
  const providerCard = provider => {
    const engine = PROVIDER_ENGINE[provider];
    const connection = connections?.[engine] || null;
    const plans = planView(provider === 'anthropic' ? 'claude' : 'chatgpt', { detected: connection?.plan || null, detectedSource: connection?.planSource || null, config, now, timeZone });
    const models = providerModels(catalog, provider).map(entry => {
      const status = modelStatus(record, entry.id, { now });
      return { ...entry, status, statusText: statusText(status, timeZone, plans.plan), usedBy: usedBy(entry.id) };
    });
    return { provider, engine, name: PROVIDER_LABELS[provider], connection, plan: plans, usage: usageFor(usage, engine), models };
  };
  const ladderIds = policy.modelLadder;
  const anthropic = providerModels(catalog, 'anthropic');
  const ladderOptions = [...ladderIds.map(id => findModel(catalog, id, 'anthropic') || { id, label: id, alias: null, provider: 'anthropic' }), ...anthropic.filter(entry => !ladderIds.includes(entry.id))]
    .map(entry => ({ ...entry, checked: ladderIds.includes(entry.id), status: modelStatus(record, entry.id, { now }) }));
  return { catalog, cards: [providerCard('anthropic'), providerCard('openai')], assignments: rows, ladder: { ids: ladderIds, options: ladderOptions }, policy };
}

export { ENGINE_PROVIDER };
