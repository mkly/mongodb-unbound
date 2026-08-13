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
COLL="${2:-}"
# Only the first two positional arguments are recorded. Everything after them is
# agent-authored document or filter content and is deliberately not logged.
case "$COLL" in -*) COLL="" ;; esac

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

# Schema fingerprint: sha256 over the document's sorted top-level key names,
# truncated to 16 hex. Fixed length and free of model-authored text, so it is
# safe to log where the document itself is not -- and it is what makes schema
# convergence visible in the stream rather than only in a post-hoc pass over
# MongoDB. Key NAMES only; no values, and nested structure is not descended.
#
# Every SWE-bench Lite container is a Python repo, so python3 is present. If it
# somehow is not, or the document does not parse, the field is simply omitted --
# a missing fingerprint must never cost us the db_write record.
FINGERPRINT=""
fingerprint_of() {
  [ -n "$1" ] || return 0
  printf '%s' "$1" | python3 -c '
import hashlib, json, sys
try:
    doc = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if not isinstance(doc, dict):
    sys.exit(0)
keys = ",".join(sorted(k for k in doc if k != "_id"))
sys.stdout.write(hashlib.sha256(keys.encode()).hexdigest()[:16])
' 2>/dev/null
}

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
        # `insert <collection> <document>` vs `update <collection> <id> <document>`.
        case "$OP" in
          insert) FINGERPRINT=$(fingerprint_of "${3:-}") ;;
          update) FINGERPRINT=$(fingerprint_of "${4:-}") ;;
        esac
        DOC_ID=$(printf '%s' "$OUT" | grep -o '"\$oid":"[0-9a-f]*"' | head -1 | cut -d'"' -f4)
        [ -z "$DOC_ID" ] && DOC_ID="${3:-}"
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
