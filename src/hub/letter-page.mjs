// The page Open CoverLetter opens (2026-11-15): the letter and two buttons, nothing else (no hub navigation,
// no notes list, no engine or version lines). The letter is read from the saved letter.md, which is the very
// letter the PDF was rendered from (assembleLetter: name, contact, date, salutation, paragraphs, closing,
// signature), and laid out like the PDF (Times, centered header). Needs-review editor notes become a light
// underline on the sentence they point at (src/cover-letter/note-marks.mjs) with the note as the hover text;
// notes that point at no sentence share one line above the letter ("+N More" on hover); info notes are not
// shown. Copy puts the plain text (src/cover-letter/plain-text.mjs) on the clipboard, never the marks.
// Regenerate posts /letters/regenerate and swaps the letter in place; on failure the old letter stays and one
// plain-language line appears under the buttons.
import { classifyEditorNotes } from '../cover-letter/notes.mjs';
import { placeNotes, splitSentences } from '../cover-letter/note-marks.mjs';
import { LETTER_CLOSING, letterPlainText, salutationFor } from '../cover-letter/plain-text.mjs';
import { REPORT_TOKENS, REPORT_TOKENS_DARK, SQUIRCLE_STYLES } from '../report-theme.mjs';
import { htmlEscape } from '../utils.mjs';

// The parts of a saved letter.md (compose.mjs assembleLetter markdown), or null when it is not in that shape.
export function parseLetterMarkdown(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  if (!/^# /.test(lines[0] || '')) return null;
  const name = lines[0].slice(2).trim();
  const blocks = [];
  let current = [];
  for (const line of lines.slice(1)) {
    if (line.trim()) { current.push(line.trim()); continue; }
    if (current.length) { blocks.push(current); current = []; }
  }
  if (current.length) blocks.push(current);
  // [contact], [date], [salutation], paragraphs…, [closing, signature]; the contact line is there when the
  // salutation is the third block.
  const contact = /^Dear /.test(blocks[2]?.[0] || '') ? blocks.shift().join(' ') : '';
  const date = blocks.shift()?.[0] || '';
  const salutation = blocks.shift()?.[0] || '';
  let last = blocks.pop() || [];
  // Letters from before 2026-09-20 put a blank line between "Sincerely," and the signature.
  if (last[0] !== LETTER_CLOSING && blocks.at(-1)?.length === 1 && blocks.at(-1)[0] === LETTER_CLOSING) last = [blocks.pop()[0], ...last];
  if (!/^Dear /.test(salutation) || last[0] !== LETTER_CLOSING) return null;
  return { name, contact, date, salutation, paragraphs: blocks.map(block => block.join(' ')), closing: LETTER_CLOSING, signature: last.slice(1).join(' ') };
}

// "Dear PwC Recruiting Team," → "PwC" (the company the plain text's salutation is built from).
function companyOfSalutation(salutation, fallback) {
  const match = /^Dear (.+) Recruiting Team,$/.exec(String(salutation || ''));
  return match ? match[1] : fallback || '';
}

// The letter as the page shows it, from the saved record and letter.md (or, for a letter.md in another shape,
// the record's paragraphs with the current profile around them).
export function letterViewOf(existing, { profile = {}, assemble } = {}) {
  const record = existing?.record || {};
  const parsed = parseLetterMarkdown(existing?.markdown);
  const letter = parsed || assemble({ profile, company: record.company, paragraphs: record.paragraphs || [], now: new Date(record.createdAt || Date.now()), timeZone: record.timeZone || 'America/Chicago' });
  const company = companyOfSalutation(letter.salutation, record.company);
  const notes = record.reviewClearedAt ? [] : classifyEditorNotes(record.editorNotes || []).needsReview;
  return { ...letter, company, notes, pdfFileName: record.pdfFileName || null };
}

function paragraphHtml(paragraph, index, marks) {
  return `<p>${splitSentences(paragraph).map((sentence, s) => {
    const notes = marks.get(`${index}:${s}`);
    return notes ? `<span class="flag" title="${htmlEscape(notes.join('\n'))}">${htmlEscape(sentence)}</span>` : htmlEscape(sentence);
  }).join(' ')}</p>`;
}

// One line of the notes no sentence carries: the first in full width, the rest behind "+N More".
function unplacedLine(unplaced) {
  if (!unplaced.length) return '';
  const more = unplaced.length > 1 ? ` <span class="more">+${unplaced.length - 1} More</span>` : '';
  return `<p class="flags-top" id="letter-flags" title="${htmlEscape(unplaced.join('\n'))}"><span class="first">${htmlEscape(unplaced[0])}</span>${more}<span class="rest">${unplaced.slice(1).map(note => `<span>${htmlEscape(note)}</span>`).join('')}</span></p>`;
}

// The sheet: header, date, salutation, body with underlines, closing and signature (the PDF's order).
export function letterSheet(view) {
  const { marks, unplaced } = placeNotes(view.paragraphs, view.notes);
  const copy = { name: view.name, contact: view.contact, date: view.date, company: view.company, paragraphs: view.paragraphs, signature: view.signature };
  return `${unplacedLine(unplaced)}<article class="sheet" id="letter" data-letter="${htmlEscape(JSON.stringify(copy))}">
<header><p class="name">${htmlEscape(view.name)}</p>${view.contact ? `<p class="contact">${htmlEscape(view.contact)}</p>` : ''}</header>
<p class="date">${htmlEscape(view.date)}</p>
<p class="salutation">${htmlEscape(view.salutation)}</p>
${view.paragraphs.map((paragraph, index) => paragraphHtml(paragraph, index, marks)).join('\n')}
<p class="closing">${htmlEscape(view.closing)}</p>
<p class="signature">${htmlEscape(view.signature)}</p>
</article>`;
}

export const LETTER_PAGE_STYLES = `
:root{${REPORT_TOKENS}}
@media (prefers-color-scheme:dark){:root{${REPORT_TOKENS_DARK}}}
${SQUIRCLE_STYLES}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--bg);color:var(--ink);font-family:var(--font);font-size:var(--fs-body);line-height:var(--lh)}
main{max-width:8.5in;margin:0 auto;padding:var(--space-5) var(--space-4) var(--space-6)}
.top{display:flex;flex-direction:column;align-items:flex-end;gap:var(--space-1);margin:0 0 var(--space-3)}
.buttons{display:flex;gap:var(--space-2)}
.btn{display:inline-flex;align-items:center;justify-content:center;height:var(--control-height);padding:0 var(--space-4);border-radius:var(--r-sm);border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink);font:inherit;font-weight:600;cursor:pointer;min-width:96px}
.btn.secondary{background:var(--surface);color:var(--accent)}
.btn:disabled{opacity:.6;cursor:default}
.error{margin:0;color:var(--bad-ink);font-size:var(--fs-meta);text-align:right;max-width:60ch}
.flags-top{margin:0 0 var(--space-2);font-size:var(--fs-meta);color:var(--warn-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:default}
.flags-top .first{overflow:hidden;text-overflow:ellipsis}
.flags-top .more{font-weight:600}
.flags-top .rest{display:none}
.flags-top:hover{white-space:normal}
.flags-top:hover .more{display:none}
.flags-top:hover .rest{display:block}
.flags-top:hover .rest span{display:block}
.sheet{background:#fff;color:#000;box-shadow:var(--shadow-pop);border:1px solid var(--line);border-radius:var(--r-xl);padding:1in;font-family:"Times New Roman",Times,serif;font-size:11pt;line-height:1.15}
.sheet p{margin:0 0 7pt}
.sheet header{text-align:center;margin-bottom:8pt}
.sheet header p{text-align:center;margin:0}
.sheet .name{font-size:16pt;font-weight:bold;margin:0 0 3pt}
.sheet .closing{margin-top:4pt;margin-bottom:0}
.sheet .signature{margin:0}
.flag{text-decoration:underline;text-decoration-color:rgba(214,140,0,.55);text-decoration-thickness:2px;text-underline-offset:3px;cursor:help}
@media (max-width:760px){main{padding:var(--space-3) var(--space-4)}.sheet{padding:var(--space-5)}}
@media print{.top,.flags-top{display:none}body{background:#fff}.sheet{box-shadow:none;border:0;border-radius:0;padding:0}.flag{text-decoration:none}}
`;

export const LETTER_PAGE_SCRIPT = `
var LETTER_CLOSING = ${JSON.stringify(LETTER_CLOSING)};
${salutationFor.toString()}
${letterPlainText.toString()}
(function () {
  var copyButton = document.getElementById('copy-letter');
  var regenerate = document.getElementById('regenerate-letter');
  var error = document.getElementById('letter-error');
  var holder = document.getElementById('letter-holder');
  function parts() { try { return JSON.parse(document.getElementById('letter').getAttribute('data-letter') || '{}'); } catch (e) { return {}; } }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var area = document.createElement('textarea'); area.value = text; area.setAttribute('readonly', '');
      area.style.position = 'fixed'; area.style.opacity = '0'; document.body.appendChild(area); area.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(area);
      if (ok) resolve(); else reject(new Error('copy refused'));
    });
  }
  function fail(text) { error.textContent = text; error.hidden = false; }
  copyButton.addEventListener('click', function () {
    error.hidden = true;
    copyText(letterPlainText(parts(), 'top')).then(function () {
      copyButton.textContent = 'Copied';
      setTimeout(function () { copyButton.textContent = 'Copy'; }, 1500);
    }).catch(function () { fail('Could not copy; select the letter and copy it by hand.'); });
  });
  regenerate.addEventListener('click', function () {
    error.hidden = true;
    regenerate.disabled = true; regenerate.textContent = 'Regenerating…';
    var body = new URLSearchParams({ date: regenerate.getAttribute('data-date'), slug: regenerate.getAttribute('data-slug') }).toString();
    fetch('/letters/regenerate', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body })
      .then(function (r) { return r.json().then(function (data) { if (!r.ok) throw new Error(data.error || 'Regenerate failed; details in the hub log'); return data; }); })
      .then(function (data) {
        holder.innerHTML = data.sheet;
        regenerate.setAttribute('data-slug', data.slug);
        if (data.openUrl && window.history && window.history.replaceState) window.history.replaceState(null, '', data.openUrl);
      })
      .catch(function (e) { fail(e && e.message ? e.message : 'Regenerate failed; details in the hub log'); })
      .then(function () { regenerate.disabled = false; regenerate.textContent = 'Regenerate'; });
  });
})();
`;

// The whole document: its own minimal page, not the hub layout.
export function letterDocument({ date, slug, view }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(`CoverLetter · ${view.company || view.name}`)}</title>
<style>${LETTER_PAGE_STYLES}</style></head><body><main>
<div class="top"><div class="buttons"><button class="btn secondary" id="copy-letter" type="button">Copy</button><button class="btn" id="regenerate-letter" type="button" data-date="${htmlEscape(date)}" data-slug="${htmlEscape(slug)}">Regenerate</button></div><p class="error" id="letter-error" role="status" hidden></p></div>
<div id="letter-holder">${letterSheet(view)}</div>
</main><script>${LETTER_PAGE_SCRIPT}</script></body></html>`;
}
