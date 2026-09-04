// Resume tracks are the N private resumes a posting is scored against. Every layer works on an ordered
// list of { id, label } (plus `text` once the profile is loaded); the order decides tie-breaks and the
// column order in the reports. Payloads written before tracks existed carry dataScore / aiScore instead
// of `scores`, so the report side accepts both shapes.

export const LEGACY_TRACK_IDS = ['data', 'ai'];
export const DEFAULT_TRACK_LABELS = { data: 'Data', ai: 'AI' };
export const TRACK_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/i;

export function defaultTrackLabel(id) {
  const value = String(id || '').trim();
  if (DEFAULT_TRACK_LABELS[value]) return DEFAULT_TRACK_LABELS[value];
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : '';
}

// Accepts the loaded track list, or the pre-track `{ data: text, ai: text }` map still used by tests.
export function resumeTrackList(resumes) {
  if (Array.isArray(resumes)) return resumes;
  if (Array.isArray(resumes?.tracks)) return resumes.tracks;
  if (resumes && typeof resumes === 'object') {
    return Object.entries(resumes)
      .filter(([, text]) => typeof text === 'string')
      .map(([id, text]) => ({ id, label: defaultTrackLabel(id), text }));
  }
  throw new Error('resumes must be a track list or a { trackId: text } map');
}

export function trackSummaries(tracks) {
  return resumeTrackList(tracks).map(track => ({ id: track.id, label: track.label || defaultTrackLabel(track.id) }));
}

// Scores of one job keyed by track id; legacy rows only carried dataScore / aiScore.
export function jobScores(job) {
  if (job?.scores && typeof job.scores === 'object') return job.scores;
  const legacy = {};
  if (job?.dataScore != null) legacy.data = job.dataScore;
  if (job?.aiScore != null) legacy.ai = job.aiScore;
  return legacy;
}

export function trackScore(job, trackId) {
  const value = Number(jobScores(job)[trackId]);
  return Number.isFinite(value) ? value : 0;
}

// The recommended track is the highest score; ties go to the earliest configured track.
export function pickBestTrack(scores, tracks) {
  const list = trackSummaries(tracks);
  let best = null;
  for (const track of list) {
    const value = Number(scores?.[track.id]);
    const score = Number.isFinite(value) ? value : 0;
    if (!best || score > best.score) best = { ...track, score };
  }
  return best;
}

// Tracks to render for a payload: the run's own list when present, otherwise whatever the rows carry.
export function reportTracks(meta, jobs = []) {
  if (Array.isArray(meta?.resumeTracks) && meta.resumeTracks.length) return trackSummaries(meta.resumeTracks);
  const ids = [];
  for (const job of jobs) {
    for (const id of Object.keys(jobScores(job))) if (!ids.includes(id)) ids.push(id);
  }
  if (!ids.length) ids.push(...LEGACY_TRACK_IDS);
  return ids.map(id => ({ id, label: defaultTrackLabel(id) }));
}

export function scoreHeader(track) {
  return `${track.label} Score`;
}
