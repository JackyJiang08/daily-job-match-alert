// Engine registry. Every engine exposes the same surface:
//   id, label, model, verifyAuth(), reviewBatch(prompt, schema, { tempDirectory }), describeModel(),
//   modelMatches(actual), describeConnection()
// Only subscription CLIs exist here; API-backed engines are intentionally unavailable.
import { DEFAULT_CATALOG, ENGINE_PROVIDER, canonicalModelId, defaultModelId, findModel } from './catalog.mjs';
import { CLAUDE_DEFAULT_MODEL, createClaudeEngine, describeClaudeConnection } from './claude.mjs';
import { CODEX_DEFAULT_MODEL, createCodexEngine, describeCodexConnection } from './codex.mjs';
import { createFakeEngine } from './fake.mjs';

export const ENGINE_IDS = ['claude', 'codex'];
export const ENGINE_LABELS = { claude: 'Claude subscription', codex: 'ChatGPT subscription via Codex' };
export const ENGINE_DEFAULT_MODELS = { claude: CLAUDE_DEFAULT_MODEL, codex: CODEX_DEFAULT_MODEL };
const ALIASES = { claude: 'claude', claude_subscription: 'claude', codex: 'codex', local_only: 'local_only' };

// 'claude' (default), 'codex', or 'local_only'; anything else (including the retired codex_subscription
// spelling) is null so the caller can refuse it loudly.
export function normalizeEngineId(value) {
  const key = String(value || 'claude').trim().toLowerCase();
  return ALIASES[key] || null;
}

// The active model: an explicit per-engine entry wins, then the legacy single `model` key when it was
// written for this engine (it always describes the active engine, and a Claude alias never names a
// Codex model), then the engine default.
// The result is always the registry's full id (an alias such as "opus" becomes claude-opus-5-5); a name
// the registry does not know (a custom model) passes through unchanged.
export function resolveModel(semantic = {}, engineId = normalizeEngineId(semantic.engine)) {
  const catalog = Array.isArray(semantic.catalog) ? semantic.catalog : DEFAULT_CATALOG;
  const provider = ENGINE_PROVIDER[engineId] || null;
  const perEngine = semantic.models && typeof semantic.models === 'object' ? semantic.models[engineId] : null;
  if (perEngine) return canonicalModelId(perEngine, provider, catalog);
  if (semantic.model && normalizeEngineId(semantic.engine) === engineId) {
    const model = String(semantic.model);
    const anthropic = findModel(catalog, model, 'anthropic') || /^claude-/i.test(model);
    if (engineId === 'claude' || !anthropic) return canonicalModelId(model, provider, catalog);
  }
  return defaultModelId(engineId, catalog) || ENGINE_DEFAULT_MODELS[engineId] || null;
}

export function createEngine(engineId, options = {}) {
  const id = normalizeEngineId(engineId);
  if (id === 'claude') return createClaudeEngine(options);
  if (id === 'codex') return createCodexEngine(options);
  // local_only has no model; text generation gets a clearly labelled placeholder engine.
  if (id === 'local_only' && options.allowPlaceholder) return createFakeEngine(options);
  throw new Error(`Unsupported semanticMatching.engine: ${engineId}. Only claude, codex, and local_only exist; API-backed engines are intentionally unavailable.`);
}

// options.claudeCommand / options.codexCommand come from config.semanticMatching; options.env and
// options.homedir feed the path lookup.
export async function describeConnections(options = {}) {
  const [claude, codex] = await Promise.all([
    describeClaudeConnection(options),
    describeCodexConnection(options),
  ]);
  return { claude, codex };
}

export { resolveCliCommand, launchdPath } from './cli-path.mjs';
export { createFakeEngine, FAKE_ENGINE_LABEL } from './fake.mjs';
