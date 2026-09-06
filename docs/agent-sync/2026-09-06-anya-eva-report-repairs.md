# September 6 Anya / EVA report repairs

Basis: owner's September 6 report and explicit request to fix, push, and merge.
Source baseline: GrantFlow main eaec6fb3958325f82ad55d947f74b781b3d9d9a2.

## Reproduced defects and changes

- Crawler queries: the old double rotation reached only 23 of 35 available
  queries across repeated seeds for a needs-rich individual. Rotate one
  deduplicated broadening pool, preserve priority searches, and prove every
  candidate is reachable under the budget. City-only learned hyperlocal gaps
  now add applicant-appropriate searches (business, nonprofit, school, student).
  No result, eligibility, need, or admission threshold is relaxed.
- Coverage scheduler: only a successful completed sweep earns the 20-hour
  freshness window. A restarted running marker cannot suppress recovery after
  the existing renewed scheduler lock expires. Completed per-profile floor
  attempts are checkpointed before the next expensive crawl.
- Digest: retain bounded profile/mode/code/HTTP/next-action evidence, expose it
  in Sam, and never count an unverified Outlook response as a completed draft.
  Partial sends remain failures. No automatic retry or delivery-mode change.
- EVA: seven apps use distinct loopback API/UI ports 451xx/452xx, aligned across
  launch command, readiness probe, journey URL, API proxy, CORS, and allowlist.
  Incognito journeys no longer hard-code the old localhost instance. Protected
  processes, no-spend checks, identity/secret isolation, and strict ports remain.
  GrantFlow's per-repo manifest matches the central bundle.

## Cross-repository dependencies

- GeneMap Discovery PR #223, merged 570141f5f634ff0fd869631a6f3dbb6cbfb27e8b:
  build-only OCR asset emission, dev streaming with error handling, VITE_PORT.
- Factory Deck / local-ai-factory PR #196: FACTORY_UI_PORT and
  FACTORY_API_PROXY_PORT. Merge this before rolling out the central EVA bundle.

## Verification and unresolved runtime evidence

Local dependency-free checks: query/freshness 30 pass; EVA 151 pass, 1 existing
skip; digest diagnostic tests 3 pass. Full backend, build, and release checks
must pass in GitHub CI before merge. No live model call, email, grant submission,
owner process termination, database modification, or Windows remote run occurred.

The report alone does not identify Kidney Antigen Discovery's final Python
exception; its import traceback is truncated. The reported missing workstation
Postgres (Are We Mice / Mind Over Math) and Docker (Family Stewardship) still need
verified local availability. Historical Hamilton draft failure cause was not
recoverable from the retained summary or latest-deployment logs. Do not mark
those incidents resolved without fresh evidence. Live crawl quality and a new
50-profile Amy cohort must be remeasured; code tests do not prove those outcomes.
