#!/usr/bin/env bash
# Merge one pull request, but ONLY on green CI evidence.
#
# Usage:  scripts/codex-merge-pr.sh <pr-number> [--timeout-min N]
#
# WHY THIS EXISTS
#   `main` auto-deploys to Vercel production, and this repo has no branch
#   protection (removed by owner order 2026-08-20), so GitHub itself will happily
#   merge a red PR. Nothing upstream enforces "verified before merge" any more, so
#   the evidence gate has to live here, in the merge step.
#
#   This gate evaluates EVIDENCE: nobody is asked for
#   permission. Checks green -> it merges, by itself, immediately. Checks red or
#   missing -> it refuses and says exactly why. There is no dry-run mode and no
#   "would have merged" path; every run either merges or fails out loud.
#
#   It is also NOT a background sweeper. It merges exactly the one PR number you
#   hand it. The repo already has .github/workflows/auto-merge-recent-prs.yml for
#   scheduled sweeping; a second competing sweeper would be a defect. (Note that
#   that workflow additionally requires operator action, which is why it never
#   merges agent-authored PRs -- this script is the path that does.)
set -euo pipefail

PR="${1:-}"
TIMEOUT_MIN=30
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --timeout-min) TIMEOUT_MIN="${2:?--timeout-min needs a value}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "REFUSED: $*" >&2; exit 1; }

case "$PR" in
  ''|*[!0-9]*) echo "usage: $0 <pr-number> [--timeout-min N]" >&2; exit 2 ;;
esac

command -v gh >/dev/null 2>&1 || die "gh is not installed"
gh api user --jq .login >/dev/null 2>&1 \
  || die "gh is not authenticated (or api.github.com is unreachable from here).
  In a Codex container this means the setup script did not run, or the agent-phase
  network allowlist does not permit api.github.com."

read -r AUTHOR BASE STATE IS_DRAFT <<<"$(
  gh pr view "$PR" --json author,baseRefName,state,isDraft \
    --jq '[.author.login, .baseRefName, .state, (.isDraft|tostring)] | @tsv'
)" || die "could not read PR #$PR"

echo "PR #$PR  author=$AUTHOR  base=$BASE  state=$STATE  draft=$IS_DRAFT"

[ "$STATE" = "OPEN" ] || die "PR #$PR is $STATE, not OPEN"
[ "$IS_DRAFT" = "false" ] || die "PR #$PR is a draft"

# Never sweep up other automation's work. This script is for PRs the calling agent
# owns; Dependabot and friends have their own lifecycle.
case "$AUTHOR" in
  dependabot|dependabot[bot]|renovate|renovate[bot]|github-actions|github-actions[bot])
    die "PR #$PR is authored by $AUTHOR -- out of scope for this script" ;;
esac

# --- Wait for checks to settle, then judge them -----------------------------
deadline=$(( $(date +%s) + TIMEOUT_MIN * 60 ))
while :; do
  checks="$(gh pr checks "$PR" --json name,bucket 2>/dev/null || echo '[]')"

  # `gh pr checks` exits non-zero when checks are failing/pending, hence the
  # `|| echo` above -- judge the DATA, never the exit code.
  n_total=$(jq 'length' <<<"$checks")
  if [ "$n_total" -eq 0 ]; then
    die "PR #$PR reports no checks at all. Refusing to merge unverified work to a
  branch that auto-deploys. If this PR genuinely has no CI, merge it by hand
  deliberately."
  fi

  failed=$(jq -r '[.[] | select(.bucket=="fail" or .bucket=="cancel") | .name] | join(", ")' <<<"$checks")
  pending=$(jq -r '[.[] | select(.bucket=="pending") | .name] | join(", ")' <<<"$checks")

  if [ -n "$failed" ]; then
    die "PR #$PR has failing/cancelled checks: $failed
  Not merging. Fix the failures and re-run; do not merge past red CI."
  fi

  [ -z "$pending" ] && break

  now=$(date +%s)
  if [ "$now" -ge "$deadline" ]; then
    die "PR #$PR still has pending checks after ${TIMEOUT_MIN}m: $pending
  Not merging on incomplete evidence."
  fi
  echo "waiting on: $pending  ($(( (deadline - now) / 60 ))m budget left)"
  sleep 30
done

# The two jobs that actually run this repo's suites must be PRESENT and passing.
# "Nothing is failing" is not the same as "the tests ran" -- a PR whose test job
# never reported would otherwise sail through.
for required in test test-suite; do
  got=$(jq -r --arg n "$required" '[.[] | select(.name==$n) | .bucket] | join(",")' <<<"$checks")
  [ -n "$got" ] || die "required check '$required' never reported on PR #$PR -- refusing to merge."
  [ "$got" = "pass" ] || die "required check '$required' is '$got', not pass."
done
echo "evidence OK: $(jq 'length' <<<"$checks") checks reported, none failing, 'test' and 'test-suite' both pass"

# --- Conflicts --------------------------------------------------------------
MERGEABLE="$(gh pr view "$PR" --json mergeable --jq .mergeable)"
[ "$MERGEABLE" = "MERGEABLE" ] \
  || die "PR #$PR is not mergeable (mergeable=$MERGEABLE). Rebase it onto its base first."

# --- Merge ------------------------------------------------------------------
echo "merging PR #$PR (squash, delete branch)..."
gh pr merge "$PR" --squash --delete-branch \
  || die "gh pr merge failed for PR #$PR (token lacks merge rights, or the PR changed underneath us)"

# Confirm from GitHub, not from the exit code. NOTE: gh 2.98 has no `merged`
# field on `gh pr view --json`; mergedAt is the one that exists.
MERGED_AT="$(gh pr view "$PR" --json mergedAt --jq '.mergedAt // ""')"
[ -n "$MERGED_AT" ] \
  || die "gh pr merge reported success but PR #$PR has no mergedAt -- it is NOT merged."
echo "MERGED: PR #$PR into $BASE at $MERGED_AT"
