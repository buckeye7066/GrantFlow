# Portfolio Ledger

Dated completion records for the App Portfolio Audit. One entry per ACTIVE_APP run.

---

## 2026-08-08 — GrantFlow (Priority 1) — INCOMPLETE

| Field | Value |
|-------|-------|
| ACTIVE_APP | GrantFlow |
| Date | 2026-08-08 UTC |
| Repo / default branch | `buckeye7066/GrantFlow` / `main` |
| Baseline SHA (prior ledger tip) | `84dc4dc2928598553ffdb69678ca7e06548da39f` |
| Feature merge SHA | `a2c7c7f1bc80eebcaf5cbd530416b084999b6f47` (PR [#1184](https://github.com/buckeye7066/GrantFlow/pull/1184) squash) |
| Local path | Private Windows checkout (machine-specific path intentionally omitted) |
| Production frontend | `https://app.axiombiolabs.org/grantflow` |
| Production backend | `https://grantflow-production.up.railway.app` |
| Deployed SHA (verified) | Railway `/api/version` + `readyz` and frontend proxy all report `a2c7c7f1` / ready (**verified fact**, 2026-08-08T02:48Z) |
| Data store | PostgreSQL on Railway (`dialect: postgres`) |
| Target state | Controlled public beta: whole-profile discovery with authoritative scores, honest handoffs, proven outcomes |

### Completed this run
- Merged PR #1184 after green GitHub CI (`test`, `browser-smoke`, `postgres-migrations`, `production-image`). Catalog-rescore suite 24/24 locally.
- **Item 43 residue (code):** catalog-rescore now drains stub `{gate:catalog_rescore}` / missing-`scoring_policy_version` explains in a dedicated phase *before* the inventory walk, without applying the inventory id watermark (so lower-id stubs are not starved). Funding-sources falls back to explain JSON for policy version. CI eqeqeq on `parseExplainJson` fixed.
- Prior run carry-forward still holds: item 42 link lifecycle gate; PR #1179 match-authority; Vercel gate hardening.

### Residual blockers (exit criteria unmet)
- Amy 50/50 cohort + Google-bar parity (item 41) — needs search keys / consented cohort
- Item 43 production proof — boots must drain stub explains; owner login still needed for full UI reconciliation receipt
- Three authenticated E2E evidence chains (item 44) — needs owner credentials
- Hamilton packet/handoff live stability proof — needs owner credentials / consented profile
- Confirm Railway direct `/api/version` == `a2c7c7f1` after redeploy settles (proxy already shows it)

### Rollback point
- Pre-#1184 main tip: `84dc4dc2` (privacy redact)
- Earlier dual-deploy tip: `f6111def`

### Next owner actions (minimal)
1. Provide a consented production profile (or login) for Discover crawl + three E2E evidence chains + Hamilton handoff proof.
2. Authorize Amy 50-profile cohort + plain-web parity benchmark (or provide live search API keys for `npm run acceptance:amy-parity`).
3. Optional: Dependabot high/moderate alerts; one CodeQL Analyze JS/TS job failed on the PR while a sibling Analyze job passed — confirm baseline metadata if it keeps reddening main.

### Next app
- Do **not** start next app until GrantFlow exit criteria close or owner redirects. Next incomplete priority remains GrantFlow.

---

## 2026-08-07 — GrantFlow (Priority 1) — INCOMPLETE (superseded tip; history)

Earlier tip recorded PR #1179 + Vercel gate on `f6111def`. See 2026-08-08 entry for current main `a2c7c7f1` / PR #1184.
