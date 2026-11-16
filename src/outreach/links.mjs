// Search links and the LinkedIn guard. A link is built here and opened by the owner in a new browser tab;
// nothing in this project requests, fetches, or signs in to linkedin.com.
export const GOOGLE_SEARCH = 'https://www.google.com/search';

export function googleSearchUrl(query) {
  return `${GOOGLE_SEARCH}?q=${encodeURIComponent(query)}`;
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
