# GrantFlow discovery and workflow review — September 8, 2026

Base inspected: `397319c916f9d9bec0ec97a6fe040f19034cc8a8` on `main`.
Scope: competitor research first, then architecture review, reproducible defect repairs, repository checks and browser workflows. This is an evidence-based repair pass, not a claim that every possible defect has been eliminated.

## Competitor findings

The comparison uses official public product documentation. Competitors do not publish their private crawler implementations; their sourcing descriptions are vendor claims, not independently measured performance. GrantFlow serves individuals and families as well as organizations, so nonprofit-only onboarding is not an appropriate wholesale replacement.

| Competitor | Documented strength | GrantFlow gap and adopted change |
| --- | --- | --- |
| Instrumentl | Projects combine profile-based matching and tracking. Matches can be sorted by fit, deadline, amount or recency. Its sourcing description combines automated monitoring with human review and periodic refresh. | Keep profile-driven source selection and evidence checks. Move the full scan out of the HTTP request into a durable job. Make the sequence from profile to matches, saved opportunities and applications visible. |
| Candid | Fundraising projects connect stated goals and organizational context to recommended funders, saved searches and prospect lists. | Keep the active profile visible throughout the workflow; use one primary discovery destination and one saved list. Put alternative search and analysis tools behind clearly named disclosures. |
| GrantWatch | Explicit recipient, location, category and deadline filters; documented human review and a centralized funding workflow. | Preserve recipient eligibility and source provenance. Report failed or incomplete searches honestly instead of interpreting missing status or results as zero matches. |

Sources consulted:

- [Instrumentl grant sourcing](https://www.instrumentl.com/browse-grants)
- [Instrumentl projects](https://help.instrumentl.com/en/articles/105640-what-is-a-project-on-instrumentl)
- [Instrumentl match sorting and filtering](https://help.instrumentl.com/en/articles/3827937-sorting-and-filtering-your-opportunity-matches)
- [Candid fundraising projects](https://candid.org/blogs/candid-search-new-features-fundraising-projects-help-nonprofits-find-funding/)
- [GrantWatch search and filters](https://www.grantwatch.com/grant-search.php)

## Confirmed defects and changes

| Finding | Repair | Relevant evidence |
| --- | --- | --- |
| `/real-crawlers/discover-all` awaited the whole live source fleet inside a proxied web request; the frontend helper instead rerouted discovery to synchronous `/run-smart`. | The helper now calls `/discover-all`, whose HTTP 202 returns the ID of a persisted `crawler_os_discovery` job. Existing dispatcher claims, concurrency limits, heartbeats and recovery apply. Concurrent clicks join the active job. | API wiring, authorized route, durable enqueue, real dispatcher and browser regression tests. |
| Scheduled cross-profile calls replaced the primary profile's full context with a context-light thesis, and could omit the primary entirely. | Always match the freshly loaded primary context, then append distinct other profiles. Bump the signal version so the existing stale-match refresh revisits prior verdicts. | Single-profile versus fleet comparisons with omitted and duplicate primary theses. |
| Failed status reads became `running = 0`; failed final catalog reads became empty successful payloads. An obsolete request's cleanup could release a newer search's guard. | Poll exact job receipts, surface failures, preserve existing results on failed refresh, and scope cleanup to the owning request. | Browser failure-path regressions and profile-scoped job authorization. |
| Manual redirects could throw on malformed locations, forward credentials to a different origin, and replay POST bodies after a 303. Concurrent rate-limit waiters could wake together. | Structured redirect failures, origin-bound credentials, correct redirect methods and reserved per-host request slots. Check cancellation before network work. | Offline transport tests, including same-origin 307 preservation; [Fetch redirect standard](https://fetch.spec.whatwg.org/#http-redirect-fetch). |
| A cooperative source deadline was checked only between sources, allowing subsequent requests in a multi-request adapter to continue past it. | Check before each request and retain completed work with an explicit incomplete-source receipt. | Offline multi-request deadline regression. |
| The non-admin sidebar exposed 23 destinations while the five-step workflow was collapsed. | Nine everyday links; all 14 specialist routes remain available through disclosures. The five workflow links are always visible and mark the current step. | Existing route/capability parity checks plus browser navigation and responsive checks. |
| SQLite UTC timestamps without suffixes were interpreted in the host's local timezone in submission recheck spacing and the automation loop reset. | Normalize database timestamps as UTC while preserving explicit offsets and PostgreSQL Date values. | Existing failing tests reproduced and repaired under `TZ=Asia/Shanghai`; timestamp regression. |
| A production-shaped authentication test supplied a dummy Resend key but still attempted a real email API call. | Test child uses a deterministic email transport and rejects other external traffic; production email behavior is unchanged. UX fixtures use the shared isolated environment. | Authentication test lane; no live email delivery is needed. |
| Document context queried nonexistent `documents.uploaded_at`, then silently discarded all document evidence; the live thesis also omitted loaded documents and normalized context. | Order by canonical `created_at`, pass the complete loaded context to matching, and advance the profile signal version. | Canonical-schema document regression, signal-version guard and cross-profile parity tests. |
| Announcement loading called `.map` on an access-control Set and fell back to an empty feed. | Accept the resolver's iterable profile IDs while preserving audience restrictions. | Announcement predicate tests now use the real Set contract. |
| PostgreSQL could not infer the type of a nullable memory-scope placeholder. | Explicitly cast nullable comparisons to text without conflating null and empty scopes. | CI PostgreSQL error trace and scoped read/delete regression. |
| Saved-grant projections required nonexistent `funding_opportunities.url`, dropping provenance through fallback; score backfill selected legacy grant columns absent in PostgreSQL. | Derive saved URLs from canonical URL fields and load available grant columns for canonical rescoring. | Saved provenance and minimal-schema backfill regressions. |

## Architecture and parity

This change introduces an execution mode around the existing crawler engine, not a second discovery engine. The 180-source registry, adapters, planner, canonical scoring, direct-funding versus research-lead distinction, real evidence requirements, clinical-trial consent and tenant access rules remain the authorities.

Mechanical job contract inventory: canonical type list → fresh SQLite schema → SQLite migration 186 and PostgreSQL migration 0190 → boot constraint repair → centralized job creation → dispatcher handler → authenticated discover endpoint → profile-authorized job endpoint → Discover UI and Automation label. Retired job types remain retired. Scheduled compatibility callers retain their synchronous contract.

The source-plan audit did not find duplicate GET requests within the four sampled profile plans (student, nonprofit, family and small business). No speculative caching layer or wholesale source deletion was introduced. Improving measured grant recall still requires representative live profiles and outcome labels.

## Verification and limits

CHANGED: the repairs above and targeted regression coverage.

VERIFIED locally so far: initial repository pre-push gates; updated build/static gates; all 490 crawler tests; focused discovery, migration, timestamp and authorization tests. Final PR checks provide the complete revision-specific result.

UNKNOWN: production source availability, long-running crash recovery under an actual host restart, production PostgreSQL migration execution, and grant recall/precision across real customer profiles. Offline tests do not establish those outcomes. Public competitor documentation does not establish their private crawl architecture or comparative recall.

Merge requires the existing repository evidence gate: `test` and `test-suite` present and passing, no failing/cancelled/pending checks, current head unchanged and mergeable. The GitHub connector can enforce the same checks when `gh` is unavailable.
