# P0 discovery / Amy / web-parity acceptance

## Phase

P0 live discovery acceptance remains open. The release bar is one evidence
chain that proves healthy live search and extraction, an exact 50-member Amy
cohort, and the same cohort's web-parity result. Activity counts alone do not
close this phase.

## Changed

- Added the manual `amy-web-parity-acceptance` workflow around the existing
  hermetic runner. It uses a disposable SQLite database, the exact dispatched
  SHA, the pinned acceptance Node version, and the runner's canonical cleanup.
- A failed or policy-blocked run uploads its immutable sanitized receipt before
  the workflow remains red. This makes provider outages, incomplete cohorts,
  parity failures, cleanup failures, and policy blocks distinguishable instead
  of losing the only evidence when the command exits nonzero.
- The workflow has no production database credential and cannot mutate a real
  profile or production catalog. The owner-approved profile remains available
  to the separate read-only production audit; this exact-50 acceptance uses
  synthetic disposable members so no PII enters its receipt.

## Verified locally

- Static workflow guards prove the manual trigger, exact runner, pinned Node
  version, absence of a production database credential, and upload-before-fail
  ordering.
- The existing acceptance service test suite remains the functional contract
  for provider preflight, exact membership, stage evidence, parity provenance,
  canonical Amy cleanup, immutable receipts, and fail-closed policy handling.
- The acceptance gate now requires at least one candidate to survive the
  canonical writer (`stored > 0`), not merely page fetch and extraction
  activity. Its parity receipt also requires a closed disposition for every
  web-only result and retains web-result, real-result, stored-match, and
  disposition counts. This makes both quantity and quality auditable.

## Unknown / external blockers

- At this commit, GitHub has `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`, but no
  configured `GOOGLE_CSE_KEY` + `GOOGLE_CSE_CX`, `BRAVE_SEARCH_API_KEY`, or
  `SEARXNG_URL`. A dispatched run will therefore honestly stop at
  `no_selected_reliable_search_provider_configured` until one reliable search
  provider is configured.
- `config/web-parity-acceptance-policy.json` is intentionally absent. Even a
  technically complete run must finish `blocked` until the owner ratifies and
  versions the fleet-parity threshold; an agent must not invent that product
  bar.
- No fresh live acceptance result is claimed by this change.

## Operator sequence

1. Configure one reliable search provider secret pair/value in GitHub.
2. Have the owner ratify the exact-50 `fleet_parity >= threshold` policy and
   commit it at `config/web-parity-acceptance-policy.json` using the schema
   enforced by `evaluateCompetitivenessPolicy`.
3. Dispatch `amy-web-parity-acceptance` on the exact release SHA.
4. Record the run ID, receipt SHA, provider provenance, Amy clean/issue counts,
   parity score, web-only dispositions, and cleanup proof here.
