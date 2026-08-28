import { canonicalUrl, cleanText } from '../utils.mjs';
import { createWarning } from '../warnings.mjs';

function firstHref(html) {
  const matches = [...String(html).matchAll(/href=["']([^"']+)["']/gi)].map(match => match[1]);
  return matches.find(url => !/simplify\.jobs\/p\//i.test(url)) || matches[0] || '';
}

function parseAgeDays(value) {
  const text = cleanText(value).toLowerCase();
  const amount = Number.parseInt(text.match(/\d+/)?.[0] ?? '', 10);
  if (!Number.isFinite(amount)) return null;
  if (/mo|months?/.test(text)) return amount * 30;
  if (/w|weeks?/.test(text)) return amount * 7;
  if (/h|hours?/.test(text)) return amount / 24;
  return amount;
}

function parseRows(markdown, source, defaultRoleType) {
  const jobs = [];
  let currentCompany = '';
  const rows = String(markdown).match(/<tr>[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(match => match[1]);
    if (cells.length < 5) continue;
    const companyCell = cleanText(cells[0]);
    if (companyCell && companyCell !== '↳') currentCompany = companyCell.replace(/[🔥🛂🇺🇸🎓🔒]/gu, '').trim();
    const company = companyCell === '↳' ? currentCompany : currentCompany;
    const title = cleanText(cells[1]).replace(/[🔥🛂🇺🇸🎓🔒]/gu, '').trim();
    const location = cleanText(cells[2]);
    const url = canonicalUrl(firstHref(cells[3]));
    const ageText = cleanText(cells[4]);
    const ageDays = parseAgeDays(ageText);
    if (!company || !title || !url || ageDays == null) continue;
    jobs.push({
      source,
      sourceKind: 'public_github_list',
      company,
      title,
      location,
      url,
      roleType: defaultRoleType,
      sourceAgeDays: ageDays,
      freshnessBasis: 'source_age_days_approximate',
      description: '',
    });
  }
  return jobs;
}

export async function collectSimplifyList({ url, source, roleType, fetchImpl = fetch, warnings = null }) {
  const response = await fetchImpl(url, { headers: { accept: 'text/plain' } });
  if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`);
  const jobs = parseRows(await response.text(), source, roleType);
  // These lists always carry rows; an empty parse after a successful fetch means the README layout changed
  // and the parser is silently missing every posting.
  if (!jobs.length && Array.isArray(warnings)) {
    warnings.push(createWarning('collector', source, `HTTP ${response.status} but no job rows were parsed; the upstream README format may have changed, check the source and the parser`));
  }
  return jobs;
}

export { parseRows as parseSimplifyRows };
export { parseAgeDays };
