// Markup for the subscription and model part of Settings (data from model-settings.mjs): two plan cards
// side by side, each with its model table; the Model assignments table with fallback chains; and the
// Model Ladder as a reorderable list of registry models. Full model ids everywhere; aliases are a grey
// secondary label.
import { formatLocalDateTime } from '../time-format.mjs';
import { describeTotals } from '../engines/usage.mjs';
import { htmlEscape } from '../utils.mjs';
import { STATUS_LABELS, STATUS_TONES } from './model-settings.mjs';

const SOURCE_LABELS = { auto: 'auto', manual: 'manual' };

function aliasTag(alias) {
  return alias ? ` <span class="alias">${htmlEscape(alias)}</span>` : '';
}

export function statusBadge(status, text) {
  const tone = STATUS_TONES[status.state] || 'muted';
  return `<span class="badge badge-${tone}" data-model-state="${htmlEscape(status.state)}">${htmlEscape(text || STATUS_LABELS[status.state] || status.state)}</span>`;
}

function planCard(card, { timeZone, connectionRow, refresh }) {
  const engineName = card.provider === 'anthropic' ? 'Claude' : 'Codex';
  const plan = card.plan;
  const source = plan.source ? `<span class="badge badge-muted" data-plan-source="${htmlEscape(plan.source)}" title="${plan.source === 'auto' && plan.detectedSource ? `read from ${htmlEscape(plan.detectedSource)}` : plan.source === 'manual' ? 'entered in Settings or scheduled in config.json' : ''}">${htmlEscape(SOURCE_LABELS[plan.source] || plan.source)}</span>` : '';
  const pending = plan.pending ? `<p class="plan-change" data-plan-pending="${htmlEscape(plan.pending.effectiveDate)}">Switches to ${htmlEscape(plan.pending.plan.charAt(0).toUpperCase() + plan.pending.plan.slice(1))} on ${htmlEscape(plan.pending.dateLabel)}</p>` : '';
  const version = card.connection?.version ? `<span class="muted">${engineName} CLI ${htmlEscape(card.connection.version)}</span>` : '';
  const usage = `<p class="plan-usage" data-plan-usage="${card.engine}"><span class="muted">Last 7 days:</span> ${card.usage ? htmlEscape(describeTotals(card.usage.total)) : '—'}</p>`;
  const manualForm = `<form class="inline plan-manual" method="post" action="/settings/plans"><input type="hidden" name="provider" value="${card.provider === 'anthropic' ? 'claude' : 'chatgpt'}"><label><span class="muted">Set plan manually</span> <input type="text" name="plan" class="control-input small-input" value="${htmlEscape(plan.manual || '')}" placeholder="${card.provider === 'anthropic' ? 'max' : 'plus'}" pattern="[A-Za-z][A-Za-z0-9_-]{0,31}"></label> <button class="btn secondary small" type="submit">Save</button></form>`;
  return `<article class="card plan-card" data-provider="${card.provider}">
    <div class="plan-head"><h2>${htmlEscape(card.name)}</h2>${refresh}</div>
    <p class="plan-name" data-plan-name="${card.provider === 'anthropic' ? 'claude' : 'chatgpt'}">${htmlEscape(plan.label)} ${source}</p>
    ${pending}
    <dl class="conn">${connectionRow(engineName, card.engine, card.connection)}</dl>
    ${version ? `<p class="form-foot">${version}</p>` : ''}
    ${usage}
    ${plan.plan && plan.source === 'auto' ? '' : manualForm}
  </article>`;
}

function modelTable(card, { timeZone, testable }) {
  const rows = card.models.map(model => {
    const used = model.usedBy.length ? model.usedBy.map(item => `<span class="stage${item.primary ? ' primary' : ''}">${htmlEscape(item.stage)}</span>`).join(' ') : '<span class="muted">—</span>';
    // The CLI was given the alias; when it ran a different release than the registry id, say so.
    const resolved = model.newVersion
      ? `<br><span class="new-version" data-new-version="${htmlEscape(model.newVersion)}" title="The CLI ran this release on its last successful call">New version: ${htmlEscape(model.newVersion)}</span>`
      : model.status.resolvedId && model.status.resolvedId !== model.id ? `<br><span class="muted mono" title="Id the CLI reported on its last successful call">resolved ${htmlEscape(model.status.resolvedId)}</span>` : '';
    const test = testable
      ? `<form class="inline" method="post" action="/settings/models/test" data-test-model="${htmlEscape(model.id)}"><input type="hidden" name="model" value="${htmlEscape(model.id)}"><input type="hidden" name="confirm" value="1"><button class="btn secondary small" type="submit">Test</button></form>`
      : '';
    return `<tr data-model="${htmlEscape(model.id)}"><td>${htmlEscape(model.label)}${aliasTag(model.alias)}</td><td class="mono">${htmlEscape(model.id)}${resolved}</td><td>${statusBadge(model.status, model.statusText)}${test ? `<div class="test-cell">${test}</div>` : ''}</td><td>${model.status.lastUsedAt ? htmlEscape(formatLocalDateTime(model.status.lastUsedAt, timeZone)) : '<span class="muted">Never</span>'}</td><td>${used}</td></tr>`;
  }).join('');
  return `<article class="card model-card" data-provider="${card.provider}"><h3>${htmlEscape(card.name)} models</h3><div class="table-scroll"><table class="plain models-table"><tr><th>Model</th><th>Full ID</th><th>Status</th><th>Last used</th><th>Used by</th></tr>${rows}</table></div></article>`;
}

// The two plan cards, each with its model table beneath; stacked on narrow screens.
export function subscriptionSection(view, { timeZone, connectionRow, refresh, testable = true, checked = '' }) {
  const columns = view.cards.map(card => `<div class="plan-column">${planCard(card, { timeZone, connectionRow, refresh })}${modelTable(card, { timeZone, testable })}</div>`).join('');
  return `<section class="plan-grid" id="subscriptions">${columns}</section>${checked}`;
}

function chainMarkup(chain) {
  if (!chain.length) return '<span class="muted">—</span>';
  return `<span class="chain">${chain.map(step => `<span class="step${step.blocked ? ' off' : ''}" data-step="${htmlEscape(step.id)}"${step.note ? ` title="${htmlEscape(step.note)}"` : ''}>${htmlEscape(step.id)}${step.blocked ? ` <span class="why">· ${htmlEscape(step.reason)}</span>` : ''}</span>`).join('<span class="arrow" aria-hidden="true">→</span>')}</span>`;
}

// One row per stage. The Scoring row carries the editable engine, model, and effort controls (their
// markup comes from the caller) and the optional Codex fallback that ends its chain.
export function assignmentsFieldset(view, { scoringControls, fallbackChecked }) {
  const rows = view.assignments.map(row => {
    const engine = row.reserved ? '<span class="muted">local</span>' : htmlEscape(row.engine || '—');
    const model = row.model ? `<span class="mono">${htmlEscape(row.model)}</span>` : '<span class="muted">—</span>';
    const effort = row.engine === 'codex' ? htmlEscape(row.effort || 'CLI default') : '<span class="muted">—</span>';
    const extra = row.stage === 'scoring'
      ? `<div class="assign-controls">${scoringControls}<label class="check"><input type="checkbox" name="fallbackEngine" value="codex"${fallbackChecked ? ' checked' : ''}> End the chain with Codex on a weekly account limit (only when Codex is signed in)</label></div>`
      : row.note ? `<br><span class="muted">${htmlEscape(row.note)}</span>` : '';
    return `<tr data-stage="${row.stage}"${row.off ? ' class="stage-off"' : ''}><th scope="row">${htmlEscape(row.label)}</th><td>${engine}</td><td>${model}</td><td>${effort}</td><td>${chainMarkup(row.chain)}${extra}</td></tr>`;
  }).join('');
  return `<fieldset class="group" id="model-assignments"><legend>Model assignments</legend>
      <div class="table-scroll"><table class="plain assignments"><tr><th>Stage</th><th>Engine</th><th>Model</th><th>Effort</th><th>Fallback chain</th></tr>${rows}</table></div>
      <input type="hidden" name="quotaPresent" value="1">
    </fieldset>`;
}

// The Claude model ladder: every Anthropic registry model, checked ones in ladder order first; drag a row
// or use the arrows to reorder. The form submits the checked models in on-screen order.
export function ladderEditor(view) {
  const items = view.ladder.options.map(option => `<li class="ladder-item" draggable="true" data-id="${htmlEscape(option.id)}"><span class="grip" aria-hidden="true">⠿</span><label class="check"><input type="checkbox" name="modelLadder" value="${htmlEscape(option.id)}"${option.checked ? ' checked' : ''}> <span class="mono">${htmlEscape(option.id)}</span>${aliasTag(option.alias)}</label> ${statusBadge(option.status)} <span class="ladder-move"><button type="button" class="btn secondary small" data-move="up" aria-label="Move ${htmlEscape(option.id)} up">↑</button><button type="button" class="btn secondary small" data-move="down" aria-label="Move ${htmlEscape(option.id)} down">↓</button></span></li>`).join('');
  return `<div class="field"><span>Model Ladder (tried in order when a model hits its weekly limit or is not on the plan)</span><input type="hidden" name="ladderPresent" value="1"><ol class="ladder" id="ladder-list">${items}</ol><p class="form-foot">Drag or use the arrows to reorder; only checked Claude models are used, at least one.</p></div>`;
}

export const MODEL_SETTINGS_STYLES = `
.plan-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-3);align-items:start}
.plan-column{min-width:0}
.plan-head{display:flex;justify-content:space-between;align-items:center;gap:var(--space-2)}
.plan-name{margin:var(--space-1) 0;font-size:28px;font-weight:700;line-height:1.2;letter-spacing:-0.01em}
.plan-name .badge{vertical-align:middle;font-size:var(--fs-meta)}
.plan-change{margin:0 0 var(--space-2);font-weight:600;color:var(--warn-ink)}
.plan-usage{margin:var(--space-2) 0;font-size:var(--fs-body)}
.small-input{width:8em;min-height:28px;padding:3px 7px}
.alias{color:var(--ink-3);font-size:var(--fs-meta);font-weight:400}
.models-table td,.models-table th,.assignments td,.assignments th{font-size:var(--fs-body);vertical-align:top}
.models-table{min-width:520px}
.test-cell{margin-top:6px}
.new-version{display:inline-block;margin-top:2px;font-size:var(--fs-meta);font-weight:600;color:var(--warn-ink)}
.assignments{min-width:760px}
.models-table td.mono,.assignments td .mono,.ladder .mono{white-space:nowrap}
.chain .step{white-space:nowrap}
.stage{display:inline-block;font-size:var(--fs-meta);border:1px solid var(--line-2);border-radius:var(--radius-sm);padding:0 6px;margin:1px 0;color:var(--ink-2)}
.stage.primary{border-color:var(--accent);color:var(--accent)}
.badge-muted{background:var(--line);color:var(--ink-2)}
.chain{display:inline-flex;flex-wrap:wrap;align-items:center;gap:4px}
.chain .step{font-family:var(--font-mono);font-size:var(--fs-meta);background:var(--accent-soft);color:var(--ink);border-radius:var(--radius-sm);padding:2px 7px}
.chain .step.off{background:var(--line);color:var(--ink-3);text-decoration:line-through}
.chain .step.off .why{text-decoration:none;display:inline-block}
.chain .arrow{color:var(--ink-3)}
.assign-controls{margin-top:var(--space-2);display:flex;flex-direction:column;gap:var(--space-2)}
.stage-off{opacity:.6}
.ladder{list-style:none;margin:var(--space-1) 0 0;padding:0;display:flex;flex-direction:column;gap:4px;max-width:640px}
.ladder-item{display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap;border:1px solid var(--line);border-radius:var(--radius-sm);padding:6px 8px;background:var(--surface);cursor:grab}
.ladder-item.dragging{opacity:.5}
.ladder-item .grip{color:var(--ink-3)}
.ladder-move{margin-left:auto;display:inline-flex;gap:4px}
@media (max-width:900px){.plan-grid{grid-template-columns:1fr}}
`;

// Drag-and-drop and arrow buttons for the ladder; a confirmation before a Test call.
export const MODEL_SETTINGS_SCRIPT = `
(function(){
  var list = document.getElementById('ladder-list');
  if (list) {
    var dragging = null;
    list.addEventListener('dragstart', function(event){ dragging = event.target.closest('.ladder-item'); if (dragging) dragging.classList.add('dragging'); });
    list.addEventListener('dragend', function(){ if (dragging) dragging.classList.remove('dragging'); dragging = null; });
    list.addEventListener('dragover', function(event){
      if (!dragging) return;
      event.preventDefault();
      var over = event.target.closest('.ladder-item');
      if (!over || over === dragging) return;
      var box = over.getBoundingClientRect();
      list.insertBefore(dragging, event.clientY > box.top + box.height / 2 ? over.nextSibling : over);
    });
    list.addEventListener('click', function(event){
      var button = event.target.closest('[data-move]');
      if (!button) return;
      var item = button.closest('.ladder-item');
      if (button.getAttribute('data-move') === 'up' && item.previousElementSibling) list.insertBefore(item, item.previousElementSibling);
      if (button.getAttribute('data-move') === 'down' && item.nextElementSibling) list.insertBefore(item.nextElementSibling, item);
      button.focus();
    });
  }
  document.querySelectorAll('form[data-test-model]').forEach(function(form){
    form.addEventListener('submit', function(event){
      var model = form.getAttribute('data-test-model');
      if (!window.confirm('Send one short test prompt ("Reply with OK") to ' + model + '? It uses a little of your subscription.')) event.preventDefault();
    });
  });
})();
`;
