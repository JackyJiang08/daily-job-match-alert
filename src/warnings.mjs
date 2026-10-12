export function errorSummary(error, maximumLength = 500) {
  let message = error?.message || error?.stderr || String(error || 'Unknown error');
  // Node's fetch says only "fetch failed"; the reason (DNS, reset, timeout, certificate) is on error.cause.
  const cause = error && typeof error === 'object' && error.cause ? errorCause(error) : null;
  if (cause && !String(message).includes(cause.message || cause.code)) message = `${message} (${[cause.code, cause.message].filter(Boolean).join(': ')})`;
  return String(message).replace(/\s+/g, ' ').trim().slice(0, maximumLength);
}

// The innermost reason behind an error: { code, message } from the deepest error.cause that has one
// (an AggregateError, e.g. every address refused, contributes its first error). HTTP failures carry
// `status` and read "HTTP 404". Null when nothing more specific than the error itself is known.
export function errorCause(error) {
  if (!error || typeof error !== 'object') return null;
  if (Number.isInteger(error.status)) return { code: `HTTP ${error.status}`, message: error.message || `HTTP ${error.status}` };
  let found = null;
  let current = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 6; depth += 1) {
    if (current !== error || current.code) {
      const code = current.code ? String(current.code) : null;
      const message = current.message ? String(current.message).replace(/\s+/g, ' ').trim() : '';
      if (code || (current !== error && message)) found = { code: code || found?.code || null, message: message || found?.message || '' };
    }
    current = current.cause || (Array.isArray(current.errors) && current.errors.length ? current.errors[0] : null);
  }
  return found;
}

// Failures that say nothing about the server: no HTTP answer arrived (DNS, connection refused or reset,
// timeouts, TLS and certificate errors). An HTTP status, or a body that would not parse, is the server's.
const NETWORK_CODE = /^(?:E(?:NOTFOUND|AI_AGAIN|AI_FAIL|AI_NONAME|CONNRESET|CONNREFUSED|CONNABORTED|TIMEDOUT|NETUNREACH|NETDOWN|HOSTUNREACH|HOSTDOWN|PIPE|PROTO|ADDRNOTAVAIL)|UND_ERR_\w+|ERR_SSL_\w+|ERR_TLS_\w+|CERT_\w+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_\w+|ABORT_ERR)$/;

export function isNetworkError(error) {
  if (!error || typeof error !== 'object') return false;
  if (Number.isInteger(error.status) || error instanceof SyntaxError) return false;
  const cause = errorCause(error);
  if (cause?.code && NETWORK_CODE.test(cause.code)) return true;
  return /^fetch failed\b|^timeout after\b/i.test(String(error.message || ''));
}

export const WARNING_LEVELS = ['info', 'warning'];

// `level` separates degraded-run disclosures ("warning", the default) from purely informational
// notices such as an automatic recovery that needed no attention ("info"). Both render in the same
// report panels; the level lets a reader tell them apart.
export function createWarning(stage, source, message, level = 'warning') {
  return {
    stage: String(stage || 'pipeline'),
    source: String(source || 'unknown'),
    message: errorSummary(message),
    level: WARNING_LEVELS.includes(level) ? level : 'warning',
  };
}

export function warningText(warning) {
  if (typeof warning === 'string') return warning;
  const prefix = [warning?.stage, warning?.source].filter(Boolean).join(' / ');
  const level = warning?.level === 'info' ? 'info: ' : '';
  return `${prefix ? `[${prefix}] ` : ''}${level}${warning?.message || 'Unknown warning'}`;
}
