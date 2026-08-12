# GrantFlow production readiness

**Executor:** ChatGPT  
**Sole ACTIVE_APP:** GrantFlow  
**Updated:** 2026-08-10  
**Status:** REVIEWING  
**Repository:** `buckeye7066/GrantFlow`  
**Verified default branch:** `main`  
**Release-candidate branch:** `chatgpt/production-ready/grantflow`  
**Pull request:** `#1194`  
**PR base SHA:** `09c72b027049c61a2b050ba0940b3442d92bcdf3`  
**Implementation checkpoint before this evidence update:** `fd90da21530f7b8725cad47e9cb701e9e7a62677`

This document records evidence. It is not, by itself, proof that GrantFlow is production ready.

## Purpose and Acceptance Contract

### Intended users and problem

GrantFlow serves individuals, families, students, nonprofit and community organizations, small businesses, schools, and other legitimate applicants who need help finding and pursuing funding that actually fits their complete profile.

The product must discover real, current, profile-specific sources; explain fit without overstating eligibility; preserve claim and source provenance; distinguish direct opportunities from directories, benefits, referrals, and portals; and support the application journey through documents, deadlines, portal handoffs, approvals, submission boundaries, monitoring, and recovery.

### Primary journey

1. An authenticated user selects or completes an authorized profile.
2. GrantFlow derives only permitted search and matching facts from the profile.
3. Official and reviewed sources are discovered and validated.
4. The canonical matching engine scores and classifies each result.
5. The user receives a truthful result card with source, evidence, resource type, fit explanation, link state, next action, and uncertainty.
6. Direct opportunities may proceed into saved results, application preparation, Hamilton-assisted work, portal handoff, submission controls, and tracking.
7. Directories, benefits, referrals, and portals remain available as typed resources with honest next actions rather than being misrepresented as awards or silently discarded.
8. Failures remain visible and recoverable. No unavailable provider, stale link, missing profile fact, incomplete portal action, 2FA step, signature, or submission boundary may become false success.

### Production acceptance

GrantFlow requires all of the following before a `PRODUCTION READY` decision:

- one authoritative matching and scoring contract;
- missing or null profile facts remain neutral unless a source-defined hard eligibility rule applies;
- current-source and claim-level provenance;
- every visible direct opportunity meets the fresh-link requirement;
- at least 95% of the complete visible catalog is freshly link verified, including benefits, directories, referrals, and portals;
- broken-link repair, quarantine, retry, retirement, and audit evidence reconcile exactly;
- duplicate handling does not inflate results;
- representative profile-cohort evidence and comparison with competent manual search;
- Amy recovery and the required 50-profile cohort evidence;
- honest Hamilton and external-portal handoffs, including 2FA, signatures, and user-controlled submission;
- authenticated end-to-end production journeys;
- complete review with no unresolved release-blocking finding;
- exact frontend, backend, database-migration, and evidence-artifact release identity;
- exact merged-SHA CI, deployment, post-merge review, rollback, and recovery proof.

## Reconciled source of truth

| Item | Current evidence |
|---|---|
| Default branch | `main` |
| Current PR base | `09c72b027049c61a2b050ba0940b3442d92bcdf3` |
| Release-candidate branch | `chatgpt/production-ready/grantflow` |
| Active PR | `#1194`, open and mergeable at this checkpoint |
| Frontend production target | Vercel target behind `app.axiombiolabs.org` |
| Backend production target | Railway target behind `grantflow-production.up.railway.app` |
| Local Windows launcher | Not available through the connected execution environment; not claimed as verified |

## Implemented in the current release candidate

### No-Cost Green Home Upgrades

- Dedicated household path and API for weatherization, insulation, air sealing, heat pumps, eligible HVAC work, geothermal, residential solar/storage, and small residential wind.
- Household-profile gate prevents organization and business profiles from receiving homeowner pathways.
- External discovery receives only broad applicant class and two-letter state.
- Persisted catalog candidates are reloaded and rechecked against the complete server-side profile before promotion.
- Loans, financing, PACE, leases, PPAs, tax credits, rebates, reimbursement-only offers, required purchases, fees, matching funds, cost sharing, and applicant contributions are excluded.
- “Direct install,” “grant funded,” and non-repayment wording are not treated as proof that the household pays nothing.
- Raw web snippets remain unverified even when they point to government domains.
- Link liveness and content review are separate evidence dimensions.
- DOE WAP is retained as a reviewed official no-cost starting path. The federal LIHEAP locator remains review-only until the administering source proves that the particular local service requires no household payment.
- Solar for All references are held out under the retired/rescinded-program guard.
- The route is registered in both full/admin and end-user navigation with localization and route-totality tests.

### Source, privacy, and egress hardening

- Full IPv6 link-local range `fe80::/10` is blocked by the shared SSRF policy, including scoped literals.
- Redirect-hop DNS and socket address protections remain centralized in `safeFetch`.
- Rejected and failed avatar/logo responses dispose of unread bodies.
- Green-home provider failures clear stale prior results rather than showing them as current.
- Search-context tests prove names, contacts, street address, income, disability/medical facts, veteran identifiers, document text, and credentials do not enter the external search request.

### Complete-catalog link lifecycle

Mission health now publishes and gates on two explicit measurements:

1. **Visible direct opportunities:** 100% must be freshly link verified.
2. **Complete visible catalog:** at least 95% must be freshly link verified, with every active, non-hidden row in the denominator, including direct opportunities, benefits, directories, referrals, portals, legacy rows, and rows with a missing URL.

A failed catalog snapshot is itself a release blocker. Resource typing cannot be used to remove an item from the denominator.

### Content-addressed release identity

The release candidate now binds:

- exact provider-reported commit SHA;
- package version;
- ordered Postgres migration filenames, byte lengths, SHA-256 hashes, and migration-set manifest hash;
- ordered SQLite migration filenames, byte lengths, SHA-256 hashes, and migration-set manifest hash;
- the SHA-256 of this release-evidence artifact;
- one canonical release-manifest SHA-256.

Vite emits `/deployment-version.json` and `/release-identity.json`. The backend `/api/version` returns the same release identity plus a database migration comparison against ordered `_migrations` rows. The comparison explicitly states that historical applied bytes are not independently attested; it proves that the production migration-name set maps exactly to the checksummed migration files shipped in the release; historical insertion order remains a separate diagnostic.

The deployment-proof script now requires agreement among the certified Git branch, Vercel receipt, Railway receipt, database migration identity, and evidence-artifact hash.

## Verification completed on the implementation candidate

Disposable validation workflow run `31360502616`, job `93368572487`, completed successfully before producing implementation commit `fd90da21530f7b8725cad47e9cb701e9e7a62677`.

The workflow passed:

- asserted source transformations;
- generated-source syntax and JSON validation;
- focused release-identity tests;
- focused database-migration identity tests;
- complete-catalog mission-health tests;
- full repository lint through `npm run lint:ci`;
- full TypeScript check through `npm run typecheck`;
- production Vite build through `npm run build`;
- removal of all temporary patch scripts and one-shot workflows before commit.

Earlier exact-head checks for this PR also exercised the production Docker image, PostgreSQL migrations, browser smoke journey, CodeQL, SSRF regressions, authorization, green-home policy, privacy minimization, route visibility, and failure-state rendering. Those earlier results must still be repeated or reconciled on the final reviewed candidate and exact merged SHA.

## Fresh human inspection of `fd90da2…`

Reviewed surfaces:

- `backend/services/missionHealthService.js`
- `shared/releaseIdentity.js`
- `scripts/deployment-version-plugin.mjs`
- `backend/routes/version.js`
- `scripts/production-deployment-proof.mjs`
- `vercel.json`
- `Dockerfile`
- route registry and navigation tests
- release-identity and mission-health regression tests

The implementation is internally consistent at this checkpoint. The next gate is the repository’s normal exact-head CI and substantive external review on the evidence-checkpoint commit created from this document update.

## Remaining gates before merge

1. Normal GitHub CI, CodeQL, production-image, browser-smoke, and PostgreSQL migration jobs must pass on one exact final PR head.
2. Vercel preview must build that same exact head.
3. A fresh substantive CodeRabbit review must cover the complete final diff.
4. Every valid review finding and material review thread must be resolved with regression evidence.
5. PR `#1194` must be reconciled with the latest `main` and deliberately merged.
6. CI and security checks must pass on the exact merge SHA.
7. The exact merge SHA must be deployed to both Vercel and Railway.
8. `/deployment-version.json`, `/release-identity.json`, and `/api/version` must agree on code, manifest, evidence artifact, and database migration identity.
9. Production mission health must prove the 100% visible-direct and 95% complete-catalog link gates.
10. Representative cohort/manual-search comparison, Amy recovery/cohort, and Hamilton/portal handoffs must be completed.
11. A fresh post-merge review must find no unresolved release-blocking issue.

## Current truthful decision

**REVIEWING.**

GrantFlow is not being called Production Ready. The current candidate has substantial implementation and validation evidence, but normal exact-head CI, complete fresh review, merge, post-merge CI/review, exact dual deployment, production database identity, live catalog metrics, Amy cohort evidence, Hamilton/portal evidence, and manual-search comparison are not yet all complete.

## Rollback

- Before merge: close PR `#1194` or reset the release-candidate branch to the last reviewed good commit.
- After merge: revert the merge commit through a reviewed PR, redeploy the resulting exact SHA, and rerun database, mission-health, release-identity, and authenticated-journey verification.
- Database migrations remain additive. Rollback must not rewrite `_migrations`; use an explicit compensating migration when schema or data reversal is required.
