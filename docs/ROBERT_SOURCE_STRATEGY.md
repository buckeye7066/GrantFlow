# Robert — Source Strategy

How Robert decides what to search, what to fetch, and what to trust.

## Source families (priority order)

1. **Federal portals** — Grants.gov, SAM.gov assistance listings, Benefits.gov, StudentAid.gov.
2. **Federal program pages** — FEMA AFG/SAFER, USDA Rural Development, SBA grants (true grants only — not loans).
3. **State grant portals & state agency pages** — `grants.ga.gov`-style sites, `tn.gov/grants`, etc.
4. **County / city grant pages.**
5. **Community foundations** — Council on Foundations locator.
6. **Private foundations & corporate giving pages** (case-by-case).
7. **University / school scholarship portals.**
8. **Hospital / charity-care resources, utility rebate / assistance programs, disability assistance, veteran organizations, faith-based foundations, fire-department associations, rural development programs, education / scholarship directories, nonprofit directories, benefits / direct-assistance directories.**

The seed list lives in `backend/services/robert/robertSourceRegistry.js`
(`ROBERT_SEED_SOURCES`). The seeds are intentionally small and admin-curated.

## Trust scoring

`computeSourceTrustScore(url)` returns 0–100:

| Tier | Examples | Score |
|---|---|---|
| Grants.gov / SAM.gov | grants.gov | 95 |
| .gov / .mil / .us | fema.gov, studentaid.gov, benefits.gov | 90 |
| .edu | harvard.edu | 85 |
| Major foundations / community foundations | gatesfoundation.org, cof.org | 80 |
| State grant portals (`grants.*`, `opportunities.*` keywords) | grants.tn.gov | 75 |
| Reputable nonprofit directories | guidestar.org, candid.org, 211.org, findhelp.org | 70 |
| Generic .org | a small foundation site | 55 |
| Generic .com | unknown | 30 |
| Placeholder / search-engine URLs | example.com, google.com/search | 0 |

**`ROBERT_MIN_SOURCE_TRUST=60`** is the default cutoff for accepting a
new source candidate from live discovery.

## Search query generator

`buildSearchPlans(demand, opts)` produces structured plans:

```json
{
  "profile_id": "...",
  "applicant_type": "volunteer_fire_department",
  "location_scope": "county",
  "need_category": "equipment",
  "search_query": "volunteer fire department equipment grant Bradley, TN",
  "source_types": ["fire_department_grants", "rural_development", ...],
  "trusted_domains": ["grants.gov", "fema.gov", ...],
  "exclude_terms": ["loan", "loans", "matching funds", ...],
  "expected_evidence": ["real .gov URL", "sponsor", "application path"],
  "priority": 65,
  "reason": "volunteer fire department · equipment · county"
}
```

**Geographic expansion** is built in: every profile gets queries at
`city → county → state → national` scope so zero-result avoidance is
driven by the planner, not by ad-hoc fallback code.

**Applicant-type hints** add national queries that are common to a
type, e.g. `volunteer_fire_department` adds `'volunteer fire
department equipment grant'`, `'turnout gear grant'`, etc.

## What Robert never accepts

| Never | Why |
|---|---|
| Search engine URLs as direct opportunity URLs | They are not the funder |
| Placeholder / example / localhost / test domains | Not real |
| Loan / microloan / interest-bearing products | GrantFlow is grants-only |
| Matching-fund / cost-share programs (when explicitly required) | Not pure grants |
| Expired fixed deadlines | Past windows confuse users |
| Generic directory landing pages without an actionable link | Surface those as **source candidates**, not opportunities |
| Login-gated / captcha-blocked pages | Out of scope |

All of these rejection reasons are first-class codes in
`backend/services/robert/robertTypes.REJECTION_REASONS` so the admin
console can surface them.

## Persisted source review queue

Discovered sources land in `robert_source_candidates` with
`status='pending'` and a `trust_score`. Admins review them via:

- `GET /api/robert/source-candidates?status=pending`
- `POST /api/robert/source-candidates/:id/approve`
- `POST /api/robert/source-candidates/:id/reject`

Approved sources are eligible for direct opportunity discovery; rejected
sources are quarantined.

## Domain rate limiting

`robert_domain_rate_limits` tracks request counts per domain in a
rolling-hour bucket. Default cap: `ROBERT_RATE_LIMIT_PER_DOMAIN_PER_HOUR=60`.
A domain blocked by a previous error stays blocked until
`blocked_until` elapses.

## How to plug in a real fetcher

Robert's discovery layer is intentionally **adapter-based**. The agent
accepts two injectable callables:

- `searchProvider({ query, exclude, trustedDomains }) → [{ url, title, snippet }]`
- `opportunityAdapter({ source, plans, config }) → records[]`
  where each `record` is a structured opportunity (Grants.gov-style,
  Benefits.gov API, foundation HTML you've already parsed, etc.).

We did not ship a default `searchProvider` because Robert must NOT make
live requests in this PR. The adapter is the place to wire your search
engine API key, your foundation HTML scraper, or any partner integration.

## Learning loop

- Every Robert run writes an audit row (`robert_runs`) plus per-finding
  candidate rows (`robert_opportunity_candidates`).
- Rejected candidates retain `verification_reasons_json` so a future
  curation pass can spot a source that consistently produces junk.
- Recommendations the user accepts/declines write to
  `robert_profile_recommendations` so the system can de-prioritise
  sources that produce a high decline rate and prefer sources that
  produce accepted matches.

The aggregation/learning analyzer is intentionally simple in this PR;
a future iteration can layer per-source acceptance rates on top of
the existing storage.
