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
2. The user enters or updates only profile facts that have a documented, tested product consumer and permitted use.
3. GrantFlow derives a minimized search context from those facts. External crawler and search requests may contain only non-sensitive search attributes needed to locate funding, such as broad geography, applicant type, education level, organization type, program area, or requested item category. They must never contain direct identifiers, contact details, account data, uploaded-document contents, precise financial values, disability diagnoses, veteran identifiers, government identifiers, or similarly sensitive facts, regardless of consent.
4. GrantFlow searches current official and reputable sources, deduplicates results, verifies source identity and links, and classifies each result as a direct opportunity, directory, referral, benefit, portal, or other truthful resource type.
5. GrantFlow applies one authoritative, versioned matching contract and presents the persisted canonical decision, score, explanation, provenance, eligibility evidence, uncertainty, deadline, verification state, resource type, and next action.
6. Direct opportunities and typed supporting resources remain available in separate surfaces. A directory, referral, benefit, or portal is retained with its truthful classification and next action unless an explicit, persisted exclusion reason applies; its non-direct status alone is never grounds for silently discarding it.
7. The user saves or dismisses resources and can move legitimate opportunities through research, preparation, human review, external handoff, submitted, externally received, awarded, denied, withdrawn, expired, or retired states.
8. Hamilton or another approved workflow may prepare documents and guide the user, but account creation, CAPTCHA, MFA/2FA, signatures, attestations, payment, and irreversible submission remain explicit human gates unless a reviewed official integration proves otherwise.
9. GrantFlow records durable receipts and external evidence. It must never claim submitted, received, approved, or awarded without the corresponding evidence.

## 4. Profile-field collection and use boundary

Every collected profile field must appear in a versioned field-use registry with:

- field identifier and sensitivity class;
- intended user-facing purpose;
- named internal consumer or workflow;
- whether it may influence ranking, hard eligibility, document preparation, reminders, or display only;
- whether a minimized derivative may enter an external search request;
- retention and deletion behavior;
- regression tests proving the permitted use and preventing prohibited use.

A field without a registered consumer and test is hidden from production collection until the contract exists. Sensitive values may be used internally for source-defined eligibility evaluation or document preparation only when the user has authorized that workflow. Consent does not permit raw sensitive identifiers to enter crawler queries, logs, analytics, model prompts, or third-party search requests.

Examples of permitted minimized search attributes include state or region, broad age band when a source requires it, student grade or degree level, organization category, broad veteran status without identifiers, broad accessibility or disability program category without diagnosis, and funding purpose. Examples of prohibited outbound values include names, emails, phone numbers, street addresses, dates of birth, Social Security or government identifiers, bank or tax data, exact income or asset values, medical details, uploaded-document text, and portal credentials.

## 5. Required inputs

- Authenticated user and active profile identity
- Registered profile facts and declared goals
- Optional documents, only through secure upload and processing paths
- Search-provider and official-source data
- Opportunity source records, URLs, deadlines, and provenance
- Explicit consent and action-bound approvals for consequential operations
- External portal receipts, confirmations, or owner-entered outcome evidence where automation cannot verify the result

## 6. Required outputs and real-world outcome

GrantFlow must produce:

- Current, profile-specific funding results from official or clearly identified reputable sources
- A canonical decision and score whose displayed value exactly matches the persisted authoritative result
- A clear explanation of fit, missing facts, source-defined hard disqualifiers, uncertainty, source, retrieval or verification date, resource type, and next action
- Direct opportunities shown only when their actionable-source and link requirements pass
- Directories, referrals, benefits, and portals retained as typed resources with truthful next actions unless an explicit exclusion reason is persisted
- A usable application-preparation and handoff path with truthful human gates
- Durable tracking of submission, external receipt, award, denial, withdrawal, expiration, and recovery states
- Reproducible evidence comparing GrantFlow with a blinded 30-minute manual search using the same permitted profile facts

## 7. Essential integrations

- Vercel production frontend
- Railway production API and workers
- Production PostgreSQL database and migrations
- Current web/search providers and official-source adapters
- AI providers only where they add bounded assistance and never replace source evidence
- Email/SMS services where enabled
- Hamilton application-preparation and portal-handoff workflows
- External portals, MFA, signatures, and payment systems through truthful human or reviewed official integration boundaries

## 8. Accuracy, quality, privacy, security, and data-integrity requirements

- One versioned matching, scoring, and decision contract is authoritative across crawler, API, database, Amy, Hamilton, and UI.
- Displayed score, decision, explanation, provenance, type, and counts must reconcile numerically and semantically with persisted canonical outputs.
- Direct opportunities, benefits, directories, referrals, portals, and historical intelligence remain distinct.
- Direct `ACCEPT` requires actionable source evidence.
- Directories and referrals may never be promoted to direct `ACCEPT` merely because their text resembles the profile, but they must remain discoverable as typed resources unless explicitly excluded.
- Positive profile evidence may increase confidence or score. Missing, unknown, redacted, or `null` profile fields are neutral and may not reduce a score or exclude a result.
- An opportunity may be excluded only by an explicit hard eligibility rule stated by the authoritative source and evaluated from a known profile fact. Every hard exclusion stores the source text or structured rule, source URL, evaluated fact, rule version, and explanation.
- Search-provider scores and model self-scores may not silently become GrantFlow eligibility truth.
- Every material claim preserves source identity, retrieval or verification time, and known uncertainty.
- Authentication, authorization, profile or tenant scope, consent, payment caps, rate limits, secret handling, SSRF protection, redirect validation, DNS and socket pinning, upload safety, and audit integrity are enforced server-side.
- Consequential actions require fresh, exact-target, action-bound confirmation. CAPTCHA, MFA, legal attestations, signatures, and payment cannot be bypassed.
- Account deletion may not strand active billing or destroy required receipts without the defined retention and pseudonymization path.

## 9. Failure, cancellation, retry, resume, rollback, and recovery

- Network or provider failures are explicit and retryable; they never become false zero results, false broken links, false submission, or false completion.
- Crawler, verifier, Amy, Hamilton, and background-job operations are idempotent, profile-scoped, lease or fence protected where concurrent, restartable, and observable.
- Broken or unsafe direct links are quarantined. Successful re-verification can restore them; retirement and retry counts must reconcile.
- Ambiguous external submission is not blindly retried. The system performs read-only reconciliation before any repeat action.
- User cancellation leaves a truthful cancelled or draft state and preserves recoverable work.
- Database migrations, deployments, and catalog changes have tested rollback and backup or restore procedures.
- The last known safe release can be restored without losing authoritative application and outcome evidence.

## 10. Release target

The intended release is the exact reviewed default-branch SHA deployed to both:

- `https://app.axiombiolabs.org/grantflow`
- `https://grantflow-production.up.railway.app`

The frontend, API, workers, database schema, and release evidence must identify the same release. A preview deployment, local checkout, documentation commit, or green health endpoint is not the production release.

## 11. Exact acceptance tests before Production Ready

### 11.1 Source and release identity

- GitHub `main` is the reconciled source of truth.
- No production-required work remains in an open PR, abandoned branch, patch, or undeployed commit.
- Vercel frontend, frontend deployment metadata, Railway `/api/version`, Railway health and readiness, and production workers identify the exact final `main` SHA.
- The production database reports a canonical migration-set identity derived from the ordered applied migration filenames and file hashes, and that identity matches the release manifest generated for the same SHA.
- The release-evidence packet is a content-addressed artifact whose SHA-256 is recorded in the release manifest and returned by the deployment-proof check; a mutable document title or health response is not artifact identity.

### 11.2 Engineering gates

- Full formatting or lint, full typecheck, unit, integration, API contract, PostgreSQL migration, security, privacy, accessibility, browser, production-image, and release gates pass on the exact final SHA.
- Critical concurrency, retry, stale-write, payment-cap, consent, SSRF, DNS-rebinding, redirect, cancellation, and recovery paths have regression tests.

### 11.3 Canonical matching and display parity

- Crawler OS, matching APIs, persisted rows, Amy reports, Hamilton inputs, and UI use the same canonical decision contract.
- Displayed decision, score, explanation, type, and included or total counts match persisted authoritative values for every sampled result.
- Missing or `null` profile fields remain neutral in contract tests.
- Every hard exclusion is reproduced from an explicit source-defined rule and known profile fact.
- No generic search URL, quarantined, hidden, broken, unsafe, expired, or retired row is presented as an actionable direct opportunity.
- Directory, referral, benefit, and portal rows survive as typed resources unless a persisted exclusion reason is present.
- Duplicate and near-duplicate resources reconcile to the correct canonical record without losing source history.

### 11.4 Current-source and link lifecycle

Define the **complete release catalog denominator** as every non-deleted catalog row eligible for release evaluation after deterministic duplicate consolidation, including direct opportunities and typed supporting resources. Test or fixture-only rows and rows whose authoritative source explicitly states that the program has ended are excluded by recorded reason; no other row may be omitted from the denominator.

- Every resource visible in production has a current source identity and a persisted link state.
- Every visible direct opportunity has an application URL that was successfully verified within the configured release freshness window. A visible direct row may not be marked `skipped_by_policy`, `unknown`, retryable, quarantined, or broken.
- The complete release catalog has a verified-link rate of at least 95%, calculated as successfully verified rows divided by the complete release catalog denominator.
- The remainder is separately counted as retryable, policy-blocked, quarantined, or retired, with a persisted reason. These categories do not satisfy the visible-direct requirement and cannot be used to shrink the denominator.
- Retry, restore, retirement, quarantine, numerator, and denominator metrics reconcile exactly with underlying rows.

### 11.5 Fixed 50-profile Amy and manual-search comparison

Before execution, commit a cohort manifest and immutable random seed. The cohort contains 50 consented or synthetic profiles and covers all supported applicant classes and at least five distinct geographic regions. At minimum it includes students, households or caregivers, disability-program seekers, veterans, nonprofits or community organizations, small businesses, education or training needs, housing or utility needs, and item-specific funding needs. No profile may be selected or replaced after results are viewed except for a documented invalid-fixture reason.

For each profile:

1. Freeze the permitted search facts and a redacted outbound-query snapshot.
2. Run GrantFlow once on the exact release with configured provider timeouts and record every job state, query, source, result, exclusion, duplicate, and error.
3. In a blinded lane, give a reviewer the same permitted facts and 30 minutes to search current official or reputable sources without viewing GrantFlow results.
4. Adjudicate both result sets against the same source, eligibility, freshness, resource-type, and duplicate rules.
5. Record true relevant direct opportunities, true typed supporting resources, false positives, missed resources, broken or stale links, time to first usable result, and completion state.

A profile passes parity only when:

- every manually found valid direct opportunity is either surfaced by GrantFlow or has a correct, source-backed exclusion recorded before adjudication;
- GrantFlow surfaces at least as many adjudicated valid direct opportunities as the manual lane;
- no directory, referral, benefit, or portal is misclassified as a direct opportunity;
- the false-direct-opportunity count is zero;
- the run reaches a terminal state within its configured timeout plus a five-minute worker-recovery allowance; and
- every partial provider failure is visible rather than represented as a successful zero-result run.

Production readiness requires 50 of 50 profiles to pass this defined parity test. The report preserves per-profile evidence and may not replace failed profiles with easier ones.

### 11.6 Authenticated real journeys

Run at least three consented, authenticated production evidence chains on the exact release. Use three distinct applicant classes and at least two geographies.

Each chain must persist and then re-read:

- active profile identity and field-use contract version;
- discovery job and provider-status records;
- canonical resource type, decision, score, explanation, and provenance;
- saved or tracked state;
- generated or selected application materials with field and source provenance;
- human-gate state for CAPTCHA, MFA, signature, attestation, or payment where encountered;
- external handoff result; and
- one of `externally_received`, `not_submitted`, `cancelled`, `failed`, or `pending_reconciliation`, supported by a receipt or explicit evidence.

Hamilton must demonstrate account or session reuse without credential leakage, profile-scoped tasks, consent, document and field provenance, action-bound payment limits, ambiguous-result reconciliation, and durable receipts. A draft, click, or packet is never treated as submission.

### 11.7 Failure and recovery

Execute these controlled scenarios and verify the expected persisted state after restart:

- **Search-provider outage:** one provider times out while another succeeds. Expected: partial-provider status, retained valid results, no false zero-result success, retry metadata persisted.
- **Link-verifier failure:** verifier becomes unavailable. Expected: prior verified state is not rewritten as broken; rows become retryable or verification-stale with the failure reason.
- **Worker interruption:** terminate a crawler or Amy worker after checkpoint creation. Expected: expired lease or fence is reclaimed once, work resumes without duplicate canonical rows, and the terminal job records recovery.
- **Ambiguous portal response:** interrupt after an external submit action before receipt capture. Expected: `pending_reconciliation`, no blind retry, read-only external reconciliation before any new submit attempt.
- **User cancellation:** cancel preparation or automation mid-run. Expected: `cancelled` or draft state, no external submission claim, recoverable user work retained.
- **Deployment rollback:** deploy the candidate, write and read a reversible test record, roll back to the last safe release, then verify schema compatibility, record preservation, health, and restored release identity.

No scenario passes through log inspection alone. The database or durable store, API response, user-visible state, and relevant receipt or audit record must agree.

### 11.8 Independent review

- The complete release receives fresh product, architecture, security, privacy, data-integrity, QA, accessibility, performance, UX, release, and funding-domain review.
- Zero unresolved P0 or P1 findings remain, and no unresolved finding affects purpose, matching truth, privacy, security, billing, submission, deployment, or recovery.

## 12. False or watered-down substitutes

The following do **not** satisfy this contract:

- A page that loads, a health endpoint returning 200, or a green deployment badge
- A generic AI-generated list of grants
- Search results without profile-specific canonical scoring and provenance
- Silently discarding directories, referrals, benefits, or portals instead of presenting their truthful type and next action
- Direct opportunities that are actually directories, referrals, search pages, placeholders, expired notices, or broken links
- Sample profiles, mock portals, synthetic receipts, or a local-only demonstration used in place of real release evidence
- A prepared packet presented as submitted
- A clicked button presented as externally received
- A self-authored readiness report presented as proof
- A merged PR without exact-SHA CI, deployment, authenticated production journeys, and inspected output
- “Software complete,” “ready except for,” or “pending owner action” presented as Production Ready
