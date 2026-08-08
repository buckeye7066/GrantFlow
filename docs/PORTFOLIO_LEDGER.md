# Portfolio Ledger

Dated completion records for the App Portfolio Audit. One entry per ACTIVE_APP run.

---

## 2026-08-07 — GrantFlow (Priority 1) — INCOMPLETE

| Field | Value |
|-------|-------|
| ACTIVE_APP | GrantFlow |
| Date | 2026-08-07 (evening release) |
| Repo / default branch | `buckeye7066/GrantFlow` / `main` |
| Baseline SHA | `4f4aa567d0e86500ff682d54a4855a72105dead3` |
| Release SHA | `c1997d2ca8566f52d361d59e191ca894f0112e99` (merge of PR [#1179](https://github.com/buckeye7066/GrantFlow/pull/1179)) |
| Local path | Private Windows checkout (machine-specific path intentionally omitted) |
| Production frontend | `https://app.axiombiolabs.org/grantflow` (Vercel) |
| Production backend | `https://grantflow-production.up.railway.app` |
| Deployed SHA (verified) | Railway `/api/version` **and** Vercel `/grantflow/api/version` both report `c1997d2c…` (**verified fact**, 2026-08-08T00:51Z) |
| Data store | PostgreSQL on Railway (`dialect: postgres`; ~21,142 opportunities) |
| Target state | Controlled public beta: whole-profile discovery with authoritative scores, honest handoffs, proven outcomes |

### Completed this run
- Merged PR #1179 after green CI (`test`, `browser-smoke`, `postgres-migrations`, `production-image`) on tip `b16dbd67`.
- Dual-deploy SHA convergence proven on Railway + Vercel API proxy to merge SHA `c1997d2c`.
- **Exit item 42 met:** mission health `production_gate=true`, `verified_pct=100`, `broken_pct=0`, no release blockers; `readyz=ready`.
- Match-authority bridge: soft relevance penalties wired into `computeMatchDecision`; Discover keeps ACCEPT/directory rows; matching-funds → REVIEW; shared women exclusivity classifier; recovery aliases honest.
- Wired farm-lane adapters so `crawler:verify` = 178/178 adapters, 0 failures; offline profile runs PASS.
- Local suites: recovery, soft-penalty, Discover keep, farm coverage, structured eligibility — all green.

### Residual blockers (exit criteria unmet)
- Amy 50/50 cohort + Google-bar parity (item 41) — needs consented cohort run / owner credentials
- Authenticated production score/display reconciliation audit after deploy (item 43) — needs owner login
- Three authenticated E2E evidence chains (item 44) — needs owner credentials
- Hamilton packet/handoff live stability proof (bridge 37) — needs owner credentials / consented profile
- Main CI on merge commit still running at ledger write time (item 40 partially proven via PR CI + production health)
- Frontend static asset cache may lag API SHA; confirm Vercel production deployment for SPA assets separately if UI drift appears

### Rollback point
- Previous production: `4f4aa567` on `main`

### Next owner actions (minimal)
1. Approve/confirm any remaining GitHub Actions spend if main CI stalls on `action_required`.
2. Provide a consented production profile (or credentials) for Discover crawl + three E2E evidence chains + Hamilton handoff proof.
3. Authorize Amy 50-profile cohort + plain-web parity benchmark run.

### Next app
- Do **not** start next app until GrantFlow exit criteria close or owner redirects. Next incomplete priority remains GrantFlow.
