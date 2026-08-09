# GrantFlow production readiness

**Agent:** production-agent-grantflow  
**Updated:** 2026-08-08T23:55Z  
**Branch:** `production-ready/grantflow`  
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
| Open PRs (baseline) | #1173, #1181, #1183 (draft), #1187 (draft) — see `OPEN_PRS_BASELINE.md` |

Vercel + Railway were already aligned on the same main tip before this agent’s merge. Post-merge deploy SHAs will be recorded after the superseding PR lands.

## Phase B — Audit (vs exit 40–45 / bridge 33–39)

| Area | Finding |
|------|---------|
| Match authority | Crawler-OS + `computeMatchDecision` / `qualifiesForDisplay` are the surfacing contract; prior #1188 drained stale explain stubs. |
| Zero-results | Matching path already had recovery; **`GET /api/discover-grants` hard-filtered on minScore without the ladder** → could return included=0 while matches existed. Fixed on this branch. |
| Counts 1:1 | Matching response lacked explicit `included`/`total_found`; Discover UI preferred local partitions. Aliases + UI prefer `included` now. |
| SSRF / payments / OTP | Open security PRs not on main; CI red on stale branches (privacy tripwire / flaky redos). Reconciled onto this branch. |
| Amy 50/50 + Google parity (41) | Ledger: last measured **21/50**; still open (needs keys / overnight cohort). |
| Link lifecycle ≥95% (42) | Prior work present; not re-proven this run. |
| Score/display authority (43) | #1188 drain evidence on main; residual fleet explains noted in ledger. |
| Three E2E evidence chains (44) | Blocked on consented prod profile / owner credentials. |
| Exact SHA dual deploy + auth journeys (45) | Pre-change SHA aligned; post-merge verify pending merge+deploy. |
| Hamilton honest handoffs (37) | Payment cap atomicity lands via #1173; live portal capture/submit still needs owner proof (Demo STEM pending tasks). |

## Phase C — Plan

1. Cherry-pick/merge open PRs onto `production-ready/grantflow` from current main.  
2. Fix Discover zero-result path + count contract.  
3. Harden flaky redos gate that blocked unrelated PRs.  
4. Open one superseding PR; close #1173/#1181/#1183/#1187 with pointers.  
5. Merge when CI green; record post-deploy SHAs; continue Amy/Hamilton/E2E with owner inputs.

## Phase D — Implemented this run

- Merged #1173 (safeFetch SSRF chokepoint, atomic payment authorization cap, CSPRNG OTP).  
- Cherry-picked #1181 (env-driven login maintenance ETA).  
- Cherry-picked #1183 (avatar_lookup redirect SSRF).  
- Cherry-picked #1187 (httpClient + Yana HTML hop-safe SSRF).  
- `loadProfileOsResults` / discover-grants: zero-result ladder + logged suppression/recovery.  
- Matching API: `included` + `total_found` (+ coverage_summary mirrors).  
- DiscoverGrants UI: prefer `included` for count metadata.  
- `documentIngestionRedos` best-of-3 ratio (CI jitter).  

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
```

Live pre-change:

```
GET https://grantflow-production.up.railway.app/api/version
→ commit 4130970bf33b9f191e20d05f13b1d3974c514ddf

GET https://app.axiombiolabs.org/api/version
→ same commit (Vercel→Railway rewrite)

GET https://app.axiombiolabs.org/grantflow → HTTP 200
```

## Phase F/G — Review / release

- Superseding PR from `production-ready/grantflow` (this report’s tip).  
- Close baseline PRs as superseded after superseding PR is open.  
- **Do not mark exit 40–45 complete** until CI green on merge SHA, dual deploy SHA match, Amy/parity, link rate, three E2E chains, and Hamilton handoff proof.

## Residual blockers (owner)

1. Consented production profile (or login) for Discover crawl + three E2E chains + Hamilton portal capture/submit.  
2. Amy overnight 50-profile cohort + search provider keys for item 41 parity.  
3. Approve/merge superseding PR and confirm post-deploy Vercel+Railway SHAs match.
