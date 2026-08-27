import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalUrl, cleanText, isoDate, sha256, unique } from '../utils.mjs';

function decodeQuotedPrintable(value) {
  return String(value)
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function header(raw, name) {
  const unfolded = String(raw).replace(/\r?\n[ \t]+/g, ' ');
  return unfolded.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'))?.[1]?.trim() || '';
}

function sourceFor(from, subject) {
  const text = `${from} ${subject}`.toLowerCase();
  if (text.includes('handshake')) return 'Handshake email alert';
  if (text.includes('jobright')) return 'Jobright email alert';
  if (text.includes('wellfound') || text.includes('angel.co')) return 'Wellfound email alert';
  if (text.includes('ziprecruiter')) return 'ZipRecruiter email alert';
  if (text.includes('simplify')) return 'Simplify email alert';
  return 'Job alert email';
}

function isNoiseUrl(url) {
  return /unsubscribe|preferences|privacy|terms|tracking|pixel|\.png($|\?)|\.jpg($|\?)|\.gif($|\?)/i.test(url);
}

export function parseEml(raw, fileName = 'message.eml') {
  const decoded = decodeQuotedPrintable(raw);
  const from = header(decoded, 'From');
  const subject = cleanText(header(decoded, 'Subject'));
  const messageDate = isoDate(header(decoded, 'Date'));
  const urls = unique(
    [...decoded.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)]
      .map(match => canonicalUrl(match[0].replace(/&amp;/g, '&')))
      .filter(url => url && !isNoiseUrl(url)),
  );
  const body = cleanText(decoded.split(/\r?\n\r?\n/).slice(1).join('\n'));
  return urls.map(url => ({
    source: sourceFor(from, subject),
    sourceKind: 'official_email_alert',
    company: '',
    title: subject || 'Job alert link',
    location: '',
    url,
    roleType: null,
    postedAt: messageDate,
    freshnessBasis: 'email_received_at',
    description: body.slice(0, 12000),
    emailFile: fileName,
    emailFingerprint: sha256(raw),
  }));
}

export async function collectEmailFiles(directory) {
  let names;
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = names.filter(name => /\.eml$/i.test(name)).sort();
  const batches = await Promise.all(files.map(async name => {
    const raw = await fs.readFile(path.join(directory, name), 'utf8');
    return parseEml(raw, name);
  }));
  return batches.flat();
}
