// Recruiter contacts the posting itself names (the most reliable lead): "Recruiter: Jane Doe",
// "contact Jane Doe at jane.doe@example.com", "Jane Doe, University Recruiter", or a recruiting e-mail
// address. Read from the job's plain-text description only; nothing is fetched. Each lead says where it came
// from (source 'JD') and carries the sentence it was found in so the owner can check it.

const NAME = "[A-Z][a-z]+(?:[-'’][A-Z]?[a-z]+)?(?:\\s[A-Z]\\.)?(?:\\s[A-Z][a-z]+(?:[-'’][A-Z]?[a-z]+)?){1,2}";
const EMAIL = '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}';
const ROLE = '(?:(?:Senior|Sr\\.|Lead|Principal|Technical|Tech|University|Campus|Early Career|Executive|Corporate)\\s)*(?:Recruiter|Recruiting (?:Partner|Lead|Manager|Coordinator|Specialist)|Talent Acquisition(?: (?:Partner|Specialist|Manager|Lead|Coordinator|Advisor))?|Talent Partner|Sourcer|Hiring Manager)';
// Words that make a "name" a department or a phrase instead of a person.
const NOT_A_PERSON = /\b(?:Human|Resources|Team|Department|Recruiting|Talent|Acquisition|Office|Services|Center|Support|Hiring|Manager|Our|Us|The|Please|Equal|Opportunity|Employer|Benefits|Careers?|Company|Inc|LLC|United|States|Remote|Data|Analyst|Engineer)\b/;
// Addresses for accommodations, privacy, fraud and the like are not a recruiter to reach out to.
const NOT_A_RECRUITER_EMAIL = /^(?:.*(?:accommodat|disabilit|privacy|eeo|\bada\b|noreply|no-reply|donotreply|benefits|payroll|legal|fraud|security|support|help|compliance|ethics|webmaster|info|media|press|investor))/i;

const LABELED = new RegExp(`\\b(${ROLE}|Recruiting Contact|Point of Contact|Contact)\\s*[:–-]\\s*(${NAME})(?:\\s*\\(?(${EMAIL})\\)?)?`, 'g');
const CONTACT_AT = new RegExp(`\\b(?:[Cc]ontact|[Rr]each out to|[Ee]mail|[Qq]uestions\\?? (?:to|for)|[Ss]end (?:your )?(?:resume|questions) to)\\s+(${NAME})(?:,\\s*(?:our\\s+|the\\s+)?(${ROLE}),?)?\\s+(?:at|via|:)\\s+(${EMAIL})`, 'g');
const NAME_ROLE = new RegExp(`\\b(${NAME}),?\\s+(?:\\(|,\\s*|our\\s+|the\\s+)?(${ROLE})\\b`, 'g');
const EMAILS = new RegExp(EMAIL, 'g');

function excerpt(text, index, length) {
  const start = Math.max(0, text.lastIndexOf('.', index) + 1, index - 80);
  const stop = Math.min(text.length, index + length + 80);
  return `${start > 0 ? '…' : ''}${text.slice(start, stop).trim()}${stop < text.length ? '…' : ''}`;
}

// A capitalized word before the name ("Contact Alex Morgan", "Meet Priya Shah") is not part of it.
const LEADING_WORD = /^(?:Contact|Email|E-mail|Reach|Meet|Ask|Call|Message|Questions?|Please|Recruiter|Recruiting|Hello|Hi|Dear|Led|By)\s+/;

function personName(value) {
  let name = String(value || '').trim();
  while (LEADING_WORD.test(name)) name = name.replace(LEADING_WORD, '');
  return name && /\s/.test(name) && !NOT_A_PERSON.test(name) ? name : null;
}

function recruiterEmail(value) {
  const email = String(value || '').trim().replace(/[.,;:]+$/, '');
  return email && !NOT_A_RECRUITER_EMAIL.test(email.split('@')[0]) ? email : null;
}

// [{ name, title, email, source: 'JD', excerpt }], at most `limit`, one per person or address.
export function extractJdContacts(description, { limit = 5 } = {}) {
  const text = String(description || '').replace(/\s+/g, ' ');
  const found = [];
  const add = (lead, index, length) => {
    const name = personName(lead.name);
    const email = recruiterEmail(lead.email);
    if (!name && !email) return;
    const same = found.find(item => (name && item.name === name) || (email && item.email === email));
    if (same) {
      same.name ||= name;
      same.email ||= email;
      same.title ||= lead.title || null;
      return;
    }
    found.push({ name, title: lead.title || null, email, source: 'JD', excerpt: excerpt(text, index, length) });
  };
  for (const match of text.matchAll(LABELED)) {
    const label = match[1];
    add({ name: match[2], title: /^(?:Contact|Point of Contact|Recruiting Contact)$/.test(label) ? null : label, email: match[3] }, match.index, match[0].length);
  }
  for (const match of text.matchAll(CONTACT_AT)) add({ name: match[1], title: match[2], email: match[3] }, match.index, match[0].length);
  for (const match of text.matchAll(NAME_ROLE)) add({ name: match[1], title: match[2] }, match.index, match[0].length);
  // An address alone, when it reads as a recruiting mailbox or a person's address beside recruiting words.
  for (const match of text.matchAll(EMAILS)) {
    const around = text.slice(Math.max(0, match.index - 120), match.index + match[0].length + 40);
    if (/recruit|talent|hiring|questions about (?:this|the) (?:role|position)|apply/i.test(around)) add({ email: match[0] }, match.index, match[0].length);
  }
  return found.slice(0, limit);
}
