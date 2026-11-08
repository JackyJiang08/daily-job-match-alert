// Job Description markup (2026-11-08). The collectors keep the posting's own HTML beside the plain text the
// scorer reads (job.descriptionHtml: Greenhouse content, Lever description + lists, Ashby descriptionHtml,
// Workday jobDescription, SmartRecruiters sections, JSON-LD description), cleaned by a whitelist:
//   - kept: p, br, ul, ol, li, strong, b, em, i, h1–h4, and a (http, https, or mailto href only, opened in a
//     new tab with rel="noopener noreferrer");
//   - dropped with their content: script, style, iframe, and the other embedding elements;
//   - every other tag is dropped and its text kept (a block such as div or tr ends the line);
//   - no attribute survives except a link's href: inline styles and event handlers are gone;
//   - entities are decoded and the text escaped again, so the result is safe to set as innerHTML.
// The report shows that markup in the folded Job Description; a source with only plain text (and every older
// report) is split into paragraphs at its own line breaks.
import { decodeEntities, htmlEscape } from './utils.mjs';

const KEPT = new Set(['p', 'br', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'h1', 'h2', 'h3', 'h4', 'a']);
const DROPPED_WITH_CONTENT = ['script', 'style', 'iframe', 'noscript', 'template', 'object', 'embed', 'svg', 'math', 'head', 'title', 'select', 'textarea', 'button', 'form'];
// Unknown block elements end a line so their texts do not run together.
const BLOCK_BREAK = new Set(['div', 'section', 'article', 'header', 'footer', 'aside', 'main', 'nav', 'blockquote', 'table', 'tr', 'h5', 'h6', 'dl', 'dt', 'dd', 'pre', 'hr', 'figure', 'address', 'center']);
const BLOCKS = new Set(['p', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4']);
const INLINE = new Set(['strong', 'b', 'em', 'i', 'a']);
// A JD rarely needs more; a page that does is cut, never broken (open tags are closed).
const MAXIMUM_HTML_CHARACTERS = 200_000;

// Greenhouse sends its content entity-escaped ("&lt;p&gt;…"); markup that arrives that way is decoded once.
function unescapeWrapped(raw) {
  const text = String(raw || '');
  if (/<[a-z!/]/i.test(text) || !/&lt;\/?[a-z]/i.test(text)) return text;
  return decodeEntities(text);
}

function safeHref(raw) {
  const value = decodeEntities(String(raw || '')).replace(/[\u0000- \u007f]/g, '');
  return /^(?:https?:\/\/|mailto:)/i.test(value) ? value : null;
}

function hrefOf(attributes) {
  const match = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attributes || '');
  return match ? safeHref(match[1] ?? match[2] ?? match[3]) : null;
}

// Whitelist-cleaned HTML for one posting, or '' when nothing readable is left.
export function sanitizeJobHtml(raw) {
  let html = unescapeWrapped(raw).slice(0, MAXIMUM_HTML_CHARACTERS);
  html = html.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ').replace(/<![^>]*>/g, ' ').replace(/<\?[\s\S]*?\?>/g, ' ');
  for (const name of DROPPED_WITH_CONTENT) html = html.replace(new RegExp(`<${name}\\b[\\s\\S]*?(?:<\\/${name}\\s*>|$)`, 'gi'), ' ');

  const out = [];
  const stack = [];
  const open = name => stack.includes(name);
  const close = name => { // closes `name` and anything opened inside it
    const index = stack.lastIndexOf(name);
    if (index < 0) return;
    while (stack.length > index) out.push(`</${stack.pop()}>`);
  };
  const closeInline = () => { while (stack.length && INLINE.has(stack[stack.length - 1])) out.push(`</${stack.pop()}>`); };
  const lineBreak = () => { if (out.length && out[out.length - 1] !== '<br>') out.push('<br>'); };

  const pattern = /<(\/?)([a-z][a-z0-9]*)\b([^>]*)>|([^<]+)|(<)/gi;
  for (const match of html.matchAll(pattern)) {
    const [, slash, rawName, attributes, text, stray] = match;
    if (text != null || stray != null) {
      const value = htmlEscape(decodeEntities(text ?? stray).replace(/[\s ]+/g, ' '));
      if (value.trim() || (out.length && !/^<(?:\/?(?:p|ul|ol|li|h[1-4])|br)>$/.test(out[out.length - 1]))) out.push(value);
      continue;
    }
    const name = rawName.toLowerCase();
    const closing = slash === '/';
    if (!KEPT.has(name)) {
      if (BLOCK_BREAK.has(name)) lineBreak();
      else if ((name === 'td' || name === 'th') && !closing) out.push(' ');
      continue;
    }
    if (name === 'br') { out.push('<br>'); continue; }
    if (closing) { close(name); continue; }
    if (BLOCKS.has(name)) {
      closeInline();
      // A block inside a paragraph or a heading ends it; a new item ends the previous one in the same list.
      if (stack.length && (stack[stack.length - 1] === 'p' || /^h[1-4]$/.test(stack[stack.length - 1]))) out.push(`</${stack.pop()}>`);
      if (name === 'li') {
        const list = Math.max(stack.lastIndexOf('ul'), stack.lastIndexOf('ol'));
        const item = stack.lastIndexOf('li');
        if (item > list) close('li');
        if (list < 0) { out.push('<ul>'); stack.push('ul'); }
      }
      out.push(`<${name}>`);
      stack.push(name);
      continue;
    }
    if (name === 'a') {
      const href = hrefOf(attributes);
      if (!href) continue; // a link without a safe target keeps only its text
      if (open('a')) close('a');
      out.push(`<a href="${htmlEscape(href)}" target="_blank" rel="noopener noreferrer">`);
      stack.push('a');
      continue;
    }
    out.push(`<${name}>`);
    stack.push(name);
  }
  while (stack.length) out.push(`</${stack.pop()}>`);

  let result = out.join('');
  // Empty elements and runs of line breaks left by the dropped tags.
  for (let pass = 0; pass < 4; pass += 1) {
    result = result
      .replace(/<(p|li|strong|b|em|i|h[1-4])>(?:\s|<br>)*<\/\1>/g, '')
      .replace(/<(ul|ol)>\s*<\/\1>/g, '')
      .replace(/<a [^>]*>\s*<\/a>/g, '');
  }
  result = result
    .replace(/(?:<br>\s*){3,}/g, '<br><br>')
    .replace(/(?:<br>\s*)+(<(?:p|ul|ol|h[1-4])>)/g, '$1')
    .replace(/(<(?:p|li|h[1-4]|ul|ol)>)\s*(?:<br>\s*)+/g, '$1')
    .replace(/(?:\s*<br>)+\s*(<\/(?:p|li|h[1-4])>)/g, '$1')
    .replace(/(<\/(?:p|ul|ol|h[1-4])>)\s*(?:<br>\s*)+/g, '$1')
    .replace(/^(?:\s*<br>)+|(?:<br>\s*)+$/g, '')
    .trim();
  return /[^\s]/.test(result.replace(/<[^>]+>/g, '')) ? result : '';
}

// The cleaned markup as a job field: absent (undefined, so it is not stored) when nothing readable is left.
export function cleanDescriptionHtml(raw) {
  return sanitizeJobHtml(raw) || undefined;
}

// Plain text as paragraphs: a blank line separates paragraphs, a single line break stays a line break.
export function textToParagraphs(text) {
  const blocks = String(text || '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(block => block.trim()).filter(Boolean);
  return blocks.map(block => `<p>${block.split('\n').map(line => htmlEscape(line.trim())).filter(Boolean).join('<br>')}</p>`).join('');
}

// The markup the folded Job Description shows: the cleaned posting HTML when the source gave one, otherwise the
// plain text by its own line breaks. Cleaned again here, so an edited or older payload cannot carry markup in.
export function jobDescriptionHtml(job) {
  const html = job?.descriptionHtml ? sanitizeJobHtml(job.descriptionHtml) : '';
  return html || textToParagraphs(job?.description || '');
}
