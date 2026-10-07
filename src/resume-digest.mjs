// A compact digest of each resume track (about 1,200 characters) for the prescreen prompt only: the skills
// the resume names, then the lines that carry numbers (results, scale, GPA), then project and role headings,
// then the remaining bullets while they fit.
// It is extracted from the resume text, not written by a model, so it costs no subscription quota. The
// digest is cached as resumes/{id}.digest.md (gitignored with the resumes) and rebuilt only when the
// resume text's hash changes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { localProfileFor } from './match.mjs';
import { sha256 } from './utils.mjs';

export const DIGEST_LIMIT = 1200;
const HASH_LINE = /^<!-- sha256: ([0-9a-f]{64}) -->\n/;

function clean(line) {
  return String(line || '').replace(/^[#>*\-•\s]+/, '').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
}

export function buildDigest(text, limit = DIGEST_LIMIT) {
  const raw = String(text || '');
  const lines = raw.split(/\r?\n/).map(clean).filter(line => line.length >= 3);
  const lower = ` ${raw.toLowerCase().replace(/[^a-z0-9+#./-]+/g, ' ')} `;
  const skills = localProfileFor(null).skills.map(skill => skill.trim()).filter(skill => lower.includes(` ${skill} `));
  const numbered = lines.filter(line => /\d/.test(line) && line.length > 12);
  const bullets = raw.split(/\r?\n/).filter(line => /^\s*(?:[-*•]|\d+\.)\s+\S/.test(line)).map(clean).filter(line => line.length > 12);
  const headings = raw.split(/\r?\n/).filter(line => /^\s*#{1,4}\s+\S/.test(line) || (/^[A-Z][^.!?]{2,70}$/.test(line.trim()) && line.trim().split(/\s+/).length <= 9)).map(clean);
  const parts = [];
  if (skills.length) parts.push(`Skills: ${skills.join(', ')}`);
  const seen = new Set(parts);
  for (const line of [...numbered, ...headings, ...bullets]) {
    if (seen.has(line)) continue;
    seen.add(line);
    parts.push(line);
  }
  let out = '';
  for (const part of parts) {
    const next = out ? `${out}\n${part}` : part;
    if (next.length > limit) {
      if (!out) out = part.slice(0, limit);
      continue;
    }
    out = next;
  }
  return out;
}

export function digestPath(root, trackId) {
  return path.join(root, 'resumes', `${trackId}.digest.md`);
}

// { [trackId]: digest } for the tracks, rebuilt only where the resume text changed. Returns which were rebuilt.
export async function ensureDigests(root, resumes, { io = fs, limit = DIGEST_LIMIT } = {}) {
  const digests = {};
  const rebuilt = [];
  for (const resume of resumes) {
    const hash = sha256(String(resume.text || ''));
    const file = digestPath(root, resume.id);
    const cached = await io.readFile(file, 'utf8').catch(() => null);
    const match = cached ? HASH_LINE.exec(cached) : null;
    if (match && match[1] === hash) {
      digests[resume.id] = cached.slice(match[0].length).trim();
      continue;
    }
    const digest = buildDigest(resume.text, limit);
    await io.mkdir(path.dirname(file), { recursive: true });
    await io.writeFile(file, `<!-- sha256: ${hash} -->\n${digest}\n`);
    digests[resume.id] = digest;
    rebuilt.push(resume.id);
  }
  return { digests, rebuilt };
}
