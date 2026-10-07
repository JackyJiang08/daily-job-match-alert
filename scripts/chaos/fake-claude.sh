#!/bin/sh
# A stand-in for the Claude Code CLI used only by the chaos scenarios. It reports a recent version, a
# claude.ai subscription login, and answers `--print` calls according to FAKE_CLAUDE_MODE:
#   fable-weekly-limit  refuse the Fable model (alias fable or the full id claude-fable-5-1) with the recorded
#                       Fable weekly notice; score with any other model
#   fable-unnamed-limit refuse the Fable model with the notice the 2026-10-06 nightly run really got, which
#                       names no model ("You're out of usage credits. Switch to another model, ...")
#   account-limit       refuse every scoring call with the recorded weekly account notice
# FAKE_CLAUDE_CALLS, when set, is a file that receives one line per --print call naming the --model given.
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
if [ -n "${FAKE_CLAUDE_CALLS:-}" ]; then echo "$model" >> "$FAKE_CLAUDE_CALLS"; fi
case "${FAKE_CLAUDE_MODE:-}" in
  account-limit)
    echo "you have reached your weekly usage limit. Lower-priority mode is offered again after your weekly limit resets.|$(( $(date +%s) + 3*86400 ))" >&2
    exit 1 ;;
  fable-unnamed-limit)
    if [ "$model" = "fable" ] || [ "$model" = "claude-fable-5-1" ]; then
      echo "You're out of usage credits. Switch to another model, or manage usage credits at https://claude.ai/settings/usage?from=cc_cli_limit_message, to continue." >&2
      exit 1
    fi ;;
  fable-weekly-limit)
    if [ "$model" = "fable" ] || [ "$model" = "claude-fable-5-1" ]; then
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
// Like the real CLI, modelUsage is keyed by the full id: a full id is reported as is, an alias as its 2.1.292 default.
const aliases = { fable: "claude-fable-5-1", opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-4-5-20251001" };
const asked = process.argv[1] || "fable";
const model = aliases[asked] || asked;
process.stdout.write(JSON.stringify({ type: "result", structured_output: { results }, modelUsage: { [model]: { inputTokens: 100, outputTokens: 50 } } }));
' "$model" <<PROMPT
$prompt
PROMPT
