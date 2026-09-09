# Daily email verification follow-ups

The full Windows portfolio run received at 14:04 UTC tested 18 of 19 apps:
63 journeys passed, one failed, and one was blocked. It used GrantFlow
runner revision `02f14dc214f4`. This replaces the earlier targeted-run
coverage impression with a measured full-registry attempt.

## Confirmed causes and changes

- Factory Deck could not prepare its authoritative snapshot. pnpm returned
  `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` while replacing its existing
  modules directory. Frozen installs now set `CI=true` only in their sanitized
  subprocess environment. The frozen lockfile, cache validation, isolated
  workspace ownership, and secret filtering still apply.
- PromoPilot main `5ab5c831eb2a` moved its owner form to `signin.html` and
  labels the password input "Owner key". The old root-page text assertion
  expected "token", which is now only an input attribute. The journey still
  starts at `/` and now verifies the private-workspace redirect, the visible
  password input inside `form#signin`, its owner-key label and submit button.
  It does not enter a credential or invoke a delivery route.
- Production verification after PR #1656 confirmed the scholarship's `varies`
  status but left the stipend unresolved. AcademicWorks puts its program
  description and contact inside `header.section-header.main`, which generic
  `htmlToText` deliberately removes. The structured reader now reads contact
  evidence from the validated heading's own parent, excluding active content.
  An unrelated contact outside that description cannot resolve the award.
  Registry version 5 makes the corrected reader eligible for reconciliation.

## Verification

The headless pnpm regression failed with the measured non-TTY error before
the install change and passed afterward. All 28 git-state guards passed.
The complete edge-runner suite passed 171 tests with one platform-specific
skip and no failures. The live portfolio run provides the pre-change
PromoPilot failure; a fresh Windows run must verify both corrected journeys.
Two additional amount regressions failed before the header-scope repair:
the official description was lost, and an unrelated contact could be borrowed.
Both must pass before publishing; production read-back still gates completion.

Merge requires the normal GitHub checks and `scripts/codex-merge-pr.sh`.
Only a new signed runner receipt can close current portfolio findings.
Historical crawls, Amy's 1/50 cohort and the search spending allowance are
outside this repair and retain their measured status.
