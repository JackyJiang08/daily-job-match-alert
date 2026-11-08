// The Reach Out panel: a drawer on the right of the Reports page, filled from GET /outreach/panel. In order:
// contacts the JD names, the search links (new tabs), search candidates (only when switched on and a key is
// set), the first-name box, the invitation note (live character count, Copy), the follow-up message (Copy),
// the recommended resume, and Mark as Contacted. Nothing here requests linkedin.com; the links are opened by
// the owner. The script also drives the cards' Mark as Applied buttons.
import { htmlEscape } from '../utils.mjs';
import { CANDIDATES_NOTE } from '../outreach/candidates.mjs';
import { FIRST_NAME_PLACEHOLDER } from '../outreach/messages.mjs';

const EXTERNAL = 'target="_blank" rel="noopener noreferrer"';

function contactsSection(contacts) {
  if (!contacts.length) return '';
  const items = contacts.map(contact => {
    const parts = [contact.name ? `<strong>${htmlEscape(contact.name)}</strong>` : '', contact.title ? htmlEscape(contact.title) : '', contact.email ? `<a href="mailto:${htmlEscape(contact.email)}">${htmlEscape(contact.email)}</a>` : ''].filter(Boolean);
    return `<li data-contact>${parts.join(' · ')} <span class="badge" data-badge="source-jd">From the JD</span><br><span class="muted">${htmlEscape(contact.excerpt)}</span></li>`;
  }).join('');
  return `<section class="reach-section" id="reach-contacts"><h3>Contacts in the JD</h3><ul class="plain-list">${items}</ul></section>`;
}

function candidatesSection(candidates) {
  if (!candidates.available && !candidates.results?.length) return '';
  const list = candidates.results?.length
    ? `<ul class="plain-list">${candidates.results.map(item => `<li data-candidate><a href="${htmlEscape(item.url)}" ${EXTERNAL}>${htmlEscape(item.name)}</a>${item.headline ? `<br><span class="muted">${htmlEscape(item.headline)}</span>` : ''}</li>`).join('')}</ul>`
    : candidates.searched
      ? `<p class="muted">${htmlEscape(candidates.reason || 'No LinkedIn profiles in the search results.')}</p>`
      : `<button class="btn secondary small" type="button" data-reach-candidates>Search Candidates</button> <span class="muted">One search for this posting (${htmlEscape(candidates.provider || 'search')})</span>`;
  return `<section class="reach-section" id="reach-candidates"><h3>Search Candidates</h3><p class="reach-warning">${CANDIDATES_NOTE}</p>${list}</section>`;
}

function messageBlock({ id, title, text, limit = null }) {
  const counter = limit ? ` <span class="reach-count" data-reach-count data-limit="${limit}"></span>` : '';
  return `<section class="reach-section" id="${id}"><h3>${title}${counter}</h3><p class="reach-text" data-reach-text data-template="${htmlEscape(text)}">${htmlEscape(text)}</p><button class="btn secondary small" type="button" data-reach-copy="${id}">Copy</button></section>`;
}

// view: { date, jobId, job, company, contacts, links, candidates, entry, limit, resume, contacted }
export function outreachPanel(view) {
  const { date, jobId, job, company, contacts, links, candidates, entry, limit, resume, contacted } = view;
  const messages = entry?.messages?.connectionNote || entry?.messages?.followUpMessage ? entry.messages : null;
  const linkButtons = links.map(link => `<a class="btn secondary small" data-reach-link="${htmlEscape(link.key)}" href="${htmlEscape(link.url)}" ${EXTERNAL}>${htmlEscape(link.label)}</a>`).join('');
  const texts = messages
    ? `${messageBlock({ id: 'reach-note', title: 'Connection Note', text: messages.connectionNote, limit })}${messageBlock({ id: 'reach-follow-up', title: 'Follow-Up Message', text: messages.followUpMessage })}`
    : `<section class="reach-section" id="reach-messages-empty"><h3>Messages</h3><p class="muted">No messages yet: they are written with the cover letter, or here on their own.</p><button class="btn small" type="button" data-reach-generate>Generate Messages</button></section>`;
  const resumeLink = resume?.available
    ? `<a class="btn secondary small" id="reach-resume" href="/outreach/resume?date=${htmlEscape(date)}&amp;job=${htmlEscape(jobId)}" download="${htmlEscape(resume.fileName)}">Download ${htmlEscape(resume.label)} Resume</a> <span class="muted">${htmlEscape(resume.fileName)}</span>`
    : `<span class="muted">${htmlEscape(resume?.reason || 'No resume PDF configured for this track')}</span>`;
  return `<div class="reach-panel" id="reach-panel" data-date="${htmlEscape(date)}" data-job="${htmlEscape(jobId)}" data-placeholder="${htmlEscape(FIRST_NAME_PLACEHOLDER)}">
  <div class="reach-head"><h2>Reach Out</h2><button class="btn secondary small" type="button" data-reach-close aria-label="Close">Close</button></div>
  <p class="reach-role"><strong>${htmlEscape(job.title || '')}</strong><br><span class="muted">${htmlEscape(company)}</span></p>
  ${contactsSection(contacts)}
  <section class="reach-section" id="reach-search"><h3>Find a Recruiter</h3><div class="reach-links">${linkButtons}</div><p class="muted">Opens in a new tab; the hub itself never visits LinkedIn.</p></section>
  ${candidatesSection(candidates)}
  <section class="reach-section"><label class="field"><span>First Name</span><input type="text" class="control-input" id="reach-first-name" value="${htmlEscape(entry?.firstName || '')}" autocomplete="off" placeholder="Recruiter's first name"></label></section>
  ${texts}
  <section class="reach-section" id="reach-resume-section"><h3>Resume</h3>${resumeLink}</section>
  <section class="reach-section"><label class="check"><input type="checkbox" id="reach-contacted"${contacted ? ' checked' : ''}> Mark as Contacted</label> <span class="muted" id="reach-contacted-label">${htmlEscape(contacted || '')}</span></section>
  <p class="letter-status" id="reach-status" role="status"></p>
</div>`;
}

// Settings > Cover Letters: the invitation-note limit and the optional candidate search.
export function outreachSettingsCard(settings = {}) {
  const limit = Number(settings.connectionNoteLimit) || 200;
  return `<article class="card" id="reach-out"><h2>Reach Out</h2>
    <form method="post" action="/settings/outreach">
      <label class="field"><span>Connection Note Limit (characters; LinkedIn allows 200 on a free account, 300 on Premium)</span><input type="number" name="connectionNoteLimit" class="control-input" min="100" max="300" step="1" value="${limit}"></label>
      <div class="field"><label class="check"><input type="checkbox" name="searchCandidates"${settings.searchCandidates === true ? ' checked' : ''}> Search Candidates</label><span class="muted">Off by default. Uses the search discovery provider and key in private/search.json and its monthly cap: one query per posting, up to three profiles from the search results only. Without a key nothing happens.</span></div>
      <button class="btn" type="submit">Save</button>
      <p class="form-foot">The note and the follow-up message are written with each cover letter; a posting without a letter can get them from its Reach Out panel.</p>
    </form></article>`;
}

export const OUTREACH_STYLES = `
.reach-drawer{position:fixed;top:0;right:0;bottom:0;width:min(440px,100%);overflow:auto;background:var(--surface);border-left:1px solid var(--line);box-shadow:-8px 0 24px rgba(16,24,40,.12);z-index:50;padding:var(--space-4)}
.reach-drawer[hidden]{display:none}
.reach-head{display:flex;align-items:center;justify-content:space-between;gap:var(--space-2)}
.reach-head h2{margin:0;font-size:var(--fs-title)}
.reach-role{margin:var(--space-2) 0 var(--space-3)}
.reach-section{margin:0 0 var(--space-4)}
.reach-section h3{margin:0 0 var(--space-2);font-size:var(--fs-body);font-weight:650}
.reach-links{display:flex;flex-wrap:wrap;gap:var(--space-2)}
.reach-text{white-space:pre-wrap;margin:0 0 var(--space-2);padding:var(--space-3);background:var(--bg);border-radius:var(--radius-sm);font-size:var(--fs-body);line-height:1.5}
.reach-count{font-weight:400;color:var(--ink-3);font-size:var(--fs-meta)}
.reach-count.over{color:var(--bad-ink);font-weight:650}
.reach-warning{margin:0 0 var(--space-2);padding:var(--space-2) var(--space-3);border-radius:var(--radius-sm);background:var(--warn-bg);color:var(--warn-ink);font-size:var(--fs-meta)}
`;

// The drawer: opened by a card's Reach Out button, filled from the panel route; every control in it is driven
// by delegation, so a re-fill needs no new listeners.
export const OUTREACH_SCRIPT = `
(function () {
  var drawer = document.getElementById('reach-drawer');
  if (!drawer) return;
  var current = null;
  function post(url, body) {
    var form = Object.keys(body).map(function (key) { return encodeURIComponent(key) + '=' + encodeURIComponent(body[key]); }).join('&');
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form })
      .then(function (r) { return r.json().then(function (data) { if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status)); return data; }); });
  }
  function panel() { return drawer.querySelector('#reach-panel'); }
  function say(text, error) { var s = drawer.querySelector('#reach-status'); if (s) { s.textContent = text || ''; s.className = 'letter-status' + (error ? ' error' : ''); } }
  function fillName() {
    var p = panel(); if (!p) return;
    var input = drawer.querySelector('#reach-first-name');
    var name = input ? input.value.replace(/\\s+/g, ' ').trim() : '';
    drawer.querySelectorAll('[data-reach-text]').forEach(function (node) {
      var text = node.getAttribute('data-template') || '';
      node.textContent = name ? text.split(p.getAttribute('data-placeholder')).join(name) : text;
      var count = node.parentNode.querySelector('[data-reach-count]');
      if (count) {
        var limit = Number(count.getAttribute('data-limit'));
        count.textContent = node.textContent.length + ' / ' + limit;
        count.classList.toggle('over', node.textContent.length > limit);
      }
    });
  }
  function open(button) {
    current = button;
    drawer.hidden = false;
    drawer.innerHTML = '<p class="muted">Loading…</p>';
    fetch('/outreach/panel?date=' + encodeURIComponent(button.getAttribute('data-date')) + '&job=' + encodeURIComponent(button.getAttribute('data-job')), { headers: { accept: 'text/html' } })
      .then(function (r) { return r.text().then(function (html) { if (!r.ok) throw new Error(html); return html; }); })
      .then(function (html) { drawer.innerHTML = html; fillName(); })
      .catch(function (error) { drawer.innerHTML = '<p class="letter-status error">' + String(error.message || error).replace(/[<&]/g, '') + '</p>'; });
  }
  function markCard(label) {
    if (!current) return;
    var card = current.closest('.job');
    if (!card) return;
    var badges = card.querySelector('.badges');
    var old = card.querySelector('[data-badge="contacted"]');
    if (old) old.remove();
    card.setAttribute('data-contacted', label ? '1' : '0');
    document.dispatchEvent(new CustomEvent('report-cards-changed'));
    if (!label) return;
    if (!badges) { badges = document.createElement('div'); badges.className = 'badges'; card.querySelector('.job-body').insertBefore(badges, card.querySelector('.actions')); }
    var badge = document.createElement('span'); badge.className = 'badge'; badge.setAttribute('data-badge', 'contacted'); badge.textContent = label; badges.appendChild(badge);
  }
  // Mark as Applied on a card: toggles the mark (POST /outreach/applied) and updates the button in place.
  function markApplied(button) {
    var on = button.getAttribute('aria-pressed') !== 'true';
    button.disabled = true;
    post('/outreach/applied', { job: button.getAttribute('data-job'), applied: on ? '1' : '0' }).then(function (result) {
      button.disabled = false;
      button.setAttribute('aria-pressed', result.label ? 'true' : 'false');
      button.textContent = result.label || 'Mark as Applied';
      var card = button.closest('.job');
      if (card) card.setAttribute('data-applied', result.label ? '1' : '0');
      document.dispatchEvent(new CustomEvent('report-cards-changed'));
    }).catch(function (error) { button.disabled = false; button.title = error.message; });
  }
  document.addEventListener('click', function (event) {
    var reach = event.target.closest && event.target.closest('[data-reach]');
    if (reach) { event.preventDefault(); open(reach); return; }
    var mark = event.target.closest && event.target.closest('[data-apply-mark]');
    if (mark) { event.preventDefault(); markApplied(mark); return; }
    if (!drawer.contains(event.target)) return;
    var p = panel();
    if (event.target.closest('[data-reach-close]')) { drawer.hidden = true; return; }
    var copy = event.target.closest('[data-reach-copy]');
    if (copy) {
      var node = drawer.querySelector('#' + copy.getAttribute('data-reach-copy') + ' [data-reach-text]');
      var text = node ? node.textContent : '';
      var done = function () { say('Copied to the clipboard.'); };
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, function () { say('Could not copy; select the text and copy it by hand.', true); });
      else { var area = document.createElement('textarea'); area.value = text; document.body.appendChild(area); area.select(); try { document.execCommand('copy'); done(); } catch (e) { say('Could not copy; select the text and copy it by hand.', true); } document.body.removeChild(area); }
      return;
    }
    if (event.target.closest('[data-reach-generate]')) {
      var generate = event.target.closest('[data-reach-generate]'); generate.disabled = true; say('Writing the messages…');
      post('/outreach/messages', { date: p.getAttribute('data-date'), job: p.getAttribute('data-job') }).then(function () { open(current); }).catch(function (error) { generate.disabled = false; say(error.message, true); });
      return;
    }
    if (event.target.closest('[data-reach-candidates]')) {
      var search = event.target.closest('[data-reach-candidates]'); search.disabled = true; say('Searching…');
      post('/outreach/candidates', { date: p.getAttribute('data-date'), job: p.getAttribute('data-job') }).then(function () { open(current); }).catch(function (error) { search.disabled = false; say(error.message, true); });
    }
  });
  document.addEventListener('input', function (event) { if (event.target && event.target.id === 'reach-first-name') fillName(); });
  document.addEventListener('change', function (event) {
    var p = panel(); if (!p || !drawer.contains(event.target)) return;
    if (event.target.id === 'reach-first-name') post('/outreach/name', { job: p.getAttribute('data-job'), firstName: event.target.value }).catch(function (error) { say(error.message, true); });
    if (event.target.id === 'reach-contacted') {
      post('/outreach/contacted', { job: p.getAttribute('data-job'), contacted: event.target.checked ? '1' : '0' }).then(function (result) {
        var label = drawer.querySelector('#reach-contacted-label'); if (label) label.textContent = result.label || '';
        markCard(result.label || null);
      }).catch(function (error) { say(error.message, true); });
    }
  });
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && !drawer.hidden) drawer.hidden = true; });
})();
`;
