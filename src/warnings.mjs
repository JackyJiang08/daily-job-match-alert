export function errorSummary(error, maximumLength = 500) {
  const message = error?.message || error?.stderr || String(error || 'Unknown error');
  return String(message).replace(/\s+/g, ' ').trim().slice(0, maximumLength);
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
