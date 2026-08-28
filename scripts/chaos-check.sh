#!/usr/bin/env bash
# Runs five unattended-failure scenarios against isolated temporary configs and output
# directories, then prints a summary. Never touches the real config.json, state/, or Desktop.
#
#   npm run chaos            run all scenarios and clean up
#   npm run chaos -- --keep  keep the temporary work directory for inspection
set -uo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_bin="${DAILY_JOB_MATCH_ALERT_NODE:-$(command -v node)}"
work_root="$(mktemp -d "${TMPDIR:-/tmp}/daily-job-match-alert-chaos.XXXXXX")"
keep=0
[[ "${1:-}" == "--keep" ]] && keep=1

cleanup() {
  if (( keep )); then
    echo "Kept chaos work directory: $work_root"
  else
    rm -rf "$work_root"
  fi
}
trap cleanup EXIT

scenarios=(baseline offline llm-down bad-input xlsx-recovery)
pass_count=0
fail_count=0
results=""

for scenario in "${scenarios[@]}"; do
  echo "== chaos scenario: $scenario"
  if "$node_bin" "$project_dir/scripts/chaos-scenario.mjs" "$scenario" "$work_root"; then
    pass_count=$((pass_count + 1))
    results+="PASS  $scenario"$'\n'
  else
    fail_count=$((fail_count + 1))
    results+="FAIL  $scenario"$'\n'
  fi
  echo
done

echo "== chaos summary"
printf '%s' "$results"
echo "$pass_count passed, $fail_count failed"

(( fail_count == 0 ))
