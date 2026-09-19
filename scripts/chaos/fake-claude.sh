#!/bin/sh
# A stand-in for the Claude Code CLI used only by the chaos scenarios. It reports a recent version, a
# claude.ai subscription login, and answers `--print` calls according to FAKE_CLAUDE_MODE:
#   fable-weekly-limit  refuse --model fable with the recorded Fable weekly notice; score with any other model
#   account-limit       refuse every scoring call with the recorded weekly account notice
# Scoring answers are built from the job ids found in the prompt, so every posting gets a result.
case "$1" in
  --version) echo "2.1.269 (Claude Code)"; exit 0 ;;
  auth) echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}'; exit 0 ;;
esac
model=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--model" ]; then model="$arg"; fi
  prev="$arg"
done
prompt=$(cat)
case "${FAKE_CLAUDE_MODE:-}" in
  account-limit)
    echo "you have reached your weekly usage limit. Lower-priority mode is offered again after your weekly limit resets.|$(( $(date +%s) + 3*86400 ))" >&2
    exit 1 ;;
  fable-weekly-limit)
    if [ "$model" = "fable" ]; then
      echo "You've reached your Fable limit. Your Fable limit resets at 9am (America/Chicago)." >&2
      exit 1
    fi ;;
esac
node -e '
const prompt = require("fs").readFileSync(0, "utf8");
const ids = [...prompt.matchAll(/"id": "([a-f0-9]{16})"/g)].map(m => m[1]);
const trackMatch = prompt.match(/using exactly these keys:\n((?:- "[^"]+"[^\n]*\n)+)/);
const tracks = trackMatch ? [...trackMatch[1].matchAll(/- "([^"]+)"/g)].map(m => m[1]) : ["data"];
const results = ids.map(id => ({ id, roleType: "new_grad", scores: Object.fromEntries(tracks.map(t => [t, 82])), recommendedTrack: tracks[0], matchLevel: "high", reasons: ["fake engine fit"], gaps: [], blockers: [] }));
const model = process.argv[1] === "fable" ? "claude-fable-5" : process.argv[1] === "opus" ? "claude-opus-5" : "claude-" + (process.argv[1] || "fable");
process.stdout.write(JSON.stringify({ type: "result", structured_output: { results }, modelUsage: { [model]: { inputTokens: 100, outputTokens: 50 } } }));
' "$model" <<PROMPT
$prompt
PROMPT
