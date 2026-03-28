#!/usr/bin/env bash
# scripts/cleanup-stale-branches.sh
# Clean up stale remote branches that have already been merged or are no longer needed.
#
# Usage:
#   bash scripts/cleanup-stale-branches.sh [--dry-run] [--remote <name>]
#
# Options:
#   --dry-run    Print what would be deleted without actually deleting (default: enabled for safety)
#   --remote     Remote name (default: origin)
#   --force      Actually delete the branches (disables dry-run)
#
# A branch is considered stale if it meets ALL of the following criteria:
#   1. It is fully merged into the default branch (main/master), OR
#   2. Its last commit is older than STALE_DAYS days (default: 90)
#
# Protected branches (main, master, develop, production, staging, release/*) are never deleted.

set -euo pipefail

REMOTE="${REMOTE:-origin}"
STALE_DAYS="${STALE_DAYS:-90}"
DRY_RUN=true
FORCE=false

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)  DRY_RUN=true; shift ;;
    --force)    FORCE=true; DRY_RUN=false; shift ;;
    --remote)   REMOTE="$2"; shift 2 ;;
    --days)     STALE_DAYS="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# //'
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

PROTECTED_PATTERN="^(main|master|develop|development|production|staging|release/.*)$"

echo "=== GrantFlow Stale Branch Cleanup ==="
echo "Remote:     $REMOTE"
echo "Stale days: $STALE_DAYS"
echo "Dry run:    $DRY_RUN"
echo ""

# Fetch latest remote state
echo "Fetching remote state from '$REMOTE'..."
git fetch "$REMOTE" --prune --quiet

# Determine default branch
DEFAULT_BRANCH=$(git remote show "$REMOTE" 2>/dev/null | grep 'HEAD branch' | awk '{print $NF}')
DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"
echo "Default branch: $DEFAULT_BRANCH"
echo ""

# Get cutoff timestamp
CUTOFF_EPOCH=$(date -d "-${STALE_DAYS} days" +%s 2>/dev/null || date -v "-${STALE_DAYS}d" +%s 2>/dev/null || echo 0)

merged=()
stale=()
skipped=()

while IFS= read -r ref; do
  branch="${ref#refs/remotes/$REMOTE/}"

  # Skip HEAD
  [[ "$branch" == "HEAD" ]] && continue

  # Skip protected branches
  if echo "$branch" | grep -qE "$PROTECTED_PATTERN"; then
    skipped+=("$branch (protected)")
    continue
  fi

  # Skip default branch
  if [[ "$branch" == "$DEFAULT_BRANCH" ]]; then
    skipped+=("$branch (default branch)")
    continue
  fi

  # Check if merged into default branch
  if git merge-base --is-ancestor "$ref" "$REMOTE/$DEFAULT_BRANCH" 2>/dev/null; then
    merged+=("$branch")
    continue
  fi

  # Check if last commit is older than STALE_DAYS
  last_commit_epoch=$(git log -1 --format="%ct" "$ref" 2>/dev/null || echo 0)
  if [[ "$CUTOFF_EPOCH" -gt 0 && "$last_commit_epoch" -lt "$CUTOFF_EPOCH" ]]; then
    last_commit_date=$(git log -1 --format="%cd" --date=short "$ref" 2>/dev/null || echo "unknown")
    stale+=("$branch (last commit: $last_commit_date)")
  fi
done < <(git for-each-ref --format="%(refname)" "refs/remotes/$REMOTE/")

echo "--- Merged branches (${#merged[@]}) ---"
for b in "${merged[@]}"; do echo "  $b"; done

echo ""
echo "--- Old branches not merged (${#stale[@]} older than ${STALE_DAYS}d) ---"
for b in "${stale[@]}"; do echo "  $b"; done

echo ""
echo "--- Skipped (${#skipped[@]}) ---"
for b in "${skipped[@]}"; do echo "  $b"; done

total=$(( ${#merged[@]} + ${#stale[@]} ))
echo ""
echo "Total to delete: $total"

if [[ "$total" -eq 0 ]]; then
  echo "Nothing to clean up."
  exit 0
fi

if [[ "$DRY_RUN" == "true" ]]; then
  echo ""
  echo "DRY RUN — no branches were deleted."
  echo "Re-run with --force to actually delete them."
  exit 0
fi

# Confirm before deleting
if [[ "$FORCE" != "true" ]]; then
  read -rp "Delete $total branches from '$REMOTE'? [y/N] " confirm
  [[ "$confirm" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }
fi

echo ""
echo "Deleting merged branches..."
for b in "${merged[@]}"; do
  echo "  Deleting $REMOTE/$b ..."
  git push "$REMOTE" --delete "$b" || echo "  WARNING: failed to delete $b"
done

echo "Deleting stale branches..."
for entry in "${stale[@]}"; do
  b="${entry%% (*}"
  echo "  Deleting $REMOTE/$b ..."
  git push "$REMOTE" --delete "$b" || echo "  WARNING: failed to delete $b"
done

echo ""
echo "Done. Deleted $total branches."
