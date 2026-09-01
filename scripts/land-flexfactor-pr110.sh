#!/usr/bin/env bash
# Land the FlexFactor option-4 apply-path that is still missing from
# origin/main after PR #110 merged (CI wire only).
#
# Local source of truth: /home/ubuntu/flexfactor tip 462fb37
# (skip 06c7d10 — already on main).
#
# Run this ONLY from a session with write to buckeye7066/flexfactor.
# GrantFlow-scoped tokens will 403 — that is expected; do not retry.
set -euo pipefail

REPO="${FLEXFACTOR_REPO:-buckeye7066/flexfactor}"
BRANCH="${FLEXFACTOR_PR_BRANCH:-fix/option4-apply-path}"
BASE_REF="${FLEXFACTOR_PR_BASE_REF:-main}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PATCH="${FLEXFACTOR_PATCH:-$HERE/docs/agent-sync/flexfactor-pr110-landing.patch}"
WORKDIR="${FLEXFACTOR_WORKDIR:-/tmp/flexfactor-option4-land}"
LOCAL_SRC="${FLEXFACTOR_LOCAL:-/home/ubuntu/flexfactor}"

echo "checking write on $REPO ..."
if ! gh api "repos/$REPO" --jq '.permissions.push' | grep -qx true; then
  echo "NO WRITE on $REPO (permissions.push is not true)." >&2
  echo "Start a FlexFactor-scoped cloud agent and re-run this script." >&2
  exit 3
fi

rm -rf "$WORKDIR"
gh repo clone "$REPO" "$WORKDIR" -- --branch "$BASE_REF"
cd "$WORKDIR"
git fetch origin "$BASE_REF"
git checkout -B "$BRANCH" "origin/$BASE_REF"
echo "branch $BRANCH at $(git rev-parse --short HEAD)"

if [[ -d "$LOCAL_SRC/.git" ]]; then
  echo "cherry-picking 7aab5ec..462fb37 from $LOCAL_SRC (skip already-landed CI wire)"
  git fetch "$LOCAL_SRC" cursor/pr110-ci-wire-a427
  # 06c7d10 is the CI wire already on main; start AFTER it.
  if ! git cherry-pick 7aab5ec^..462fb37; then
    echo "cherry-pick conflicted against current main. Resolve, then:" >&2
    echo "  git cherry-pick --continue && git push -u origin $BRANCH" >&2
    exit 4
  fi
elif [[ -f "$PATCH" ]]; then
  echo "applying $PATCH (first commit is the already-landed CI wire)"
  if ! git am --3way "$PATCH"; then
    echo "skipping already-landed first commit if it is the CI wire"
    git am --skip
  fi
else
  echo "need $LOCAL_SRC or $PATCH" >&2
  exit 2
fi

echo "running named-return + purpose-fit + stale-certifier guards ..."
python3 -m unittest \
  flexfactor_tests.RelComponentsTests.test_independent_final_review_approves_stale_and_style_reject \
  flexfactor_tests.CompetitorBridgeLedgerTests.test_invalid_acceptance_mapping_is_rejected_and_accounted \
  flexfactor_tests.IncompleteReviewLedgerTests.test_already_satisfied_finding_never_enters_the_fix_stream \
  -q

git push -u origin "$BRANCH"
NEW_HEAD="$(git rev-parse HEAD)"
echo "pushed $NEW_HEAD to $BRANCH"
echo "open a NEW PR against main (do not reopen #110)."
echo "merge only after a NEW production-readiness run on $NEW_HEAD is green on both OS jobs"
