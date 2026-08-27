#!/bin/zsh
set -euo pipefail

project_dir="${0:A:h:h}"
node_bin="${DAILY_JOB_MATCH_ALERT_NODE:-${JOB_RADAR_NODE:-$(command -v node)}}"
log_dir="$project_dir/state/logs"
mkdir -p "$log_dir"

"$node_bin" "$project_dir/src/index.mjs" --config "$project_dir/config.json" >>"$log_dir/daily.log" 2>>"$log_dir/daily.error.log"
