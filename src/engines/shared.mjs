// Shared plumbing for the subscription CLI engines: environment scrubbing, the child-process runner,
// and version/model helpers. Every engine subprocess goes through subscriptionEnvironment() so the
// launching shell can never steer a CLI toward an API key, a gateway, or a proxy.
import { spawn } from 'node:child_process';
import { withCliPath } from './cli-path.mjs';

// Prefixes catch every current and future ANTHROPIC_* (API key, base URL, auth token, custom headers,
// model overrides), AWS_* (Bedrock credentials, profiles, regions), and OPENAI_* (API key, base URL,
// org, project) variable; the explicit list covers the routing switches that live outside those prefixes.
export const CREDENTIAL_ENV_PREFIXES = ['ANTHROPIC_', 'AWS_', 'OPENAI_'];
export const CREDENTIAL_ENV_KEYS = [
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'CLAUDE_API_KEY',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUD_ML_REGION',
];

export function isCredentialEnvironmentKey(key) {
  return CREDENTIAL_ENV_KEYS.includes(key) || CREDENTIAL_ENV_PREFIXES.some(prefix => key.startsWith(prefix));
}

export function subscriptionEnvironment(environment = process.env) {
  const safe = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!isCredentialEnvironmentKey(key)) safe[key] = value;
  }
  return safe;
}

export function run(command, args, { input = '', cwd = process.cwd(), timeoutMs = 600_000, env = subscriptionEnvironment() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: withCliPath(env), stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const result = { code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      if (code === 0) resolve(result);
      else reject(new Error(`${command} exited ${code ?? signal}: ${result.stderr.slice(-2000) || result.stdout.slice(-2000)}`));
    });
    // A CLI that exits before reading its prompt (crash, bad flag, missing binary) closes the pipe while
    // the prompt is still being written. That EPIPE must not become an unhandled 'error' event that kills
    // the whole nightly run; the 'close' handler above already reports the failed exit.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function parseSemanticVersion(value) {
  const match = String(value || '').match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  return match ? match.slice(1, 4).map(Number) : null;
}

export function compareVersions(left, right) {
  const leftParts = Array.isArray(left) ? left : parseSemanticVersion(left);
  const rightParts = Array.isArray(right) ? right : parseSemanticVersion(right);
  if (!leftParts || !rightParts) throw new Error('Could not parse semantic version');
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

export function normalizeModelName(value) {
  return String(value || '').trim().toLowerCase().replace(/\[\s*1m\s*\]$/, '');
}

// `aliases` maps a CLI alias to the prefix of the canonical model family it resolves to.
export function modelMatchesConfiguration(configured, actual, aliases = {}) {
  const normalized = normalizeModelName(configured);
  const expected = aliases[normalized] || normalized;
  const reported = normalizeModelName(actual);
  if (!expected || !reported || reported === 'unknown') return true;
  return reported.startsWith(expected);
}

// Pulls `results[]` out of whatever envelope a CLI wrapped the model's JSON in.
export function extractResults(parsed) {
  if (parsed?.results) return parsed;
  if (parsed?.structured_output?.results) return parsed.structured_output;
  if (typeof parsed?.result === 'string') return JSON.parse(parsed.result);
  if (parsed?.result?.results) return parsed.result;
  throw new Error('subscription CLI returned JSON without results[]');
}

// Sorts out whether a spawn failure means "the CLI is not installed".
export function isMissingCommand(error) {
  return error?.code === 'ENOENT' || /\bENOENT\b/.test(String(error?.message || ''));
}
