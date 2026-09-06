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
- EVA: the eight startup-failed apps use distinct loopback API/UI ports
  451xx/452xx, aligned across launch command, readiness probe, journey URL,
  API proxy, CORS where applicable, and allowlist. Incognito journeys no longer
  hard-code the old localhost instance. Protected processes, no-spend checks,
  identity/secret isolation, and strict ports remain. GrantFlow's per-repo
  manifest matches the central bundle.
- Kidney: EVA previously launched global Uvicorn while preparing only Node
  lockfiles in its clean clone; the app's supported launcher uses a venv.
  The new app-owned Python bootstrap explicitly installs into backend/.venv,
  checks imports with that interpreter, and launches on API 45105. Next uses
  BACKEND_URL=45105 and UI 45205. Readiness requires /api/readyz before frontend
  warm-up. The backend-health journey now has actual browser steps/assertions;
  its old CLI fields were ignored by the selected web adapter.
- Windows verification exposed an existing LF/CRLF test-fixture mismatch.
  A fixture-local .gitattributes pins LF without weakening any dirty-worktree,
  junction, ownership, or process protection assertion or changing global Git.

## Cross-repository dependencies

- GeneMap Discovery PR #223, merged 570141f5f634ff0fd869631a6f3dbb6cbfb27e8b:
  build-only OCR asset emission, dev streaming with error handling, VITE_PORT.
- Factory Deck / local-ai-factory PR #196, merged
  d62416d630685e29e1908591f8b504d6e6f86c02: paired FACTORY_UI_PORT and
  FACTORY_API_PROXY_PORT.
- Kidney Antigen Discovery PR #7: backend/eva_start.py and fresh Linux 3.12 /
  Windows 3.13 startup verification. This dependency must merge before this
  central manifest rolls out.

## Verification and unresolved runtime evidence

The 33 native query/freshness/digest checks and the full EVA guard suite run
in the added Windows/Linux CI workflow. All pre-existing required backend,
build, browser, security, and release checks must pass at the final PR head.
Kidney's tests verify occupied-port refusal and clean-environment startup with
only disposable database/upload/output directories, not any real analysis.
No live model call, email, grant submission, owner process termination,
production database modification, or owner Windows remote run occurred.

The report does not identify Kidney's final historical Python exception; the
traceback is truncated. The known interpreter/dependency mismatch is repaired,
not claimed to establish that exception's exact cause. Missing workstation
Postgres (Are We Mice / Mind Over Math) and Docker (Family Stewardship) still
need verified local availability. The historical Hamilton draft failure cause
was not recoverable from the retained summary or latest-deployment logs.
Do not mark those incidents resolved without fresh evidence. Live crawl quality
and a new 50-profile Amy cohort must be remeasured; code tests do not prove
those outcomes.
