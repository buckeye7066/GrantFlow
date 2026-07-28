# GrantFlow production-audit corrections — 2026-07-28

This record documents the five remaining defects confirmed against the current `main` branch after the July 28 production audit and corrected in PR #1026.

## Corrected behaviors

1. **Hamilton task scoping**
   - A non-admin request carrying `profile_id` now returns tasks for that accessible profile only.
   - An inaccessible requested profile returns `403`.
   - Aggregation across accessible profiles occurs only when no profile filter is supplied.

2. **Submission evidence**
   - `completed`, `completed_draft`, and `draft_completed` no longer appear as submitted applications.
   - A Hamilton task is presented as `submitted` only when its status is `submitted` and `submitted_at` is persisted.

3. **Amy metric consistency**
   - Amy's cohort metric and finding generator now share one false-positive rule: generic-only, non-locator, and still certified `ACCEPT`.
   - Locator resources remain visible but do not count as direct-funding coverage.
   - Floor sweeps use the active data-point scale rather than the retired 50–90 scale.

4. **Funding versus resources**
   - Directory and referral resources no longer inflate the profile's direct funding-source total.
   - The API returns direct opportunities in `sources` and resources separately in `directories` with `resource_count`.

5. **Canonical directory decision guard**
   - The canonical matcher demotes a directory/referral `ACCEPT` to `REVIEW` with an explicit explanation.
   - The invariant therefore applies to every caller, not only the crawler compatibility facade.

## Verification performed before the correction commit

The one-shot branch verifier performed the following in order and committed only after every step succeeded:

- focused regression suite, including the new production-audit correction tests;
- existing Amy, need-anchored scoring, and funding-source access tests;
- `npm run check:prepush`;
- `npm run scan:secrets`;
- `git diff --check` on the staged patch.

The verifier removed its own temporary workflow and patch scripts before creating the correction commit. No production database writes, portal submissions, credential reads, or session exports were part of this correction set.
