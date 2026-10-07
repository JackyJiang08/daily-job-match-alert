// The model registry: the single place that names models. Every call (scoring, supplemental review, the
// cover-letter draft and editor passes) resolves its model here and passes the full id to the CLI;
// aliases are accepted on input (config, older files) and mapped to the entry they name.
//
// Entries: { provider: 'anthropic' | 'openai', id, label, alias, efforts?, isDefault?, weight? }. weight
// ('light' | 'standard' | 'heavy') orders models by cost; gpt-5.6-luna is light per `codex debug models`
// ("fast and efficient"), claude-haiku-4-5 is Claude's light tier. The defaults
// were checked against the CLIs installed on the owner's Mac (Claude Code 2.1.292: the binary's model
// table and its alias defaults; codex-cli 0.153.0: `codex debug models`), not taken on faith.
// config.models.catalog replaces the defaults; the older hub.modelChoices lists are migrated.
import { normalizeModelName } from './shared.mjs';

export const PROVIDERS = ['anthropic', 'openai'];
export const ENGINE_PROVIDER = { claude: 'anthropic', codex: 'openai' };
export const PROVIDER_ENGINE = { anthropic: 'claude', openai: 'codex' };
export const PROVIDER_LABELS = { anthropic: 'Claude', openai: 'ChatGPT' };

export const DEFAULT_CATALOG = [
  { provider: 'anthropic', id: 'claude-fable-5-1', label: 'Claude Fable 5.1', alias: 'fable', isDefault: true, weight: 'heavy' },
  { provider: 'anthropic', id: 'claude-opus-5-5', label: 'Claude Opus 5.5', alias: 'opus', weight: 'heavy' },
  { provider: 'anthropic', id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', alias: 'sonnet', weight: 'standard' },
  { provider: 'anthropic', id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', alias: 'haiku', weight: 'light' },
  { provider: 'openai', id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', alias: null, efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], isDefault: true, weight: 'standard' },
  { provider: 'openai', id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', alias: null, efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], weight: 'standard' },
  { provider: 'openai', id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', alias: null, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], weight: 'light' },
  { provider: 'openai', id: 'gpt-5.5', label: 'GPT-5.5', alias: null, efforts: ['low', 'medium', 'high', 'xhigh'], weight: 'standard' },
  { provider: 'openai', id: 'gpt-6-astra', label: 'GPT-6 Astra', alias: null, efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], weight: 'heavy' },
];

// The ladder the quota policy walks when a model hits its weekly limit (unchanged behaviour: Fable, then Opus).
export const DEFAULT_LADDER_ALIASES = ['fable', 'opus'];
// The Claude step cover letters fall back to when their Codex model cannot run.
export const DEFAULT_LETTER_FALLBACK_ALIAS = 'opus';

const ID_PATTERN = /^[a-z0-9][a-z0-9._\-]{0,63}(\[1m\])?$/i;

function cleanEntry(raw, fallbackProvider = null) {
  if (!raw || typeof raw !== 'object') return null;
  const provider = PROVIDERS.includes(String(raw.provider || '').toLowerCase()) ? String(raw.provider).toLowerCase() : fallbackProvider;
  const id = String(raw.id || '').trim();
  if (!provider || !ID_PATTERN.test(id)) return null;
  const alias = raw.alias ? String(raw.alias).trim().toLowerCase() : null;
  const efforts = provider === 'openai' && Array.isArray(raw.efforts) ? raw.efforts.map(item => String(item).trim().toLowerCase()).filter(Boolean) : undefined;
  const weight = ['light', 'standard', 'heavy'].includes(raw.weight) ? raw.weight : undefined;
  return { provider, id, label: String(raw.label || id).trim() || id, alias: alias || null, ...(efforts ? { efforts } : {}), ...(raw.isDefault ? { isDefault: true } : {}), ...(weight ? { weight } : {}) };
}

// The registry for a config: config.models.catalog when present; otherwise the defaults plus whatever the
// older hub.modelChoices listed (aliases fold into the entry they name, other names become entries).
export function normalizeCatalog(config = {}) {
  const explicit = Array.isArray(config?.models?.catalog) ? config.models.catalog.map(entry => cleanEntry(entry)).filter(Boolean) : null;
  if (explicit?.length) return dedupe(explicit);
  const catalog = DEFAULT_CATALOG.map(entry => ({ ...entry, ...(entry.efforts ? { efforts: [...entry.efforts] } : {}) }));
  const legacy = config?.hub?.modelChoices;
  if (legacy && typeof legacy === 'object') {
    for (const [engine, list] of Object.entries(legacy)) {
      const provider = ENGINE_PROVIDER[engine];
      if (!provider || !Array.isArray(list)) continue;
      for (const item of list) {
        const value = typeof item === 'string' ? item : item?.value;
        if (!value || findModel(catalog, value, provider)) continue;
        const entry = cleanEntry({ provider, id: value, label: typeof item === 'object' && item?.label ? item.label : value }, provider);
        if (entry) catalog.push(entry);
      }
    }
  }
  return dedupe(catalog);
}

function dedupe(entries) {
  const seen = new Set();
  return entries.filter(entry => {
    const key = `${entry.provider}:${entry.id.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The entry a name refers to: its full id, its alias, or a dated / [1m] variant of its id
// ("claude-haiku-4-5-20251001" → claude-haiku-4-5). Null for a name the registry does not know.
export function findModel(catalog, value, provider = null) {
  const name = normalizeModelName(value);
  if (!name) return null;
  const pool = (catalog || DEFAULT_CATALOG).filter(entry => !provider || entry.provider === provider);
  return pool.find(entry => entry.id.toLowerCase() === name)
    || pool.find(entry => entry.alias && entry.alias === name)
    || pool.find(entry => name.startsWith(`${entry.id.toLowerCase()}-`) && /^-\d{6,8}$/.test(name.slice(entry.id.length)))
    || null;
}

// The full id to pass to the CLI for a configured name; an unknown name (a custom model) passes through.
export function canonicalModelId(value, provider = null, catalog = DEFAULT_CATALOG) {
  const entry = findModel(catalog, value, provider);
  return entry ? entry.id : (value == null || value === '' ? null : String(value).trim());
}

// What the CLI is given for a model: the registry alias when the entry has one (claude --model fable, so
// the CLI picks the current release of that family), else the full id (Codex models have no alias). The
// id the CLI actually ran comes back in its usage report and is recorded as the resolved id.
export function cliModelArg(value, catalog = DEFAULT_CATALOG) {
  const entry = findModel(catalog, value);
  return entry ? (entry.alias || entry.id) : (value == null || value === '' ? null : String(value).trim());
}

// The family prefix of an aliased entry ("claude-fable" for claude-fable-5-1): any release the alias may
// resolve to starts with it.
export function familyPrefix(entry) {
  return entry?.alias ? entry.id.toLowerCase().replace(/(-\d+)+$/, '') : null;
}

// A different release than the registry id ("claude-fable-5-2" for claude-fable-5-1), or null. A dated
// snapshot of the same id (claude-haiku-4-5-20251001) is the same release.
export function newerRelease(entryOrId, resolvedId, catalog = DEFAULT_CATALOG) {
  const entry = typeof entryOrId === 'string' ? findModel(catalog, entryOrId) : entryOrId;
  if (!entry || !resolvedId) return null;
  return findModel(catalog, resolvedId)?.id === entry.id ? null : String(resolvedId);
}

export function defaultModelId(engineId, catalog = DEFAULT_CATALOG) {
  const provider = ENGINE_PROVIDER[engineId];
  if (!provider) return null;
  const pool = catalog.filter(entry => entry.provider === provider);
  return (pool.find(entry => entry.isDefault) || pool[0] || DEFAULT_CATALOG.find(entry => entry.provider === provider && entry.isDefault))?.id || null;
}

// The lightest model a provider offers in the registry (weight 'light'), else its last entry.
export function lightestModelId(provider, catalog = DEFAULT_CATALOG) {
  const pool = catalog.filter(entry => entry.provider === provider);
  return (pool.find(entry => entry.weight === 'light') || pool[pool.length - 1])?.id || null;
}

export function defaultLadder(catalog = DEFAULT_CATALOG) {
  return DEFAULT_LADDER_ALIASES.map(alias => canonicalModelId(alias, 'anthropic', catalog)).filter(Boolean);
}

export function providerModels(catalog, provider) {
  return (catalog || DEFAULT_CATALOG).filter(entry => entry.provider === provider);
}

// Ladder from the Settings form: every step must be a registry model of the given provider, no step may
// repeat, and at least one is required. Returns { ladder, errors }.
export function validateLadder(values, { catalog = DEFAULT_CATALOG, provider = 'anthropic' } = {}) {
  const raw = (Array.isArray(values) ? values : String(values ?? '').split(',')).map(item => String(item).trim()).filter(Boolean);
  const errors = [];
  const ladder = [];
  for (const value of raw) {
    const entry = findModel(catalog, value, provider);
    if (!entry) {
      const elsewhere = findModel(catalog, value);
      errors.push(elsewhere ? `${value} is a ${PROVIDER_LABELS[elsewhere.provider]} model; the ladder only takes ${PROVIDER_LABELS[provider]} models` : `${value} is not in the model registry`);
      continue;
    }
    if (ladder.includes(entry.id)) { errors.push(`${entry.id} appears twice in the ladder`); continue; }
    ladder.push(entry.id);
  }
  if (!raw.length) errors.push('The model ladder needs at least one model');
  return { ladder, errors };
}
