// Cover-letter pages for the hub: the Settings material section, the Letters history, and the panel
// that generates, edits, and downloads one letter. Only file metadata is shown for the material.
import { formatLocalDateTime } from '../time-format.mjs';
import { roleLabel } from '../report.mjs';
import { htmlEscape } from '../utils.mjs';

export const LETTER_STYLES = `
.letter-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--space-4);align-items:start}
.letter-head .kv{margin:0}
.para{width:100%;min-height:96px;font:inherit;font-size:var(--fs-body);line-height:1.5;color:var(--ink);background:var(--surface);border:1px solid var(--line-2);border-radius:var(--radius-sm);padding:var(--space-2) var(--space-3);resize:vertical;box-sizing:border-box;margin:0 0 var(--space-2)}
.para:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
.issues{margin:var(--space-2) 0 0;padding:0;list-style:none;font-size:var(--fs-meta)}
.issues li{padding:2px 0;color:var(--warn-ink)}
.issues li.info{color:var(--ink-3)}
.letter-meta{font-size:var(--fs-meta);color:var(--ink-3);margin:var(--space-2) 0 0}
.letter-status{font-size:var(--fs-body);color:var(--ink-2);margin:var(--space-2) 0 0}
.letter-status.error{color:var(--bad-ink)}
details.notes{margin:var(--space-2) 0 0;font-size:var(--fs-meta)}
details.notes>summary{cursor:pointer;color:var(--ink-2);font-weight:600}
.samples{margin:0;padding:0;list-style:none;font-size:var(--fs-body)}
.samples li{display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:center;padding:4px 0}
`;

function readable(value, timeZone) {
  return value ? htmlEscape(formatLocalDateTime(value, timeZone)) : '—';
}

// ---------------------------------------------------------------------------------------------- settings

export function coverLetterSettingsSection({ profile, readiness, timeZone }) {
  const playbook = profile.playbook?.file
    ? `<span class="mono">${htmlEscape(profile.playbook.originalName || profile.playbook.file)}</span> · ${Number(profile.playbook.characters || 0).toLocaleString('en-US')} characters · uploaded ${readable(profile.playbook.uploadedAt, timeZone)}`
    : '<span class="muted">No playbook yet</span>';
  const samples = (profile.samples || []).length
    ? `<ul class="samples">${profile.samples.map(sample => `<li><span class="mono">${htmlEscape(sample.originalName || sample.file)}</span>${sample.track ? `<span class="badge" data-sample-track="${htmlEscape(sample.track)}">${htmlEscape(sample.track)}</span>` : '<span class="badge badge-muted" data-sample-track="">untagged</span>'}<span class="muted">${Number(sample.characters || 0).toLocaleString('en-US')} characters · ${readable(sample.uploadedAt, timeZone)}</span><form class="inline" method="post" action="/settings/cover-letter/remove-sample"><input type="hidden" name="file" value="${htmlEscape(sample.file)}"><button class="btn secondary small" type="submit">Remove</button></form></li>`).join('')}</ul>`
    : '<p class="muted">No sample letters yet (optional, up to ten; the three closest to the chosen track go into each prompt).</p>';
  const state = readiness.ready
    ? '<span class="badge badge-good" data-letter-ready="yes">Ready to generate</span>'
    : `<span class="badge badge-warn" data-letter-ready="no">Missing: ${htmlEscape(readiness.missing.join(', '))}</span>`;
  return `<article class="card" id="cover-letters"><h2>Cover Letters</h2>
  <p class="muted">Everything here stays in <code>private/cover-letter/</code> on this Mac and is never committed. ${state}</p>
  <form method="post" action="/settings/cover-letter" enctype="multipart/form-data">
    <fieldset class="group"><legend>Contact block</legend>
      <label class="field"><span>Name</span><input type="text" name="name" value="${htmlEscape(profile.name || '')}" placeholder="Jane Doe" required></label>
      <label class="field"><span>Phone</span><input type="text" name="phone" value="${htmlEscape(profile.phone || '')}" placeholder="555-0100"></label>
      <label class="field"><span>Email</span><input type="text" name="email" value="${htmlEscape(profile.email || '')}" placeholder="jane@example.com"></label>
      <label class="field"><span>Signature name</span><input type="text" name="signatureName" value="${htmlEscape(profile.signatureName || '')}" placeholder="Jane Doe"></label>
    </fieldset>
    <fieldset class="group"><legend>Playbook (.md or .txt)</legend>
      <p class="letter-meta">${playbook}</p>
      <div class="field"><label class="file"><input type="file" name="playbook" accept=".md,.txt,text/markdown,text/plain"><span class="btn secondary">Choose Playbook…</span><span class="file-name">No file chosen</span></label></div>
    </fieldset>
    <fieldset class="group"><legend>Sample letters (.pdf or .txt, style reference only)</legend>
      ${samples}
      <div class="field"><label class="file"><input type="file" name="sample" accept=".pdf,.txt,application/pdf,text/plain"><span class="btn secondary">Choose Sample…</span><span class="file-name">No file chosen</span></label></div>
      <label class="field"><span>Resume track this sample was written for</span><select name="sampleTrack" class="control-input"><option value="">Not tagged</option><option value="data">Data</option><option value="llm">LLM</option><option value="agent">AI Agent</option></select></label>
    </fieldset>
    <button class="btn" type="submit">Save Cover Letter Material</button>
  </form></article>`;
}

// ---------------------------------------------------------------------------------------------- letters list

export function lettersPage({ letters, timeZone }) {
  const rows = letters.length
    ? `<table class="plain"><tr><th>Date</th><th>Company</th><th>Job</th><th>Track</th><th>Engine</th><th>PDF</th><th></th></tr>${letters.map(letter => `<tr>
      <td>${htmlEscape(letter.date)}</td>
      <td>${htmlEscape(letter.company)}</td>
      <td>${htmlEscape(letter.jobTitle || '')}</td>
      <td>${htmlEscape(letter.trackLabel || letter.track || '')}</td>
      <td>${htmlEscape(letter.engine || '')}${letter.model ? ` · ${htmlEscape(letter.model)}` : ''}</td>
      <td>${letter.pdf ? `${letter.pdf.pages} page${letter.pdf.pages === 1 ? '' : 's'}${letter.pdf.layout !== 'letter-1in' ? ` · ${htmlEscape(letter.pdf.layout)}` : ''}` : '—'}</td>
      <td><a class="btn secondary small" href="/letters/${letter.date}/${letter.slug}">Open</a> ${letter.pdfFileName && letter.pdf ? `<a class="btn secondary small" href="/letters/${letter.date}/${letter.slug}/${encodeURIComponent(letter.pdfFileName)}">Download PDF</a>` : ''}</td>
    </tr>`).join('')}</table>`
    : '<p class="muted">No cover letters yet. Open a report and use "Generate Cover Letter" on a job card.</p>';
  return `<h1 class="hub-title">Letters</h1><p class="hub-sub">Generated letters are stored under <code>private/cover-letters/&lt;date&gt;/&lt;Company&gt;/</code>; reopen one to edit or download it again.</p><article class="card">${rows}</article>`;
}

// ---------------------------------------------------------------------------------------------- panel

export function letterPanel({ date, jobId, job, tracks, selectedTrack, company, readiness, existing, engineLabel }) {
  const trackOptions = tracks.map(track => `<option value="${htmlEscape(track.id)}"${track.id === selectedTrack ? ' selected' : ''}>${htmlEscape(track.label)}${track.id === job.recommendedTrack ? ' (recommended)' : ''}</option>`).join('');
  const notReady = readiness.ready ? '' : `<div class="flash error">Upload a playbook and fill in your name and contact details under <a href="/settings#cover-letters">Settings → Cover Letters</a> first (missing: ${htmlEscape(readiness.missing.join(', '))}).</div>`;
  const paragraphs = existing?.record?.paragraphs || [];
  const editor = paragraphs.length
    ? paragraphs.map((paragraph, index) => `<textarea class="para" name="paragraph" data-index="${index}">${htmlEscape(paragraph)}</textarea>`).join('')
    : '';
  const issues = (existing?.record?.issues || []).map(issue => `<li data-kind="${htmlEscape(issue.kind)}">${htmlEscape(issue.message)}</li>`).join('');
  const notes = (existing?.record?.editorNotes || []).map(note => `<li>${htmlEscape(note)}</li>`).join('');
  const samplesUsed = (existing?.record?.samplesUsed || []).map(sample => `${sample.name}${sample.track ? ` (${sample.track})` : ''}`).join(', ');
  const counts = existing?.record ? `${Number(existing.record.wordCount || 0)} words${existing.record.pdf ? ` · ${existing.record.pdf.pages} page${existing.record.pdf.pages === 1 ? '' : 's'}` : ''}` : '';
  const meta = existing?.record
    ? `Generated with ${htmlEscape(existing.record.engine)} · ${htmlEscape(existing.record.model)}${existing.record.pdf ? ` · PDF: ${existing.record.pdf.pages} page${existing.record.pdf.pages === 1 ? '' : 's'} (${htmlEscape(existing.record.pdf.renderer)}, ${htmlEscape(existing.record.pdf.layout)})` : ''}`
    : `Engine: ${htmlEscape(engineLabel)}`;
  const download = existing?.record?.pdfFileName && existing.record.pdf
    ? `<a class="btn" id="download-link" href="/letters/${date}/${existing.slug}/${encodeURIComponent(existing.record.pdfFileName)}">Download PDF</a>`
    : '<a class="btn" id="download-link" hidden href="#">Download PDF</a>';
  return `<h1 class="hub-title">Cover Letter</h1>
  ${notReady}
  <article class="card letter-head" id="letter-panel" data-date="${htmlEscape(date)}" data-job="${htmlEscape(jobId)}" data-ready="${readiness.ready ? 'yes' : 'no'}">
    <dl class="kv">
      <dt>Job</dt><dd>${htmlEscape(job.title || '')}</dd>
      <dt>Company</dt><dd>${htmlEscape(job.company || 'Company not resolved')}</dd>
      <dt>Location</dt><dd>${htmlEscape(job.location || 'Location not stated')} · ${htmlEscape(roleLabel(job.roleType))}</dd>
      <dt>Report</dt><dd><a href="/reports/${htmlEscape(date)}">${htmlEscape(date)}</a></dd>
    </dl>
    <div>
      <label class="field"><span>Resume track</span><select id="letter-track" class="control-input">${trackOptions}</select></label>
      <label class="field"><span>Company name (used in the salutation and the file name)</span><input type="text" id="letter-company" class="control-input" value="${htmlEscape(company)}" required></label>
      <div class="row">
        <button class="btn" id="generate-button" type="button"${readiness.ready ? '' : ' disabled'}>${paragraphs.length ? 'Regenerate' : 'Generate'}</button>
        <button class="btn secondary" id="save-button" type="button"${paragraphs.length ? '' : ' hidden'}>Save &amp; Render PDF</button>
        ${download}
      </div>
      <p class="letter-status" id="letter-status"></p>
    </div>
  </article>
  <article class="card" id="letter-editor"${paragraphs.length ? '' : ' hidden'}>
    <h2>Body</h2>
    <p class="muted">Header, date, salutation, and sign-off are added automatically; edit the paragraphs here before rendering.</p>
    <div id="paragraphs">${editor}</div>
    <ul class="issues" id="letter-issues">${issues}</ul>
    <p class="letter-meta" id="letter-counts">${htmlEscape(counts)}</p>
    <p class="letter-meta" id="letter-samples">${samplesUsed ? `Samples used: ${htmlEscape(samplesUsed)}` : ''}</p>
    <details class="notes" id="editor-notes"${notes ? '' : ' hidden'}><summary>Editor notes</summary><ul class="issues" id="editor-notes-list">${notes}</ul></details>
    <p class="letter-meta" id="letter-meta">${meta}</p>
  </article>`;
}

export const LETTER_SCRIPT = `
(function () {
  var panel = document.getElementById('letter-panel');
  if (!panel) return;
  var generate = document.getElementById('generate-button');
  var save = document.getElementById('save-button');
  var download = document.getElementById('download-link');
  var status = document.getElementById('letter-status');
  var editor = document.getElementById('letter-editor');
  var box = document.getElementById('paragraphs');
  var issues = document.getElementById('letter-issues');
  var meta = document.getElementById('letter-meta');
  var state = { engine: null, model: null, issues: [], editorNotes: [], samplesUsed: [] };
  var counts = document.getElementById('letter-counts');
  var samplesLine = document.getElementById('letter-samples');
  var notesBox = document.getElementById('editor-notes');
  var notesList = document.getElementById('editor-notes-list');
  function say(text, error) { status.textContent = text || ''; status.className = 'letter-status' + (error ? ' error' : ''); }
  function form(fields) { var params = new URLSearchParams(); Object.keys(fields).forEach(function (key) { [].concat(fields[key]).forEach(function (value) { params.append(key, value); }); }); return params.toString(); }
  function post(url, fields) {
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(fields) }).then(function (r) { return r.json().then(function (data) { if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status)); return data; }); });
  }
  function paragraphs() { return Array.prototype.map.call(box.querySelectorAll('textarea'), function (area) { return area.value; }).filter(function (text) { return text.trim(); }); }
  function render(result) {
    box.innerHTML = '';
    result.paragraphs.forEach(function (text, index) { var area = document.createElement('textarea'); area.className = 'para'; area.name = 'paragraph'; area.dataset.index = String(index); area.value = text; box.appendChild(area); });
    issues.innerHTML = '';
    (result.issues || []).forEach(function (issue) { var item = document.createElement('li'); item.dataset.kind = issue.kind; item.textContent = issue.message; issues.appendChild(item); });
    if (counts) counts.textContent = (result.wordCount != null ? result.wordCount + ' words · ' : '') + result.paragraphs.length + ' paragraphs' + (result.pages != null ? ' · ' + result.pages + ' page' + (result.pages === 1 ? '' : 's') : '');
    if (samplesLine) samplesLine.textContent = (result.samplesUsed && result.samplesUsed.length) ? 'Samples used: ' + result.samplesUsed.map(function (s) { return s.name + (s.track ? ' (' + s.track + ')' : ''); }).join(', ') : 'Samples used: none';
    if (notesList) { notesList.innerHTML = ''; (result.editorNotes || []).forEach(function (note) { var item = document.createElement('li'); item.textContent = note; notesList.appendChild(item); }); }
    if (notesBox) notesBox.hidden = !(result.editorNotes && result.editorNotes.length);
    state.engine = result.engine; state.model = result.model; state.issues = result.issues || []; state.editorNotes = result.editorNotes || []; state.samplesUsed = result.samplesUsed || [];
    meta.textContent = 'Generated with ' + (result.engineLabel || result.engine) + ' · ' + result.model + (result.reviewed ? (result.revisionAdopted ? ' · editor revision applied' : ' · editor pass: no changes') : '');
    editor.hidden = false; save.hidden = false; download.hidden = true; generate.textContent = 'Regenerate';
  }
  generate.addEventListener('click', function () {
    generate.disabled = true; say('Generating…');
    post('/letters/generate', { date: panel.dataset.date, job: panel.dataset.job, track: document.getElementById('letter-track').value, company: document.getElementById('letter-company').value })
      .then(function (result) { render(result); say('Draft ready. Edit the paragraphs, then save and render the PDF.'); })
      .catch(function (error) { say(error.message, true); })
      .then(function () { generate.disabled = false; });
  });
  save.addEventListener('click', function () {
    save.disabled = true; say('Rendering PDF…');
    post('/letters/save', { date: panel.dataset.date, job: panel.dataset.job, track: document.getElementById('letter-track').value, company: document.getElementById('letter-company').value, paragraph: paragraphs(), engine: state.engine || (meta.dataset.engine || ''), model: state.model || '', issues: JSON.stringify(state.issues), editorNotes: JSON.stringify(state.editorNotes), samplesUsed: JSON.stringify(state.samplesUsed) })
      .then(function (result) {
        download.href = result.downloadUrl; download.hidden = false;
        if (result.pdf.condensed && result.paragraphs) { box.innerHTML = ''; result.paragraphs.forEach(function (text, index) { var area = document.createElement('textarea'); area.className = 'para'; area.name = 'paragraph'; area.dataset.index = String(index); area.value = text; box.appendChild(area); }); }
        if (counts) counts.textContent = result.wordCount + ' words · ' + (result.paragraphs || paragraphs()).length + ' paragraphs · ' + result.pdf.pages + ' page' + (result.pdf.pages === 1 ? '' : 's');
        var note = result.pdf.note ? ' ' + result.pdf.note + '.' : '';
        say('Saved. PDF: ' + result.pdf.pages + ' page' + (result.pdf.pages === 1 ? '' : 's') + ' (' + result.pdf.renderer + ', ' + result.pdf.layout + ').' + note, result.pdf.pages > 1);
      })
      .catch(function (error) { say(error.message, true); })
      .then(function () { save.disabled = false; });
  });
})();
`;
