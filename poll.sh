#!/usr/bin/env bash
DBURL="postgresql://postgres:JbgldMeRYscuCxxjgbVjHsYIiBKGkIjJ@interchange.proxy.rlwy.net:39905/railway"
OUT="C:/Users/firer/GrantFlow/.claude/worktrees/agent-a7f5a7dbae3448a27/poll.log"
: > "$OUT"
for i in 1 2 3 4 5 6 7 8 9; do
  T=$(psql -tA -c "SELECT count(*) FROM grants WHERE matcher_version='robert-source-acquisition'" "$DBURL" 2>&1)
  echo "poll $i @ $(date +%H:%M:%S): total=$T" >> "$OUT"
  sleep 45
done
echo "DONE" >> "$OUT"
