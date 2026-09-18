// Private cover-letter material and generated letters, all under private/ (gitignored):
//   private/cover-letter/profile.json        name, phone, email, signature, playbook + sample metadata
//   private/cover-letter/playbook.<ext>      the owner's writing rules and evidence library
//   private/cover-letter/samples/<file>.txt  extracted text of up to ten style samples (+ original PDF)
//   private/cover-letters/<date>/<Company>/  letter.json, letter.md, <fileName>.pdf per generated letter
// Nothing in this module carries personal data; every value comes from the owner's uploads.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_FILE_NAME_TEMPLATE, SAMPLE_TRACKS, letterFileName, sanitizeCompany } from './compose.mjs';

export const MAX_SAMPLES = 10;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const COMPANY_PATTERN = /^[A-Za-z0-9]{1,80}$/;
const FILE_PATTERN = /^[A-Za-z0-9._-]{1,160}$/;

export class LetterInputError extends Error {
  constructor(message) { super(message); this.name = 'LetterInputError'; this.status = 400; }
}

export function createLetterStore({ root, io = fs, now = () => new Date(), extractText = null }) {
  const materialDirectory = path.join(root, 'private', 'cover-letter');
  const lettersDirectory = path.join(root, 'private', 'cover-letters');
  const profilePath = path.join(materialDirectory, 'profile.json');

  async function readJson(file, fallback) {
    try { return JSON.parse(await io.readFile(file, 'utf8')); } catch { return fallback; }
  }
  async function writeJson(file, value) {
    await io.mkdir(path.dirname(file), { recursive: true });
    await io.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  }

  async function readProfile() {
    const stored = await readJson(profilePath, {});
    return { name: '', phone: '', email: '', signatureName: '', playbook: null, samples: [], ...stored };
  }

  // Is there enough on file to generate? Missing pieces are listed for the panel and the Settings page.
  async function readiness() {
    const profile = await readProfile();
    const missing = [];
    if (!profile.playbook?.file) missing.push('playbook');
    if (!String(profile.name || '').trim()) missing.push('name');
    if (!String(profile.email || '').trim() && !String(profile.phone || '').trim()) missing.push('contact');
    return { ready: missing.length === 0, missing, profile };
  }

  async function saveProfileFields(fields) {
    const profile = await readProfile();
    for (const key of ['name', 'phone', 'email', 'signatureName']) {
      if (fields[key] != null) profile[key] = String(fields[key]).trim().slice(0, 200);
    }
    await writeJson(profilePath, profile);
    return profile;
  }

  function textFromUpload(file, allowed) {
    const name = String(file?.filename || '');
    const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
    if (!file?.data?.length) throw new LetterInputError('Choose a file to upload');
    if (!allowed.includes(extension)) throw new LetterInputError(`Only ${allowed.map(item => `.${item}`).join(' / ')} files are accepted`);
    if (file.data.length > MAX_UPLOAD_BYTES) throw new LetterInputError('The file is larger than the 5 MB limit');
    return { name, extension };
  }

  async function savePlaybook(file) {
    const { name, extension } = textFromUpload(file, ['md', 'txt']);
    const text = file.data.toString('utf8');
    if (text.trim().length < 50) throw new LetterInputError('The playbook is too short to be useful');
    const target = path.join(materialDirectory, `playbook.${extension}`);
    await io.mkdir(materialDirectory, { recursive: true });
    for (const stale of ['playbook.md', 'playbook.txt']) if (stale !== path.basename(target)) await io.rm(path.join(materialDirectory, stale), { force: true }).catch(() => {});
    await io.writeFile(target, text, { mode: 0o600 });
    const profile = await readProfile();
    profile.playbook = { file: path.basename(target), originalName: path.basename(name), uploadedAt: now().toISOString(), characters: text.length };
    await writeJson(profilePath, profile);
    return profile.playbook;
  }

  function normalizeTrack(track) {
    return SAMPLE_TRACKS.includes(String(track || '').toLowerCase()) ? String(track).toLowerCase() : null;
  }

  async function removeSampleFiles(sample) {
    await io.rm(path.join(materialDirectory, 'samples', sample.file), { force: true }).catch(() => {});
    await io.rm(path.join(materialDirectory, 'samples', sample.file.replace(/\.txt$/, '.pdf')), { force: true }).catch(() => {});
  }

  // Uploading a file whose name is already on file replaces that sample in place (keeping its track);
  // `track` may pre-tag a new sample (data / llm / agent), otherwise it starts untagged.
  async function saveSample(file, { track = null } = {}) {
    const { name, extension } = textFromUpload(file, ['pdf', 'txt']);
    const originalName = path.basename(name);
    const profile = await readProfile();
    const existingIndex = (profile.samples || []).findIndex(item => item.originalName === originalName);
    const trackTag = normalizeTrack(track) ?? (existingIndex >= 0 ? profile.samples[existingIndex].track || null : null);
    if (existingIndex < 0 && (profile.samples || []).length >= MAX_SAMPLES) throw new LetterInputError(`At most ${MAX_SAMPLES} sample letters are kept; remove one first`);
    const samplesDirectory = path.join(materialDirectory, 'samples');
    await io.mkdir(samplesDirectory, { recursive: true });
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    let stem = `${stamp}-${path.basename(name).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/\.(pdf|txt)$/i, '')}`;
    // A replacement uploaded within the same second must not overwrite (and then delete) the old files.
    if (existingIndex >= 0 && profile.samples[existingIndex].file === `${stem}.txt`) stem = `${stem}-r`;
    let text;
    if (extension === 'pdf') {
      if (file.data.slice(0, 5).toString('latin1') !== '%PDF-') throw new LetterInputError('The file does not look like a PDF');
      const pdfPath = path.join(samplesDirectory, `${stem}.pdf`);
      await io.writeFile(pdfPath, file.data, { mode: 0o600 });
      if (!extractText) throw new LetterInputError('PDF text extraction is not available; upload a .txt sample instead');
      try {
        text = await extractText(pdfPath);
      } catch (error) {
        await io.rm(pdfPath, { force: true }).catch(() => {});
        throw new LetterInputError(`Could not extract text from the PDF: ${error.message}`);
      }
    } else {
      text = file.data.toString('utf8');
    }
    if (String(text).trim().length < 50) throw new LetterInputError('The sample is too short to be useful');
    const textPath = path.join(samplesDirectory, `${stem}.txt`);
    await io.writeFile(textPath, text, { mode: 0o600 });
    const sample = { file: `${stem}.txt`, originalName, track: trackTag, uploadedAt: now().toISOString(), characters: String(text).length };
    if (existingIndex >= 0) {
      await removeSampleFiles(profile.samples[existingIndex]);
      profile.samples[existingIndex] = sample;
    } else {
      profile.samples = [...(profile.samples || []), sample];
    }
    await writeJson(profilePath, profile);
    return { ...sample, replaced: existingIndex >= 0 };
  }

  async function setSampleTrack(fileName, track) {
    const profile = await readProfile();
    const name = path.basename(String(fileName || ''));
    const sample = (profile.samples || []).find(item => item.file === name);
    if (!sample) throw new LetterInputError('Unknown sample');
    sample.track = normalizeTrack(track);
    await writeJson(profilePath, profile);
    return sample;
  }

  async function removeSample(fileName) {
    const profile = await readProfile();
    const name = path.basename(String(fileName || ''));
    const sample = (profile.samples || []).find(item => item.file === name);
    if (!sample) throw new LetterInputError('Unknown sample');
    await removeSampleFiles(sample);
    profile.samples = profile.samples.filter(item => item.file !== name);
    await writeJson(profilePath, profile);
  }

  async function loadMaterial() {
    const profile = await readProfile();
    const playbook = profile.playbook?.file ? await io.readFile(path.join(materialDirectory, profile.playbook.file), 'utf8') : '';
    const samples = [];
    for (const sample of profile.samples || []) {
      const text = await io.readFile(path.join(materialDirectory, 'samples', sample.file), 'utf8').catch(() => '');
      if (text.trim()) samples.push({ ...sample, text });
    }
    return { profile, playbook, samples };
  }

  // ---- generated letters

  function letterDirectory(date, company) {
    if (!DATE_PATTERN.test(String(date || ''))) throw new LetterInputError('Invalid date');
    const slug = sanitizeCompany(company);
    if (!COMPANY_PATTERN.test(slug)) throw new LetterInputError('Company name must contain letters or digits');
    return { directory: path.join(lettersDirectory, date, slug), slug };
  }

  async function saveLetter({ date, company, meta, markdown }) {
    const { directory, slug } = letterDirectory(date, company);
    await io.mkdir(directory, { recursive: true });
    const record = { ...meta, date, companySlug: slug, savedAt: now().toISOString() };
    await writeJson(path.join(directory, 'letter.json'), record);
    await io.writeFile(path.join(directory, 'letter.md'), markdown, { mode: 0o600 });
    return { directory, slug, record };
  }

  async function loadLetter(date, company) {
    const { directory, slug } = letterDirectory(date, company);
    const record = await readJson(path.join(directory, 'letter.json'), null);
    if (!record) return null;
    const markdown = await io.readFile(path.join(directory, 'letter.md'), 'utf8').catch(() => '');
    return { directory, slug, record, markdown };
  }

  async function listLetters() {
    const letters = [];
    let dates = [];
    try { dates = (await io.readdir(lettersDirectory)).filter(name => DATE_PATTERN.test(name)); } catch { return letters; }
    for (const date of dates.sort().reverse()) {
      let companies = [];
      try { companies = await io.readdir(path.join(lettersDirectory, date)); } catch { continue; }
      for (const slug of companies.filter(name => COMPANY_PATTERN.test(name))) {
        const record = await readJson(path.join(lettersDirectory, date, slug, 'letter.json'), null);
        if (record) letters.push({ date, slug, ...record });
      }
    }
    return letters.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
  }

  // Only files the store itself wrote can be downloaded: letter.md or the recorded PDF name.
  async function resolveDownload(date, company, fileName) {
    const { directory } = letterDirectory(date, company);
    const name = String(fileName || '');
    if (!FILE_PATTERN.test(name) || name.includes('..')) throw new LetterInputError('Invalid file name');
    const record = await readJson(path.join(directory, 'letter.json'), null);
    if (!record) return null;
    if (name !== 'letter.md' && name !== record.pdfFileName) return null;
    return path.join(directory, name);
  }

  async function lettersByJob() {
    const index = new Map();
    for (const letter of await listLetters()) {
      if (letter.jobId && !index.has(letter.jobId)) index.set(letter.jobId, letter);
    }
    return index;
  }

  return {
    materialDirectory, lettersDirectory, profilePath,
    readProfile, readiness, saveProfileFields, savePlaybook, saveSample, setSampleTrack, removeSample, loadMaterial,
    saveLetter, loadLetter, listLetters, resolveDownload, lettersByJob,
    fileNameFor: (template, profile, company) => letterFileName(template || DEFAULT_FILE_NAME_TEMPLATE, { name: profile.name, company }),
  };
}
