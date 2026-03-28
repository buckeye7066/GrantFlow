#!/usr/bin/env bash
# cleanup-stale-branches.sh
# Interactively prune stale remote-tracking refs and optionally delete merged
# remote branches from GitHub.
#
# Usage:
#   bash scripts/cleanup-stale-branches.sh [--dry-run] [--remote <name>]
#
# Options:
#   --dry-run      Show what would be deleted without making any changes.
#   --remote       Remote name to operate on (default: origin).
#
# Requirements:
#   - git, gh (GitHub CLI) — install gh from https://cli.github.com/

set -euo pipefail

DRY_RUN=false
REMOTE="origin"
MAIN_BRANCH="${DEFAULT_BRANCH:-main}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --remote)  REMOTE="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo "=== GrantFlow stale-branch cleanup ==="
echo "Remote: $REMOTE | Main: $MAIN_BRANCH | Dry-run: $DRY_RUN"
echo ""

# Step 1: Prune stale remote-tracking refs (refs that no longer exist on the remote)
echo "--- Step 1: Pruning stale remote-tracking refs ---"
if $DRY_RUN; then
  git remote prune "$REMOTE" --dry-run
else
  git remote prune "$REMOTE"
  echo "Pruned stale tracking refs from $REMOTE"
fi

# Step 2: Fetch latest state from remote
echo ""
echo "--- Step 2: Fetching latest remote state ---"
git fetch "$REMOTE" --prune

# Step 3: Find branches that are fully merged into the main branch
echo ""
echo "--- Step 3: Finding branches merged into $MAIN_BRANCH ---"
MERGED_BRANCHES=$(git branch -r --merged "$REMOTE/$MAIN_BRANCH" \
  | grep "$REMOTE/" \
  | grep -v "HEAD\|$MAIN_BRANCH\|develop\|staging\|release" \
  | sed "s|$REMOTE/||" \
  | tr -d ' ')

if [[ -z "$MERGED_BRANCHES" ]]; then
  echo "No merged branches found to clean up."
else
  echo "Merged branches eligible for deletion:"
  echo "$MERGED_BRANCHES" | while read -r branch; do
    echo "  - $branch"
  done

  echo ""
  if $DRY_RUN; then
    echo "[DRY RUN] Would delete the above branches from $REMOTE"
  else
    echo "Deleting merged branches from $REMOTE..."
    echo "$MERGED_BRANCHES" | while read -r branch; do
      if git push "$REMOTE" --delete "$branch" 2>/dev/null; then
        echo "  Deleted: $branch"
      else
        echo "  Skipped (already gone or protected): $branch"
      fi
    done
    echo "Done."
  fi
fi

# Step 4: List Copilot/bot branches older than 30 days (informational)
echo ""
echo "--- Step 4: Copilot/bot branches older than 30 days (informational) ---"
CUTOFF=$(date -d "30 days ago" +%s 2>/dev/null || date -v -30d +%s 2>/dev/null || echo 0)
git branch -r \
  | grep "$REMOTE/copilot/" \
  | sed "s|$REMOTE/||" \
  | tr -d ' ' \
  | while read -r branch; do
      LAST_COMMIT=$(git log -1 --format="%ct" "$REMOTE/$branch" 2>/dev/null || echo 0)
      if [[ "$LAST_COMMIT" -lt "$CUTOFF" ]]; then
        HUMAN=$(git log -1 --format="%ar" "$REMOTE/$branch" 2>/dev/null || echo "unknown")
        echo "  stale: $branch (last commit: $HUMAN)"
      fi
    done || echo "  (gh CLI not available or no copilot branches found)"

echo ""
echo "=== Cleanup complete ==="
