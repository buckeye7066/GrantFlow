# Portfolio Ledger

Dated completion records for the App Portfolio Audit. One entry per ACTIVE_APP run.

---

## 2026-08-07 — GrantFlow (Priority 1) — INCOMPLETE

| Field | Value |
|-------|-------|
| ACTIVE_APP | GrantFlow |
| Date | 2026-08-07 (continued evening run) |
| Repo / default branch | `buckeye7066/GrantFlow` / `main` |
| Baseline SHA | `4f4aa567d0e86500ff682d54a4855a72105dead3` (**verified fact**: matches Railway `/api/version` + Vercel `/grantflow/api/version`) |
| Release SHA | *not released this run* — PR [#1179](https://github.com/buckeye7066/GrantFlow/pull/1179) on `fix/match-authority-soft-penalty-and-display-parity` pending green CI + merge + dual deploy |
| Local path | Private Windows checkout (machine-specific path intentionally omitted) |
| Production frontend | `https://app.axiombiolabs.org/grantflow` (Vercel; trailing-slash URL 308 → `/grantflow`) |
| Production backend | `https://grantflow-production.up.railway.app` |
| Deployed SHA (verified) | Railway + Vercel API proxy both report `4f4aa567…` |
| Data store | PostgreSQL on Railway (`dialect: postgres`; ~21,142 opportunities at probe) |
| Target state | Controlled public beta: whole-profile discovery with authoritative scores, honest handoffs, proven outcomes |

### Completed this run
- Re-verified locations and exact production SHA convergence against current `origin/main`.
- **Verified fact — exit item 42 met on production:** `GET /api/health/mission` → `production_gate=true`, `rates.verified_pct=97.5`, `broken_pct=0`, `link_lifecycle.partition_reconciles=true`, broken visible=0 / retired=21 / scheduled_retry=15 / repair_pending=8.
- Confirmed PR 1179 match-authority fixes (soft relevance penalty wiring, matching-funds REVIEW, women exclusivity classifier, Discover ACCEPT/directory keep, recovery alias honesty).
- Fixed CI-blocking recovery regression: recovery test no longer self-disables via `strict`/`allow_relax`; raised cold-import timeouts.
- Wired three orphan farm-lane adapters (`sare_farmer_rancher_grants`, `usda_value_added_producer_grants`, `ky_agricultural_development_fund`) so `npm run crawler:verify` is **178/178 adapters, 0 failures** (was 175/178 + 3 `missing_adapter`).
- Local verification: recovery + soft-relevance + Discover keep + farm coverage tests pass; crawler offline verify passes with multi-profile runs.

### Residual blockers (exit criteria unmet)
- Full CI / clean-room release gates on a merge SHA (item 40) — last CI failure was pre-tip (`3ea20f6d`); tip CI run ended `action_required` with 0 jobs (owner/Actions approval needed to re-run)
- Amy 50/50 cohort + Google-bar parity (item 41)
- Displayed scores/decisions reconciled on production after PR 1179 deploy (item 43)
- Three authenticated E2E evidence chains in production (item 44)
- Dual-deploy of one merge SHA with authenticated production audit (item 45)
- Hamilton packet/handoff live stability proof (bridge 37)
- Fresh consented profile crawl through live Discover UI with owner credentials (owner action)

### Rollback point
- Pre-change production: `4f4aa567` on `main`

### Next app
- Do **not** start next app until GrantFlow exit criteria close or owner redirects. Next incomplete priority remains GrantFlow.

---

## 2026-08-07 — GrantFlow (Priority 1) — INCOMPLETE (earlier daytime entry)

| Field | Value |
|-------|-------|
| ACTIVE_APP | GrantFlow |
| Date | 2026-08-07 |
| Repo / default branch | `buckeye7066/GrantFlow` / `main` |
| Baseline SHA | `a236444cbcfa39a80852a065688425ce687cb529` |
| Release SHA | *not released this run* — branch `fix/match-authority-soft-penalty-and-display-parity` pending PR merge + dual deploy |
| Local path | Private Windows checkout (machine-specific path intentionally omitted) |
| Production frontend | `https://app.axiombiolabs.org/grantflow/` (Vercel) |
| Production backend | `https://grantflow-production.up.railway.app` |
| Deployed SHA (verified) | Railway `/api/health` + `/api/version` report `a236444c…` — **same as main** (superseded by evening re-verify) |
| Data store | PostgreSQL on Railway (`dialect: postgres`; ~20,849 opportunities at probe) |
| Target state | Controlled public beta: whole-profile discovery with authoritative scores, honest handoffs, proven outcomes |

### Completed this run
- Re-verified locations and exact production SHA convergence (Vercel API proxy → Railway build SHA).
- Fixed P0 match-authority / display-parity defects (soft relevance penalty wiring, `requires_match` REVIEW, women exclusivity vs prioritization, Discover ACCEPT/directory keep, honest recovery params).
- Regression tests: 35 passed in targeted suites; local multi-source simulation: 4 included / 6 found across 4 sources.

### Residual blockers (exit criteria unmet)
- Full CI / clean-room release gates on a merge SHA (item 40)
- Amy 50/50 cohort + Google-bar parity (item 41)
- Broken-link quarantine ≥95% verified-link rate (item 42) — *later met; see evening entry*
- Three authenticated E2E evidence chains in production (item 44)
- Dual-deploy of one merge SHA with authenticated production audit (item 45)
- Hamilton packet/handoff stability proof (bridge 37)
- Fresh consented profile crawl through live Discover UI with owner credentials (owner action)

### Rollback point
- Pre-change: `a236444c` on `main` (then current production)

### Next app
- Do **not** start next app until GrantFlow exit criteria close or owner redirects. Next incomplete priority remains GrantFlow.
