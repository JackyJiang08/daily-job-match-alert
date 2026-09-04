import { classifyRole, minimumYears } from './classify.mjs';
import { assessEligibility } from './eligibility.mjs';
import { pickBestTrack, resumeTrackList } from './resume-tracks.mjs';
import { unique } from './utils.mjs';

const STOP = new Set('a an and are as at be by for from has have in into is it its of on or that the their this to using with you your we our will work role team experience skills preferred required responsibilities qualifications'.split(' '));

// Keyword profiles for the local (pre-review) score, keyed by track id. A track whose id has no
// profile of its own is scored against the union of every profile, so any custom track still gets a
// sensible triage score; the subscription review supplies the real per-track judgment.
const LOCAL_PROFILES = {
  data: {
    title: ['data analyst', 'data scientist', 'analytics', 'business intelligence', 'bi analyst', 'product analyst', 'decision scientist', 'data engineer'],
    skills: ['sql', 'python', ' r ', 'tableau', 'power bi', 'excel', 'pandas', 'numpy', 'statistics', 'statistical modeling', 'data visualization', 'etl', 'dbt', 'snowflake', 'bigquery', 'spark', 'airflow', 'experimentation', 'a/b testing', 'aws', 'gcp', 'azure'],
  },
  ai: {
    title: ['machine learning', 'ml engineer', 'ai engineer', 'ai research', 'research scientist', 'applied scientist', 'nlp', 'computer vision', 'generative ai', 'data scientist'],
    skills: ['python', 'pytorch', 'tensorflow', 'transformers', 'llm', 'large language model', 'rag', 'retrieval augmented generation', 'nlp', 'computer vision', 'machine learning', 'deep learning', 'scikit-learn', 'mlops', 'docker', 'kubernetes', 'aws', 'gcp', 'azure', 'hugging face'],
  },
  llm: {
    title: ['llm', 'large language model', 'generative ai', 'ai engineer', 'nlp', 'machine learning', 'ml engineer', 'applied scientist', 'research scientist', 'prompt engineer'],
    skills: ['python', 'pytorch', 'transformers', 'llm', 'large language model', 'rag', 'retrieval augmented generation', 'fine-tuning', 'lora', 'evaluation', 'embeddings', 'vector database', 'prompt engineering', 'hugging face', 'openai', 'anthropic', 'nlp', 'deep learning', 'docker', 'aws', 'gcp', 'azure'],
  },
  agent: {
    title: ['ai agent', 'agentic', 'agent engineer', 'ai engineer', 'llm', 'generative ai', 'automation engineer', 'machine learning', 'ml engineer', 'applied scientist', 'forward deployed'],
    skills: ['python', 'typescript', 'llm', 'large language model', 'agents', 'agentic', 'tool use', 'function calling', 'mcp', 'model context protocol', 'langchain', 'langgraph', 'rag', 'retrieval augmented generation', 'orchestration', 'evaluation', 'prompt engineering', 'api', 'docker', 'kubernetes', 'aws', 'gcp', 'azure'],
  },
};

const UNION_PROFILE = {
  title: unique(Object.values(LOCAL_PROFILES).flatMap(profile => profile.title)),
  skills: unique(Object.values(LOCAL_PROFILES).flatMap(profile => profile.skills)),
};

export function localProfileFor(trackId) {
  return LOCAL_PROFILES[String(trackId || '').toLowerCase()] || UNION_PROFILE;
}

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

function scoreTrack(job, track, preferences) {
  const rules = localProfileFor(track.id);
  const resume = String(track.text || '');
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
    titleMatches.length ? `title aligns with ${track.label}: ${titleMatches.slice(0, 3).join(', ')}` : null,
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

export function maxRoleRelevance(job) {
  return Math.max(0, ...Object.values(job?.scoreDetails || {}).map(detail => Number(detail?.roleRelevance) || 0));
}

// Scores one posting against every enabled track. `scores` is keyed by track id; the recommended
// resume is the label of the highest-scoring track, with ties resolved by configured order.
export function evaluateJob(job, resumes, preferences = {}) {
  const tracks = resumeTrackList(resumes);
  if (!tracks.length) throw new Error('evaluateJob needs at least one resume track');
  let roleType = classifyRole(job);
  const years = minimumYears(`${job.title} ${job.description}`);
  if (roleType === 'unknown' && /\b(data|analytics|machine learning|ml|ai|artificial intelligence|nlp|computer vision|applied scientist|research scientist)\b/i.test(job.title)) {
    if (years == null || years <= (preferences.maxYearsExperience ?? 3)) roleType = 'entry_level';
  }
  const scoreDetails = {};
  const scores = {};
  for (const track of tracks) {
    const detail = scoreTrack(job, track, preferences);
    scoreDetails[track.id] = detail;
    scores[track.id] = detail.score;
  }
  const best = pickBestTrack(scores, tracks);
  const bestDetail = scoreDetails[best.id];
  return {
    ...job,
    roleType,
    scores,
    bestScore: best.score,
    recommendedTrack: best.id,
    recommendedResume: best.label,
    reasons: bestDetail.reasons,
    gaps: bestDetail.gaps,
    blockers: unique(tracks.flatMap(track => scoreDetails[track.id].blockers)),
    scoreDetails,
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
  if (maxRoleRelevance(job) < 14) return false;
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
