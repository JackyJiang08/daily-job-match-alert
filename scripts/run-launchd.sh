#!/bin/zsh
set -u

project_dir="${0:A:h:h}"
node_bin="${DAILY_JOB_MATCH_ALERT_NODE:-${JOB_RADAR_NODE:-$(command -v node)}}"
log_dir="$project_dir/state/logs"
fallback_log="/tmp/daily-job-match-alert-$(date +%Y-%m-%d).log"

log_path="$("$node_bin" "$project_dir/src/logs.mjs" --directory "$log_dir" 2>/dev/null)" || log_path="$fallback_log"
[[ -n "$log_path" ]] || log_path="$fallback_log"

"$node_bin" "$project_dir/src/launchd-dispatch.mjs" --config "$project_dir/config.json" >>"$log_path" 2>&1
