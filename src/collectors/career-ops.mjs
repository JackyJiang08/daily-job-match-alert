import fs from 'node:fs/promises';
import { canonicalUrl, isoDate } from '../utils.mjs';

export function parseCareerOpsHistory(tsv, cutoff) {
  const jobs = [];
  for (const line of String(tsv).split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const [rawUrl, firstSeen, portal, title, company, status, location, , postedAt] = line.split('\t');
    const seenAt = isoDate(firstSeen);
    if (!seenAt || new Date(seenAt) < cutoff) continue;
    if (!['added', 'migrated'].includes(status)) continue;
    const url = canonicalUrl(rawUrl);
    if (!url || !title) continue;
    jobs.push({
      source: `career-ops:${portal || 'unknown'}`,
      sourceKind: 'career_ops_scan',
      company: company || '',
      title,
      location: location || '',
      url,
      roleType: null,
      postedAt: isoDate(postedAt),
      discoveredAt: seenAt,
      freshnessBasis: postedAt ? 'employer_posted_at' : 'career_ops_first_seen',
      description: '',
    });
  }
  return jobs;
}

export async function collectCareerOps(scanHistoryPath, cutoff) {
  try {
    return parseCareerOpsHistory(await fs.readFile(scanHistoryPath, 'utf8'), cutoff);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
