import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalUrl, cleanText, isoDate, sha256, unique } from '../utils.mjs';
import { createWarning, errorSummary } from '../warnings.mjs';

// Alert emails are small; anything larger is not a job alert and is skipped instead of parsed.
const MAXIMUM_EMAIL_BYTES = 5 * 1024 * 1024;

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

function decodeBody(rawBody, transferEncoding) {
  const encoding = String(transferEncoding || '').toLowerCase();
  if (encoding.includes('base64')) {
    const compact = rawBody.replace(/\s+/g, '');
    if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
      throw new Error('body declares base64 transfer encoding but the data is truncated or invalid');
    }
    return Buffer.from(compact, 'base64').toString('utf8');
  }
  return decodeQuotedPrintable(rawBody);
}

export function parseEml(raw, fileName = 'message.eml') {
  const text = String(raw);
  const separator = text.match(/\r?\n\r?\n/);
  const headerBlock = separator ? text.slice(0, separator.index) : text;
  const rawBody = separator ? text.slice(separator.index + separator[0].length) : '';
  const from = header(headerBlock, 'From');
  const subject = cleanText(header(headerBlock, 'Subject'));
  const dateHeader = header(headerBlock, 'Date');
  if (!dateHeader) throw new Error(`${fileName}: missing Date header`);
  const messageDate = isoDate(dateHeader);
  if (!messageDate) throw new Error(`${fileName}: unparseable Date header "${dateHeader.slice(0, 80)}"`);
  const body = decodeBody(rawBody, header(headerBlock, 'Content-Transfer-Encoding'));
  const urls = unique(
    [...body.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)]
      .map(match => canonicalUrl(match[0].replace(/&amp;/g, '&')))
      .filter(url => url && !isNoiseUrl(url)),
  );
  const description = cleanText(body);
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
    description: description.slice(0, 12000),
    emailFile: fileName,
    emailFingerprint: sha256(raw),
  }));
}

// Each .eml is parsed in isolation: one malformed or oversized file is skipped with a warning
// instead of failing the whole email source.
export async function collectEmailFiles(directory, options = {}) {
  let names;
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const warnings = Array.isArray(options.warnings) ? options.warnings : null;
  const skip = (name, reason) => {
    if (warnings) warnings.push(createWarning('collector', 'Email files', `Skipped ${name}: ${reason}`));
  };
  const files = names.filter(name => /\.eml$/i.test(name)).sort();
  const batches = await Promise.all(files.map(async name => {
    const filePath = path.join(directory, name);
    try {
      const { size } = await fs.stat(filePath);
      if (size > MAXIMUM_EMAIL_BYTES) {
        skip(name, `file is ${size} bytes, above the ${MAXIMUM_EMAIL_BYTES} byte limit for alert email`);
        return [];
      }
      return parseEml(await fs.readFile(filePath, 'utf8'), name);
    } catch (error) {
      skip(name, errorSummary(error, 300));
      return [];
    }
  }));
  return batches.flat();
}

export { MAXIMUM_EMAIL_BYTES };
