// Engine registry. Every engine exposes the same surface:
//   id, label, model, verifyAuth(), reviewBatch(prompt, schema, { tempDirectory }), describeModel(),
//   modelMatches(actual), describeConnection()
// Only subscription CLIs exist here; API-backed engines are intentionally unavailable.
import { CLAUDE_DEFAULT_MODEL, createClaudeEngine, describeClaudeConnection } from './claude.mjs';
import { CODEX_DEFAULT_MODEL, createCodexEngine, describeCodexConnection } from './codex.mjs';

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
const CLAUDE_LOOKING = /^(fable|opus|sonnet|haiku)$|^claude-/i;

export function resolveModel(semantic = {}, engineId = normalizeEngineId(semantic.engine)) {
  const perEngine = semantic.models && typeof semantic.models === 'object' ? semantic.models[engineId] : null;
  if (perEngine) return String(perEngine);
  if (semantic.model && normalizeEngineId(semantic.engine) === engineId) {
    const model = String(semantic.model);
    if (engineId === 'claude' || !CLAUDE_LOOKING.test(model)) return model;
  }
  return ENGINE_DEFAULT_MODELS[engineId] || null;
}

export function createEngine(engineId, options = {}) {
  const id = normalizeEngineId(engineId);
  if (id === 'claude') return createClaudeEngine(options);
  if (id === 'codex') return createCodexEngine(options);
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
