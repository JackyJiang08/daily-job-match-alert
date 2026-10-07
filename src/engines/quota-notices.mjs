// The CLI's own words for every limit event, kept so the classification table can be checked against
// what the CLI really says. Stored in state/quota-notices.json (newest last, 50 entries, 35 days); the
// text is already sanitized by quota.mjs sanitizeNotice (no CLI path, account ids, e-mail, or URL query)
// and is cut to 300 characters again here. Written by the nightly run and the hub (cover letters); every
// write re-reads the file so neither drops the other's entries.
import fs from 'node:fs/promises';
import path from 'node:path';
import { sanitizeNotice } from './quota.mjs';

export const NOTICE_LIMIT = 50;
export const NOTICE_RETENTION_DAYS = 35;

export function quotaNoticesPath(root) {
  return path.join(root, 'state', 'quota-notices.json');
}

export async function readQuotaNotices(file, io = fs) {
  try {
    const raw = JSON.parse(await io.readFile(file, 'utf8'));
    return Array.isArray(raw?.notices) ? raw.notices.filter(item => item && item.at && typeof item.text === 'string') : [];
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return [];
    throw error;
  }
}

export async function appendQuotaNotices(file, entries, { now = new Date(), io = fs } = {}) {
  const fresh = entries.filter(entry => entry && entry.text).map(entry => ({
    at: entry.at || now.toISOString(), source: entry.source || 'nightly', kind: entry.kind || null, model: entry.model || null,
    engine: entry.engine || null, action: entry.action || null, text: sanitizeNotice(entry.text),
  }));
  if (!fresh.length) return null;
  const cutoff = now.getTime() - NOTICE_RETENTION_DAYS * 86_400_000;
  const notices = [...await readQuotaNotices(file, io), ...fresh].filter(item => new Date(item.at).getTime() >= cutoff).slice(-NOTICE_LIMIT);
  await io.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await io.writeFile(temp, `${JSON.stringify({ version: 1, notices }, null, 1)}\n`);
  await io.rename(temp, file);
  return notices;
}
