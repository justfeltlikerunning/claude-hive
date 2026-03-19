#!/bin/bash
# smart-heartbeat.sh v3 — Only spawns orchestrator agent if NEW issues found
# Configure AGENTS, HIVELOG, ORCHESTRATOR in the variables below.
set -euo pipefail

# ── Config (edit these for your deployment) ────────────────────────────────
AGENTS_DIR="${HOME}/agents"
SYNAPSE="http://localhost:18789"
HIVELOG="${HIVELOG_URL:-http://localhost:3000}"
LOGS_DIR="${HOME}/logs"
OPS_FILE="${HOME}/shared/FLEET-OPS.md"
STATE_FILE="${HOME}/logs/.heartbeat-state"
ORCHESTRATOR="${ORCHESTRATOR_AGENT:-agent-orchestrator}"

# Space-separated list of agent names to check for failed tasks
AGENTS="${HEARTBEAT_AGENTS:-agent-orchestrator agent-data agent-monitor}"

DATE=$(date +%Y-%m-%d)
TIME=$(date +%H:%M:%S)
ISSUES=""

# Load last known state
LAST_CB_FAILS=0
LAST_JOB_FAILS=0
if [ -f "$STATE_FILE" ]; then
  source "$STATE_FILE" 2>/dev/null || true
  # Reset state if date changed
  if [ "${STATE_DATE:-}" != "$DATE" ]; then
    LAST_CB_FAILS=0
    LAST_JOB_FAILS=0
  fi
fi

# 1. Check for NEW failed tasks in TASKS.md (only alert on increase)
for agent in $AGENTS; do
  TASKS_FILE="$AGENTS_DIR/$agent/TASKS.md"
  if [ -f "$TASKS_FILE" ]; then
    FAILED=$(grep -c "| failed" "$TASKS_FILE" 2>/dev/null || true)
    FAILED=${FAILED:-0}
    # Compare against last known count for this agent
    # Use safe variable name (replace hyphens with underscores)
    SAFE_NAME=$(echo "$agent" | tr '-' '_')
    LAST_VAR="LAST_TASK_FAILS_${SAFE_NAME}"
    LAST_COUNT=${!LAST_VAR:-0}
    if [ "$FAILED" -gt "$LAST_COUNT" ] 2>/dev/null; then
      NEW_FAILS=$((FAILED - LAST_COUNT))
      ISSUES="$ISSUES\n- $agent has $NEW_FAILS NEW failed task(s) (total: $FAILED)"
    fi
    eval "CURRENT_TASK_FAILS_${SAFE_NAME}=$FAILED"
  fi
done

# 2. Check synapse health
HEALTH=$(curl -sf -m 5 "$SYNAPSE/health" 2>/dev/null || echo '{"status":"down"}')
STATUS=$(echo "$HEALTH" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status','down'))" 2>/dev/null || echo "down")
if [ "$STATUS" != "ok" ]; then
  ISSUES="$ISSUES\n- Synapse is $STATUS"
fi

# 3. Check for NEW callback failures (only alert on increase)
LOG_FILE="$LOGS_DIR/synapse-$DATE.log"
if [ -f "$LOG_FILE" ]; then
  CB_FAILS=$(grep -c "Callback failed" "$LOG_FILE" 2>/dev/null || true)
  CB_FAILS=${CB_FAILS:-0}
  if [ "$CB_FAILS" -gt "$LAST_CB_FAILS" ] 2>/dev/null; then
    NEW_CB=$((CB_FAILS - LAST_CB_FAILS))
    ISSUES="$ISSUES\n- $NEW_CB NEW callback failure(s) (total: $CB_FAILS today)"
  fi

  JOB_FAILS=$(grep -c "Job failed" "$LOG_FILE" 2>/dev/null || true)
  JOB_FAILS=${JOB_FAILS:-0}
  if [ "$JOB_FAILS" -gt "$LAST_JOB_FAILS" ] 2>/dev/null; then
    NEW_JF=$((JOB_FAILS - LAST_JOB_FAILS))
    ISSUES="$ISSUES\n- $NEW_JF NEW job failure(s) (total: $JOB_FAILS today)"
  fi
fi

# 4. Check FLEET-OPS.md for open escalations
if [ -f "$OPS_FILE" ]; then
  OPEN=$(grep -cP "^- Status: open$" "$OPS_FILE" 2>/dev/null || true)
  OPEN=${OPEN:-0}
  if [ "$OPEN" -gt 0 ] 2>/dev/null; then
    ISSUES="$ISSUES\n- $OPEN open escalation(s) in FLEET-OPS.md"
  fi
fi

# 5. Check HiveLog reachability
HIVE_OK=$(curl -sf -m 5 "$HIVELOG/api/health" 2>/dev/null || echo "")
if [ -z "$HIVE_OK" ]; then
  ISSUES="$ISSUES\n- HiveLog ($HIVELOG) is unreachable"
fi

# Save current state (so next run only alerts on NEW issues)
{
  echo "STATE_DATE=\"$DATE\""
  echo "LAST_CB_FAILS=${CB_FAILS:-0}"
  echo "LAST_JOB_FAILS=${JOB_FAILS:-0}"
  for agent in $AGENTS; do
    SAFE_NAME=$(echo "$agent" | tr '-' '_')
    VAR="CURRENT_TASK_FAILS_${SAFE_NAME}"
    echo "LAST_TASK_FAILS_${SAFE_NAME}=${!VAR:-0}"
  done
} > "$STATE_FILE"

if [ -n "$ISSUES" ]; then
  PROMPT="HEARTBEAT ALERT ($DATE $TIME) — NEW issues detected:\n$ISSUES\n\nDiagnose each NEW issue. Check agent memory and synapse logs. Write findings to memory. Escalate to FLEET-OPS.md if needed."

  RESPONSE=$(curl -sf -m 10 "$HIVELOG/api/tasks" \
    -H "Content-Type: application/json" \
    -d "{\"agent\": \"$ORCHESTRATOR\", \"prompt\": $(echo -e "$PROMPT" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read().strip()))'), \"source\": \"alert\"}" \
    2>/dev/null || echo "")

  if [ -n "$RESPONSE" ]; then
    TASK_ID=$(echo "$RESPONSE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
    if [ -n "$TASK_ID" ]; then
      curl -sf -m 600 "$HIVELOG/api/tasks/$TASK_ID/run" -X POST 2>/dev/null || true
    fi
  else
    curl -sf -m 300 "$SYNAPSE/spawn/$ORCHESTRATOR" \
      -H "Content-Type: application/json" \
      -d "{\"task\": $(echo -e "$PROMPT" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read().strip()))'), \"source\": \"alert\"}" \
      2>/dev/null || true
  fi
else
  MEMORY_FILE="$AGENTS_DIR/$ORCHESTRATOR/memory/$DATE.md"
  if [ ! -f "$MEMORY_FILE" ]; then
    echo "# $DATE — Daily Log" > "$MEMORY_FILE"
    echo "" >> "$MEMORY_FILE"
  fi
  echo "- [$TIME] HEARTBEAT_OK (no new issues)" >> "$MEMORY_FILE"
fi
