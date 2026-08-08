# Portfolio Ledger

Dated completion records for the App Portfolio Audit. One entry per ACTIVE_APP run.

---

## 2026-08-07 — GrantFlow (Priority 1) — INCOMPLETE

| Field | Value |
|-------|-------|
| ACTIVE_APP | GrantFlow |
| Date | 2026-08-07 / 2026-08-08 UTC |
| Repo / default branch | `buckeye7066/GrantFlow` / `main` |
| Baseline SHA | `4f4aa567d0e86500ff682d54a4855a72105dead3` |
| Feature merge SHA | `c1997d2ca8566f52d361d59e191ca894f0112e99` (PR [#1179](https://github.com/buckeye7066/GrantFlow/pull/1179)) |
| Release SHA (live) | `f6111def8ff6a11fed477ad39bbb88b93580a65f` (PR 1179 + Vercel gate hardening) |
| Local path | Private Windows checkout (machine-specific path intentionally omitted) |
| Production frontend | `https://app.axiombiolabs.org/grantflow` (Vercel Production deploy **success** on `f6111def`) |
| Production backend | `https://grantflow-production.up.railway.app` |
| Deployed SHA (verified) | Railway `/api/version`, Vercel `/grantflow/api/version`, and GitHub Production deployment all report `f6111def…` (**verified fact**, 2026-08-08T01:14Z) |
| Data store | PostgreSQL on Railway (`dialect: postgres`) |
| Target state | Controlled public beta: whole-profile discovery with authoritative scores, honest handoffs, proven outcomes |

### Completed this run
- Merged PR #1179 after green GitHub CI (`test`, `browser-smoke`, `postgres-migrations`, `production-image`).
- **Exit item 42 met:** mission `production_gate=true`, `verified_pct=100`, `broken_pct=0`, `readyz=ready`.
- **Exit item 45 largely met:** Vercel Production + Railway converged on the same live SHA `f6111def`.
- Match-authority: soft relevance penalties in `computeMatchDecision`; Discover ACCEPT/directory keep; matching-funds → REVIEW; shared women exclusivity classifier; recovery alias honesty.
- Farm-lane adapters wired: `crawler:verify` 178/178, 0 failures.
- Fixed Vercel production deploy blocker: OTP/server gates 503 under Vercel build sandbox; Vercel now runs SPA `build` + `crawler-os:lint`, full matrix stays on GitHub CI.

### Residual blockers (exit criteria unmet)
- Amy 50/50 cohort + Google-bar parity (item 41) — needs consented cohort / owner credentials
- Authenticated production score/display reconciliation (item 43) — needs owner login
- Three authenticated E2E evidence chains (item 44) — needs owner credentials
- Hamilton packet/handoff live stability proof (bridge 37) — needs owner credentials / consented profile
- Item 40: PR CI green on merge candidate; main CI may still be catching up on follow-up commits — treat GitHub Actions history as evidence

### Rollback point
- Previous healthy production frontend: `4f4aa567` (pre-PR-1179 Vercel success)
- Previous backend before this run: `4f4aa567`

### Next owner actions (minimal)
1. Provide a consented production profile (or login) for Discover crawl + three E2E evidence chains + Hamilton handoff proof.
2. Authorize Amy 50-profile cohort + plain-web parity benchmark.
3. Optional: review Dependabot high/moderate alerts noted by GitHub on push.

### Next app
- Do **not** start next app until GrantFlow exit criteria close or owner redirects. Next incomplete priority remains GrantFlow.
