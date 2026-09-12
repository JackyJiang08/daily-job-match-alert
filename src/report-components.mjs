// HTML components for the daily report. Every function takes a plain view object (assembled in
// report.mjs) and returns a string; nothing here reads pipeline state, so the same components can be
// reused by a local hub that renders the same cards from stored payloads.
import { htmlEscape } from './utils.mjs';
import { REPORT_SCRIPT, REPORT_STYLES } from './report-theme.mjs';

const VISIBLE_FACTS = 2;
// Every link out of the report opens a new tab so the shortlist itself is never navigated away.
export const EXTERNAL_LINK = 'target="_blank" rel="noopener noreferrer"';

export function renderMasthead({ title, dateLabel, matchLabel }) {
  return `<header class="masthead"><h1>${htmlEscape(title)}</h1><p class="sub">${htmlEscape(dateLabel)} · ${htmlEscape(matchLabel)}</p></header>`;
}

function option(value, label, selected = false) {
  return `<option value="${htmlEscape(value)}"${selected ? ' selected' : ''}>${htmlEscape(label)}</option>`;
}

export function renderToolbar({ roleTypes, tracks, quiet, total }) {
  return `<form class="toolbar${quiet ? ' quiet' : ''}" id="toolbar" autocomplete="off">
    <input type="search" id="q" placeholder="Search company or title" aria-label="Search company or title">
    <label class="control"><span>Sort by</span><select id="sort">${option('score', 'Best Score', true)}${option('company', 'Company')}${option('posted', 'Posted Time')}</select></label>
    <select id="role" aria-label="Role type">${option('', 'All Role Types')}${roleTypes.map(item => option(item.value, item.label)).join('')}</select>
    <label class="control"><span>Resume</span><select id="track">${option('', 'All Resumes')}${tracks.map(track => option(track.id, track.label)).join('')}</select></label>
    <span class="count" id="count">${total} shown</span>
  </form>`;
}

export function renderBadge(badge) {
  const tone = badge.tone && badge.tone !== 'note' ? ` badge-${htmlEscape(badge.tone)}` : '';
  const title = badge.title ? ` title="${htmlEscape(badge.title)}"` : '';
  return `<span class="badge${tone}" data-badge="${htmlEscape(badge.key)}"${title}>${htmlEscape(badge.label)}</span>`;
}

export function renderScoreRing(score) {
  const value = Math.max(0, Math.min(100, Number(score) || 0));
  return `<div class="ring" style="--score:${value}" role="img" aria-label="Best score ${value}"><b>${value}</b></div>`;
}

function renderFacts(label, items, className) {
  if (!items.length) return '';
  const visible = items.slice(0, VISIBLE_FACTS).map(item => `<li>${htmlEscape(item)}</li>`).join('');
  const rest = items.slice(VISIBLE_FACTS);
  const more = rest.length
    ? `<details class="more"><summary>${rest.length} more</summary><ul class="facts ${className}">${rest.map(item => `<li>${htmlEscape(item)}</li>`).join('')}</ul></details>`
    : '';
  return `<div class="facts-label">${htmlEscape(label)}</div><ul class="facts ${className}">${visible}</ul>${more}`;
}

export function renderScores(card) {
  const parts = card.scores.map(score => `<span class="track${score.best ? ' best' : ''}" data-track="${htmlEscape(score.id)}">${htmlEscape(score.label)} <b>${score.value}</b></span>`);
  return `<div class="scores">${parts.join('<span class="sep">·</span>')}<span class="recommend">${htmlEscape(card.recommendation)}</span></div>`;
}

export function renderJobCard(card) {
  const attributes = [
    `data-score="${card.sort.score}"`,
    `data-company="${htmlEscape(card.sort.company)}"`,
    `data-posted="${card.sort.posted}"`,
    `data-role="${htmlEscape(card.roleType)}"`,
    `data-track="${htmlEscape(card.recommendedTrack)}"`,
    `data-search="${htmlEscape(card.sort.search)}"`,
  ].join(' ');
  const badges = card.badges.length ? `<div class="badges">${card.badges.map(renderBadge).join('')}</div>` : '';
  const description = card.description
    ? `<details class="jd"><summary>Full Captured JD</summary><p>${htmlEscape(card.description)}</p></details>`
    : '';
  return `<article class="job" ${attributes}>
    ${renderScoreRing(card.bestScore)}
    <div class="job-body">
      <h2 class="job-title"><a ${EXTERNAL_LINK} href="${htmlEscape(card.url)}">${htmlEscape(card.title)}</a></h2>
      <p class="job-meta">${htmlEscape(card.company)} · ${htmlEscape(card.location)} · ${htmlEscape(card.roleLabel)}</p>
      ${renderScores(card)}
      ${badges}
      ${renderFacts('Why It Matches', card.reasons, 'reasons')}
      ${renderFacts('Gaps / Verify', card.gaps, 'gaps')}
      ${description}
      <div class="actions"><a class="apply" ${EXTERNAL_LINK} href="${htmlEscape(card.url)}">Open Posting</a><span class="meta">${htmlEscape(card.footnote)}</span></div>
    </div>
  </article>`;
}

export function renderRunDetails({ rows }) {
  const items = rows.map(row => {
    const list = row.items?.length ? `<ul>${row.items.map(item => `<li>${htmlEscape(item)}</li>`).join('')}</ul>` : '';
    return `<dt>${htmlEscape(row.term)}</dt><dd>${htmlEscape(row.detail)}${list}</dd>`;
  }).join('');
  return `<details class="run" id="run-details"><summary>Run Details</summary><dl>${items}</dl></details>`;
}

export function renderEmptyState(message) {
  return `<div class="empty">${htmlEscape(message)}</div>`;
}

// Everything between <main> and </main>: the hub embeds this inside its own shell.
export function renderReportBody(view) {
  const list = view.cards.length
    ? `<section class="jobs" id="jobs">${view.cards.map(renderJobCard).join('\n')}</section><div class="empty" id="no-results" hidden>No matches for the current filters.</div>`
    : renderEmptyState(view.emptyMessage);
  return `${renderMasthead(view)}
${renderToolbar(view.toolbar)}
${list}
${renderRunDetails(view.runDetails)}
<footer class="foot">${htmlEscape(view.footer)}</footer>`;
}

export function renderReportPage(view) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlEscape(view.title)} — ${htmlEscape(view.dateLabel)}</title>
<style>${REPORT_STYLES}</style></head>
<body><main class="page">
${renderReportBody(view)}
</main>
<script>${REPORT_SCRIPT}</script>
</body></html>`;
}
