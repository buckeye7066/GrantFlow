# Canonical funding-result API shape

Phase 5 mission rule: every user-facing endpoint that returns funding
results must use the same JSON shape, and every frontend page that displays
results must use the same component (`src/components/funding/FundingResultCard`).

This file is the single source of truth for that shape. Tests in
`tests/mission/mission-match-parity.test.mjs` and
`src/components/funding/FundingResultCard.test.jsx` lock it in place.

## Endpoints that follow this shape

- `GET  /api/matching/profile/:profileId/opportunities`
- `POST /api/comprehensiveMatch`
- `POST /api/searchOpportunities`
- Anya tool `grants.summarizeMatches` (per-opportunity sub-payload)

(Verified 2026-08-14 against `backend/server.js` route mounts + `backend/routes/matching.js`
and `backend/routes/discovery.js`: `matchingRouter` mounts at `/api/matching` and exposes
`GET /profile/:profileId/opportunities`, not a `/match/:profileId` route; `discoveryRouter`
mounts at bare `/api` and exposes `/comprehensiveMatch` / `/searchOpportunities` directly,
not under an `/api/discovery` prefix. The frontend confirms this via
`src/api/matching.js` and `client.functions.invoke()` in `src/api/client.js`, which POSTs to
`/api/${functionName}`.)

## Response envelope

```json
{
  "profile_id": "string",
  "opportunities": [ /* result[] — see below */ ],
  "total": "number",
  "returned": "number",
  "threshold_used": "number",
  "threshold_relaxed": "boolean (only when relaxed)",
  "threshold_relaxed_reason": "string (only when relaxed)",
  "profile_signal_audit": {
    "profile_type": "string|null",
    "location_used": "string[]",
    "needs_used": "string[]",
    "missing_high_value_fields": "string[]",
    "...": "additional fields"
  },
  "diagnostics": { /* per-route diagnostics, optional */ }
}
```

## Per-result shape

Every entry in `opportunities[]` MUST carry the following fields. Missing
fields default to `null` / `[]`. `kind`, `source_trust_tier`, and
`link_status` come from Phase 1 (`opportunityRealityGate.js`). The match
fields come from Phase 2 (`computeMatchDecision`).

```json
{
  "id": "string",
  "title": "string",
  "sponsor": "string",
  "description": "string",

  "application_url": "string|null",
  "source_url": "string|null",
  "source": "string",

  "kind": "direct|benefit|directory|referral|school_portal",
  "source_trust_tier": "official_api|official_portal|verified_directory|community_directory|open_web|manual_curated",
  "link_status": "verified|unverified|broken|redirect|unreachable",

  "deadline": "ISO date string|null",
  "deadline_type": "fixed|rolling|ongoing|null",
  "amount_min": "number|null",
  "amount_max": "number|null",
  "amount_description": "string|null",
  "eligibility_summary": "string|null",

  "match_score": "number",
  "match_decision": "ACCEPT|REVIEW|REJECT",
  "match_confidence": "number",
  "matched_profile_facts": "string[]",
  "ineligibility_reasons": "string[]",

  "next_action": "apply|visit|contact|search_directory|request_info",

  "threshold_relaxed": "boolean (set if this row only appears because the threshold was relaxed)",
  "relaxed_reason": "string (set when threshold_relaxed is true)"
}
```

## Display contract — FundingResultCard

The card component MUST render every field above. The mapping to
plain-language UI is:

| Field                    | Card slot                                  |
| ------------------------ | ------------------------------------------ |
| `kind`                   | type badge ("Direct grant", "Directory…")  |
| `source_trust_tier`      | trust label ("Official portal", …)         |
| `link_status`            | trust label ("Link verified", "broken")    |
| `match_score`            | top-right score                            |
| `match_confidence`       | secondary "X% conf"                        |
| `matched_profile_facts`  | "Why this matched" list                    |
| `ineligibility_reasons`  | "Possible eligibility concerns" panel      |
| `deadline`               | deadline cell                              |
| `amount_min/max/desc`    | amount cell                                |
| `eligibility_summary`    | eligibility cell                           |
| `next_action`            | primary CTA label                          |
| `threshold_relaxed`      | amber "showing lower-confidence" banner    |
| `link_status=broken`     | red "we couldn't reach this link" banner   |
| `kind=directory|referral`| "this is a directory, not a direct grant"  |

## Adding a new endpoint

1. Use `loadProfileContext()` (Phase 3 mission rule — never a thin row).
2. Run `computeMatchDecision()` per opportunity (Phase 2 — sole authority).
3. Build the per-result object using the shape above.
4. Attach `profile_signal_audit` (from `buildProfileSignalAudit`) to the
   envelope.
5. Surface `threshold_relaxed` honestly (Phase 5 mission rule).
6. Verify with `tests/mission/mission-match-parity.test.mjs` and
   `src/components/funding/FundingResultCard.test.jsx`.
