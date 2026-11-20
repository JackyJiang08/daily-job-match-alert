// Facts about the owner that the letter rules and the prefilter state (2026-11-19). Each one is a config key
// whose default is exactly what the code did before it was configurable, so a config.json without these keys
// behaves as before:
//   preferences.homeState       US state code or name of the owner's home; a posting there adds "you are in
//                               state" to paragraph 1. Default "IL". "" (or null) turns the sentence off.
//   preferences.degree          the degree being completed, as the internship timeline names it.
//                               Default "bachelor's degree".
//   preferences.plannedProgram  the further study the internship timeline mentions when the rules allow it.
//                               Default "a master's program"; "" means none is planned.
//   preferences.cohortYear      the graduating class the early-career JD signal looks for ("Class of 2027").
//                               Default 2027.
export const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  PR: 'Puerto Rico', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
  UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

export const DEFAULT_HOME_STATE = 'IL';
export const DEFAULT_DEGREE = "bachelor's degree";
export const DEFAULT_PLANNED_PROGRAM = "a master's program";
export const DEFAULT_COHORT_YEAR = 2027;

// "IL", "il", "Illinois" → { code: 'IL', name: 'Illinois', pattern: /\bIL\b|\bIllinois\b/i }; null when the key is
// set to "" or null, or names no US state.
export function homeStateOf(preferences = {}) {
  const raw = preferences && Object.prototype.hasOwnProperty.call(preferences, 'homeState') ? preferences.homeState : DEFAULT_HOME_STATE;
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const code = US_STATES[value.toUpperCase()] ? value.toUpperCase() : Object.keys(US_STATES).find(key => US_STATES[key].toLowerCase() === value.toLowerCase());
  if (!code) return null;
  const name = US_STATES[code];
  return { code, name, pattern: new RegExp(`\\b${code}\\b|\\b${name.replace(/ /g, '\\s+')}\\b`, 'i') };
}

function textOr(preferences, key, fallback) {
  if (!preferences || !Object.prototype.hasOwnProperty.call(preferences, key)) return fallback;
  return String(preferences[key] ?? '').trim();
}

// What the letter rules say about the owner: { home, degree, plannedProgram }.
export function letterProfile(preferences = {}) {
  return {
    home: homeStateOf(preferences),
    degree: textOr(preferences, 'degree', DEFAULT_DEGREE) || DEFAULT_DEGREE,
    plannedProgram: textOr(preferences, 'plannedProgram', DEFAULT_PLANNED_PROGRAM),
  };
}

export function cohortYearOf(preferences = {}) {
  const year = Number(preferences?.cohortYear);
  return Number.isInteger(year) && year > 1900 ? year : DEFAULT_COHORT_YEAR;
}

// Whether the posting's location is in the owner's home state.
export function inHomeState(job, graduation) {
  const home = graduation?.profile ? graduation.profile.home : homeStateOf();
  return Boolean(home && home.pattern.test(String(job?.location || '')));
}
