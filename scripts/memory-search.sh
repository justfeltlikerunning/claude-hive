#!/bin/bash
# Search all agent memories
# Usage: memory-search.sh "keyword" [days]
QUERY="$1"
DAYS="${2:-30}"
if [ -z "$QUERY" ]; then
    echo "Usage: memory-search.sh <keyword> [days]"
    exit 1
fi

AGENTS_DIR="$HOME/agents"
echo "=== Searching all agent memories for: $QUERY ==="
for agent_dir in "$AGENTS_DIR"/*/; do
    agent=$(basename "$agent_dir")
    RESULTS=$(find "$agent_dir/memory/" -name '*.md' -mtime -$DAYS -exec grep -lin "$QUERY" {} \; 2>/dev/null)
    if [ -n "$RESULTS" ]; then
        echo ""
        echo "--- $agent ---"
        for f in $RESULTS; do
            echo "$f:"
            grep -n -i "$QUERY" "$f" | head -5
        done
    fi
done
