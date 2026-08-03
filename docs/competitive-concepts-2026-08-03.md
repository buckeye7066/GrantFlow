# Competitive concepts — what the winning products do, and what GrantFlow takes from each (2026-08-03)

Owner directive: *"Compare the top grant-finding software out there to
GrantFlow and implement the concepts and ideas they have that are better than
ours. Use any outside source; for example, for scholarships, use the setup
ScholarshipOwl uses."*

Product mechanics below were researched live 2026-08-03 (web). Status column
is honest: IMPLEMENTED = landed on `feat/recall-first-competitive` this
session; BRIEF = specified below with measured justification, not built.

## The eight transferable concepts, ranked

| # | Concept | Who proves it | GrantFlow status |
|---|---|---|---|
| 1 | **Continuous background re-matching against a standing profile** — crawl into a shared catalog once; matching is a cheap repeated join run continuously, not a crawl-on-demand event. Fastweb refreshes matches daily; Instrumentl "matches continue to update"; Bold.org "published daily and matched to you". | Fastweb, Instrumentl, Bold.org, ScholarshipOwl | **IMPLEMENTED** (census mode): `services/matching/catalogRescoreSweep.js` — every active non-pointer catalog row is eventually adjudicated by the canonical engine for every real profile, cursor-paced per boot, ACCEPT-only, reconcile-surviving version. Writes gated on the fix/qa-36-profile-junk fundability chain (see recall-guardrail-audit doc: blind ACCEPT rate 13–20% incl. junk classes). |
| 2 | **Eligibility-window-scoped matching** — "you won't receive matches you cannot apply for" (Fastweb): match = profile fits AND application window open; a recurring award re-enters the feed automatically when it reopens. | Fastweb | **BRIEF** (below) |
| 3 | **Recurring-cycle intelligence** — ScholarshipOwl auto-re-enters recurring click-to-apply awards (1/3/6/12-month cycles); Instrumentl *predicts* unannounced deadlines from past cycles and alerts on change. | ScholarshipOwl, Instrumentl | **BRIEF** (below) |
| 4 | **One-profile→many-applications reuse** — prefill, bundles (Going Merry: ~11 similar-prompt awards, one essay), stored-form reuse + auto-submit for no-requirement awards only. Nobody credibly auto-submits essay applications. | Going Merry (†2026), ScholarshipOwl | **Largely present**: draft packets ARE the portal fill source (`draftPacketPortalBridge`), auto-submit is live and evidence-gated (#1103-#1108). Gap = *bundling* similar-prompt awards into one review step — BRIEF below. |
| 5 | **Profile-completeness → more-matches loop** — "more information will increase the number of scholarships available to you" (ScholarshipOwl); Fastweb shows new matches + total eligible dollars at login. | ScholarshipOwl, Appily, Fastweb, Bold.org | **Partially present** (Coverage & Evidence dashboard names the next question to answer). Gap = the visible counter: "answering X unlocked N new matches / $Y". BRIEF below. |
| 6 | **Deadline-first pipeline** — Instrumentl Researching→Planned→Submitted→Awarded with submission AND post-award report reminders; Fastweb exports any deadline to 6 calendar systems; GrantWatch calendar sync. | Instrumentl, GrantWatch, Fastweb | **BRIEF** (below) |
| 7 | **Event-driven alert ladder** — per-event new-match emails (Fastweb), weekly per-project digests (Instrumentl Thursdays), stage-change alerts (Bold.org), funder-page-change alerts (Instrumentl 24/7 monitoring). | Fastweb, Instrumentl | **Partially present** (Anya morning brief is owner-facing). Gap = per-PROFILE new-match digest fed by concept #1's sweep output. BRIEF below. |
| 8 | **Aggregator source lanes with per-lane ToS/trust handling** — every winning catalog is a blend: agency APIs, licensed data, human curation, self-listing, 990-derived intelligence. | Appily (Wintergreen/Peterson's), Instrumentl, OpenGrants | **Largely present** (167-source registry, 990 lane, grants.gov API). Data-source verdicts below. |

## Compliant data-source verdicts (researched 2026-08-03)

- **CareerOneStop Scholarship Finder (US DOL)** — the *website tool* lists
  "more than 9,500" scholarships, but **no public Scholarship API could be
  confirmed**: the complete public API Explorer catalog (41 endpoints) has no
  scholarship endpoint; docs 403 automated fetchers. License (Web API License
  Agreement): free registration, attribution to DOLETA + MN DEED required on
  every displaying page. **Action: owner emails info@careeronestop.org /
  files the data-request form asking whether the scholarship dataset is
  API-licensable. Do NOT scrape the tool** — an adapter was deliberately not
  built on an unconfirmed endpoint.
- **Grants.gov Search2** (`POST api.grants.gov/v1/api/search2`) — keyless,
  public domain, unrestricted. Already in the registry (federal lane).
- **SAM.gov Assistance Listings** — grants-relevant (the contracts API is
  not); free key; 10 req/day keyless-role limit → use the bulk public
  extracts. Public domain.
- **IRS 990 bulk XML** (irs.gov downloads) — public record; the raw material
  for funder-intelligence (Instrumentl/GrantWatch model). ProPublica's API:
  lookups only — ToS forbids bulk republication.
- **College Scorecard** — CC0, 1,000 req/hr; school cost/aid enrichment.
- **Open Scholarships** (github.com/Grudged/open-scholarships) — CC BY 4.0
  JSON directory with provenance URLs; legally cleanest open scholarship set
  found, but early-stage/Nevada-focused. Candidate for a small env-gated lane
  once its coverage grows.
- **Scraped aggregator datasets on GitHub** — NOT legally clean (repo license
  does not launder the source aggregator's ToS). Refused.

## File-level briefs (unbuilt, with justification)

### B1. Eligibility-window scoping + recurring-cycle series (concepts 2+3)
- **Where**: `backend/config/opportunityWindow.js` (new, pure) — resolve a
  row's `{opens_at, closes_at, recurrence_hint}` from `deadline_at` +
  stored page facts; `matchSurfacing.qualifiesForDisplay` already drops
  past-deadline rows in the awardable count — extend the SAME choke point,
  never per-call. A row whose deadline passed but whose title/page shows an
  annual cycle ("2026", "annual", month-name deadlines) becomes
  `dormant_recurring` instead of dead: hidden from "apply now", listed in a
  "reopens ~<month>" band, and re-offered automatically when re-crawled with
  a fresh window (the rolling snapshot + catalogRescoreSweep already
  re-adjudicate on catalog drift).
- **Why measured**: prod carries `deadline_passed_count` on every profile
  audit already; Fastweb's window rule is the cheapest precision win that
  ADDS recall back (reopened awards return by construction).
- **Trap**: never *predict* a deadline as a fact (G0) — a predicted reopen is
  labeled "predicted from last cycle", the Instrumentl posture.

### B2. Recurring re-application scheduling (ScholarshipOwl's signature)
- **Where**: extend `application_tasks` with `recurrence` read at Hamilton
  task-creation; when a VERIFIED-submitted task's opportunity reopens (B1
  window fact), mint a NEW application task pre-consented iff the original
  carried `allow_auto_submit` (owner rule: auto-submit means auto-submit; the
  toggle IS the selection — never widen consent across cycles without the
  stored authorization).
- **Bar**: submission evidence rules unchanged (`assessSubmissionEvidence`).

### B3. Per-profile new-match digest (concept 7)
- **Where**: `services/matching/matchDigest.js` (new) — nightly diff of
  surfaced awardable rows per profile (the `catalog-rescore-link` +
  crawler-os sets), folded into the EXISTING notification/email path Anya
  uses; per-profile, capped, with "N new matches · $Y total listed" (pipelineValue
  choke point for the dollar sum). No new admission rule — it reports what
  the engine already accepted.

### B4. Completeness counter (concept 5)
- **Where**: Coverage & Evidence dashboard already computes the next-question
  gap; add the measured payoff: when a profile field changes, the
  catalogRescoreSweep cursor for that profile re-opens (profile-drift
  fingerprint, mirroring `RESULT_FLOOR_CATALOG_DRIFT_STEP`) and the digest
  (B3) reports "answering <field> unlocked N matches". The counter must be a
  MEASUREMENT of engine output, never a projection.

### B5. Similar-prompt bundling (concept 4, Going Merry's vacated niche)
- **Where**: draft packets already tailor by opportunity shape
  (`buildDefaultSectionsForStyle`); group a profile's open scholarship tasks
  by section-shape hash so ONE personal-statement review covers the bundle.
  UI: one review step, N submissions — each still individually
  evidence-gated.
