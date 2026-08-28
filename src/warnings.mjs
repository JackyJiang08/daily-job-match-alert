export function errorSummary(error, maximumLength = 500) {
  const message = error?.message || error?.stderr || String(error || 'Unknown error');
  return String(message).replace(/\s+/g, ' ').trim().slice(0, maximumLength);
}

export function createWarning(stage, source, message) {
  return {
    stage: String(stage || 'pipeline'),
    source: String(source || 'unknown'),
    message: errorSummary(message),
  };
}

export function warningText(warning) {
  if (typeof warning === 'string') return warning;
  const prefix = [warning?.stage, warning?.source].filter(Boolean).join(' / ');
  return `${prefix ? `[${prefix}] ` : ''}${warning?.message || 'Unknown warning'}`;
}
