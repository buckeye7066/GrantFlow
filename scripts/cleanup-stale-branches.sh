#!/usr/bin/env bash
# cleanup-stale-branches.sh
#
# Lists stale remote branches and optionally deletes them.
#
# Usage:
#   bash scripts/cleanup-stale-branches.sh           # dry-run (lists branches only)
#   bash scripts/cleanup-stale-branches.sh --execute  # actually deletes branches
#
# Protected branches (never deleted): main, master, develop, production

set -euo pipefail

EXECUTE=false
PROTECTED_BRANCHES=("main" "master" "develop" "production")

# Parse arguments
for arg in "$@"; do
  case "$arg" in
    --execute)
      EXECUTE=true
      ;;
    --help|-h)
      sed -n '2,14p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--execute]" >&2
      exit 1
      ;;
  esac
done

# Fetch latest remote state
echo "Fetching remote branch list..."
git fetch --prune origin 2>/dev/null || true

# Build list of stale branches: merged into HEAD and not protected
stale=()
while IFS= read -r branch; do
  # Strip leading whitespace and remote prefix
  branch="${branch#  }"
  branch="${branch#* }"
  short="${branch#origin/}"

  # Skip protected branches
  skip=false
  for protected in "${PROTECTED_BRANCHES[@]}"; do
    if [[ "$short" == "$protected" ]]; then
      skip=true
      break
    fi
  done
  $skip && continue

  stale+=("$short")
done < <(git branch -r --merged origin/main 2>/dev/null | grep -v 'HEAD' | grep 'origin/' || true)

if [[ ${#stale[@]} -eq 0 ]]; then
  echo "No stale branches found (all remote branches are unmerged or protected)."
  exit 0
fi

echo ""
echo "Stale branches (merged into main, not protected):"
for branch in "${stale[@]}"; do
  echo "  - $branch"
done
echo ""

if $EXECUTE; then
  echo "Deleting ${#stale[@]} stale branch(es)..."
  for branch in "${stale[@]}"; do
    echo "  Deleting origin/$branch"
    git push origin --delete "$branch"
  done
  echo "Done. ${#stale[@]} branch(es) deleted."
else
  echo "Dry-run mode: no branches were deleted."
  echo "Run with --execute to actually delete the branches above."
fi
