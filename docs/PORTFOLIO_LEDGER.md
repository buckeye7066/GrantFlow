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
| Feature merge SHA | `5ae8d5000a586ae0408d295804763fc06f009d52` (PR [#1185](https://github.com/buckeye7066/GrantFlow/pull/1185) squash; builds on #1184 `a2c7c7f1`) |
| Local path | Private Windows checkout (machine-specific path intentionally omitted) |
| Production frontend | `https://app.axiombiolabs.org/grantflow` |
| Production backend | `https://grantflow-production.up.railway.app` |
| Deployed SHA (verified) | Railway `/api/version` + `readyz` report `5ae8d500` / ready (**verified fact**, 2026-08-08T03:53Z) |
| Data store | PostgreSQL on Railway (`dialect: postgres`) |
| Target state | Controlled public beta: whole-profile discovery with authoritative scores, honest handoffs, proven outcomes |

### Completed this run
- Merged PR #1184 (stub explain drain phase) then PR #1185 (pause inventory + prefer stub-bearing profiles + 90s explain-drain budget). Binding CI green; one intermittent CodeQL Analyze JS/TS sibling still flaky.
- **Item 43 prod after #1185 boot (admin SQL):** fleet exact stubs `{"gate":"catalog_rescore"}` → **0**; catalog-rescore rows with policy key **3826/3826**; Demo STEM profile catalog-rescore rows **266/266** carry `need_first` policy (was 284/284 exact stubs). Mission gate green.
- Prior carry-forward: item 42 link lifecycle; PR #1179 match-authority; Vercel gate hardening.

### Residual blockers (exit criteria unmet)
- Amy 50/50 cohort + Google-bar parity (item 41) — needs search keys / consented cohort
- Item 43 UI receipt — owner login still needed for full Funding Sources reconciliation receipt (backend provenance now current)
- Three authenticated E2E evidence chains (item 44) — needs owner credentials
- Hamilton packet/handoff live stability proof — needs owner credentials / consented profile
- Optional: Dependabot high/moderate alerts; intermittent CodeQL Analyze JS/TS baseline

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
