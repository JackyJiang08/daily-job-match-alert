import { classifyRole, minimumYears } from './classify.mjs';
import { assessEligibility } from './eligibility.mjs';
import { unique } from './utils.mjs';

const STOP = new Set('a an and are as at be by for from has have in into is it its of on or that the their this to using with you your we our will work role team experience skills preferred required responsibilities qualifications'.split(' '));

const TRACKS = {
  data: {
    title: ['data analyst', 'data scientist', 'analytics', 'business intelligence', 'bi analyst', 'product analyst', 'decision scientist', 'data engineer'],
    skills: ['sql', 'python', ' r ', 'tableau', 'power bi', 'excel', 'pandas', 'numpy', 'statistics', 'statistical modeling', 'data visualization', 'etl', 'dbt', 'snowflake', 'bigquery', 'spark', 'airflow', 'experimentation', 'a/b testing', 'aws', 'gcp', 'azure'],
  },
  ai: {
    title: ['machine learning', 'ml engineer', 'ai engineer', 'ai research', 'research scientist', 'applied scientist', 'nlp', 'computer vision', 'generative ai', 'data scientist'],
    skills: ['python', 'pytorch', 'tensorflow', 'transformers', 'llm', 'large language model', 'rag', 'retrieval augmented generation', 'nlp', 'computer vision', 'machine learning', 'deep learning', 'scikit-learn', 'mlops', 'docker', 'kubernetes', 'aws', 'gcp', 'azure', 'hugging face'],
  },
};

function normalized(text) {
  return ` ${String(text).toLowerCase().replace(/[^a-z0-9+#./-]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

function includesPhrase(text, phrase) {
  return normalized(text).includes(normalized(phrase));
}

function tokens(text) {
  return new Set(normalized(text).trim().split(' ').filter(token => token.length >= 3 && !STOP.has(token) && !/^\d+$/.test(token)));
}

function locationScore(job, preferences) {
  if (!preferences.locations?.length) return { score: 10, reason: null };
  const location = normalized(job.location);
  if (!location.trim()) return { score: 5, reason: 'location not stated' };
  if (preferences.remoteOkay && /\bremote\b/i.test(location)) return { score: 10, reason: 'remote matches preference' };
  if (preferences.locations.some(item => location.includes(normalized(item).trim()))) return { score: 10, reason: 'location matches preference' };
  return { score: 0, reason: `location may not match: ${job.location}` };
}

function blockers(job, preferences) {
  const found = [];
  const text = `${job.title} ${job.description}`;
  const years = minimumYears(text);
  if (years != null && Number.isFinite(preferences.maxYearsExperience) && years > preferences.maxYearsExperience) {
    found.push(`requires about ${years}+ years of experience`);
  }
  if (preferences.needsSponsorship === true && /\b(no sponsorship|unable to sponsor|will not sponsor|does not sponsor|without sponsorship)\b/i.test(text)) {
    found.push('posting says sponsorship is unavailable');
  }
  if (preferences.needsSponsorship === true && /\b(u\.?s\.? citizens? only|requires? u\.?s\.? citizenship|security clearance required)\b/i.test(text)) {
    found.push('citizenship or clearance restriction');
  }
  return found;
}

function scoreTrack(job, resume, track, preferences) {
  const rules = TRACKS[track];
  const titleMatches = rules.title.filter(phrase => includesPhrase(job.title, phrase));
  const descriptionTitleMatches = rules.title.filter(phrase => includesPhrase(job.description, phrase));
  const roleRelevance = titleMatches.length ? 25 : descriptionTitleMatches.length ? 14 : 0;

  const jdSkills = rules.skills.filter(skill => includesPhrase(`${job.title} ${job.description}`, skill));
  const resumeSkills = rules.skills.filter(skill => includesPhrase(resume, skill));
  const matchedSkills = jdSkills.filter(skill => resumeSkills.includes(skill));
  const skillScore = jdSkills.length ? Math.round(40 * matchedSkills.length / jdSkills.length) : 12;

  const jdTokens = tokens(`${job.title} ${job.description}`);
  const resumeTokens = tokens(resume);
  const overlap = [...jdTokens].filter(token => resumeTokens.has(token));
  const keywordScore = Math.min(15, Math.round(15 * overlap.length / Math.max(12, Math.min(45, jdTokens.size))));

  const years = minimumYears(`${job.title} ${job.description}`);
  const experienceScore = years == null ? 7 : years <= (preferences.maxYearsExperience ?? 3) ? 10 : 0;
  const location = locationScore(job, preferences);
  const hardBlockers = blockers(job, preferences);
  const penalty = hardBlockers.length ? 35 : 0;
  const score = Math.max(0, Math.min(100, roleRelevance + skillScore + keywordScore + experienceScore + location.score - penalty));

  const reasons = unique([
    titleMatches.length ? `title aligns with ${track.toUpperCase()}: ${titleMatches.slice(0, 3).join(', ')}` : null,
    matchedSkills.length ? `matched skills: ${matchedSkills.slice(0, 8).join(', ')}` : null,
    overlap.length ? `resume/JD keyword overlap: ${overlap.slice(0, 6).join(', ')}` : null,
    location.reason?.includes('matches') ? location.reason : null,
  ]);
  const gaps = unique([
    ...jdSkills.filter(skill => !resumeSkills.includes(skill)).slice(0, 8).map(skill => `JD skill not found in resume: ${skill}`),
    location.reason && !location.reason.includes('matches') ? location.reason : null,
  ]);
  return { score, roleRelevance, titleMatches, reasons, gaps, blockers: hardBlockers, matchedSkills, jdSkills };
}

export function evaluateJob(job, resumes, preferences = {}) {
  let roleType = classifyRole(job);
  const years = minimumYears(`${job.title} ${job.description}`);
  if (roleType === 'unknown' && /\b(data|analytics|machine learning|ml|ai|artificial intelligence|nlp|computer vision|applied scientist|research scientist)\b/i.test(job.title)) {
    if (years == null || years <= (preferences.maxYearsExperience ?? 3)) roleType = 'entry_level';
  }
  const data = scoreTrack(job, resumes.data, 'data', preferences);
  const ai = scoreTrack(job, resumes.ai, 'ai', preferences);
  const recommendedResume = data.score >= ai.score ? 'Data' : 'AI';
  const best = Math.max(data.score, ai.score);
  return {
    ...job,
    roleType,
    dataScore: data.score,
    aiScore: ai.score,
    bestScore: best,
    recommendedResume,
    reasons: recommendedResume === 'Data' ? data.reasons : ai.reasons,
    gaps: recommendedResume === 'Data' ? data.gaps : ai.gaps,
    blockers: unique([...data.blockers, ...ai.blockers]),
    scoreDetails: { data, ai },
  };
}

export function isEligible(job, config) {
  const prefs = config.preferences || {};
  // Deterministic eligibility runs first and for every posting, regardless of which engine scored it.
  if ((job.eligibility || assessEligibility(job, prefs)).exclusion) return false;
  if (config.requireFullDescription !== false && String(job.description || '').trim().length < Number(config.minimumDescriptionCharacters || 200)) return false;
  if (prefs.roleTypes?.length && !prefs.roleTypes.includes(job.roleType)) return false;
  if (prefs.excludeTitleTerms?.some(term => includesPhrase(job.title, term))) return false;
  if (job.blockers?.length) return false;
  if (Math.max(job.scoreDetails?.data?.roleRelevance || 0, job.scoreDetails?.ai?.roleRelevance || 0) < 14) return false;
  const semantic = config.semanticMatching || {};
  if ((semantic.engine || 'claude_subscription') !== 'local_only') {
    const locallyFallbacked = job.matchLevel === 'unreviewed' || job.scoringEngine === 'local_fallback';
    if (!locallyFallbacked) {
      if (!job.semanticReviewed) return false;
      if (!(semantic.acceptedMatchLevels || ['high']).includes(job.matchLevel)) return false;
    }
  }
  return job.bestScore >= Number(config.minimumMatchScore || 60);
}
