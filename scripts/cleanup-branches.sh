#!/usr/bin/env bash
# =============================================================================
# cleanup-branches.sh
# Deletes all remote branches except 'main' from the GrantFlow repository.
#
# Usage:
#   chmod +x scripts/cleanup-branches.sh
#   ./scripts/cleanup-branches.sh          # dry-run (shows what would be deleted)
#   ./scripts/cleanup-branches.sh --force  # actually delete branches
#
# Prerequisites: git CLI with push access to the remote.
# =============================================================================

set -euo pipefail

FORCE=false
if [[ "${1:-}" == "--force" ]]; then
  FORCE=true
fi

PROTECTED_BRANCH="main"

echo "Fetching latest remote branch list..."
git fetch --prune origin

BRANCHES=$(git branch -r | sed 's|origin/||' | sed 's/^[[:space:]]*//' | grep -v "^${PROTECTED_BRANCH}$" | grep -v "HEAD")

BRANCH_COUNT=$(echo "$BRANCHES" | grep -c . || true)

if [[ "$BRANCH_COUNT" -eq 0 ]]; then
  echo "✅ No branches to delete. Only '${PROTECTED_BRANCH}' exists."
  exit 0
fi

echo ""
echo "Found ${BRANCH_COUNT} branch(es) to delete (keeping '${PROTECTED_BRANCH}'):"
echo "──────────────────────────────────────────"
echo "$BRANCHES"
echo "──────────────────────────────────────────"

if [[ "$FORCE" == false ]]; then
  echo ""
  echo "🔍 DRY RUN — no branches were deleted."
  echo "   Run with --force to delete all branches listed above."
  exit 0
fi

echo ""
echo "🗑️  Deleting ${BRANCH_COUNT} remote branch(es)..."
echo ""

DELETED=0
FAILED=0

while IFS= read -r branch; do
  [[ -z "$branch" ]] && continue
  echo -n "  Deleting origin/${branch}... "
  if git push origin --delete "$branch" 2>/dev/null; then
    echo "✅"
    ((DELETED++))
  else
    echo "❌ (failed or already deleted)"
    ((FAILED++))
  fi
done <<< "$BRANCHES"

echo ""
echo "Done! Deleted ${DELETED} branch(es), ${FAILED} failed."
echo "Only '${PROTECTED_BRANCH}' remains."
