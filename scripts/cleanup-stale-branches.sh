#!/usr/bin/env bash
# cleanup-stale-branches.sh
# Lists (or deletes) remote branches that are fully merged into main.
#
# Usage:
#   ./scripts/cleanup-stale-branches.sh             # dry-run: list branches
#   ./scripts/cleanup-stale-branches.sh --execute   # actually delete branches

set -euo pipefail

EXECUTE=false
if [[ "${1:-}" == "--execute" ]]; then
  EXECUTE=true
fi

PROTECTED=("main" "master" "develop" "production")

# Fetch latest remote state
git fetch --prune origin

MERGED=$(git branch -r --merged origin/main | grep -v 'origin/main' | sed 's|origin/||' | tr -d ' ')

stale=()
for branch in $MERGED; do
  skip=false
  for protected in "${PROTECTED[@]}"; do
    if [[ "$branch" == "$protected" ]]; then
      skip=true
      break
    fi
  done
  if [[ "$skip" == "false" ]]; then
    stale+=("$branch")
  fi
done

count=${#stale[@]}

if [[ $count -eq 0 ]]; then
  echo "No stale merged branches found."
  exit 0
fi

if [[ "$EXECUTE" == "false" ]]; then
  echo "Dry-run: the following $count branch(es) would be deleted:"
  for b in "${stale[@]}"; do
    echo "  - $b"
  done
  echo ""
  echo "Run with --execute to delete them."
else
  echo "Deleting $count stale branch(es)..."
  for b in "${stale[@]}"; do
    git push origin --delete "$b"
    echo "  deleted: $b"
  done
  echo "Done. $count branch(es) deleted."
fi
