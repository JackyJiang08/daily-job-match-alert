// npm run setup: a first-run wizard (2026-11-19). It asks for the owner's name, school, graduation, home state
// and time zone, the roles to look for, the role types, one to four resume tracks, checks the claude and codex
// CLIs, and the nightly run time; then writes config.json (from config.example.json) and the private/ files a
// new hub needs. It never overwrites a file: when config.json exists it prints one line and stops, unless
// --force-new names a --config path that does not exist yet; private/ files that exist are left as they are.
//
//   npm run setup
//   npm run setup -- --force-new --config other.json
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { US_STATES } from './candidate-profile.mjs';
import { DEFAULT_TARGET_ROLE_FAMILIES } from './role-families.mjs';
import { ENTRY_PROGRAM_TERMS } from './prefilter.mjs';
import { resolveFrom } from './utils.mjs';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXISTS_MESSAGE = 'config.json already exists, nothing changed';
export const MAX_TRACKS = 4;

// Title words that put a posting in each role family (the prefilter's title families).
export const FAMILY_TITLE_WORDS = {
  data: ['data', 'analytics', 'analyst', 'scientist', 'business intelligence', 'BI', 'insights', 'statistic', 'quantitative', 'quant', 'decision', 'actuarial'],
  'AI/ML': ['machine learning', 'ML', 'AI', 'research', 'applied scientist'],
  software: ['software engineer', 'developer', 'data engineer', 'forward deployed engineer', 'solutions engineer'],
  'product management': ['product manager', 'associate product manager', 'APM', 'product analyst', 'program manager'],
  'consulting/strategy': ['consultant', 'consulting', 'strategy', 'strategist', 'business analyst'],
};

export const ROLE_TYPE_CHOICES = [
  { label: 'Internship', roleTypes: ['internship'] },
  { label: 'New Grad', roleTypes: ['new_grad', 'entry_level'] },
  { label: 'Both', roleTypes: ['internship', 'new_grad', 'entry_level'] },
];

function parseArgs(argv) {
  const args = { forceNew: false, config: 'config.json' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--force-new') args.forceNew = true;
    else if (argv[index] === '--config') args.config = argv[index + 1] || args.config, index += 1;
  }
  return args;
}

async function exists(file, io) {
  return io.stat(file).then(() => true, () => false);
}

export function trackIdOf(name, taken = []) {
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^(\d)/, 't$1').slice(0, 24) || 'track';
  let id = base;
  for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`;
  return id;
}

export function monthAfter(graduationDate) {
  const [year, month] = String(graduationDate).split('-').map(Number);
  const next = new Date(Date.UTC(month === 12 ? year + 1 : year, month % 12, 1));
  return next.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function validTimeZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// "1, 3, sports analytics" → families [data, software] and keywords [sports analytics].
export function parseRoleAnswer(answer, families = DEFAULT_TARGET_ROLE_FAMILIES) {
  const picked = [];
  const keywords = [];
  for (const part of String(answer || '').split(',').map(item => item.trim()).filter(Boolean)) {
    const number = /^\d+$/.test(part) ? Number(part) : null;
    if (number && families[number - 1]) {
      if (!picked.includes(families[number - 1])) picked.push(families[number - 1]);
    } else if (!keywords.some(item => item.toLowerCase() === part.toLowerCase())) {
      keywords.push(part);
    }
  }
  return { families: picked, keywords };
}

// The config a new owner starts from: config.example.json with the answers in place.
export function buildConfig(example, answers) {
  const config = structuredClone(example);
  const year = Number(answers.graduationDate.slice(0, 4));
  const families = answers.families.length ? answers.families : answers.keywords.length ? [] : [...DEFAULT_TARGET_ROLE_FAMILIES];
  const titleWords = [...new Set([...families.flatMap(family => FAMILY_TITLE_WORDS[family] || []), ...answers.keywords, ...ENTRY_PROGRAM_TERMS])];
  config.timeZone = answers.timeZone;
  config.preferences = {
    ...config.preferences,
    roleTypes: answers.roleTypes,
    graduationDate: answers.graduationDate,
    cohortYear: year,
    homeState: answers.homeState,
    plannedProgram: '',
    titleFamilies: titleWords,
    targetRoleFamilies: [...families, ...answers.keywords],
    prefilterExcludeOverrides: (config.preferences?.prefilterExcludeOverrides || []).map(item => (/^\d{4}$/.test(item) ? String(year) : item)),
  };
  config.resumes = {
    ...config.resumes,
    autoRefresh: answers.tracks.some(track => track.pdf),
    tracks: answers.tracks.map(track => ({ id: track.id, label: track.label, ...(track.pdf ? { pdf: track.pdf } : {}), enabled: true })),
  };
  config.coverLetter = {
    ...config.coverLetter,
    availability: { fullTimeFrom: monthAfter(answers.graduationDate), springTerm: false, mentionMasters: { internship: false, newGrad: false } },
    businessRoleTrack: null,
    sampleTracks: answers.tracks.map(track => track.id),
  };
  config.semanticMatching = { ...config.semanticMatching, engine: answers.engine };
  config.outreach = { ...config.outreach, ...(answers.school ? { profile: { schools: [answers.school] } } : {}) };
  const queryWords = [...answers.keywords, ...families.flatMap(family => (FAMILY_TITLE_WORDS[family] || []).slice(0, 2))].filter(word => !/^[A-Z]{2,4}$/.test(word)).slice(0, 9);
  const level = answers.roleTypes.includes('internship') && !answers.roleTypes.includes('new_grad') ? 'intern' : 'new grad';
  config.sources = { ...config.sources, searchDiscovery: { ...config.sources?.searchDiscovery, queries: queryWords.map(word => `${level} ${word} ${year}`) } };
  // The example's plan block names one owner's scheduled change; a new owner's plans are detected.
  config.plans = { plansNote: config.plans?.plansNote, claude: {}, chatgpt: { manual: '' } };
  return config;
}

// Questions are read from `input` one line at a time (a terminal or, in tests, a stream of answers).
function lineReader(input, output) {
  const rl = readline.createInterface({ input, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  let closed = false;
  return {
    async ask(question, { fallback = '' } = {}) {
      output.write(question);
      if (closed) throw new SetupAborted();
      const { value, done } = await lines.next();
      if (done) { closed = true; throw new SetupAborted(); }
      output.write(input.isTTY ? '' : '\n');
      return String(value).trim() || fallback;
    },
    close: () => rl.close(),
  };
}

export class SetupAborted extends Error {
  constructor() { super('Setup stopped before every question was answered; nothing was written'); }
}

async function askValid(reader, question, check, problem, options = {}) {
  for (;;) {
    const answer = await reader.ask(question, options);
    const value = check(answer);
    if (value !== undefined) return value;
    reader.output.write(`  ${problem}\n`);
  }
}

// Writes a file only when nothing is there ('wx'); returns whether it was written.
async function writeNew(file, content, io) {
  await io.mkdir(path.dirname(file), { recursive: true });
  try {
    await io.writeFile(file, content, { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

export async function runSetup({ argv = [], root = PROJECT, input = process.stdin, output = process.stdout, io = fs, describeConnections = null, defaultTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  const args = parseArgs(argv);
  const target = path.resolve(root, args.config);
  const hasConfig = await exists(path.join(root, 'config.json'), io);
  if ((hasConfig && !args.forceNew) || await exists(target, io)) {
    output.write(`${hasConfig && !args.forceNew ? EXISTS_MESSAGE : `${path.relative(root, target) || target} already exists, nothing changed`}\n`);
    return { written: [], skipped: [], stopped: true };
  }
  const reader = lineReader(input, output);
  reader.output = output;
  try {
    output.write('Daily Job Match Alert setup. Press Enter to keep a [default].\n\n');
    const name = await askValid(reader, 'Your full name: ', answer => answer || undefined, 'A name is needed for the letters.');
    const school = await reader.ask('School (Enter to skip): ');
    const graduationDate = await askValid(reader, 'Graduation month (YYYY-MM, e.g. 2027-05): ', answer => (/^\d{4}-(0[1-9]|1[0-2])$/.test(answer) ? answer : undefined), 'Write it as YYYY-MM.');
    const homeState = await askValid(reader, 'Home state (two letters, e.g. CA; Enter to skip): ', answer => {
      if (!answer) return '';
      const code = answer.toUpperCase();
      return US_STATES[code] ? code : Object.keys(US_STATES).find(key => US_STATES[key].toLowerCase() === answer.toLowerCase());
    }, 'Use a US state code such as CA or NY.');
    const timeZone = await askValid(reader, `Time zone [${defaultTimeZone}]: `, answer => (validTimeZone(answer) ? answer : undefined), 'Use an IANA name such as America/New_York.', { fallback: defaultTimeZone });
    output.write(`\nRoles to look for:\n${DEFAULT_TARGET_ROLE_FAMILIES.map((family, index) => `  ${index + 1}) ${family}`).join('\n')}\n`);
    const roles = await askValid(reader, 'Pick numbers, or type job title words, separated by commas [1,2,3,4,5]: ', answer => {
      const parsed = parseRoleAnswer(answer);
      return parsed.families.length || parsed.keywords.length ? parsed : undefined;
    }, 'Pick at least one number or type a title word.', { fallback: '1,2,3,4,5' });
    output.write(`\nRole types: ${ROLE_TYPE_CHOICES.map((choice, index) => `${index + 1}) ${choice.label}`).join('  ')}\n`);
    const roleTypes = await askValid(reader, 'Choose 1, 2 or 3 [3]: ', answer => ROLE_TYPE_CHOICES[Number(answer) - 1]?.roleTypes, 'Choose 1, 2 or 3.', { fallback: '3' });
    const count = await askValid(reader, `\nHow many resume tracks (1-${MAX_TRACKS}) [1]: `, answer => (/^[1-4]$/.test(answer) ? Number(answer) : undefined), `Choose 1 to ${MAX_TRACKS}.`, { fallback: '1' });
    const tracks = [];
    for (let index = 1; index <= count; index += 1) {
      const label = await askValid(reader, `Track ${index} name (e.g. Data Analyst): `, answer => answer || undefined, 'A track needs a name.');
      const pdf = await reader.ask(`Track ${index} resume PDF path (Enter to upload later in the hub): `);
      if (pdf && !await exists(resolveFrom(root, pdf), io)) output.write('  That file was not found; the path is kept, and the hub can take an upload instead.\n');
      tracks.push({ id: trackIdOf(label, tracks.map(track => track.id)), label, pdf });
    }
    output.write('\nScoring engines (your Claude or ChatGPT subscription, through its CLI):\n');
    const connections = describeConnections ? await describeConnections().catch(() => null) : null;
    const line = (title, entry) => (entry?.connected ? `  ✓ ${title}: signed in` : entry?.installed ? `  ✗ ${title}: not signed in. Run: ${entry.hint}` : `  ✗ ${title}: not installed. Run: ${entry?.hint || 'see docs/troubleshooting.md'}`);
    output.write(`${line('Claude Code', connections?.claude)}\n${line('Codex', connections?.codex)}\n`);
    const engine = connections?.claude?.connected || !connections?.codex?.connected ? 'claude' : 'codex';
    const runTime = await askValid(reader, '\nNightly run time (HH:MM, 24-hour) [18:00]: ', answer => {
      const match = /^(\d{1,2}):(\d{2})$/.exec(answer);
      return match && Number(match[1]) < 24 && Number(match[2]) < 60 ? { hour: Number(match[1]), minute: Number(match[2]) } : undefined;
    }, 'Write it as HH:MM, such as 18:00.', { fallback: '18:00' });

    const example = JSON.parse(await io.readFile(path.join(PROJECT, 'config.example.json'), 'utf8'));
    const config = buildConfig(example, { name, school, graduationDate, homeState, timeZone, families: roles.families, keywords: roles.keywords, roleTypes, tracks, engine });
    const base = path.dirname(target);
    const written = [];
    const skipped = [];
    const files = [
      [target, `${JSON.stringify(config, null, 2)}\n`],
      [path.join(base, 'private', 'cover-letter', 'playbook.md'), await io.readFile(path.join(PROJECT, 'cover-letter', 'playbook.example.md'), 'utf8')],
      [path.join(base, 'private', 'cover-letter', 'profile.json'), `${JSON.stringify({ name, signatureName: name, phone: '', email: '' }, null, 2)}\n`],
    ];
    for (const [file, content] of files) (await writeNew(file, content, io) ? written : skipped).push(path.relative(root, file) || file);
    output.write(`\nWrote ${written.join(', ')}${skipped.length ? `; kept the existing ${skipped.join(', ')}` : ''}.\n`);
    output.write(`\nNext:\n${tracks.some(track => track.pdf) ? '  npm run resume:sync            extract the resume text\n' : '  npm run hub, then Resumes      upload a PDF per track\n'}`);
    output.write('  npm run hub                    open http://127.0.0.1:4747\n');
    output.write(`  zsh scripts/install-launchd.sh ${runTime.hour} ${runTime.minute}   run every night at ${String(runTime.hour).padStart(2, '0')}:${String(runTime.minute).padStart(2, '0')}\n`);
    output.write('  npm run doctor                 check everything is in place\n');
    output.write('Add your phone and email under Settings > Cover Letters before the first letter.\n');
    return { written, skipped, stopped: false, config, runTime };
  } catch (error) {
    if (error instanceof SetupAborted) {
      output.write(`\n${error.message}\n`);
      return { written: [], skipped: [], stopped: true };
    }
    throw error;
  } finally {
    reader.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { describeConnections } = await import('./engines/index.mjs');
  await runSetup({ argv: process.argv.slice(2), root: process.cwd(), describeConnections: () => describeConnections({}) });
}
