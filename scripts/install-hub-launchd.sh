#!/bin/zsh
# Installs the always-on local hub as its own LaunchAgent (separate from the nightly job). Run with zsh:
#   ./scripts/install-hub-launchd.sh          install or reinstall
#   ./scripts/install-hub-launchd.sh --remove  stop and remove the agent
if [ -z "${ZSH_VERSION:-}" ]; then
  echo "install-hub-launchd.sh must be run with zsh, not bash or sh. 请用 zsh 运行：zsh scripts/install-hub-launchd.sh，或直接 ./scripts/install-hub-launchd.sh" >&2
  exit 2
fi
set -euo pipefail

project_dir="${0:A:h:h}"
node_bin="${DAILY_JOB_MATCH_ALERT_NODE:-$(command -v node)}"
agent_dir="$HOME/Library/LaunchAgents"
label="com.dailyjobmatchalert.hub"
agent_path="$agent_dir/$label.plist"
template="$project_dir/launchd/$label.plist.template"

if [[ "${1:-}" == "--remove" ]]; then
  launchctl bootout "gui/$(id -u)" "$agent_path" 2>/dev/null || true
  rm -f "$agent_path"
  print "Removed $label."
  exit 0
fi
if [[ ! -f "$project_dir/config.json" ]]; then
  print -u2 "Create config.json before installing the hub."
  exit 2
fi
if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
  print -u2 "node was not found; set DAILY_JOB_MATCH_ALERT_NODE to the absolute node path."
  exit 2
fi

mkdir -p "$agent_dir" "$project_dir/state/logs" "$project_dir/private"
temp_file="$(mktemp)"
trap 'rm -f "$temp_file"' EXIT
sed -e "s|__PROJECT_DIR__|$project_dir|g" -e "s|__NODE_BIN__|$node_bin|g" -e "s|__HOME__|$HOME|g" "$template" >"$temp_file"
plutil -lint "$temp_file"
cp "$temp_file" "$agent_path"
launchctl bootout "gui/$(id -u)" "$agent_path" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$agent_path"
launchctl enable "gui/$(id -u)/$label"
port="$("$node_bin" -e "try{const c=require('$project_dir/config.json');console.log(c.hub&&c.hub.port||4747)}catch{console.log(4747)}")"
print "Installed the hub LaunchAgent (KeepAlive). Open http://127.0.0.1:${port}/"
print "LaunchAgent: $agent_path · logs: $project_dir/state/logs/hub.out.log"
