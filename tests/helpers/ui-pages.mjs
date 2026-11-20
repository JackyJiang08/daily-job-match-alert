// The pages the shape checks (2026-11-19) look at, built from placeholder data: the Reports page, Letters, the
// letter editor, Resumes, Status, the three Settings tabs, the standalone letter page, the Message to Recruiters panel and the Desktop
// HTML. buildUiPages() starts an in-process hub on the report fixture project (tests/helpers/report-hub.mjs)
// with a stubbed search API, so nothing leaves the machine; close() stops it and removes the project.
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildHtml } from '../../src/report.mjs';
import { jobIdOf } from '../../src/hub/letters.mjs';
import { fixtureJob, fixturePayload, normalizeHtml, prepareReportProject, selectedMatches, startReportHub, writePayload } from './report-hub.mjs';

const LETTER = [
  'Dear Example Corp 1 Recruiting Team,',
  '',
  'I am applying for the Data Analyst 1 role at Example Corp 1. I will graduate in May 2027 with a degree in Statistics.',
  '',
  'At Example Labs I built a weekly reporting pipeline in SQL and Python that replaced a manual spreadsheet process.',
  '',
  'I would bring the same care to the analytics team. Thank you for considering my application.',
  '',
  'Sincerely,',
  'Jane Doe',
].join('\n');

const PEOPLE = {
  recruiter: [{ title: 'Sam Lee - Campus Recruiter - Example Corp 1 | LinkedIn', url: 'https://www.linkedin.com/in/sam-lee', description: 'Early career recruiting at Example Corp 1.' }],
  team: [{ title: 'Lee Park - Analytics Manager - Example Corp 1 | LinkedIn', url: 'https://www.linkedin.com/in/lee-park', description: 'Example Corp 1.' }],
  alumni: [],
};

// The stubbed search API: it answers from PEOPLE and refuses any other host than the search endpoint.
async function fetchImpl(url) {
  const host = new URL(url).hostname;
  if (/linkedin\.com$/.test(host)) throw new Error('linkedin requested');
  const query = new URL(url).searchParams.get('q') || '';
  const kind = /recruiter/i.test(query) ? 'recruiter' : /manager/i.test(query) ? 'team' : 'alumni';
  return new Response(JSON.stringify({ web: { results: PEOPLE[kind] } }), { status: 200 });
}

export const FIRST_JOB = selectedMatches()[0];

export async function buildUiPages() {
  const root = await prepareReportProject();
  const config = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
  config.outreach = { connectionNoteLimit: 200 };
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(config));
  await fs.writeFile(path.join(root, 'private', 'search.json'), JSON.stringify({ brave: 'not-real' }));
  await writePayload(root, fixturePayload('2026-10-12', [fixtureJob(50, { roleType: 'internship' })]));
  const letterDirectory = path.join(root, 'private', 'cover-letters', '2026-10-17', 'ExampleCorp1');
  await fs.writeFile(path.join(letterDirectory, 'letter.md'), LETTER);
  const note = 'Hi {First Name}, I saw the Data Analyst 1 role at Example Corp 1 and would like to connect.';
  const follow = 'Hi {First Name},\n\nThank you for connecting. My resume is attached; would you have time for a brief call?';
  await fs.mkdir(path.join(root, 'private', 'outreach'), { recursive: true });
  await fs.writeFile(path.join(root, 'private', 'outreach', 'state.json'), JSON.stringify({ version: 1, jobs: { [jobIdOf(FIRST_JOB)]: { messages: { connectionNote: note, followUpMessage: follow, limit: 200 } } } }));
  const desktopFile = path.join(root, 'desktop.html');
  const meta = fixturePayload('2026-10-17', selectedMatches()).meta;
  await fs.writeFile(desktopFile, buildHtml(selectedMatches(), meta, { reviewed: selectedMatches() }));
  const hub = await startReportHub(root, { context: { fetchImpl, peopleTimeoutMs: 1500 } });
  const base = `http://127.0.0.1:${hub.port()}`;
  const pages = [
    { name: 'report', url: `${base}/reports/2026-10-17` },
    { name: 'letters', url: `${base}/letters` },
    { name: 'letter-edit', url: `${base}/letters/2026-10-17/ExampleCorp1/edit` },
    { name: 'resumes', url: `${base}/resumes` },
    { name: 'status', url: `${base}/status` },
    { name: 'settings-models', url: `${base}/settings?tab=models` },
    { name: 'settings-pipeline', url: `${base}/settings?tab=pipeline` },
    { name: 'settings-letters', url: `${base}/settings?tab=letters` },
    { name: 'letter-page', url: `${base}/letters/2026-10-17/ExampleCorp1` },
    { name: 'outreach-panel', url: `${base}/outreach/panel?date=2026-10-17&job=${encodeURIComponent(jobIdOf(FIRST_JOB))}`, fragment: true },
    { name: 'desktop', url: `file://${desktopFile}` },
  ];
  // The page's HTML as served (the Desktop page read from its file), with the port and the project path normalized.
  async function html(page) {
    const text = page.url.startsWith('file://') ? await fs.readFile(desktopFile, 'utf8') : (await hub.request(page.url.slice(base.length))).text;
    return normalizeHtml(text, { port: hub.port(), root });
  }
  async function close() {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
  return { root, hub, base, pages, html, close, firstJobId: jobIdOf(FIRST_JOB) };
}
