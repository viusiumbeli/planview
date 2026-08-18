#!/usr/bin/env bash
# planview session-map — tell planview which Claude Code transcript THIS agterm session is writing.
#
# Registered as a Claude Code SessionStart hook. It is the only participant that knows both halves
# of the mapping exactly: the claude session id + transcript path (from the hook event) and the
# agterm session (from the environment agterm injects). Without it planview can only guess a
# session's history by cwd and mtime.
#
# As a hook it must never interfere with the agent:
#   * stdout is SILENT. A SessionStart hook's stdout is injected into the prompt context, so
#     printing anything here would pollute every conversation.
#   * it always exits 0. A non-zero exit can block the session from starting.
#   * it never blocks. curl is capped at 2s against localhost and failure is ignored — a stopped
#     planview daemon just means no history panel.
#
# PLANVIEW_PIN_RESTORE=1 additionally pins `claude --resume <id>` as this pane's restore command —
# the officially recommended agterm pattern so a restart reattaches this session instead of forking
# a new one. Off by default: it overwrites the pane's restore override on every session start.
set -u

LOG="${PLANVIEW_HOOK_LOG:-$HOME/.local/state/planview/hook.log}"
log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG" 2>/dev/null || true; }

log "session-map fired session=${AGTERM_SESSION_ID:-none}"

[ -n "${AGTERM_SESSION_ID:-}" ] || { log "  skip: not inside agterm"; exit 0; }

port="${PLANVIEW_PORT:-7777}"
payload=$(cat)

read -r claude_id transcript <<EOF2
$(printf '%s' "$payload" | python3 -c '
import json,sys
try:
  data = json.load(sys.stdin)
  print(data.get("session_id") or "", data.get("transcript_path") or "")
except Exception:
  print("", "")
' 2>/dev/null)
EOF2

[ -n "${claude_id:-}" ] && [ -n "${transcript:-}" ] || { log "  skip: no session_id/transcript_path in hook event"; exit 0; }

python3 -c '
import json,sys
print(json.dumps({
  "claudeSessionId": sys.argv[1],
  "agtermSessionId": sys.argv[2],
  "transcriptPath": sys.argv[3],
  "cwd": sys.argv[4] or None,
}))' "$claude_id" "$AGTERM_SESSION_ID" "$transcript" "${PWD:-}" 2>/dev/null |
  curl -fsS --max-time 2 -X POST \
    -H 'content-type: application/json' \
    --data-binary @- \
    "http://127.0.0.1:${port}/api/term/claude-session" >/dev/null 2>&1 &&
  log "  registered claude=$claude_id" || log "  POST failed (planview down, or an older build)"

if [ "${PLANVIEW_PIN_RESTORE:-0}" = "1" ]; then
  AGTERMCTL="${AGTERMCTL:-/Applications/agterm.app/Contents/MacOS/agtermctl}"
  "$AGTERMCTL" session restore "claude --resume $claude_id" \
    --target "$AGTERM_SESSION_ID" \
    ${AGTERM_PANE_ID:+--pane-id "$AGTERM_PANE_ID"} --pane left \
    >/dev/null 2>&1 && log "  pinned restore" || log "  restore pin failed"
fi

exit 0
