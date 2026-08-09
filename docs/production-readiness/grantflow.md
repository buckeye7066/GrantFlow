# GrantFlow production readiness

**Agent:** production-agent-grantflow  
**Updated:** 2026-08-09T00:52Z  
**Status:** SOFTWARE COMPLETE, EXTERNAL RELEASE BLOCKER  
**Branch:** `production-ready/grantflow` (merged)  
**GitHub SoT:** `buckeye7066/GrantFlow` `main`

## Phase A — Source of truth

| Item | Evidence |
|------|----------|
| Main tip (start) | `4130970bf33b9f191e20d05f13b1d3974c514ddf` — docs(portfolio): PR 1188 item-43 drain (#1190) |
| Local path | Private Windows checkout (machine-specific path intentionally omitted) |
| Production FE | `https://app.axiombiolabs.org/grantflow` (alias `grant-flow-three.vercel.app`) |
| Production BE | `https://grantflow-production.up.railway.app` |
| **Pre-change Railway SHA** | `4130970bf33b9f191e20d05f13b1d3974c514ddf` via `GET /api/version` + `/api/health` build.commit_sha |
| **Pre-change Vercel SHA** | GitHub Production deployment id `5809433795` → same `4130970b…`; FE proxy `GET https://app.axiombiolabs.org/api/version` returns same commit |
| Open PRs (baseline) | #1173, #1181, #1183 (draft), #1187 (draft) — superseded by #1191 (all CLOSED) |

## Phase B — Audit (vs exit 40–45 / bridge 33–39)

| Area | Finding |
|------|---------|
| Match authority | Crawler-OS + `computeMatchDecision` / `qualifiesForDisplay` are the surfacing contract; prior #1188 drained stale explain stubs. |
| Zero-results | Matching path already had recovery; **`GET /api/discover-grants` hard-filtered on minScore without the ladder** → could return included=0 while matches existed. Fixed on #1191. |
| Counts 1:1 | Matching response lacked explicit `included`/`total_found`; Discover UI preferred local partitions. Aliases + UI prefer `included` now. |
| SSRF / payments / OTP | Open security PRs reconciled onto #1191 and merged. |
| Amy 50/50 + Google parity (41) | Ledger: last measured **21/50**; still open (needs keys / overnight cohort). **Exit 41 NOT complete.** |
| Link lifecycle ≥95% (42) | Prior work present; not re-proven this run. **Exit 42 NOT re-certified here.** |
| Score/display authority (43) | #1188 drain evidence on main; residual fleet explains noted in ledger. |
| Three E2E evidence chains (44) | Blocked on consented prod profile / owner credentials. **Exit 44 NOT complete.** |
| Exact SHA dual deploy (45 deploy half) | Post-merge Vercel+Railway SHAs match merge commit (below). Authenticated journeys still owner-gated. **Exit 45 NOT fully complete.** |
| Hamilton honest handoffs (37) | Payment cap atomicity landed via #1173/#1191; live portal capture/submit still needs owner proof. |

## Phase C — Plan

1. Cherry-pick/merge open PRs onto `production-ready/grantflow` from current main.  
2. Fix Discover zero-result path + count contract.  
3. Harden flaky redos gate that blocked unrelated PRs.  
4. Open one superseding PR; close #1173/#1181/#1183/#1187 with pointers.  
5. Merge when CI green; record post-deploy SHAs; leave Amy/Hamilton/E2E as owner blockers.

## Phase D — Implemented this run

- Merged #1173 (safeFetch SSRF chokepoint, atomic payment authorization cap, CSPRNG OTP).  
- Cherry-picked #1181 (env-driven login maintenance ETA).  
- Cherry-picked #1183 (avatar_lookup redirect SSRF).  
- Cherry-picked #1187 (httpClient + Yana HTML hop-safe SSRF).  
- `loadProfileOsResults` / discover-grants: zero-result ladder + logged suppression/recovery.  
- Matching API: `included` + `total_found` (+ coverage_summary mirrors).  
- DiscoverGrants UI: prefer `included` for count metadata.  
- `documentIngestionRedos` best-of-3 ratio (CI jitter).  
- Fixed `crawlerOsVerifiedAtHonesty` hermetic `fetchImpl` (CI release-gates timeout).  

## Phase E — Verification evidence

```
node scripts/run-vitest-isolated.mjs run \
  backend/tests/safeFetchSsrf.test.js \
  backend/tests/paymentAuthorizationCap.test.js \
  backend/tests/avatarCrawlerSsrf.test.js \
  backend/tests/httpClientSsrfEgress.test.js \
  backend/tests/yanaHtmlFetcherSsrf.test.js
→ 5 files / 50 tests passed

node scripts/run-vitest-isolated.mjs run backend/tests/matchingZeroResultRecovery.test.js
→ 6 passed (asserts included === returned === opportunities.length; total_found ≥ included)

node scripts/run-vitest-isolated.mjs run backend/tests/crawlerOsVerifiedAtHonesty.test.js
→ 6 passed
```

CI on #1191 head `48e86077fb3de7d7e96ad98046e118238ce06427`:
- Workflow run `31286455249` — test / browser-smoke / postgres-migrations / production-image all SUCCESS

## Phase F/G — Review / release

| Item | Evidence |
|------|----------|
| Superseding PR | https://github.com/buckeye7066/GrantFlow/pull/1191 — **MERGED** 2026-08-09T00:46:29Z |
| Merge commit (main tip) | `75c38dc8bac79ba0830641e01f4c0e214cd5693f` |
| Baseline PRs | #1173 #1181 #1183 #1187 — CLOSED (superseded) |
| GitHub Production deploy | id `5814199609` sha `75c38dc8…` |
| GitHub Railway deploy | id `5814189025` sha `75c38dc8…` (“Deployed to Railway”) |

### Post-merge dual SHA verify (exact)

```
GET https://grantflow-production.up.railway.app/api/version
→ commit 75c38dc8bac79ba0830641e01f4c0e214cd5693f (branch main, railwayEnv production)

GET https://grantflow-production.up.railway.app/api/health
→ build.commit_sha 75c38dc8bac79ba0830641e01f4c0e214cd5693f status ok

GET https://grantflow-production.up.railway.app/readyz
→ ok true / mission_gate passed

GET https://app.axiombiolabs.org/api/version
→ same commit (Vercel→Railway rewrite)

GET https://app.axiombiolabs.org/assets/deployment-version.json
→ commit 75c38dc8bac79ba0830641e01f4c0e214cd5693f source VERCEL_GIT_COMMIT_SHA

GET https://app.axiombiolabs.org/grantflow → HTTP 200
```

**Verdict:** Software path for this release is merged and dual-deployed on exact merge SHA. Exit criteria **40–45 are NOT weakened and remain incomplete** where owner keys/consents are required.

## Residual blockers (owner) — EXTERNAL RELEASE BLOCKER

1. **Exit 41** — Amy overnight 50-profile cohort + search provider keys for Google-bar parity (last measured 21/50).  
2. **Exit 44** — Three authenticated E2E evidence chains on a consented production profile.  
3. **Exit 45 (auth journeys)** — Dual SHA deploy half is done; authenticated production journeys still need owner login/consent.  
4. **Hamilton** — Live portal capture/submit proof still owner-gated (Demo STEM pending tasks).  
5. **Exit 42** — Link lifecycle ≥95% not re-proven in this run (do not claim complete).
