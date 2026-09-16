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
- The shared live-search ladder now has an official OpenAI web-search fallback.
  Only tool-cited URLs are returned, and those URLs still go through the same
  fetch, extraction, reality, four-truth, dedupe, and canonical match gates.
  The exact-50 workflow permits this provider, so its already-protected
  `OPENAI_API_KEY` can keep the web lane from being completely dark when no
  separate SERP-vendor secret is configured.
- The crawler verification fixture now supplies the Grants.gov opportunity
  number in the adapter's actual `number` field. The old fixture placed that
  public identifier in the API-internal `id` field, accidentally generated a
  different canonical opportunity, and falsely reported that durable re-crawl
  dedupe/matching was broken.
- The acceptance runtime assertion now matches the repository's `.nvmrc`
  (`24.19.0`). Live run `35129147632` proved the workflow itself selected that
  pin but the runner still required the retired `20.20.2`, stopping before any
  cohort work; the assertion and workflow are coherent again.
- Owner direction in the production-readiness closeout ratified a meet-or-beat
  parity bar. The benchmark persists `fleet_parity` as a percentage, so the
  requested ratio `1.0` is versioned as threshold `100` for the exact-50 cohort;
  using numeric `1` would have meant only one-percent overlap and would have
  silently weakened the stated bar.
- Live run `35130829519` then reached the OpenAI search provider but its
  15-second outer dependency probe expired before the provider's request. The
  official tool-backed search now has a 45-second client budget inside a
  60-second acceptance deadline.

## Unknown / external blockers

- GitHub has `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`, while the separate Google,
  Brave, and SearXNG credentials were absent at the last inspection. The new
  OpenAI fallback removes the *configuration* blocker, but a fresh dispatched
  run is still required to prove that the protected key has web-search access,
  returns useful results, and survives the exact-50 quantity/quality gates.
- No fresh live acceptance result is claimed by this change.

## ZIP closure authentication correction

- Live ZIP closure run `35131967138` reconfirmed that the duplicated
  `ANYA_ADMIN_TOKEN` in GitHub no longer matched Railway (`401`). The workflow
  no longer depends on that drift-prone shared secret.
- It now mints a short-lived GitHub Actions OIDC token. The backend grants the
  ZIP-closure service identity only after verifying the GitHub signature plus
  exact audience, repository, `main` ref, manual-dispatch event, protected
  `production-audit` environment, and workflow path. A fork, another branch,
  another environment, or another workflow fails closed.
- First OIDC run `35140053453` proved token minting worked but authentication
  still failed because the verifier expected a standalone `environment` claim.
  GitHub binds protected environments in the canonical `sub` claim; the guard
  now requires the exact subject
  `repo:buckeye7066/GrantFlow:environment:production-audit`.

## Operator sequence

1. Configure one reliable search provider secret pair/value in GitHub.
2. Have the owner ratify the exact-50 `fleet_parity >= threshold` policy and
   commit it at `config/web-parity-acceptance-policy.json` using the schema
   enforced by `evaluateCompetitivenessPolicy`.
3. Dispatch `amy-web-parity-acceptance` on the exact release SHA.
4. Record the run ID, receipt SHA, provider provenance, Amy clean/issue counts,
   parity score, web-only dispositions, and cleanup proof here.
