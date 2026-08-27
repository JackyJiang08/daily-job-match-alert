import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveFrom } from './utils.mjs';

export async function loadConfig(configPath) {
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
  if (!config.resumes?.data || !config.resumes?.ai) {
    throw new Error('config.json must define both resumes.data and resumes.ai');
  }
  config.root = root;
  config.outputDirectory = resolveFrom(root, config.outputDirectory || './daily-reports');
  config.resumes = {
    data: resolveFrom(root, config.resumes.data),
    ai: resolveFrom(root, config.resumes.ai),
  };
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

export async function loadResumes(config) {
  const [data, ai] = await Promise.all([
    fs.readFile(config.resumes.data, 'utf8'),
    fs.readFile(config.resumes.ai, 'utf8'),
  ]);
  for (const [track, content] of Object.entries({ data, ai })) {
    if (content.length < 250 || /resume placeholder|replace this file/i.test(content)) {
      throw new Error(`${track} resume is still a placeholder or is too short: ${config.resumes[track]}`);
    }
  }
  return { data, ai };
}
