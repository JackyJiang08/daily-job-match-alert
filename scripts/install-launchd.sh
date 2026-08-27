#!/bin/zsh
set -euo pipefail

project_dir="${0:A:h:h}"
hour="${1:-6}"
minute="${2:-30}"
node_bin="${DAILY_JOB_MATCH_ALERT_NODE:-${JOB_RADAR_NODE:-$(command -v node)}}"
agent_dir="$HOME/Library/LaunchAgents"
agent_path="$agent_dir/com.dailyjobmatchalert.daily.plist"
template="$project_dir/launchd/com.dailyjobmatchalert.daily.plist.template"

if [[ ! "$hour" =~ '^[0-9]{1,2}$' ]] || (( hour < 0 || hour > 23 )); then
  print -u2 "Hour must be 0-23"
  exit 2
fi
if [[ ! "$minute" =~ '^[0-9]{1,2}$' ]] || (( minute < 0 || minute > 59 )); then
  print -u2 "Minute must be 0-59"
  exit 2
fi
if [[ ! -f "$project_dir/config.json" ]]; then
  print -u2 "Create config.json and both resume files before installing the schedule."
  exit 2
fi

mkdir -p "$agent_dir" "$project_dir/state/logs"
temp_file="$(mktemp)"
trap 'rm -f "$temp_file"' EXIT
sed -e "s|__PROJECT_DIR__|$project_dir|g" -e "s|__NODE_BIN__|$node_bin|g" -e "s|__HOUR__|$hour|g" -e "s|__MINUTE__|$minute|g" "$template" >"$temp_file"
plutil -lint "$temp_file"
cp "$temp_file" "$agent_path"
launchctl bootout "gui/$(id -u)" "$agent_path" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$agent_path"
launchctl enable "gui/$(id -u)/com.dailyjobmatchalert.daily"
print "Installed Daily Job Match Alert at ${hour}:$(printf '%02d' "$minute") local time."
print "LaunchAgent: $agent_path"
