#!/bin/sh
# Restarts the installed hub LaunchAgent so it picks up new code or a changed hub.port.
#   npm run hub:restart
label="com.dailyjobmatchalert.hub"
plist="$HOME/Library/LaunchAgents/$label.plist"
if [ ! -f "$plist" ]; then
  echo "The hub LaunchAgent is not installed ($plist is missing). Install it with ./scripts/install-hub-launchd.sh, or run npm run hub in a terminal." >&2
  exit 2
fi
if launchctl kickstart -k "gui/$(id -u)/$label"; then
  echo "Restarted $label."
else
  echo "launchctl kickstart failed; try ./scripts/install-hub-launchd.sh to reinstall the agent." >&2
  exit 1
fi
