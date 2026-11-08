// The cover letter as plain text, for pasting into an application form's text box (the letter page's
// "Copy Full Letter" and "Copy From Salutation"). The same parts as the PDF (compose.mjs assembleLetter): name,
// contact line, date, salutation, the body paragraphs, "Sincerely," and the signature. Blocks are separated by
// one blank line; the name and contact line, and "Sincerely," and the signature, stay on consecutive lines as in
// the letter. The functions are written to run unchanged in the page too (their source is put in the page
// script), so the copied text and the tests use one implementation.

export const LETTER_CLOSING = 'Sincerely,';

// "Dear PwC Recruiting Team,"
export function salutationFor(company) {
  return 'Dear ' + (String(company || '').trim() || 'Hiring') + ' Recruiting Team,';
}

// parts { name, contact, date, company, paragraphs, signature }; from 'top' (the whole letter) or 'salutation'.
export function letterPlainText(parts, from) {
  var clean = function (value) { return String(value == null ? '' : value).replace(/\s+/g, ' ').trim(); };
  var body = (parts.paragraphs || []).map(clean).filter(Boolean);
  var blocks = [];
  if (from !== 'salutation') {
    var head = [clean(parts.name), clean(parts.contact)].filter(Boolean).join('\n');
    if (head) blocks.push(head);
    if (clean(parts.date)) blocks.push(clean(parts.date));
  }
  blocks.push(salutationFor(parts.company));
  blocks = blocks.concat(body);
  blocks.push([LETTER_CLOSING, clean(parts.signature)].filter(Boolean).join('\n'));
  return blocks.join('\n\n');
}
