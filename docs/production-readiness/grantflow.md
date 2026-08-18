# GrantFlow production readiness

**Executor:** ChatGPT  
**Sole ACTIVE_APP:** GrantFlow  
**Updated:** 2026-08-18  
**Status:** REVIEWING  
**Repository:** `buckeye7066/GrantFlow`  
**Verified default branch:** `main`  
**Current main SHA:** `735bc331d9e73619a14d8f8db5b560c72ee0471c`

This document records evidence. It is not, by itself, proof that GrantFlow is production ready.

## Current checkpoint (2026-08-18)

The 2026-08-10 record below still describes implemented product behavior. These
release-tracking facts in that record are **stale and must not be chased**:

- PR **#1194** merged 2026-08-12. It is not an open merge blocker.
- Persistence repair (atomic invoice counters, extras bootstrap, last stubs)
  landed as PR **#1266** / `3060385`.
- Allocated invoice numbers cannot be rewritten by PUT: PR **#1270** /
  `735bc331`.

GrantFlow remains a live **controlled beta**, not Production Ready.

Remaining owner-ops before a `PRODUCTION READY` decision:

1. Exact-SHA Vercel frontend and Railway backend deploy proof for current `main`.
2. Production mission health: 100% visible direct opportunities freshly link
   verified, and at least 95% of the complete visible catalog freshly link
   verified.
3. Amy recovery and the required 50-profile cohort evidence.
4. Authenticated end-to-end production journeys.
5. Hamilton / external-portal handoff evidence. Hamilton stays fixture-only in
   controlled beta (`controlledBetaBrowserPolicy.js`); do not widen it for a
   marketing screenshot.

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
| Default branch | `main` @ `735bc331` |
| Production-hardening PR | `#1194` merged 2026-08-12 |
| Persistence PR | `#1266` / `3060385` |
| Invoice immutability PR | `#1270` / `735bc331` |
| Frontend production target | Vercel target behind `app.axiombiolabs.org` |
| Backend production target | Railway target behind `grantflow-production.up.railway.app` |
| Local Windows launcher | Not claimed as verified in this record |

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

## Remaining gates

1. Exact merged-SHA CI on current `main`.
2. The exact `main` SHA deployed to both Vercel and Railway.
3. `/deployment-version.json`, `/release-identity.json`, and `/api/version` agree on that SHA.
4. Production mission health proves the 100% visible-direct and 95% complete-catalog link gates.
5. Representative cohort/manual-search comparison, Amy recovery/cohort, and Hamilton/portal handoffs.
6. A fresh review finds no unresolved release-blocking issue.

## Current truthful decision

**REVIEWING.**

GrantFlow is not Production Ready. Persistence and invoice-number defects that blocked a truthful workspace are repaired on `main`. Owner-ops (exact-SHA dual deploy, live catalog metrics, Amy cohort, authenticated journeys) are not complete.

## Rollback

- After merge: revert through a reviewed PR, redeploy the resulting exact SHA, and rerun database, mission-health, release-identity, and authenticated-journey verification.
- Database migrations remain additive. Rollback must not rewrite `_migrations`; use an explicit compensating migration when schema or data reversal is required.
