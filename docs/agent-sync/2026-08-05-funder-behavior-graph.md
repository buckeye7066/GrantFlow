# 2026-08-05 — The funder-behavior graph (itemized 990 giving) — PR #1166

**Read this if you touch matching, enforceInvariants, matchSurfacing, or the
990/foundation lanes.**

## What landed

- **Two new tables**: `grant_transactions` (one row per itemized grant a funder
  filed — 990-PF Part XV / 990 Schedule I) and `funder_990_ingest_state`
  (per-EIN burn/retry state). Migrations sqlite `161` / pg `0165`.
- **Two new boot steps** (totality **54 → 56**, pinned in
  `enforceInvariants.test.js`): `funder_990_ingest` (bounded: 3 funders/boot,
  20s, env-gated `ENFORCE_FUNDER_990_INGEST`) and `funder_behavior_recall`
  (env-gated `ENFORCE_FUNDER_BEHAVIOR_RECALL`), placed between
  `county_crisis_need_recall` and `catalog_rescore_convergence`.
- **One new matcher_version**: `funder-behavior-link`, registered in
  `SURFACED_MATCHER_VERSIONS` (and pinned in `matchSurfacing.test.js`). The
  crawler-os reconcile's DELETE deliberately does not name it. Its rows are
  engine ACCEPT/**REVIEW** — a funder row structurally lacks an apply_url, so
  the engine downgrades its ACCEPTs to REVIEW; do NOT "tighten" this net to
  ACCEPT-only, that makes it inert by construction (measured 2026-08-05).
- **New direct dependency**: `fast-xml-parser` (was override-only, never
  installed).
- **New config**: `backend/config/funderBehavior.js` — imports
  `DECLARED_NEED_FIELDS`/`HOUSING_INSTABILITY_FLAGS` from
  `crisisNeedRecall.js` (import-only; if you change that registry, this
  consumer follows automatically).

## The data chain (live-verified 2026-08-05)

ProPublica org page (open; `download-xml?object_id=<18 digits>` links) →
GivingTuesday 990 data lake
(`gt990datalake-rawdata.s3.amazonaws.com/EfileData/XmlFiles/<oid>_public.xml`,
keyless) → parse. **ProPublica's own download-xml endpoint is bot-walled and
its JSON API carries no object ids** — do not "simplify" the chain onto
either; both dead ends are measured in the PR.

## Merge-order rule (the two-green-PRs class)

This PR shares `enforceInvariants.js`/`.test.js` and `matchSurfacing.js`/
`.test.js` seams with #1148 and #1161. Whichever merges second MUST re-run the
first's suites — the totality pins (`ran = 56`, the step-name array, the
versions array) are the tripwires. If you add a boot step after this lands,
the count moves 56 → 57, and so on.

## Named follow-ups (not in this PR)

- A nightly-budget ingest lane (the boot budget deliberately covers only
  3 funders/boot; prod coverage accrues across boots).
- Recipient-similarity beyond state+need (NTEE class of recipients, award-size
  vs need scale).
- First prod-boot measurement: read `system_kv enforce_invariants_last_run`
  for `funder_990_ingest` / `funder_behavior_recall` scanned/linked/rejected.
