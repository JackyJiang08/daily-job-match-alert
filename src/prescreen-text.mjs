// Display text for the prescreen (Run Details, Status, Settings); no engine imports, so the report and
// the hub views can use it.
function percent(value) {
  return value == null ? 'n/a' : `${Math.round(value * 100)}%`;
}

// "recall 100% (0 of 3 final matches would have been dropped)"
export function recallText(finalMatches, lost) {
  if (!finalMatches) return 'recall n/a (no final matches yet)';
  return `recall ${percent((finalMatches - lost) / finalMatches)} (${lost} of ${finalMatches} final matches would have been dropped)`;
}

// One line for Run Details and Status: what the prescreen did this run.
export function describePrescreen(meta) {
  if (!meta) return null;
  const model = meta.model ? ` · ${meta.model}${meta.effort ? ` (${meta.effort})` : ''}` : '';
  if (meta.status === 'off') return `off (${meta.reason || 'turned off'})`;
  if (meta.status === 'idle') return `no candidates to prescreen${model}`;
  if (meta.status === 'failed') return `failed${model}: ${meta.error || 'unknown error'}; the review budget used the local order and nothing was dropped`;
  const stage = meta.mode === 'enforced' ? 'enforced' : `shadow night ${Math.min(Number(meta.shadowRunsDone || 0), Math.max(Number(meta.shadowRuns || 0), 1))} of ${Number(meta.shadowRuns || 0)}${meta.readyToEnforce ? ' (shadow period complete; enable it in Settings)' : ''}`;
  const outcome = meta.mode === 'enforced'
    ? `${Number(meta.passed || 0)} passed · ${Number(meta.droppedCount || 0)} prescreened out below ${meta.threshold} (marked seen)`
    : `${Number(meta.wouldDrop || 0)} would be dropped below ${meta.threshold} · ${recallText(meta.finalMatches, meta.lost)}`;
  return `${stage}${model} · ${Number(meta.scored || 0)} of ${Number(meta.candidates || 0)} scored · ${outcome}`;
}

// "40 candidates → 40 prescreened → 25 passed → 25 reviewed → 4 matched"
export function funnelText(funnel) {
  if (!funnel) return null;
  return `${Number(funnel.candidates || 0)} candidates → ${Number(funnel.prescreened || 0)} prescreened → ${Number(funnel.passed || 0)} passed → ${Number(funnel.reviewed || 0)} reviewed → ${Number(funnel.matched || 0)} matched`;
}
