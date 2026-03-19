#!/bin/bash
# Consolidated cron runner — creates tasks via HiveLog API
# Tasks appear in the same list as manually created ones, with conversation threading
# Usage: cron-runner.sh <agent> "prompt" [source_label]
set -euo pipefail

AGENT="${1:?Usage: cron-runner.sh <agent> <prompt> [source_label]}"
PROMPT="${2:?Usage: cron-runner.sh <agent> <prompt> [source_label]}"
SOURCE="${3:-cron}"

HIVELOG="$HIVELOG_URL"
SYNAPSE="http://localhost:18789"

# Try HiveLog first (creates task with conversation threading)
RESPONSE=$(curl -sf -m 10 "$HIVELOG/api/tasks" \
    -H "Content-Type: application/json" \
    -d "{\"agent\": \"$AGENT\", \"description\": $(echo "$PROMPT" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read().strip()))'), \"outputFormat\": \"text\", \"source\": \"$SOURCE\"}" \
    2>/dev/null || echo "")

if [ -n "$RESPONSE" ]; then
    TASK_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
    if [ -n "$TASK_ID" ]; then
        # Run the task via HiveLog
        curl -sf -m 600 "$HIVELOG/api/tasks/$TASK_ID/run" \
            -X POST \
            -H "Content-Type: application/json" \
            2>/dev/null || true
        exit 0
    fi
fi

# Fallback: direct to synapse if HiveLog is down
if curl -sf "$SYNAPSE/health" >/dev/null 2>&1; then
    curl -sf -m 300 "$SYNAPSE/spawn/$AGENT" \
        -H "Content-Type: application/json" \
        -d "{\"task\": $(echo "$PROMPT" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read().strip()))'), \"timeout\": 300000}" \
        2>/dev/null || true
fi
