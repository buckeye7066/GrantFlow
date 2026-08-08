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
| Feature merge SHA | pending drain-priority PR (builds on `a2c7c7f1` / tip `ac18f59c`) |
| Local path | Private Windows checkout (machine-specific path intentionally omitted) |
| Production frontend | `https://app.axiombiolabs.org/grantflow` |
| Production backend | `https://grantflow-production.up.railway.app` |
| Deployed SHA (verified) | Railway tip was `a2c7c7f1`/`ac18f59c` at post-#1184 probe; re-verify after drain-priority merge |
| Data store | PostgreSQL on Railway (`dialect: postgres`) |
| Target state | Controlled public beta: whole-profile discovery with authoritative scores, honest handoffs, proven outcomes |

### Completed this run
- Merged PR #1184 after green GitHub CI (`test`, `browser-smoke`, `postgres-migrations`, `production-image`). Catalog-rescore suite then 24/24 locally.
- **Item 43 residue (code, #1184):** catalog-rescore drains stub `{gate:catalog_rescore}` / missing-`scoring_policy_version` explains before inventory, without the inventory id watermark. Funding-sources falls back to explain JSON for policy version.
- **Item 43 residue (prod measured after #1184):** fleet still ~2754 stale explains / Demo STEM profile (`c4a92724-…`) 284/284 stubs — 20s boot + inventory walk starved the drain. Follow-up: pause inventory while stubs remain, prefer stub-bearing profiles, raise wall clock via `CATALOG_RESCORE_EXPLAIN_TIME_BUDGET_MS` (default 90s). Suite 25/25 locally.
- Prior run carry-forward still holds: item 42 link lifecycle gate; PR #1179 match-authority; Vercel gate hardening.

### Residual blockers (exit criteria unmet)
- Amy 50/50 cohort + Google-bar parity (item 41) — needs search keys / consented cohort
- Item 43 production proof — after drain-priority deploy, re-probe Demo STEM profile + fleet `scoring_policy_*`; owner login still needed for full UI reconciliation receipt
- Three authenticated E2E evidence chains (item 44) — needs owner credentials
- Hamilton packet/handoff live stability proof — needs owner credentials / consented profile
- One CodeQL Analyze JS/TS job failed on a prior PR while a sibling Analyze job passed — confirm baseline metadata if it keeps reddening main

### Rollback point
- Pre-#1184 main tip: `84dc4dc2` (privacy redact)
- Earlier dual-deploy tip: `f6111def`

### Next owner actions (minimal)
1. Provide a consented production profile (or login) for Discover crawl + three E2E evidence chains + Hamilton handoff proof.
2. Authorize Amy 50-profile cohort + plain-web parity benchmark (or provide live search API keys for `npm run acceptance:amy-parity`).
3. Optional: Dependabot high/moderate alerts.

### Next app
- Do **not** start next app until GrantFlow exit criteria close or owner redirects. Next incomplete priority remains GrantFlow.

---

## 2026-08-07 — GrantFlow (Priority 1) — INCOMPLETE (superseded tip; history)

Earlier tip recorded PR #1179 + Vercel gate on `f6111def`. See 2026-08-08 entry for current main `a2c7c7f1` / PR #1184.
