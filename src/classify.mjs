const INTERN = /\b(intern(ship)?|co[- ]?op|summer analyst)\b/i;
// Plurals count too ("new grads", "new graduates", "recent graduates").
const NEW_GRAD = /\b(new grad(uate)?s?|graduate program|university grad(uate)?s?|campus hire|early career|recent graduates?)\b/i;
const ENTRY = /\b(entry[- ]level|junior|associate|engineer i\b|scientist i\b|analyst i\b|level 1|0\s*[-–]\s*3 years?)\b/i;

export function classifyRole(job) {
  if (job.roleType) return job.roleType;
  const text = `${job.title} ${job.description}`;
  if (INTERN.test(text)) return 'internship';
  if (NEW_GRAD.test(text)) return 'new_grad';
  if (ENTRY.test(text)) return 'entry_level';
  return 'unknown';
}

export function minimumYears(text) {
  const candidates = [];
  for (const match of String(text).matchAll(/(?:minimum(?: of)?|at least|requires?|with)?\s*(\d+)\s*(?:\+|plus)?\s*(?:-|–|to)?\s*\d*\s*years?(?: of)? (?:professional |relevant )?experience/gi)) {
    candidates.push(Number(match[1]));
  }
  return candidates.length ? Math.max(...candidates) : null;
}
