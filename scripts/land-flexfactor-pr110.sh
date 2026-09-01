#!/usr/bin/env bash
# Land the FlexFactor PR #110 CI-wire + option-4 apply-path commits
# (12 commits: 06c7d10..f3bfa29).
# Run this ONLY from a session with write to buckeye7066/flexfactor.
# GrantFlow-scoped tokens will 403 — that is expected; do not retry.
set -euo pipefail

REPO="${FLEXFACTOR_REPO:-buckeye7066/flexfactor}"
BRANCH="${FLEXFACTOR_PR_BRANCH:-fix/autoclean-verifies-what-it-commits}"
BASE_SHA="${FLEXFACTOR_PR_BASE_SHA:-634250cffd34298412cdc50fbdc3a9e96b518e35}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PATCH="${FLEXFACTOR_PATCH:-$HERE/docs/agent-sync/flexfactor-pr110-landing.patch}"
WORKDIR="${FLEXFACTOR_WORKDIR:-/tmp/flexfactor-pr110-land}"

if [[ ! -f "$PATCH" ]]; then
  echo "missing patch: $PATCH" >&2
  exit 2
fi

echo "checking write on $REPO ..."
if ! gh api "repos/$REPO" --jq '.permissions.push' | grep -qx true; then
  echo "NO WRITE on $REPO (permissions.push is not true)." >&2
  echo "Start a FlexFactor-scoped cloud agent and re-run this script." >&2
  exit 3
fi

rm -rf "$WORKDIR"
gh repo clone "$REPO" "$WORKDIR" -- --branch "$BRANCH"
cd "$WORKDIR"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"

HEAD="$(git rev-parse HEAD)"
echo "current HEAD=$HEAD"
if [[ "$HEAD" != "$BASE_SHA" && "$HEAD" != "$(git rev-parse --verify "$BASE_SHA" 2>/dev/null || true)" ]]; then
  echo "HEAD is not $BASE_SHA. Applying patch only if the CI wire is still missing."
fi

if ! grep -q 'flexfactor_autoclean_preverify_tests.py' .github/workflows/production-readiness.yml; then
  echo "applying $PATCH"
  git am --3way "$PATCH"
else
  echo "CI wire already present; skipping git am"
fi

echo "running totality + named-return guards ..."
python3 -m unittest \
  flexfactor_invariant_sweep_tests.SweepIsWiredIntoCITests \
  -q

git push origin "HEAD:$BRANCH"
NEW_HEAD="$(git rev-parse HEAD)"
echo "pushed $NEW_HEAD to $BRANCH"
echo "watch: gh run list --repo $REPO --branch $BRANCH --limit 5"
echo "merge only after a NEW production-readiness run on $NEW_HEAD is green on both OS jobs"
