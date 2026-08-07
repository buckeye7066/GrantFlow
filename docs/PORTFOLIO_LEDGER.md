# Portfolio Ledger

Dated completion records for the App Portfolio Audit. One entry per ACTIVE_APP run.

---

## 2026-08-07 — GrantFlow (Priority 1) — INCOMPLETE

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
| Deployed SHA (verified) | Railway `/api/health` + `/api/version` report `a236444c…` — **same as main** |
| Data store | PostgreSQL on Railway (`dialect: postgres`; ~20,849 opportunities at probe) |
| Target state | Controlled public beta: whole-profile discovery with authoritative scores, honest handoffs, proven outcomes |

### Completed this run
- Re-verified locations and exact production SHA convergence (Vercel API proxy → Railway build SHA).
- Fixed P0 match-authority / display-parity defects (soft relevance penalty wiring, `requires_match` REVIEW, women exclusivity vs prioritization, Discover ACCEPT/directory keep, honest recovery params).
- Regression tests: 35 passed in targeted suites; local multi-source simulation: 4 included / 6 found across 4 sources.

### Residual blockers (exit criteria unmet)
- Full CI / clean-room release gates on a merge SHA (item 40)
- Amy 50/50 cohort + Google-bar parity (item 41)
- Broken-link quarantine ≥95% verified-link rate (item 42)
- Three authenticated E2E evidence chains in production (item 44)
- Dual-deploy of one merge SHA with authenticated production audit (item 45)
- Hamilton packet/handoff stability proof (bridge 37)
- Fresh consented profile crawl through live Discover UI with owner credentials (owner action)

### Rollback point
- Pre-change: `a236444c` on `main` (current production)

### Next app
- Do **not** start next app until GrantFlow exit criteria close or owner redirects. Next incomplete priority remains GrantFlow.
