#!/bin/sh
# Pilot-only telemetry wrapper. Occupies `unbounded` on each agent's PATH,
# appends JSONL, then execs the real executable.
#
# The Unbounded executable itself emits no telemetry and has no concept of runs,
# agents, or conditions -- that separation is deliberate. All experiment
# attribution is added here, by the pilot, from environment variables the
# launcher sets.
#
# Mounted read-only into every SWE-bench agent container as:
#   /usr/local/bin/unbounded      <- this script
#   /opt/unbounded/bin/unbounded  <- the compiled executable
#   /telemetry                    <- writable, one JSONL file per agent
#
# Records are kept under 4096 bytes so concurrent O_APPEND writes stay atomic
# on Linux. That is why no document content is ever recorded here.

REAL="${UNBOUNDED_BIN:-/opt/unbounded/bin/unbounded}"

# No telemetry sink configured (or arm C, which has no memory): stay transparent.
if [ -z "$UNBOUNDED_TELEMETRY" ]; then
  exec "$REAL" "$@"
fi

OP="${1:-none}"
# Only the operation and collection are recorded. Everything else on the command
# line is agent-authored document or filter content and is deliberately not
# logged. The collection is OPTIONAL in every command (`insert [collection]
# <document>`), so $2 is a collection only when it is not an option and not the
# JSON document -- otherwise a whole model-authored document would land in the
# `collection` field, which is both the content we refuse to log and a good way
# to push the record past PIPE_BUF.
COLL="${2:-}"
case "$COLL" in -* | '{'* | '['*) COLL="" ;; esac

START=$(date +%s%3N 2>/dev/null || echo 0)
OUT=$("$REAL" "$@" 2>&1)
CODE=$?
END=$(date +%s%3N 2>/dev/null || echo 0)

printf '%s\n' "$OUT"

DUR=$((END - START))
[ "$DUR" -lt 0 ] && DUR=0
TS=$(date -u +%Y-%m-%dT%H:%M:%S).$(printf '%03d' $((END % 1000)))Z

# uuid4 if the kernel offers one, otherwise a unique-enough fallback.
new_event_id() {
  if [ -r /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
  else
    awk -v p=$$ -v t="$END" 'BEGIN{srand(t+p);printf "%d-%d-%08x", p, t, rand()*4294967295}'
  fi
}
EVENT_ID=$(new_event_id)

case "$OUT" in
  *'"ok":true'*) SUCCESS=true ;;
  *) SUCCESS=false ;;
esac

esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# The executable reports the collection it resolved and, for insert/update, a
# `schemaFingerprint` -- a 16 hex digest of the document's field names and BSON
# types. Fixed length and free of model-authored text, so it is safe to log
# where the document itself is not, and it makes schema convergence visible in
# the stream rather than only in a post-hoc pass over MongoDB.
#
# Both are READ OUT of the output rather than recomputed here. A second
# fingerprint implementation in shell would drift from the executable's, and the
# two would no longer cluster the same documents together -- which is the one
# thing the convergence measurement depends on. Absent fields are simply
# omitted; missing telemetry must never cost us the record.
field_of() {
  printf '%s' "$OUT" | grep -o "\"$1\":\"[A-Za-z0-9_.-]*\"" | head -1 | cut -d'"' -f4
}

RESOLVED_COLL=$(field_of collection)
[ -n "$RESOLVED_COLL" ] && COLL="$RESOLVED_COLL"
FINGERPRINT=$(field_of schemaFingerprint)

envelope() {
  printf '{"type":"%s","event_id":"%s","timestamp":"%s","run_id":"%s","task_id":"%s","agent_id":"%s","condition":"%s"' \
    "$1" "$EVENT_ID" "$TS" "$(esc "$UNBOUNDED_RUN_ID")" "$(esc "$UNBOUNDED_TASK_ID")" \
    "$(esc "$UNBOUNDED_AGENT_ID")" "$(esc "$UNBOUNDED_CONDITION")"
}

{
  envelope unbounded_op
  printf ',"operation":"%s","collection":"%s","success":%s,"exit_code":%d,"duration_ms":%d}\n' \
    "$(esc "$OP")" "$(esc "$COLL")" "$SUCCESS" "$CODE" "$DUR"

  # A successful mutation is also a database write. Correlates to the change
  # stream by (collection, document_id); carries the attribution the change
  # stream cannot know.
  if [ "$SUCCESS" = true ]; then
    case "$OP" in
      insert|update|delete)
        DOC_ID=$(printf '%s' "$OUT" | grep -o '"\$oid":"[0-9a-f]*"' | head -1 | cut -d'"' -f4)
        # Only `insert` echoes an id. For update/delete it is the argument after
        # the collection -- which the agent may have omitted, so fall back the
        # same way the executable resolves it.
        if [ -z "$DOC_ID" ]; then
          if [ -n "$RESOLVED_COLL" ] && [ "$RESOLVED_COLL" = "${2:-}" ]; then
            DOC_ID="${3:-}"
          else
            DOC_ID="${2:-}"
          fi
        fi
        if [ -n "$DOC_ID" ]; then
          EVENT_ID=$(new_event_id)
          envelope db_write
          printf ',"operation":"%s","collection":"%s","document_id":"%s"' \
            "$(esc "$OP")" "$(esc "$COLL")" "$(esc "$DOC_ID")"
          [ -n "$FINGERPRINT" ] && printf ',"schema_fingerprint":"%s"' "$FINGERPRINT"
          printf '}\n'
        fi
        ;;
    esac
  fi
} >>"$UNBOUNDED_TELEMETRY" 2>/dev/null

exit $CODE
