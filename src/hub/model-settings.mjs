// The data behind Settings → Subscriptions & Models: one card per subscription (connection, plan with its
// source and detection time, a scheduled change, CLI path and version, seven days of tokens per model, the
// latest limit event and its expected reset), a compact table of registry models per provider (the release
// the alias resolves to, availability on the current plan, last use, the stages that use it), and the
// task assignments with their fallback chains. Built from what the hub already keeps: the connection probes,
// state/model-availability.json, state/usage.json, quota events, and config.json. Nothing here calls a model.
import { ENGINE_PROVIDER, PROVIDER_ENGINE, PROVIDER_LABELS, findModel, newerRelease, normalizeCatalog, providerModels } from '../engines/catalog.mjs';
import { STAGE_LABELS, stageAssignments, stageChain } from '../engines/assignments.mjs';
import { modelKey, modelStatus } from '../engines/model-availability.mjs';
import { describeQuota, planLabel } from '../engines/quota.mjs';
import { planView, displayPlan } from '../engines/plans.mjs';
import { formatLocalDateTime } from '../time-format.mjs';
import { usageWindow } from '../engines/usage.mjs';

export const STATUS_LABELS = {
  available: 'Available', not_verified: 'Not verified', weekly_limit: 'Weekly limit', not_on_plan: 'Unavailable', unknown_model: 'Unknown model',
};
export const STATUS_TONES = { available: 'good', not_verified: 'muted', weekly_limit: 'warn', not_on_plan: 'bad', unknown_model: 'bad' };
const BLOCKING = new Set(['not_on_plan', 'unknown_model', 'weekly_limit']);

// "Available", "Unavailable on Pro", "Weekly limit until Oct 8, 2026, 9:00 AM" (or "since …" without a
// reset time), "Unknown model", "Not verified".
export function statusText(status, timeZone, plan = null) {
  if (status.state === 'weekly_limit') return status.resetsAt ? `Weekly limit until ${formatLocalDateTime(status.resetsAt, timeZone)}` : `Weekly limit since ${formatLocalDateTime(status.at, timeZone)}`;
  if (status.state === 'not_on_plan') return `Unavailable on ${planLabel(status.plan || plan)}`;
  return STATUS_LABELS[status.state] || status.state;
}

function step(catalog, record, entry, { now, timeZone, plan }) {
  const status = modelStatus(record, entry.model, { now });
  return { ...entry, alias: findModel(catalog, entry.model)?.alias || null, status, blocked: BLOCKING.has(status.state), reason: BLOCKING.has(status.state) ? statusText(status, timeZone, plan) : null };
}

// The latest limit event for an engine: from this hub's own log or the newest run, with the reset time a
// recorded weekly limit adds.
function lastLimitFor(engine, events, record, timeZone) {
  const own = (events || []).filter(event => event && (event.engine === engine || (!event.engine && engine === 'claude')) && event.kind !== 'auth_expired');
  own.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  const event = own[0];
  if (!event) return null;
  const limit = event.model ? record?.limits?.[modelKey(event.model)] : null;
  const resetsAt = event.resetsAt || limit?.resetsAt || null;
  return { at: event.at, text: describeQuota(event, { timeZone }), resetsAt, action: event.action || null, source: event.source || 'nightly run' };
}

export function modelSettingsView({ config = {}, settings = {}, connections = null, record, usage = null, events = [], now = new Date(), timeZone = 'America/Chicago' }) {
  const catalog = normalizeCatalog(config);
  const assignments = stageAssignments(config);
  const claudePlan = planView('claude', { detected: connections?.claude?.plan || null, detectedSource: connections?.claude?.planSource || null, config, now, timeZone });
  const chatgptPlan = planView('chatgpt', { detected: connections?.codex?.plan || null, detectedSource: connections?.codex?.planSource || null, config, now, timeZone });
  const planFor = provider => (provider === 'anthropic' ? claudePlan : chatgptPlan);

  const stages = ['scoring', 'supplemental', 'letterDraft', 'letterEditor', 'prescreen'].map(stage => {
    const assignment = assignments[stage];
    const chain = stageChain(assignment, catalog).map(entry => step(catalog, record, entry, { now, timeZone, plan: planFor(ENGINE_PROVIDER[entry.engine])?.plan }));
    return { stage, label: STAGE_LABELS[stage], ...assignment, chain, off: (stage === 'letterEditor' && settings.editorReview === false) || (stage === 'prescreen' && config.prescreen?.enabled === false) };
  });
  const usedBy = id => stages.filter(row => !row.reserved && !row.linked && !row.off && row.chain.some(item => modelKey(item.model) === modelKey(id)))
    .map(row => ({ stage: row.label, primary: modelKey(row.model) === modelKey(id) }));

  const card = provider => {
    const engine = PROVIDER_ENGINE[provider];
    const connection = connections?.[engine] || null;
    const plan = planFor(provider);
    const window = usage?.entries ? usageWindow({ entries: usage.entries.filter(entry => entry.engine === engine) }, usage.options) : null;
    const tokensByModel = window?.total?.calls ? Object.entries(window.byModel).map(([model, totals]) => ({ model, totals })).sort((a, b) => (b.totals.input + b.totals.output) - (a.totals.input + a.totals.output)) : [];
    const models = providerModels(catalog, provider).map(entry => {
      const status = modelStatus(record, entry.id, { now });
      const stagesUsing = usedBy(entry.id);
      return {
        ...entry, status, statusText: statusText(status, timeZone, plan.plan), usedBy: stagesUsing,
        version: status.resolvedId || null, newVersion: newerRelease(entry, status.resolvedId, catalog),
        // Models nobody uses and nothing has called fold under "Show all models".
        folded: !status.lastUsedAt && !stagesUsing.length && status.state === 'not_verified',
      };
    });
    return {
      provider, engine, name: PROVIDER_LABELS[provider], connection, plan, checkedAt: connections?.checkedAt || null,
      usage: window?.total?.calls ? { total: window.total, tokensByModel } : null,
      lastLimit: lastLimitFor(engine, events, record, timeZone), models,
    };
  };
  return { catalog, cards: [card('anthropic'), card('openai')], stages, assignments, displayPlan };
}
