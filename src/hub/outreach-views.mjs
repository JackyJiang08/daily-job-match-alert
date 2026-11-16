// The Message to Recruiters panel (rewritten 2026-11-16): a drawer on the right of the Reports page, filled
// from GET /outreach/panel. Three things, top to bottom: "Company — Title" with a close button; up to five
// people, one row each (name, headline, kind tag, ↗ to the profile in a new tab, a copy icon for that person's
// message); and the message for the selected row with its own copy icon, the character count, and a Follow-Up
// link that swaps the text. When there is no person to list (no key, the cap reached, a failed search, nothing
// found) the people row is three buttons that open the same searches on Google. Nothing here requests
// linkedin.com; the owner's browser opens every link.
import { htmlEscape } from '../utils.mjs';
import { KIND_LABELS } from '../outreach/people.mjs';
import { personalizeMessage } from '../outreach/messages.mjs';

const EXTERNAL = 'target="_blank" rel="noopener noreferrer"';
const COPY_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';

function fallbackButtons(fallback) {
  return `<div class="reach-find" id="reach-find">${fallback.map(item => `<a class="btn secondary small" data-reach-find="${htmlEscape(item.kind)}" href="${htmlEscape(item.url)}" ${EXTERNAL}>${htmlEscape(item.label)}</a>`).join('')}</div>`;
}

// Where ↗ goes: the profile, or for a JD contact its address (mailto) or nothing.
function personLink(person) {
  if (person.url) return `<a class="reach-icon" href="${htmlEscape(person.url)}" ${EXTERNAL} title="Open Profile" aria-label="Open Profile">↗</a>`;
  if (person.email) return `<a class="reach-icon" href="mailto:${htmlEscape(person.email)}" title="Email" aria-label="Email">↗</a>`;
  return '';
}

function personRow(person, index, { copied, fellow }) {
  const done = Boolean(copied[person.key]);
  const classes = ['reach-person', index === 0 ? 'selected' : '', done ? 'copied' : ''].filter(Boolean).join(' ');
  return `<li class="${classes}" data-person="${htmlEscape(person.key)}" data-first="${htmlEscape(person.firstName || '')}" data-fellow="${person.kind === 'alumni' ? htmlEscape(fellow) : ''}" tabindex="0">
  <span class="reach-who"><strong>${htmlEscape(person.name)}</strong>${person.headline ? ` <span class="reach-headline">· ${htmlEscape(person.headline)}</span>` : ''}</span>
  <span class="badge reach-kind" data-kind="${person.kind}">${KIND_LABELS[person.kind]}</span>${personLink(person)}<button class="reach-icon" type="button" data-reach-copy-person title="Copy Message" aria-label="Copy Message">${COPY_ICON}</button><span class="reach-check" aria-hidden="true">✓</span>
</li>`;
}

// view: { loading, people (JD contacts), fallback, copied } or { people, status, fallback, copied, fellow }. The buttons stand in whenever no searched
// person made the list (JD contacts, when there are any, stay above them).
export function peopleSection(view) {
  const people = view.people || [];
  const rows = people.length ? `<ul class="reach-list">${people.map((person, index) => personRow(person, index, { copied: {}, fellow: '', ...view })).join('')}</ul>` : '';
  // While searching, the JD contacts are already listed; the result replaces the whole section.
  if (view.loading) return `<section class="reach-people" id="reach-people" data-loading="1">${rows}<p class="muted reach-finding">Finding People…</p></section><template id="reach-fallback">${rows}${fallbackButtons(view.fallback)}</template>`;
  const searched = people.some(person => person.kind !== 'posting');
  return `<section class="reach-people" id="reach-people">${rows}${searched ? '' : fallbackButtons(view.fallback)}</section>`;
}

// The text shown first: the first row's name (and "Fellow …" for an Alumni row), else "Hi there,".
function firstText(template, section, limit) {
  const first = section.people?.[0];
  return personalizeMessage(template, { firstName: first?.firstName || '', fellow: first?.kind === 'alumni' ? section.fellow : '', limit });
}

// view: { date, jobId, job, company, section, entry, limit }
export function outreachPanel(view) {
  const { date, jobId, job, company, section, entry, limit } = view;
  const messages = entry?.messages?.connectionNote || entry?.messages?.followUpMessage ? entry.messages : null;
  const message = messages
    ? `<section class="reach-message" id="reach-message" data-note="${htmlEscape(messages.connectionNote || '')}" data-follow="${htmlEscape(messages.followUpMessage || '')}" data-mode="note">
  <div class="reach-box"><p class="reach-text" id="reach-text">${htmlEscape(firstText(messages.connectionNote || '', section, limit))}</p><button class="reach-icon reach-copy" type="button" data-reach-copy title="Copy" aria-label="Copy">${COPY_ICON}</button></div>
  <div class="reach-foot"><button class="reach-link" type="button" data-reach-mode>Follow-Up</button><span class="reach-count" id="reach-count"></span></div>
</section>`
    : '<section class="reach-message" id="reach-message"><button class="btn small" type="button" data-reach-generate>Generate Messages</button></section>';
  return `<div class="reach-panel" id="reach-panel" data-date="${htmlEscape(date)}" data-job="${htmlEscape(jobId)}" data-limit="${limit}">
  <div class="reach-head"><p class="reach-title">${htmlEscape(company)} — ${htmlEscape(job.title || '')}</p><button class="reach-close" type="button" data-reach-close title="Close" aria-label="Close">×</button></div>
  ${peopleSection(section)}
  ${message}
  <p class="reach-status" id="reach-status" role="status"></p>
</div>`;
}

// Settings > Cover Letters: the note limit and the people search (switch, monthly cap, this month's use).
export function outreachSettingsCard(view = {}) {
  const limit = Number(view.connectionNoteLimit) || 200;
  const people = view.peopleSearch || { enabled: true, monthlyCap: 300 };
  const usage = view.usage || { queries: 0, cap: people.monthlyCap };
  const used = view.keyMissing ? 'No Search Key in private/search.json: the panel offers Google searches instead.' : `Used This Month: ${usage.queries} / ${usage.cap} searches.`;
  return `<article class="card" id="reach-out"><h2>Message to Recruiters</h2>
    <form method="post" action="/settings/outreach">
      <label class="field"><span>Connection Note Limit (characters; LinkedIn allows 200 on a free account, 300 on Premium)</span><input type="number" name="connectionNoteLimit" class="control-input" min="100" max="300" step="1" value="${limit}"></label>
      <div class="field"><label class="check"><input type="checkbox" name="peopleSearch"${people.enabled ? ' checked' : ''}> People Search</label><span class="muted">Opening a panel finds recruiters, team leads and alumni through the search API in private/search.json: up to three searches per company, kept for 30 days. Never in the nightly run.</span></div>
      <label class="field"><span>People Search Monthly Cap</span><input type="number" name="peopleSearchCap" class="control-input" min="0" max="10000" step="1" value="${Number(people.monthlyCap)}"></label>
      <p class="muted" id="people-search-usage">${htmlEscape(used)}</p>
      <button class="btn" type="submit">Save</button>
      <p class="form-foot">The note and the follow-up message are written with each cover letter; a posting without a letter can get them from its Message to Recruiters panel.</p>
    </form></article>`;
}

export const OUTREACH_STYLES = `
.reach-drawer{position:fixed;top:0;right:0;bottom:0;width:min(440px,100%);overflow:auto;background:var(--surface);border-left:1px solid var(--line);box-shadow:-8px 0 24px rgba(16,24,40,.12);z-index:50;padding:var(--space-4)}
.reach-drawer[hidden]{display:none}
.reach-head{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--space-2);margin:0 0 var(--space-3)}
.reach-title{margin:0;font-size:var(--fs-meta);color:var(--ink-2);line-height:1.4}
.reach-close{border:0;background:none;color:var(--ink-3);font-size:20px;line-height:1;cursor:pointer;padding:0 2px}
.reach-close:hover{color:var(--ink)}
.reach-people{margin:0 0 var(--space-4)}
.reach-list{list-style:none;margin:0;padding:0}
.reach-person{display:flex;align-items:center;gap:var(--space-2);padding:6px var(--space-2);border-radius:var(--radius-sm);cursor:pointer}
.reach-person:hover{background:var(--bg)}
.reach-person.selected{background:var(--accent-bg, var(--bg));box-shadow:inset 2px 0 0 var(--accent)}
.reach-person.copied{opacity:.55}
.reach-who{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.reach-headline{color:var(--ink-3);font-size:var(--fs-meta)}
.reach-kind{flex:none;font-size:11px}
.reach-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:var(--radius-sm);background:none;color:var(--ink-3);text-decoration:none;cursor:pointer;font-size:14px}
.reach-icon:hover{background:var(--line);color:var(--ink)}
.reach-check{flex:none;width:14px;color:var(--good-ink, var(--accent));visibility:hidden}
.reach-person.copied .reach-check{visibility:visible}
.reach-finding{margin:0}
.reach-find{display:flex;flex-wrap:wrap;gap:var(--space-2)}
.reach-box{position:relative}
.reach-text{white-space:pre-wrap;margin:0;padding:var(--space-3) 36px var(--space-3) var(--space-3);background:var(--bg);border-radius:var(--radius-sm);font-size:var(--fs-body);line-height:1.5}
.reach-copy{position:absolute;top:6px;right:6px}
.reach-foot{display:flex;justify-content:space-between;align-items:center;margin-top:4px}
.reach-link{border:0;background:none;padding:0;color:var(--accent);font:inherit;font-size:var(--fs-meta);cursor:pointer}
.reach-link:hover{text-decoration:underline}
.reach-count{font-size:var(--fs-meta);color:var(--ink-3)}
.reach-count.over{color:var(--bad-ink);font-weight:650}
.reach-status{margin:var(--space-2) 0 0;font-size:var(--fs-meta);color:var(--ink-3)}
.reach-status.error{color:var(--bad-ink)}
`;

// The drawer: opened by a card's Message to Recruiters button, filled from the panel route; every control in it
// is driven by delegation, so a re-fill needs no new listeners. personalizeMessage is the same function the
// server used for the first text.
export const OUTREACH_SCRIPT = `
${personalizeMessage.toString()}
(function () {
  var drawer = document.getElementById('reach-drawer');
  if (!drawer) return;
  var current = null;
  var PEOPLE_WAIT_MS = 30000;
  function post(url, body) {
    var form = Object.keys(body).map(function (key) { return encodeURIComponent(key) + '=' + encodeURIComponent(body[key]); }).join('&');
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form })
      .then(function (r) { return r.json().then(function (data) { if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status)); return data; }); });
  }
  function panel() { return drawer.querySelector('#reach-panel'); }
  function say(text, error) { var s = drawer.querySelector('#reach-status'); if (s) { s.textContent = text || ''; s.className = 'reach-status' + (error ? ' error' : ''); } }
  function selected() { return drawer.querySelector('.reach-person.selected') || drawer.querySelector('.reach-person'); }
  function textFor(row) {
    var p = panel(); var box = drawer.querySelector('#reach-message');
    if (!p || !box || !box.hasAttribute('data-note')) return '';
    var note = box.getAttribute('data-mode') !== 'follow';
    var limit = Number(p.getAttribute('data-limit'));
    return personalizeMessage(box.getAttribute(note ? 'data-note' : 'data-follow'), { firstName: row ? row.getAttribute('data-first') : '', fellow: note && row ? row.getAttribute('data-fellow') : '', limit: note ? limit : 0 });
  }
  function render() {
    var p = panel(); var box = drawer.querySelector('#reach-message'); var node = drawer.querySelector('#reach-text');
    if (!p || !box || !node) return;
    node.textContent = textFor(selected());
    var note = box.getAttribute('data-mode') !== 'follow';
    var count = drawer.querySelector('#reach-count'); var limit = Number(p.getAttribute('data-limit'));
    if (count) { count.textContent = note ? node.textContent.length + ' / ' + limit : ''; count.classList.toggle('over', note && node.textContent.length > limit); }
    var mode = drawer.querySelector('[data-reach-mode]'); if (mode) mode.textContent = note ? 'Follow-Up' : 'Connection Note';
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var area = document.createElement('textarea'); area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
      document.body.appendChild(area); area.select(); var ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(area); if (ok) resolve(); else reject(new Error('copy refused'));
    });
  }
  function fallback() {
    var section = drawer.querySelector('#reach-people'); var template = drawer.querySelector('#reach-fallback');
    if (section && template) { section.removeAttribute('data-loading'); section.innerHTML = template.innerHTML; }
  }
  function findPeople() {
    var p = panel(); var section = drawer.querySelector('#reach-people');
    if (!p || !section || !section.hasAttribute('data-loading')) return;
    var job = p.getAttribute('data-job'); var done = false;
    var timer = setTimeout(function () { if (!done) { done = true; fallback(); } }, PEOPLE_WAIT_MS);
    post('/outreach/people', { date: p.getAttribute('data-date'), job: job }).then(function (data) {
      if (done || !panel() || panel().getAttribute('data-job') !== job) return;
      done = true; clearTimeout(timer);
      var holder = document.createElement('div'); holder.innerHTML = data.html;
      var fresh = holder.querySelector('#reach-people'); var old = drawer.querySelector('#reach-people');
      if (fresh && old) old.parentNode.replaceChild(fresh, old);
      var template = drawer.querySelector('#reach-fallback'); if (template) template.remove();
      render();
    }).catch(function () { if (!done) { done = true; clearTimeout(timer); fallback(); } });
  }
  function open(button) {
    current = button;
    drawer.hidden = false;
    drawer.innerHTML = '<p class="muted">Loading…</p>';
    fetch('/outreach/panel?date=' + encodeURIComponent(button.getAttribute('data-date')) + '&job=' + encodeURIComponent(button.getAttribute('data-job')), { headers: { accept: 'text/html' } })
      .then(function (r) { return r.text().then(function (html) { if (!r.ok) throw new Error(html); return html; }); })
      .then(function (html) { drawer.innerHTML = html; render(); findPeople(); })
      .catch(function (error) { drawer.innerHTML = '<p class="reach-status error">' + String(error.message || error).replace(/[<&]/g, '') + '</p>'; });
  }
  function markCard(label) {
    if (!current || !label) return;
    var card = current.closest('.job');
    if (!card || card.querySelector('[data-badge="contacted"]')) return;
    card.setAttribute('data-contacted', '1');
    var badges = card.querySelector('.badges');
    if (!badges) { var head = card.querySelector('.job-head'); badges = document.createElement('div'); badges.className = 'badges'; head.parentNode.insertBefore(badges, head.nextSibling); }
    var badge = document.createElement('span'); badge.className = 'badge'; badge.setAttribute('data-badge', 'contacted'); badge.textContent = label; badges.appendChild(badge);
    document.dispatchEvent(new CustomEvent('report-cards-changed'));
  }
  document.addEventListener('click', function (event) {
    var reach = event.target.closest && event.target.closest('[data-reach]');
    if (reach) { event.preventDefault(); open(reach); return; }
    if (!drawer.contains(event.target)) return;
    var p = panel();
    if (event.target.closest('[data-reach-close]')) { drawer.hidden = true; return; }
    var personCopy = event.target.closest('[data-reach-copy-person]');
    if (personCopy) {
      var row = personCopy.closest('.reach-person');
      copyText(textFor(row)).then(function () {
        row.classList.add('copied'); say('');
        post('/outreach/copied', { job: p.getAttribute('data-job'), person: row.getAttribute('data-person') }).then(function (result) { markCard(result.label); }).catch(function (error) { say(error.message, true); });
      }, function () { say('Could not copy; select the text and copy it by hand.', true); });
      return;
    }
    if (event.target.closest('[data-reach-copy]')) {
      var node = drawer.querySelector('#reach-text');
      copyText(node ? node.textContent : '').then(function () { say(''); }, function () { say('Could not copy; select the text and copy it by hand.', true); });
      return;
    }
    if (event.target.closest('[data-reach-mode]')) {
      var box = drawer.querySelector('#reach-message'); box.setAttribute('data-mode', box.getAttribute('data-mode') === 'follow' ? 'note' : 'follow'); render();
      return;
    }
    if (event.target.closest('[data-reach-generate]')) {
      var generate = event.target.closest('[data-reach-generate]'); generate.disabled = true; generate.textContent = 'Writing…';
      post('/outreach/messages', { date: p.getAttribute('data-date'), job: p.getAttribute('data-job') }).then(function () { open(current); }).catch(function (error) { generate.disabled = false; generate.textContent = 'Generate Messages'; say(error.message, true); });
      return;
    }
    var pick = event.target.closest('.reach-person');
    if (pick && !event.target.closest('a')) {
      drawer.querySelectorAll('.reach-person.selected').forEach(function (item) { item.classList.remove('selected'); });
      pick.classList.add('selected'); render();
    }
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !drawer.hidden) { drawer.hidden = true; return; }
    if ((event.key === 'Enter' || event.key === ' ') && event.target.classList && event.target.classList.contains('reach-person')) { event.preventDefault(); event.target.click(); }
  });
})();
`;
