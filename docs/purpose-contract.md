# GrantFlow Purpose and Acceptance Contract

**Application:** GrantFlow  
**Executor:** ChatGPT  
**Repository:** `buckeye7066/GrantFlow`  
**Default branch:** `main`  
**Production web:** `https://app.axiombiolabs.org/grantflow`  
**Production API:** `https://grantflow-production.up.railway.app`  
**Contract status:** Binding. The product may not be redefined downward to fit incomplete implementation.

## 1. Intended users

GrantFlow serves individuals, families, students, caregivers, small businesses, nonprofit organizations, schools, churches, community programs, and other legitimate applicants seeking grants, scholarships, public benefits, foundation support, local assistance, and item-specific funding. It also serves authorized GrantFlow operators who maintain the funding catalog, verify sources, review automation, and support applicants.

## 2. Problem the product was created to solve

Funding discovery is fragmented across government sites, foundations, schools, local organizations, directories, and application portals. A user should not need to repeat the same background research, guess which programs fit, or mistake a directory, referral page, expired announcement, or broken link for an actionable opportunity.

GrantFlow must turn a complete user profile into a current, profile-specific, evidence-backed funding workflow that helps the user find, understand, organize, prepare, submit or hand off, and track real opportunities without overstating eligibility, submission, or award status.

## 3. Primary user journey

1. The user securely creates or signs into an account and selects the correct profile.
2. The user enters or updates relevant personal, household, education, employment, organization, location, financial, disability, veteran, project, and item-funding facts, with explicit consent for sensitive or external operations.
3. GrantFlow searches current official and reputable sources, deduplicates results, verifies source identity and links, and classifies each result as a direct opportunity, directory, referral, benefit, portal, or other truthful resource type.
4. GrantFlow applies one authoritative, versioned matching contract and presents the persisted canonical decision, score, explanation, provenance, eligibility evidence, uncertainty, deadline, verification state, and next action.
5. The user saves or dismisses opportunities and can move legitimate opportunities through research, preparation, human review, external handoff, submitted, externally received, awarded, denied, withdrawn, expired, or retired states.
6. Hamilton or another approved workflow may prepare documents and guide the user, but account creation, CAPTCHA, MFA/2FA, signatures, attestations, payment, and irreversible submission remain explicit human gates unless a reviewed official integration proves otherwise.
7. GrantFlow records durable receipts and external evidence. It must never claim submitted, received, approved, or awarded without the corresponding evidence.

## 4. Required inputs

- Authenticated user and active profile identity
- Profile facts and declared goals
- Optional documents, only through secure upload and processing paths
- Search-provider and official-source data
- Opportunity source records, URLs, deadlines, and provenance
- Explicit consent and action-bound approvals for consequential operations
- External portal receipts, confirmations, or owner-entered outcome evidence where automation cannot verify the result

## 5. Required outputs and real-world outcome

GrantFlow must produce:

- Current, profile-specific funding results from official or clearly identified reputable sources
- A canonical decision and score whose displayed value exactly matches the persisted authoritative result
- A clear explanation of fit, missing facts, disqualifiers, uncertainty, source, retrieval/verification date, and resource type
- No direct-opportunity presentation for directories, referral pages, generic search results, quarantined rows, broken links, expired rows, or unsafe records
- A usable application-preparation and handoff path with truthful human gates
- Durable tracking of submission, external receipt, award, denial, withdrawal, expiration, and recovery states
- Evidence sufficient to compare GrantFlow's usefulness against competent manual web research

## 6. Essential integrations

- Vercel production frontend
- Railway production API and workers
- Production PostgreSQL database and migrations
- Current web/search providers and official-source adapters
- AI providers only where they add bounded assistance and never replace source evidence
- Email/SMS services where enabled
- Hamilton application-preparation and portal-handoff workflows
- External portals, MFA, signatures, and payment systems through truthful human or reviewed official integration boundaries

## 7. Accuracy, quality, privacy, security, and data-integrity requirements

- One versioned matching/scoring/decision contract is authoritative across crawler, API, database, Amy, Hamilton, and UI.
- Displayed score, decision, explanation, and provenance must reconcile numerically and semantically with persisted canonical outputs.
- Direct opportunities, benefits, directories, referrals, and historical intelligence remain distinct.
- Direct `ACCEPT` requires actionable source evidence; directories and referrals may never be promoted to direct `ACCEPT` merely because their text resembles the profile.
- Search/provider scores and model self-scores may not silently become GrantFlow eligibility truth.
- Every material claim preserves source identity, retrieval or verification time, and known uncertainty.
- Authentication, authorization, profile/tenant scope, consent, payment caps, rate limits, secret handling, SSRF protection, redirect validation, DNS/socket pinning, upload safety, and audit integrity are enforced server-side.
- Consequential actions require fresh, exact-target, action-bound confirmation. CAPTCHA, MFA, legal attestations, signatures, and payment cannot be bypassed.
- Account deletion may not strand active billing or destroy required receipts without the defined retention and pseudonymization path.

## 8. Failure, cancellation, retry, resume, rollback, and recovery

- Network/provider failures are explicit and retryable; they never become false zero results, false broken links, false submission, or false completion.
- Crawler, verifier, Amy, Hamilton, and background-job operations are idempotent, profile-scoped, lease/fence protected where concurrent, restartable, and observable.
- Broken or unsafe direct links are quarantined. Successful re-verification can restore them; retirement and retry counts must reconcile.
- Ambiguous external submission is not blindly retried. The system performs read-only reconciliation before any repeat action.
- User cancellation leaves a truthful cancelled or draft state and preserves recoverable work.
- Database migrations, deployments, and catalog changes have tested rollback and backup/restore procedures.
- The last known safe release can be restored without losing authoritative application and outcome evidence.

## 9. Release target

The intended release is the exact reviewed default-branch SHA deployed to both:

- `https://app.axiombiolabs.org/grantflow`
- `https://grantflow-production.up.railway.app`

The frontend, API, workers, database schema, and release evidence must identify the same release. A preview deployment, local checkout, documentation commit, or green health endpoint is not the production release.

## 10. Exact acceptance tests before Production Ready

1. **Source and release identity**
   - GitHub `main` is the reconciled source of truth.
   - No production-required work remains in an open PR, abandoned branch, patch, or undeployed commit.
   - Vercel frontend, frontend deployment metadata, Railway `/api/version`, Railway health/readiness, and workers identify the exact final `main` SHA.

2. **Engineering gates**
   - Full formatting/lint, full typecheck, unit, integration, API contract, PostgreSQL migration, security, privacy, accessibility, browser, production-image, and release gates pass on the exact final SHA.
   - Critical concurrency, retry, stale-write, payment-cap, consent, SSRF, DNS-rebinding, redirect, cancellation, and recovery paths have regression tests.

3. **Canonical matching and display parity**
   - Crawler OS, matching APIs, persisted rows, Amy reports, Hamilton inputs, and UI use the same canonical decision contract.
   - Displayed decision, score, explanation, and included/total counts match persisted authoritative values.
   - No generic search URL, directory, referral, quarantined, hidden, broken, unsafe, expired, or retired direct row is presented as an actionable direct opportunity.
   - Duplicate and near-duplicate opportunities reconcile to the correct canonical record without losing source history.

4. **Current-source and link lifecycle**
   - Visible direct opportunities have zero known broken application links at release time.
   - Verified-link rate is at least 95% for the release catalog, with the remainder truthfully classified as retryable, skipped-by-policy, quarantined, or retired.
   - Retry, restore, retirement, and quarantine metrics reconcile with underlying rows.

5. **Representative profile and manual-search comparison**
   - A fresh representative 50-profile Amy cohort completes on the exact release with no stuck or falsely completed profile.
   - Each profile's useful results, omissions, and false positives are compared with a competent manual search using the same profile facts.
   - The report distinguishes official direct opportunities from directories/referrals and records why GrantFlow is better, equal, or worse for each profile without invented success.

6. **Authenticated real journeys**
   - At least three consented, authenticated profile-to-outcome evidence chains run on production.
   - Each chain covers discovery, canonical fit explanation, save/track, preparation, human handoff, and external confirmation or a truthfully evidenced non-submission outcome.
   - Hamilton demonstrates account/session reuse, profile-scoped tasks, consent, document/field provenance, CAPTCHA/MFA/signature/payment human gates, ambiguous-result reconciliation, and durable receipts.

7. **Failure and recovery**
   - At least one search-provider outage, link-verifier failure, worker interruption, ambiguous portal response, and deployment rollback are exercised and inspected.
   - No path reports success before persistence or external confirmation.

8. **Independent review**
   - The complete release receives fresh product, architecture, security, privacy, data-integrity, QA, accessibility, performance, UX, release, and funding-domain review.
   - Zero unresolved P0/P1 findings remain, and no unresolved finding affects purpose, matching truth, privacy, security, billing, submission, deployment, or recovery.

## 11. False or watered-down substitutes

The following do **not** satisfy this contract:

- A page that loads, a health endpoint returning 200, or a green deployment badge
- A generic AI-generated list of grants
- Search results without profile-specific canonical scoring and provenance
- Direct opportunities that are actually directories, referrals, search pages, placeholders, expired notices, or broken links
- Sample profiles, mock portals, synthetic receipts, or a local-only demonstration used in place of real release evidence
- A prepared packet presented as submitted
- A clicked button presented as externally received
- A self-authored readiness report presented as proof
- A merged PR without exact-SHA CI, deployment, authenticated production journeys, and inspected output
- “Software complete,” “ready except for,” or “pending owner action” presented as Production Ready
