# GrantFlow — Project Brief

## Purpose

GrantFlow is a full-stack JavaScript platform for discovering funding sources and
managing grant applications across individuals, students, families, veterans,
nonprofits, and small businesses.  It automates the tedious parts of the grant
lifecycle — discovery, matching, drafting, portal submission, and reporting —
while keeping humans in control of every decision that matters.

---

## Grant Discovery Methodology

### 1. Multi-agent crawler fleet

Discovery runs through a set of named autonomous agents, each with a defined
scope and trust level:

| Agent | Role |
|-------|------|
| **Sam** | Registry-based discovery: iterates a curated source catalog and fetches known grant pages |
| **Robert** | Web-search lane: issues profile-tailored queries to search providers and mines the top results |
| **Yana** | Lead-contact enrichment: finds the right human contact at a funding organization |
| **John** | Outreach drafting: composes personalised reach-out emails once a lead is enriched |
| **Hamilton** | Portal automation: fills and submits applications on portal sites using Playwright |
| **Anya** | Continuous quality agent: nightly synthetic cohort testing, gap detection, and autonomous micro-repairs |
| **Amy** | Synthetic profile training: generates adversarial profiles to surface coverage gaps |

### 2. Source catalog (`backend/crawler-os/sourceRegistry.js`)

A curated registry maps source identifiers to base URLs, need categories,
applicant types, geographic scope, and keyword vocabularies.  Every discovery
run consults this registry to select which lanes to run for a given profile.

### 3. Lane selection and ranking

The crawler planner (`backend/crawler-os/planner.js`) selects sources by:
1. **Applicant-type match** — does the source serve the profile's entity type
   (individual, family, nonprofit, small business, etc.)?
2. **Need intersection** — does the source address at least one of the profile's
   declared needs?
3. **Geographic scope** — is the source national, or does it match the profile's
   state/county?
4. **Tier ranking** — sources whose curated keywords name a topic the profile
   explicitly declared are promoted ahead of generic lanes.

### 4. Page fetching and extraction

Each candidate page is fetched through an SSRF-safe HTTP client.  The extracted
HTML is parsed for funding-opportunity facts using a combination of:

- **Deterministic signals** — structured fields (deadline, award ceiling, entity
  types, application URL).
- **LLM extraction** — a prompt-based extractor (`backend/services/webGrantExtractor.js`) asks the
  model to enumerate opportunities from unstructured page text.
- **Profile-blind shadow extractor** (flag `WEB_LANE_PROFILE_BLIND`) — a
  second, profile-unaware extraction pass runs in parallel to surface facts the
  profile-conditioned pass may have biased away.

### 5. Reality gate

Every extracted row passes `backend/services/opportunityRealityGate.js` before entering the
catalog.  The gate rejects:
- Procedural and regulatory notices (Federal Register rule changes, OMB
  collections, antitrust filings).
- Foreign-jurisdiction funders on country-code TLDs or by recognised funder
  name/host registries.
- Lead-generation funnels (scholarship aggregators with no direct award).
- Anonymised or fabricated sponsors.
- Search-engine result URLs as application targets.

### 6. Deduplication

Catalog rows are collapsed to a canonical identity by
`canonicalOpportunityKey()` (`backend/crawler-os/contract.js`):

```
external_id → token-sorted (title + sponsor) → source URL
```

This ensures the same real-world program is never stored as multiple rows even
when re-extracted with paraphrased text.

---

## Grant Matching Algorithm

### Scoring model (data-point scale)

```
score = round(
  matchedDataPointCredit / totalDataPoints × 100
  × eligibilityFactor
  × geoFactor
)
```

- **`totalDataPoints`** — every answered field in the profile inventory.
- **`matchedDataPointCredit`** — the sum of credits for profile facts that the
  opportunity addresses (need categories, eligibility criteria, geographic
  scope, applicant types, etc.).
- **`eligibilityFactor`** — 0–1 multiplier from eligibility-text analysis.
- **`geoFactor`** — 0–1 multiplier: 1.0 for a verified state/county match, 0.5
  for a national-only source.

A score of 100 means the opportunity addresses every data point in the profile.
The pipeline admission bar is **8** (configurable via `MATCH_SCORE_FLOOR`).
See `backend/config/matchThresholds.js` for all thresholds and their rationale.

### Decision bands

| Band | Score | Meaning |
|------|-------|---------|
| ACCEPT | ≥ admission bar | Recommended — add to pipeline |
| REVIEW | < bar, ≥ floor | Surfaced for human review |
| REJECT | < floor | Dropped |

### Hard-rejection gates (applied before scoring)

The single choke point `matchEngine.makeDecision()` enforces:

- **Geography** — foreign jurisdiction, declared-place exclusivity, cross-state
  agency mismatch.
- **Applicant type** — individual vs organisation, nonprofit vs small business.
- **Stage of life** — graduate/professional/post-doctoral/adult-reentry programs
  are refused for verified high-school seniors or undergraduates.
- **Aid preference** — declined aid types (e.g. work-study) are always refused.
- **Individual award ceiling** — awards above `INDIVIDUAL_AWARD_CEILING`
  ($100 000 by default) are refused for individual/family profiles.
- **Profession eligibility** — profession-restricted awards are refused when the
  profile's declared occupation does not match.
- **Non-grant notices** — regulatory filings, procedural notices, and
  foreign-government programs are refused.

### Match persistence

Accepted and review matches are stored in `profile_opportunity_matches` keyed
by `(profile_id, opportunity_id, matcher_version)`.  The crawler-os snapshot
lane uses a rolling-delete/re-insert pattern; specialised recall lanes
(`institution-link`, `student-aid-instate-link`, `county-crisis-need-link`,
`field-of-study-link`) survive the nightly snapshot reset by using distinct
`matcher_version` values listed in `SURFACED_MATCHER_VERSIONS`.

---

## Supported Grant Types

| Kind | Description | Pipeline behaviour |
|------|-------------|-------------------|
| `program` | Direct-award funding program | Fully matched; can be auto-submitted |
| `scholarship` | Education-specific award | Fully matched; Hamilton portal automation |
| `fellowship` | Research / professional fellowship | Fully matched |
| `benefit` | Government benefit (Pell, LIHEAP, SSI) | Matched; no fixed dollar amount |
| `directory` | Pointer / locator resource | Surfaced at REVIEW only; never ACCEPT |
| `referral` | Lead to another source | Surfaced at REVIEW; no dollar figure |
| `school_portal` | School-specific portal entry | Visibility-only; General Application governs |
| `loan` | Repayable loan product | Excluded from grant pipeline |

---

## Funding Database Integrations

### Federal sources

| Source | Integration |
|--------|-------------|
| **Grants.gov** | REST API via `backend/services/shared/grantsGovApiClient.js`; `awardCeiling`/`awardFloor` from `synopsis` and `forecast` nodes; adapter in `backend/services/sources/grantsGovAmountAdapter.js` |
| **SAM.gov / FAL** | Structured JSON fetcher in `backend/services/sources/samFalAmountAdapter.js`; `backend/services/sources/federalRegisterAmountAdapter.js` for FR-published award ceilings |
| **USASpending.gov** | `backend/services/sources/usaSpending.js`; used for awarded-amount reference data |
| **Federal Register** | `backend/services/sources/federalRegisterAmountAdapter.js`; used for award ceiling extraction from rule-making notices |

### State and local sources

| Source | Integration |
|--------|-------------|
| **State housing finance agencies** | `backend/crawler-os/adapters/stateHousingAgencyAdapter.js` resolves the profile's own state agency from `STATE_REGISTRY`; yields one national catalog row with per-state resolution at match time |
| **State benefits portals** | `STATE_BENEFITS_PORTALS` registry (`backend/services/coverageEvidenceService.js`); four household portals (TN, WV, PA, OR) curated with awardable program URLs |
| **County/city crisis resources** | `backend/config/crisisNeedRecall.js`; county-phrase + state + declared-need matching against the local-crisis catalog |

### School portal integrations

| Provider | Mode |
|----------|------|
| **TSAC** (Tennessee Student Assistance Corporation) | Manual-import pilot; JSON paste from portal |
| **NGWeb Scholarship Manager** | Automated sync (`backend/services/hamilton/portalSync/connectors/ngwebScholarshipManager.js`) for `*.scholarships.ngwebsolutions.com` tenants (MTSU, Cleveland State CC) |
| **AcademicWorks** | Hamilton portal automation (`backend/services/hamilton/hamiltonAutopilotEngine.js`) for `*.academicworks.com` tenant slug matching |

### Third-party discovery APIs

| Source | Notes |
|--------|-------|
| **Web search providers** | Configurable; queries built by `buildWebQueries()` from the profile thesis |
| **Candid / GrantWatch** | Referenced in grant description text; no live API call in open-source build |
| **findhelp.org** | County/ZIP deep-link constructed at match time for local assistance directories |

---

## Application Workflow

1. **Discovery** — crawler agents surface opportunities matching the profile.
2. **Pipeline admission** — `saveToProfilePipeline()` is the single entry point;
   applies tombstone, source, relevance, and duplicate gates.
3. **Proposal development** — AI-assisted section drafting via Anthropic Claude
   and OpenAI; templates are opportunity-shaped (scholarship vs org-grant).
4. **Checklist completion** — `SubmissionAssistant` guides through a
   completeness checklist before marking submitted.
5. **Portal automation** — Hamilton fills portal forms using Playwright;
   auto-submit is gated on completeness and explicit consent.
6. **Submission proof** — confirmation screenshots and HTML are stored durably
   in `documents` (BYTEA) and linked to `application_tasks.output_document_id`.
7. **Follow-up tracking** — pipeline stage advances through
   `discovered → research → application → follow_up → reporting → awarded/declined`.

---

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite, TypeScript, Tailwind CSS, Radix UI, Zustand |
| Backend | Node.js 20, Express, ~100 route files |
| Database | SQLite (local/test), PostgreSQL (production) |
| AI | Anthropic Claude (`@anthropic-ai/sdk`), OpenAI |
| Portal automation | Playwright (Hamilton agent) |
| Mobile | Capacitor (iOS + Android) |
| Deployment | Vercel (frontend) + Railway (backend + PostgreSQL) |

---

## Quality and Reliability

- **Boot invariants** (`backend/startup/enforceInvariants.js`) — 53+ data-quality
  sweeps run on every server start to repair cross-profile bleed, stale scores,
  dangling matches, fabricated place signals, and more.
- **Golden-outcome sentinel** — owner-verified profile/opportunity pairs are
  stored in `system_kv golden_outcome_expectations`; Amy's nightly report
  flags any regression.
- **Amount coverage ratchet** — tracks the share of pipeline grants with a known
  dollar figure; a sudden drop indicates a catalog wipe or adapter failure.
- **Vitest unit test suite** — 500+ tests across backend services, matching
  logic, crawler-os subsystem, and frontend utilities.

---

*Last updated: 2026-08-19*
