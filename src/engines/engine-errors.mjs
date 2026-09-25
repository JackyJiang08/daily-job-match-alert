// One place that turns whatever a subscription CLI threw into a classification and a sentence a person
// can act on. Nothing here ever returns raw JSON: the CLI's print-mode result envelope ({ type: "result",
// is_error: true, result: "<notice>" }, recorded in tests/fixtures/engine-errors.json) is unwrapped to its
// notice, quota notices go through quota.mjs, an expired login becomes auth_expired, and anything else
// becomes a short "Generation failed" line while the full text stays in the hub log.
import { classifyQuotaError, describeQuota, normalizeQuotaPolicy } from './quota.mjs';

export const AUTH_EXPIRED_MESSAGE = 'Claude session expired. Run `claude auth login --claudeai` in Terminal, then try again.';
export const AUTH_EXPIRED_NOTIFICATION = 'Claude login expired, run claude auth login';

// The CLI writes its JSON envelope to stdout even on a failed exit, and run() folds that into the error
// message ("claude exited 1: {…}"). Returns { notice, envelope } when a result envelope is present.
export function unwrapCliEnvelope(text) {
  const value = String(text || '');
  const start = value.indexOf('{');
  if (start < 0) return null;
  for (let end = value.lastIndexOf('}'); end > start; end = value.lastIndexOf('}', end - 1)) {
    try {
      const envelope = JSON.parse(value.slice(start, end + 1));
      if (envelope && typeof envelope === 'object' && ('is_error' in envelope || 'result' in envelope || envelope.type === 'result')) {
        const notice = typeof envelope.result === 'string' ? envelope.result.trim() : '';
        return { notice, envelope };
      }
      return null;
    } catch {
      // keep shrinking the candidate window
    }
  }
  return null;
}

// run() keeps only the tail of the CLI output, so the envelope is often cut off with no closing brace and
// JSON.parse cannot help; the "result" field is still readable with a regex.
export function resultFieldOf(text) {
  const match = /"result"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(String(text || ''));
  if (!match) return '';
  try { return JSON.parse(`"${match[1]}"`).trim(); } catch { return match[1].replace(/\\"/g, '"').trim(); }
}

// Everything from the first brace to the end of the line, plus any stray JSON fragments, removed.
function withoutJson(text) {
  const firstLine = String(text || '').split(/\r?\n/)[0] || '';
  return firstLine.replace(/\{[\s\S]*$/, '').replace(/["\[\]{}]/g, ' ').replace(/\s+/g, ' ').trim();
}

// The plain notice behind an engine error: the envelope's result text when there is one (even from a
// truncated envelope), else the first line of the message with any JSON removed.
export function engineNotice(error) {
  if (error?.notice) return String(error.notice);
  const message = String(error?.raw || error?.message || error || '');
  const unwrapped = unwrapCliEnvelope(message);
  if (unwrapped?.notice) return unwrapped.notice;
  const field = resultFieldOf(message);
  if (field) return field;
  return withoutJson(message);
}

export function isAuthExpiredText(text, policy = normalizeQuotaPolicy()) {
  const value = String(text || '');
  return (policy.patterns.authExpired || []).some(pattern => pattern.test(value));
}

// { kind: 'auth_expired' | <quota kind> | 'engine_error' | 'missing_cli', notice, quota? } for any error
// thrown by an engine call; null for a value that is not an error at all.
export function classifyEngineError(error, { now = new Date(), policy = normalizeQuotaPolicy() } = {}) {
  if (error == null) return null;
  const notice = engineNotice(error);
  const haystack = `${notice}\n${String(error?.message || '')}`;
  if (error?.code === 'SUBSCRIPTION_AUTH' || isAuthExpiredText(haystack, policy)) return { kind: 'auth_expired', notice };
  const quota = error?.code === 'SUBSCRIPTION_QUOTA' ? error.quota : classifyQuotaError(new Error(notice || String(error?.message || '')), { now, policy });
  if (quota) return { kind: quota.kind, notice, quota };
  if (error?.code === 'ENOENT' || /\bENOENT\b/.test(String(error?.message || ''))) return { kind: 'missing_cli', notice };
  return { kind: 'engine_error', notice };
}

export class AuthExpiredError extends Error {
  constructor(notice, cause = null) {
    super(AUTH_EXPIRED_MESSAGE);
    this.name = 'AuthExpiredError';
    this.code = 'SUBSCRIPTION_AUTH';
    this.notice = notice;
    this.cause = cause;
  }
}

// A generic engine failure whose user-facing text is already humanized; the raw text rides along for logs.
export class EngineError extends Error {
  constructor(message, cause = null, kind = 'engine_error') {
    super(message);
    this.name = 'EngineError';
    this.code = 'ENGINE_FAILURE';
    this.kind = kind;
    this.cause = cause;
    this.raw = String(cause?.message || cause || '');
  }
}

// At most 120 characters of the notice, never a brace or a JSON key.
export function shortReason(notice, error) {
  const text = withoutJson(String(notice || engineNotice(error) || '').replace(/\s+/g, ' ').trim()) || String(notice || '').replace(/[{}"]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return 'unknown error';
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

export function generationFailedMessage(reason) {
  return `Generation failed (${reason || 'unknown error'}); details in the hub log`;
}

// Every user-visible engine error passes through here: cards, the panel, one-click status, warnings.
export function humanizeEngineError(error, { now = new Date(), policy = normalizeQuotaPolicy(), timeZone = 'America/Chicago' } = {}) {
  const verdict = classifyEngineError(error, { now, policy });
  if (!verdict) return { kind: 'engine_error', message: 'Generation failed (unknown error); details in the hub log', codexSuggested: false };
  if (verdict.kind === 'auth_expired') return { kind: 'auth_expired', message: AUTH_EXPIRED_MESSAGE, codexSuggested: true, notice: verdict.notice };
  if (verdict.quota) return { kind: verdict.kind, message: describeQuota(verdict.quota, { timeZone }), codexSuggested: true, quota: verdict.quota, notice: verdict.notice };
  if (verdict.kind === 'missing_cli') return { kind: 'missing_cli', message: generationFailedMessage('the Claude CLI was not found on this Mac'), codexSuggested: true, notice: verdict.notice };
  // An EngineError is rebuilt from its raw text every time, so a message that once carried CLI JSON
  // (an envelope, cut off or not) is reduced to the envelope's result field or the first plain line.
  if (error?.code === 'ENGINE_FAILURE') {
    const source = error.raw || error.cause?.message || error.message || '';
    const envelope = unwrapCliEnvelope(source);
    const reason = envelope?.notice ? shortReason(envelope.notice) : (resultFieldOf(source) ? shortReason(resultFieldOf(source)) : shortReason(withoutJson(source) || withoutJson(error.message)));
    return { kind: 'engine_error', message: generationFailedMessage(reason), codexSuggested: false, notice: verdict.notice };
  }
  return { kind: 'engine_error', message: generationFailedMessage(shortReason(verdict.notice, error)), codexSuggested: false, notice: verdict.notice };
}
