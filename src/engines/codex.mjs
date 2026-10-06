// OpenAI Codex CLI engine, ChatGPT-subscription only. Verified against codex-cli 0.153.0:
//   codex exec [OPTIONS] [PROMPT]   prompt on stdin when omitted; -m/--model; -s/--sandbox read-only;
//                                   --ephemeral; --skip-git-repo-check; -C dir; --color never;
//                                   --json (JSONL events on stdout); --output-schema <file> (native JSON
//                                   schema for the final message); -o/--output-last-message <file>.
//   codex login status              prints "Logged in using ChatGPT" (exit 0), "Logged in using API key",
//                                   or "Not logged in" (non-zero exit).
// The final message is read from the --output-last-message file (the JSONL stream is the fallback), then
// parsed and validated strictly; anything else propagates to the orchestrator's retry / supplemental /
// local_fallback chain.
import { chatgptPlanFromAuthFile } from './chatgpt-plan.mjs';
import { DEFAULT_CATALOG, canonicalModelId, defaultModelId } from './catalog.mjs';
import { codexUsageFromJsonl } from './usage.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractResults, isMissingCommand, modelMatchesConfiguration, run, subscriptionEnvironment } from './shared.mjs';
import { errorSummary } from '../warnings.mjs';
import { INSTALL_HINTS, resolveCliCommand } from './cli-path.mjs';

export const CODEX_DEFAULT_MODEL = defaultModelId('codex');

// Allow-list: only a ChatGPT (subscription) login is accepted. API-key logins and logged-out states
// fall back to local scoring with a plain-language reason.
export function assessCodexLoginStatus(text, exitCode = 0) {
  const output = String(text || '').trim();
  const reject = detail => ({
    accepted: false,
    reason: `Codex is not signed in with a ChatGPT subscription (${detail}). Run \`codex login\` and choose the ChatGPT account option; API-key logins are intentionally rejected.`,
  });
  if (/logged in using chatgpt/i.test(output)) return { accepted: true, reason: null, method: 'ChatGPT' };
  if (/api key/i.test(output)) return reject('logged in with an API key; run `codex logout` first');
  if (/not logged in/i.test(output) || exitCode !== 0) return reject(output ? `codex login status said: ${output.slice(0, 120)}` : 'not logged in');
  return reject(output ? `unrecognized login status: ${output.slice(0, 120)}` : 'empty login status');
}

async function loginStatus(runner, command) {
  try {
    const result = await runner(command, ['login', 'status'], { timeoutMs: 30_000, env: subscriptionEnvironment() });
    return { text: `${result.stdout || ''}\n${result.stderr || ''}`, exitCode: 0 };
  } catch (error) {
    if (isMissingCommand(error)) throw error;
    return { text: String(error?.message || ''), exitCode: 1 };
  }
}

async function resolvedCommand(options) {
  const resolver = options.resolveCommand || resolveCliCommand;
  return (await resolver('codex', options.codexCommand || null, options)).command;
}

export async function verifyCodexSubscription(options = {}) {
  const runner = options.runner || run;
  const command = await resolvedCommand(options);
  try {
    await runner(command, ['--version'], { timeoutMs: 30_000, env: subscriptionEnvironment() });
  } catch (error) {
    throw new Error(`Could not run the Codex CLI. Install it with \`npm i -g @openai/codex\`, then sign in with \`codex login\`. ${errorSummary(error)}`);
  }
  const status = await loginStatus(runner, command);
  const verdict = assessCodexLoginStatus(status.text, status.exitCode);
  if (!verdict.accepted) throw new Error(verdict.reason);
  return verdict;
}

// "0.153.0" from `codex --version`, or null; the probe never fails on it.
async function cliVersion(runner, command) {
  try {
    const result = await runner(command, ['--version'], { timeoutMs: 15_000, env: subscriptionEnvironment() });
    return /(\d+\.\d+\.\d+)/.exec(`${result.stdout || ''} ${result.stderr || ''}`)?.[1] || null;
  } catch {
    return null;
  }
}

export async function describeCodexConnection(options = {}) {
  const runner = options.runner || run;
  const resolver = options.resolveCommand || resolveCliCommand;
  const resolution = await resolver('codex', options.codexCommand || null, options);
  const location = { path: resolution.found ? resolution.command : null, source: resolution.source, configured: resolution.configured || null, configuredMissing: resolution.configuredMissing === true, searched: resolution.searched };
  if (!resolution.found) return { installed: false, connected: false, detail: null, hint: INSTALL_HINTS.codex, reason: 'Codex CLI was not found on this Mac', ...location };
  try {
    const status = await loginStatus(runner, resolution.command);
    const verdict = assessCodexLoginStatus(status.text, status.exitCode);
    if (!verdict.accepted) return { installed: true, connected: false, detail: null, hint: 'codex login', reason: verdict.reason, ...location };
    // `codex login status` names no plan today; an optional "(plan)" or "plan: x" suffix is read when present,
    // else the plan claim in ~/.codex/auth.json is decoded locally (see chatgpt-plan.mjs).
    const printed = /ChatGPT\s*\(([^)]+)\)|\bplan[:=]\s*([a-z0-9_-]+)/i.exec(status.text || '');
    const fromFile = printed ? null : await (options.readChatgptPlan || chatgptPlanFromAuthFile)({ homedir: options.homedir, codexHome: options.codexHome, io: options.io });
    const planName = printed ? String(printed[1] || printed[2]).trim().toLowerCase() : fromFile?.plan || null;
    const planSource = printed ? 'login status' : fromFile ? 'auth.json' : null;
    const version = await cliVersion(runner, resolution.command);
    return { installed: true, connected: true, detail: planName ? `Codex · ChatGPT · ${planName}` : 'Codex · ChatGPT', plan: planName, planSource, version, hint: null, reason: null, ...location };
  } catch (error) {
    if (isMissingCommand(error)) return { installed: false, connected: false, detail: null, hint: INSTALL_HINTS.codex, reason: 'Codex CLI was not found on this Mac', ...location, path: null, source: 'missing' };
    return { installed: true, connected: false, detail: null, hint: 'codex login', reason: errorSummary(error), ...location };
  }
}

// Finds a `model` string anywhere in the JSONL event stream (session metadata carries it); falls back to
// the model we asked for, since `-m` pins it.
export function extractCodexModel(jsonl, configuredModel = null) {
  for (const line of String(jsonl || '').split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const found = findModel(event, 0);
    if (found) return found;
  }
  return configuredModel || null;
}

function findModel(value, depth) {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  if (typeof value.model === 'string' && value.model.trim()) return value.model.trim();
  for (const child of Object.values(value)) {
    const found = findModel(child, depth + 1);
    if (found) return found;
  }
  return null;
}

// Last agent message from the JSONL stream, used when the --output-last-message file is missing.
export function lastAgentMessage(jsonl) {
  let last = null;
  for (const line of String(jsonl || '').split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const item = event.item || event;
    if ((item?.type === 'agent_message' || item?.type === 'message') && typeof item.text === 'string') last = item.text;
  }
  return last;
}

export function parseCodexOutput(lastMessage, jsonl, configuredModel, effort = null) {
  const text = String(lastMessage || '').trim() || lastAgentMessage(jsonl) || '';
  if (!text) throw new Error('Codex returned no final message');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Codex final message is not a JSON object');
  const parsed = JSON.parse(text.slice(start, end + 1));
  const results = extractResults(parsed).results;
  if (!Array.isArray(results)) throw new Error('Codex JSON lacks a results[] array');
  return { results, scoringModel: extractCodexModel(jsonl, configuredModel), usage: codexUsageFromJsonl(jsonl, { model: configuredModel, effort }) };
}

export function createCodexEngine(options = {}) {
  const model = canonicalModelId(options.model || CODEX_DEFAULT_MODEL, 'openai', Array.isArray(options.catalog) ? options.catalog : DEFAULT_CATALOG);
  // A reasoning effort set in Settings reaches the CLI as its documented config override; none means the
  // CLI's own default (model_reasoning_effort in ~/.codex/config.toml), as before.
  const effort = /^[a-z]{2,10}$/.test(String(options.reasoningEffort || '')) ? String(options.reasoningEffort) : null;
  const effortArgs = effort ? ['-c', `model_reasoning_effort="${effort}"`] : [];
  const runner = options.runner || run;
  const io = options.io || fs;
  let command = null;
  const commandOf = async () => { command = command || await resolvedCommand(options); return command; };
  return {
    id: 'codex',
    label: 'ChatGPT subscription via Codex',
    model,
    async verifyAuth() {
      return verifyCodexSubscription({ ...options, runner });
    },
    async reviewBatch(prompt, schema, context = {}) {
      const directory = context.tempDirectory || process.cwd();
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const schemaPath = path.join(directory, `schema-${stamp}.json`);
      const lastMessagePath = path.join(directory, `last-${stamp}.json`);
      await io.writeFile(schemaPath, JSON.stringify(schema));
      const args = [
        'exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', directory, '--color', 'never',
        '--json', '--output-schema', schemaPath, '--output-last-message', lastMessagePath, '--model', model,
        ...effortArgs,
      ];
      try {
        const result = await runner(await commandOf(), args, {
          input: prompt, cwd: directory, timeoutMs: Number(options.timeoutMs || 600_000), env: subscriptionEnvironment(),
        });
        const lastMessage = await io.readFile(lastMessagePath, 'utf8').catch(() => '');
        return parseCodexOutput(lastMessage, result.stdout, model, options.reasoningEffort || null);
      } finally {
        await io.rm(schemaPath, { force: true }).catch(() => {});
        await io.rm(lastMessagePath, { force: true }).catch(() => {});
      }
    },
    async generateText(prompt, context = {}) {
      const directory = context.tempDirectory || process.cwd();
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const schemaPath = path.join(directory, `schema-${stamp}.json`);
      const lastMessagePath = path.join(directory, `last-${stamp}.txt`);
      const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', directory, '--color', 'never', '--json', '--output-last-message', lastMessagePath, '--model', model, ...effortArgs];
      if (context.schema) {
        await io.writeFile(schemaPath, JSON.stringify(context.schema));
        args.push('--output-schema', schemaPath);
      }
      try {
        const result = await runner(await commandOf(), args, {
          input: prompt, cwd: directory, timeoutMs: Number(context.timeoutMs || options.timeoutMs || 600_000), env: subscriptionEnvironment(),
        });
        const lastMessage = (await io.readFile(lastMessagePath, 'utf8').catch(() => '')).trim() || lastAgentMessage(result.stdout) || '';
        if (!lastMessage) throw new Error('Codex returned no final message');
        let output = lastMessage;
        if (context.schema) {
          const start = lastMessage.indexOf('{');
          const end = lastMessage.lastIndexOf('}');
          if (start < 0 || end < start) throw new Error('Codex final message is not a JSON object');
          output = JSON.parse(lastMessage.slice(start, end + 1));
        }
        return { output, scoringModel: extractCodexModel(result.stdout, model), usage: codexUsageFromJsonl(result.stdout, { model, effort: options.reasoningEffort || null }) };
      } finally {
        await io.rm(schemaPath, { force: true }).catch(() => {});
        await io.rm(lastMessagePath, { force: true }).catch(() => {});
      }
    },
    describeModel() {
      return { engine: 'codex', model, label: `Codex · ${model}` };
    },
    modelMatches(actual) {
      return modelMatchesConfiguration(model, actual);
    },
    describeConnection() {
      return describeCodexConnection({ ...options, runner });
    },
  };
}
