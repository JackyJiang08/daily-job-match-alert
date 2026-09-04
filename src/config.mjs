import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveFrom } from './utils.mjs';
import { LEGACY_TRACK_IDS, TRACK_ID_PATTERN, defaultTrackLabel } from './resume-tracks.mjs';

export const LEGACY_RESUME_CONFIG_NOTICE = 'config.json still uses the legacy "resumes": { data, ai } + "resumeSources" layout; it was migrated in memory. Move to "resumes": { autoRefresh, pdftotextCommand, tracks: [...] } as shown in config.example.json to silence this notice and to add or disable tracks.';

function isLegacyResumeLayout(resumes) {
  if (!resumes || typeof resumes !== 'object' || Array.isArray(resumes)) return false;
  if (Array.isArray(resumes.tracks)) return false;
  return LEGACY_TRACK_IDS.some(id => typeof resumes[id] === 'string');
}

// Old layout: resumes.{data,ai} are profile paths and resumeSources.{data,ai}Pdf are the PDFs.
function migrateLegacyResumes(raw) {
  const sources = raw.resumeSources && typeof raw.resumeSources === 'object' ? raw.resumeSources : {};
  const tracks = LEGACY_TRACK_IDS
    .filter(id => typeof raw.resumes[id] === 'string')
    .map(id => ({
      id,
      label: defaultTrackLabel(id),
      profile: raw.resumes[id],
      pdf: sources[`${id}Pdf`] || null,
      enabled: true,
    }));
  return {
    autoRefresh: Boolean(sources.autoRefresh),
    pdftotextCommand: sources.pdftotextCommand || 'pdftotext',
    tracks,
  };
}

// Normalizes the resumes block into { autoRefresh, pdftotextCommand, tracks } with absolute paths.
// Every track keeps its `enabled` flag so callers can report what was skipped; use enabledResumeTracks()
// for the list that actually takes part in extraction, scoring, and reporting.
export function normalizeResumeConfig(raw, root, options = {}) {
  const notify = options.notify || (message => console.warn(message));
  let block = raw.resumes;
  let legacy = false;
  if (isLegacyResumeLayout(block)) {
    block = migrateLegacyResumes(raw);
    legacy = true;
    notify(LEGACY_RESUME_CONFIG_NOTICE);
  }
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    throw new Error('config.json must define resumes.tracks with at least one enabled resume track');
  }
  const rawTracks = Array.isArray(block.tracks) ? block.tracks : [];
  const seen = new Set();
  const tracks = rawTracks.map((track, index) => {
    if (!track || typeof track !== 'object') throw new Error(`resumes.tracks[${index}] must be an object`);
    const id = String(track.id || '').trim();
    if (!TRACK_ID_PATTERN.test(id)) {
      throw new Error(`resumes.tracks[${index}].id "${id}" is invalid; use letters, digits, "_" or "-" (for example "data", "llm", "agent")`);
    }
    if (seen.has(id)) throw new Error(`resumes.tracks has a duplicate id "${id}"`);
    seen.add(id);
    const label = String(track.label || '').trim() || defaultTrackLabel(id);
    const enabled = track.enabled !== false;
    const profile = resolveFrom(root, track.profile ? String(track.profile) : `./resumes/${id}.md`);
    const pdf = track.pdf ? resolveFrom(root, String(track.pdf)) : null;
    return { id, label, profile, pdf, enabled };
  });
  if (!tracks.some(track => track.enabled)) {
    throw new Error('config.json must define at least one enabled resume track under resumes.tracks (all tracks are missing or disabled)');
  }
  return {
    autoRefresh: Boolean(block.autoRefresh),
    pdftotextCommand: block.pdftotextCommand || 'pdftotext',
    tracks,
    legacyLayout: legacy,
  };
}

export function enabledResumeTracks(config) {
  return (config?.resumes?.tracks || []).filter(track => track.enabled !== false);
}

export async function loadConfig(configPath, options = {}) {
  const absolute = path.resolve(configPath);
  const root = path.dirname(absolute);
  const raw = JSON.parse(await fs.readFile(absolute, 'utf8'));
  const config = {
    lookbackHours: 24,
    minimumMatchScore: 60,
    preferences: {},
    sources: {},
    network: {},
    ...raw,
  };
  config.root = root;
  config.outputDirectory = resolveFrom(root, config.outputDirectory || './daily-reports');
  config.resumes = normalizeResumeConfig(raw, root, options);
  delete config.resumeSources;
  if (config.sources.emailFiles?.directory) {
    config.sources.emailFiles.directory = resolveFrom(root, config.sources.emailFiles.directory);
  }
  if (config.sources.careerOps?.projectDirectory) {
    config.sources.careerOps.projectDirectory = resolveFrom(root, config.sources.careerOps.projectDirectory);
  }
  if (config.sources.careerOps?.scanHistoryPath) {
    config.sources.careerOps.scanHistoryPath = resolveFrom(root, config.sources.careerOps.scanHistoryPath);
  }
  return config;
}

// Returns the enabled tracks in configured order, each with its extracted resume text.
export async function loadResumes(config) {
  const tracks = enabledResumeTracks(config);
  if (!tracks.length) throw new Error('No enabled resume track is configured');
  return Promise.all(tracks.map(async track => {
    const text = await fs.readFile(track.profile, 'utf8');
    if (text.length < 250 || /resume placeholder|replace this file/i.test(text)) {
      throw new Error(`${track.label} resume (${track.id}) is still a placeholder or is too short: ${track.profile}`);
    }
    return { id: track.id, label: track.label, text };
  }));
}
