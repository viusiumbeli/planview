#!/usr/bin/env bash
# planview plan-pending — tell planview that THIS agterm session is blocked on a plan approval.
#
# Registered as a Claude Code hook on the plan-approval prompt. It is the only participant that
# knows both halves of the mapping: the plan file (from the transcript) and the agterm session
# (from the environment agterm injects). planview cannot work that out on its own — every idle
# session in `agtermctl tree` looks identical.
#
# As a hook it must never interfere with the agent:
#   * stdout is SILENT. A PreToolUse hook's stdout is parsed as a permission decision, so printing
#     anything here could approve or deny the plan by accident. Staying quiet leaves the normal
#     prompt to appear in the terminal exactly as it always does.
#   * it always exits 0. A non-zero exit can block the turn.
#   * it never blocks. curl is capped at 2s against localhost and failure is ignored, so a stopped
#     planview daemon just means no buttons.
set -u

# One line per invocation. Without it, "the button did not appear" is unanswerable: you cannot tell a
# hook that never fired from one that fired and bailed out.
LOG="${PLANVIEW_HOOK_LOG:-$HOME/.local/state/planview/hook.log}"
log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG" 2>/dev/null || true; }

log "fired session=${AGTERM_SESSION_ID:-none} pane=${AGTERM_PANE:-none}"

[ -n "${AGTERM_SESSION_ID:-}" ] || { log "  skip: not inside agterm"; exit 0; }

port="${PLANVIEW_PORT:-7777}"
payload=$(cat)                              # the hook event JSON on stdin

# The transcript is where the plan file path is recorded; the hook event itself does not carry it.
transcript=$(printf '%s' "$payload" | python3 -c '
import json,sys
try: print(json.load(sys.stdin).get("transcript_path") or "")
except Exception: print("")
' 2>/dev/null) || exit 0
[ -n "$transcript" ] && [ -f "$transcript" ] || { log "  skip: no readable transcript_path"; exit 0; }

# Last mention wins: re-entering plan mode writes a new plan file, and the newest reference is the
# one currently in play.
plan=$(grep -oE '/[^"[:space:]]*/\.claude/plans/[A-Za-z0-9._-]+\.md' "$transcript" 2>/dev/null | tail -1)
[ -n "$plan" ] && [ -f "$plan" ] || { log "  skip: no plan file found in $transcript"; exit 0; }

plan_id=$(basename "$plan" .md)
log "  plan=$plan_id -> POST 127.0.0.1:$port"

python3 -c '
import json,sys
print(json.dumps({
  "planId": sys.argv[1],
  "agtermSessionId": sys.argv[2],
  "agtermSocket": sys.argv[3] or None,
  "agtermPane": sys.argv[4] or None,
  "agtermPaneId": sys.argv[5] or None,
  "cwd": sys.argv[6] or None,
}))' \
  "$plan_id" "$AGTERM_SESSION_ID" "${AGTERM_SOCKET:-}" "${AGTERM_PANE:-}" "${AGTERM_PANE_ID:-}" \
  "${PWD:-}" 2>/dev/null |
  curl -fsS --max-time 2 -X POST \
    -H 'content-type: application/json' \
    --data-binary @- \
    "http://127.0.0.1:${port}/api/pending" >/dev/null 2>&1 &&
  log "  registered" || log "  POST failed (planview down, or an older build without /api/pending)"

exit 0
