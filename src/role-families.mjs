// Role scope beyond data and software: product management and consulting/strategy entry roles.
//
//   config.preferences.targetRoleFamilies   the role families the owner applies to (default data, AI/ML,
//                                           software, product management, consulting/strategy). They go
//                                           into the review and prescreen prompts, so a product or
//                                           consulting posting is judged on what those roles ask for and
//                                           is never marked down for not being a data role. The score
//                                           bands and thresholds are unchanged, and the model still picks
//                                           the resume track from the evidence.
//   roleFamilyOf(title)                     the Run Details bucket of a posting (data, AI/ML, software,
//                                           product, consulting, other), counted at the prescreen, the
//                                           review, and the matches.
export const DEFAULT_TARGET_ROLE_FAMILIES = ['data', 'AI/ML', 'software', 'product management', 'consulting/strategy'];

export const ROLE_FAMILY_BUCKETS = [
  { key: 'product', label: 'product', pattern: /(?<![A-Za-z0-9])(?:product\s+(?:manager|management|owner)|program\s+manager|APM|technical\s+program)(?![A-Za-z0-9])/i },
  { key: 'consulting', label: 'consulting', pattern: /(?<![A-Za-z0-9])(?:consult(?:ant|ants|ing)?|strateg(?:y|ies|ist|ic)|business\s+analyst)(?![A-Za-z0-9])/i },
  // The acronyms match case-sensitively so "Retail" or "html" never count; the words in any case.
  { key: 'ai_ml', label: 'AI/ML', pattern: /(?<![A-Za-z0-9])(?:AI|ML|NLP|LLM|LLMs|GenAI)(?![A-Za-z0-9])/, words: /(?<![A-Za-z0-9])(?:artificial\s+intelligence|computer\s+vision|applied\s+scientist|research\s+scientist|machine\s+learning|deep\s+learning)(?![A-Za-z0-9])/i },
  { key: 'data', label: 'data', pattern: /(?<![A-Za-z0-9])(?:data|analytics?|analysts?|scientists?|statistic(?:s|al|ian)?|quant(?:itative)?|business\s+intelligence|BI|insights|actuarial|decision)(?![A-Za-z0-9])/i },
  { key: 'software', label: 'software', pattern: /(?<![A-Za-z0-9])(?:software|developer|engineer(?:ing)?|SWE|backend|front[\s-]?end|full[\s-]?stack|programmer|devops)(?![A-Za-z0-9])/i },
];
export const OTHER_ROLE_FAMILY = { key: 'other', label: 'other' };

// The first bucket whose words appear in the title, in the order above: "Product Analyst" stays data,
// "Associate Product Manager" is product, "Strategy Analyst" is consulting, "ML Engineer" is AI/ML.
export function roleFamilyOf(title) {
  const text = String(title || '');
  for (const bucket of ROLE_FAMILY_BUCKETS) {
    if (bucket.pattern.test(text) || bucket.words?.test(text)) return bucket.key;
  }
  return OTHER_ROLE_FAMILY.key;
}

// Per bucket: how many postings reached the prescreen, the review, and the matches. Buckets with no
// posting at any stage are still listed (except "other"), so the row always shows the five families.
export function countByRoleFamily({ prescreen = [], review = [], matched = [] } = {}) {
  const rows = [...ROLE_FAMILY_BUCKETS, OTHER_ROLE_FAMILY].map(bucket => ({ key: bucket.key, label: bucket.label, prescreen: 0, review: 0, matched: 0 }));
  const byKey = new Map(rows.map(row => [row.key, row]));
  for (const [stage, jobs] of [['prescreen', prescreen], ['review', review], ['matched', matched]]) {
    for (const job of jobs) byKey.get(roleFamilyOf(job?.title))[stage] += 1;
  }
  return rows.filter(row => row.key !== 'other' || row.prescreen || row.review || row.matched);
}

export function roleFamilyCountsText(rows = []) {
  return rows.map(row => `${row.label} ${Number(row.prescreen)} / ${Number(row.review)} / ${Number(row.matched)}`).join(' · ');
}

function cleanList(value) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const text = String(item ?? '').trim();
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
  }
  return out;
}

export function targetRoleFamilies(preferences = {}) {
  return cleanList(preferences?.targetRoleFamilies) || [...DEFAULT_TARGET_ROLE_FAMILIES];
}

// The paragraph the review and the prescreen prompts carry. It only says which roles are in scope and
// what a product or consulting posting is judged on; the score bands stay as they are.
export function targetRoleGuidance(preferences = {}) {
  const families = targetRoleFamilies(preferences);
  if (!families.length) return '';
  return [
    `Target role families (all in scope for this candidate): ${families.join(', ')}.`,
    'For product management and consulting/strategy postings (Associate Product Manager, APM, Business Analyst, Associate Consultant, Consulting or Strategy Analyst, rotational and graduate programs), judge fit on analytical ability, project and internship experience, communication and collaboration, and business understanding; do not mark a posting down because it is not a data role.',
    'An entry-level title that contains "Manager" (Associate Product Manager, Associate Program Manager, a new-grad Product Manager program) is not a manager role. Senior Consultant, Engagement Manager, and Principal roles remain too senior.',
    'Choose the recommended resume track from the evidence in the resumes; no track is preferred for these roles.',
  ].join('\n');
}
