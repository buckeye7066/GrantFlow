#!/usr/bin/env bash
# cleanup-stale-branches.sh
# Lists stale remote branches and optionally deletes them.
#
# Usage:
#   bash scripts/cleanup-stale-branches.sh            # dry-run (list only)
#   bash scripts/cleanup-stale-branches.sh --execute  # actually delete branches

set -euo pipefail

EXECUTE=false
REMOTE="${REMOTE:-origin}"

# Protected branches that will never be deleted
PROTECTED_BRANCHES=("main" "master" "develop" "production")

usage() {
  echo "Usage: $0 [--execute]"
  echo ""
  echo "  --execute   Actually delete stale branches (default: dry-run)"
  echo ""
  echo "Protected branches (never deleted): ${PROTECTED_BRANCHES[*]}"
}

is_protected() {
  local branch="$1"
  for protected in "${PROTECTED_BRANCHES[@]}"; do
    if [[ "$branch" == "$protected" ]]; then
      return 0
    fi
  done
  return 1
}

for arg in "$@"; do
  case "$arg" in
    --execute) EXECUTE=true ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $arg"; usage; exit 1 ;;
  esac
done

echo "Fetching remote branch list from '$REMOTE'..."
git fetch --prune "$REMOTE" 2>/dev/null || true

# Get merged branches (already merged into main/master)
echo ""
echo "=== Branches merged into HEAD ==="
MERGED=$(git branch -r --merged HEAD | grep "^  $REMOTE/" | sed "s|  $REMOTE/||" | grep -v "^HEAD" || true)

STALE_BRANCHES=()

while IFS= read -r branch; do
  [[ -z "$branch" ]] && continue
  if is_protected "$branch"; then
    echo "  [protected] $branch"
    continue
  fi
  STALE_BRANCHES+=("$branch")
  echo "  [stale] $branch"
done <<< "$MERGED"

if [[ ${#STALE_BRANCHES[@]} -eq 0 ]]; then
  echo "  (none found)"
fi

echo ""
if [[ "$EXECUTE" == "false" ]]; then
  echo "DRY-RUN mode: no branches were deleted."
  echo "Run with --execute to delete the ${#STALE_BRANCHES[@]} stale branch(es) listed above."
else
  if [[ ${#STALE_BRANCHES[@]} -eq 0 ]]; then
    echo "No stale branches to delete."
  else
    echo "Deleting ${#STALE_BRANCHES[@]} stale branch(es)..."
    for branch in "${STALE_BRANCHES[@]}"; do
      echo "  Deleting $REMOTE/$branch ..."
      git push "$REMOTE" --delete "$branch"
    done
    echo "Done."
  fi
fi
