// Claude Code subscription engine: `claude --print` with a JSON schema, allow-listed claude.ai login.
import { compareVersions, extractResults, isMissingCommand, modelMatchesConfiguration, normalizeModelName, parseSemanticVersion, run, subscriptionEnvironment } from './shared.mjs';
import { errorSummary } from '../warnings.mjs';
import { INSTALL_HINTS, resolveCliCommand } from './cli-path.mjs';

// Subscription flags used below were validated against this installed Claude Code release.
export const MINIMUM_CLAUDE_CODE_VERSION = '2.1.250';
export const CLAUDE_DEFAULT_MODEL = 'fable';
// Aliases accepted by `claude --model`; each expands to the prefix of the canonical model family.
export const CLAUDE_MODEL_ALIASES = { fable: 'claude-fable', opus: 'claude-opus', sonnet: 'claude-sonnet', haiku: 'claude-haiku' };

export function parseClaudeCodeVersion(value) {
  return parseSemanticVersion(value);
}

export function expandModelAlias(value) {
  const normalized = normalizeModelName(value);
  return CLAUDE_MODEL_ALIASES[normalized] || normalized;
}

export function claudeModelMatches(configured, actual) {
  return modelMatchesConfiguration(configured, actual, CLAUDE_MODEL_ALIASES);
}

// Allow-list, not deny-list: only a claude.ai subscription login is accepted. `console` (Anthropic Console
// billing), `apiKey`, Bedrock, Vertex, and anything unrecognized fall back to local scoring.
const SUBSCRIPTION_AUTH_METHODS = new Set(['claude.ai', 'claudeai', 'subscription']);
const SUBSCRIPTION_TYPES = new Set(['pro', 'max', 'team', 'enterprise']);

function normalizeAuthValue(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

export function assessClaudeAuthStatus(status) {
  const reject = detail => ({
    accepted: false,
    reason: `Claude Code is not authenticated with a Claude subscription (${detail}). Run \`claude auth login --claudeai\`; Console, API-key, Bedrock, and Vertex billing paths are intentionally rejected.`,
  });
  if (!status || typeof status !== 'object') return reject('auth status was not a JSON object');
  const authMethod = status.authMethod == null ? '' : String(status.authMethod);
  if (status.loggedIn !== true) return reject(`loggedIn=${JSON.stringify(status.loggedIn ?? null)}, authMethod="${authMethod}"`);
  if (!SUBSCRIPTION_AUTH_METHODS.has(normalizeAuthValue(authMethod))) return reject(`authMethod="${authMethod}"`);
  // The remaining fields are optional in the CLI output; when present they must agree with the login.
  if (Object.hasOwn(status, 'apiProvider') && normalizeAuthValue(status.apiProvider) !== 'firstparty') {
    return reject(`authMethod="${authMethod}", apiProvider="${status.apiProvider}"`);
  }
  if (Object.hasOwn(status, 'subscriptionType') && !SUBSCRIPTION_TYPES.has(normalizeAuthValue(status.subscriptionType))) {
    return reject(`authMethod="${authMethod}", subscriptionType="${status.subscriptionType}"`);
  }
  return { accepted: true, reason: null };
}

// `claude --print --output-format json` reports usage per model id under modelUsage; the scoring model is the
// entry that produced the most output tokens (helper calls such as Haiku title generation are much smaller).
export function extractScoringModel(parsed) {
  const usage = parsed?.modelUsage;
  if (usage && typeof usage === 'object') {
    let best = null;
    for (const [id, stats] of Object.entries(usage)) {
      const outputTokens = Number(stats?.outputTokens || 0);
      const inputTokens = Number(stats?.inputTokens || 0) + Number(stats?.cacheReadInputTokens || 0) + Number(stats?.cacheCreationInputTokens || 0);
      const candidate = { name: String(stats?.canonicalModel || id), outputTokens, inputTokens };
      if (!best || candidate.outputTokens > best.outputTokens || (candidate.outputTokens === best.outputTokens && candidate.inputTokens > best.inputTokens)) {
        best = candidate;
      }
    }
    if (best?.name) return best.name;
  }
  if (typeof parsed?.model === 'string' && parsed.model.trim()) return parsed.model.trim();
  return null;
}

export function parseStructuredOutput(raw) {
  const parsed = JSON.parse(raw.trim());
  return { results: extractResults(parsed).results, scoringModel: extractScoringModel(parsed) };
}

export async function verifyClaudeSubscription(options = {}) {
  const runner = options.runner || run;
  const command = await resolvedCommand(options);
  let versionResult;
  try {
    versionResult = await runner(command, ['--version'], { timeoutMs: 30_000, env: subscriptionEnvironment() });
  } catch (error) {
    throw new Error(`Could not verify the Claude Code version. Upgrade with \`npm i -g @anthropic-ai/claude-code@latest\`, then retry. ${errorSummary(error)}`);
  }
  const versionText = `${versionResult.stdout || ''}\n${versionResult.stderr || ''}`;
  const installedVersion = parseClaudeCodeVersion(versionText);
  if (!installedVersion) {
    throw new Error(`Claude Code returned an unrecognized version string. Version ${MINIMUM_CLAUDE_CODE_VERSION} or newer is required; upgrade with \`npm i -g @anthropic-ai/claude-code@latest\`.`);
  }
  if (compareVersions(installedVersion, MINIMUM_CLAUDE_CODE_VERSION) < 0) {
    throw new Error(`Claude Code ${installedVersion.join('.')} is older than the verified minimum ${MINIMUM_CLAUDE_CODE_VERSION}. Upgrade with \`npm i -g @anthropic-ai/claude-code@latest\`.`);
  }

  const result = await runner(command, ['auth', 'status', '--json'], { timeoutMs: 30_000, env: subscriptionEnvironment() });
  const status = JSON.parse(result.stdout);
  const verdict = assessClaudeAuthStatus(status);
  if (!verdict.accepted) throw new Error(verdict.reason);
  return status;
}

// The binary: the configured path when it exists, else a PATH / well-known-directory lookup, else the
// configured name so the spawn error stays what it always was.
async function resolvedCommand(options) {
  const resolver = options.resolveCommand || resolveCliCommand;
  const resolution = await resolver('claude', options.claudeCommand || null, options);
  return resolution.command;
}

// Read-only connection probe for the hub: found where? signed in with a subscription? which plan?
export async function describeClaudeConnection(options = {}) {
  const runner = options.runner || run;
  const resolver = options.resolveCommand || resolveCliCommand;
  const resolution = await resolver('claude', options.claudeCommand || null, options);
  const location = { path: resolution.found ? resolution.command : null, source: resolution.source, configured: resolution.configured || null, configuredMissing: resolution.configuredMissing === true, searched: resolution.searched };
  if (!resolution.found) return { installed: false, connected: false, detail: null, hint: INSTALL_HINTS.claude, reason: 'Claude Code CLI was not found on this Mac', ...location };
  try {
    const result = await runner(resolution.command, ['auth', 'status', '--json'], { timeoutMs: 30_000, env: subscriptionEnvironment() });
    const status = JSON.parse(result.stdout);
    const verdict = assessClaudeAuthStatus(status);
    if (!verdict.accepted) return { installed: true, connected: false, detail: null, hint: 'claude auth login --claudeai', reason: verdict.reason, ...location };
    const plan = status.subscriptionType ? String(status.subscriptionType).charAt(0).toUpperCase() + String(status.subscriptionType).slice(1) : 'Subscription';
    return { installed: true, connected: true, detail: `Claude · ${plan} · ${status.authMethod}`, hint: null, reason: null, ...location };
  } catch (error) {
    if (isMissingCommand(error)) return { installed: false, connected: false, detail: null, hint: INSTALL_HINTS.claude, reason: 'Claude Code CLI was not found on this Mac', ...location, path: null, source: 'missing' };
    return { installed: true, connected: false, detail: null, hint: 'claude auth login --claudeai', reason: errorSummary(error), ...location };
  }
}

export function createClaudeEngine(options = {}) {
  const model = options.model || CLAUDE_DEFAULT_MODEL;
  const runner = options.runner || run;
  let command = null;
  const commandOf = async () => { command = command || await resolvedCommand(options); return command; };
  return {
    id: 'claude',
    label: 'Claude subscription',
    model,
    async verifyAuth() {
      return verifyClaudeSubscription({ ...options, runner });
    },
    // Scores one batch; the caller supplies the prompt, the per-run JSON schema, and a scratch directory.
    async reviewBatch(prompt, schema, context = {}) {
      const args = [
        '--print', '--safe-mode', '--no-session-persistence', '--permission-mode', 'dontAsk',
        '--tools', '', '--output-format', 'json', '--json-schema', JSON.stringify(schema),
      ];
      if (model) args.push('--model', model);
      const result = await runner(await commandOf(), args, {
        input: prompt, cwd: context.tempDirectory || process.cwd(), timeoutMs: Number(options.timeoutMs || 600_000), env: subscriptionEnvironment(),
      });
      return parseStructuredOutput(result.stdout);
    },
    // One structured call for free-form generation (cover letters); same flags, auth, and env scrubbing.
    async generateText(prompt, context = {}) {
      const args = ['--print', '--safe-mode', '--no-session-persistence', '--permission-mode', 'dontAsk', '--tools', '', '--output-format', 'json'];
      if (context.schema) args.push('--json-schema', JSON.stringify(context.schema));
      if (model) args.push('--model', model);
      const result = await runner(await commandOf(), args, {
        input: prompt, cwd: context.tempDirectory || process.cwd(), timeoutMs: Number(context.timeoutMs || options.timeoutMs || 600_000), env: subscriptionEnvironment(),
      });
      const parsed = JSON.parse(String(result.stdout).trim());
      const output = context.schema
        ? (parsed?.structured_output ?? (typeof parsed?.result === 'string' ? JSON.parse(parsed.result) : parsed?.result ?? parsed))
        : (typeof parsed?.result === 'string' ? parsed.result : String(parsed?.result ?? ''));
      return { output, scoringModel: extractScoringModel(parsed) || model };
    },
    describeModel() {
      return { engine: 'claude', model, label: `Claude · ${model}` };
    },
    modelMatches(actual) {
      return claudeModelMatches(model, actual);
    },
    describeConnection() {
      return describeClaudeConnection({ ...options, runner });
    },
  };
}
