import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseEml } from './email-files.mjs';

const execFileAsync = promisify(execFile);

function envelopeRows(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.envelopes || payload?.data || payload?.items || [];
}

function fromText(value) {
  if (Array.isArray(value)) return value.map(fromText).join(', ');
  if (value && typeof value === 'object') return value.address || value.addr || value.email || value.name || JSON.stringify(value);
  return String(value || '');
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

export async function collectHimalaya(options, cutoff, runner = execFileAsync) {
  const folder = options.folder || 'job-alerts';
  const listArgs = ['--output', 'json', 'envelope', 'list', '--folder', folder, '--page-size', String(options.pageSize || 100)];
  if (options.account) listArgs.push('--account', options.account);
  listArgs.push('after', dateOnly(new Date(cutoff.getTime() - 24 * 60 * 60 * 1000)), 'order', 'by', 'date', 'desc');
  const listed = await runner('himalaya', listArgs, { timeout: 60_000, maxBuffer: 5_000_000 });
  const rows = envelopeRows(JSON.parse(listed.stdout));
  const jobs = [];
  for (const envelope of rows) {
    const id = envelope.id ?? envelope.messageId ?? envelope.message_id;
    if (id == null) continue;
    const readArgs = ['--output', 'plain', 'message', 'read', '--preview', '--no-headers', '--folder', folder];
    if (options.account) readArgs.push('--account', options.account);
    readArgs.push(String(id));
    const message = await runner('himalaya', readArgs, { timeout: 60_000, maxBuffer: 5_000_000 });
    const syntheticEml = [
      `From: ${fromText(envelope.from || envelope.sender)}`,
      `Date: ${envelope.date || envelope.receivedAt || envelope.received_at || ''}`,
      `Subject: ${envelope.subject || 'Job alert'}`,
      '',
      message.stdout,
    ].join('\n');
    jobs.push(...parseEml(syntheticEml, `himalaya:${id}`).map(job => ({
      ...job,
      sourceKind: 'official_email_alert_via_himalaya',
      emailAccount: options.account || 'default',
      emailFolder: folder,
    })));
  }
  return jobs;
}

export { envelopeRows };
