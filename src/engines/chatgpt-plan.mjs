// The ChatGPT plan behind a Codex login. `codex login status` prints no plan (codex-cli 0.153.0), so the
// hub decodes, locally, the claims of the id_token the Codex CLI keeps in ~/.codex/auth.json and reads
// the plan type ("https://api.openai.com/auth".chatgpt_plan_type). Nothing else leaves this function:
// the tokens, the account ids, the e-mail, and every other claim stay unread or discarded, and no error
// message is propagated (a JSON parse error can quote the text it failed on).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const AUTH_CLAIM = 'https://api.openai.com/auth';
const PLAN_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export function codexAuthPath({ homedir = os.homedir(), codexHome = null } = {}) {
  return path.join(codexHome || path.join(homedir, '.codex'), 'auth.json');
}

// The plan type from an id_token's payload, or null. Only the one field is returned.
export function planFromIdToken(idToken) {
  try {
    const parts = String(idToken || '').split('.');
    if (parts.length < 2) return null;
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const value = claims?.[AUTH_CLAIM]?.chatgpt_plan_type ?? claims?.chatgpt_plan_type ?? null;
    const plan = typeof value === 'string' ? value.trim().toLowerCase() : null;
    return plan && PLAN_PATTERN.test(plan) ? plan : null;
  } catch {
    return null;
  }
}

// { plan, source: 'auth.json' } or null when the file, the token, or the claim is missing or unreadable.
export async function chatgptPlanFromAuthFile(options = {}) {
  const io = options.io || fs;
  try {
    const raw = JSON.parse(await io.readFile(options.file || codexAuthPath(options), 'utf8'));
    const plan = planFromIdToken(raw?.tokens?.id_token);
    return plan ? { plan, source: 'auth.json' } : null;
  } catch {
    return null;
  }
}
