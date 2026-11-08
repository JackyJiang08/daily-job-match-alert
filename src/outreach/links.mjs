// Search links for finding a recruiter: built here, opened by the owner in a new browser tab. Nothing in this
// project requests, fetches, or signs in to linkedin.com; these are plain URLs (no key needed).
export const LINKEDIN_PEOPLE_SEARCH = 'https://www.linkedin.com/search/results/people/';
export const GOOGLE_SEARCH = 'https://www.google.com/search';
export const RECRUITER_TERMS = '(recruiter OR "talent acquisition" OR "university recruiting" OR "campus recruiting")';
export const PROFILE_TERMS = '(recruiter OR "talent acquisition")';

// A company name as a search term: quoted when it has more than one word ("Dow Jones"), as typed otherwise.
export function companyTerm(company) {
  const name = String(company || '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
  return /\s/.test(name) ? `"${name}"` : name;
}

// The direction a role belongs to, as one search word for the variant link: "data", "product", "consulting",
// or "technology".
export function roleDirection(job) {
  const title = String(job?.title || '').toLowerCase();
  const family = String(job?.roleFamily || '').toLowerCase();
  if (/product/.test(family) || /\bproduct\b/.test(title)) return 'product';
  if (/consult/.test(family) || /\bconsult/.test(title)) return 'consulting';
  if (/^data$/.test(family) || /\b(?:data|analytics?|analyst|business intelligence|bi|statistic|quantitative)\b/.test(title)) return 'data';
  return 'technology';
}

export function linkedInPeopleSearchUrl(keywords) {
  return `${LINKEDIN_PEOPLE_SEARCH}?keywords=${encodeURIComponent(keywords)}`;
}

export function googleSearchUrl(query) {
  return `${GOOGLE_SEARCH}?q=${encodeURIComponent(query)}`;
}

// The three links of the Reach Out panel, in order.
export function outreachLinks({ company, job }) {
  const term = companyTerm(company);
  const direction = roleDirection(job);
  return [
    { key: 'linkedin', label: 'LinkedIn: Recruiters', url: linkedInPeopleSearchUrl(`${term} ${RECRUITER_TERMS}`) },
    { key: 'linkedin-direction', label: `LinkedIn: ${direction.charAt(0).toUpperCase()}${direction.slice(1)} Recruiters`, url: linkedInPeopleSearchUrl(`${term} ${RECRUITER_TERMS} ${direction}`) },
    { key: 'google', label: 'Google: LinkedIn Profiles', url: googleSearchUrl(`site:linkedin.com/in ${/^"/.test(term) ? term : `"${term}"`} ${PROFILE_TERMS}`) },
  ];
}

// True for linkedin.com and its subdomains. Every request this project makes for outreach goes through
// assertNotLinkedIn first.
export function isLinkedInUrl(raw) {
  try {
    return /(?:^|\.)linkedin\.com$/i.test(new URL(String(raw)).hostname);
  } catch {
    return false;
  }
}

export function assertNotLinkedIn(raw) {
  if (isLinkedInUrl(raw)) throw new Error('Refused: this project never requests linkedin.com');
  return raw;
}
