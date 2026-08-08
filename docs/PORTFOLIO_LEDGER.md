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
| Feature merge SHA | `d1c45680f66b2e0fdb6b620249b871e9233c7558` (PR [#1188](https://github.com/buckeye7066/GrantFlow/pull/1188); builds on #1185/`5ae8d500`, #1184/`a2c7c7f1`, CodeQL #1186/`cfb2abd2`) |
| Local path | Private Windows checkout (machine-specific path intentionally omitted) |
| Production frontend | `https://app.axiombiolabs.org/grantflow` |
| Production backend | `https://grantflow-production.up.railway.app` |
| Deployed SHA (verified) | Railway `/api/version` + `/api/health` report `d1c45680` / ok (**verified fact**, 2026-08-08T13:37Z); frontend HTTP 200 |
| Data store | PostgreSQL on Railway (`dialect: postgres`) |
| Target state | Controlled public beta: whole-profile discovery with authoritative scores, honest handoffs, proven outcomes |

### Completed this run
- Merged PR #1184 → #1185 (catalog-rescore stub drain + drain-priority) then **PR #1188** (linker explain persistence + `stale_match_explain_refresh` boot net).
- **Item 43 prod after #1188 boot (admin SQL):** `stale_match_explain_refresh` scanned/repaired **263/263**; Demo STEM active matches with missing `scoring_policy_version` → **0**; fleet residual lacking the key → **12** (next boots drain). Mission gate green; CodeQL push-lane green after #1186 schema-2 baseline.
- Dependabot overrides PR #1189 opened (`js-yaml@4.3.1`, nested `uuid@11.1.1`).
- Amy 50-profile cohort re-queued on prod (poll `/api/amy/status`); prior measured cohort still **21 ok / 29 weak**.
- Prior carry-forward: item 42 link lifecycle; PR #1179 match-authority; Vercel gate hardening.

### Residual blockers (exit criteria unmet)
- Amy 50/50 clean + Google-bar parity (item 41) — last measured 21/50; local `acceptance:amy-parity` needs search provider keys
- Three authenticated E2E evidence chains (item 44) — needs owner credentials
- Hamilton live submit/handoff proof — Demo STEM readiness shows **41 pending tasks**, most portals `needs_capture`; only a few sessions present
- Optional: Dependabot alerts close once #1189 merges; fleet 12 residual stale explains

### Rollback point
- Pre-#1188 tip: `cfb2abd2` (CodeQL schema-2)
- Pre-#1184 tip: `84dc4dc2` (privacy redact)

### Next owner actions (minimal)
1. Provide a consented production profile (or login) for Discover crawl + three E2E evidence chains + Hamilton portal capture/submit proof.
2. Confirm Amy overnight cohort; authorize plain-web parity (`GOOGLE_CSE_*` / SearXNG) if item 41 must close.
3. Merge Dependabot override PR #1189 if CI green.

### Next app
- Do **not** start next app until GrantFlow exit criteria close or owner redirects. Next incomplete priority remains GrantFlow.

---

## 2026-08-07 — GrantFlow (Priority 1) — INCOMPLETE (superseded tip; history)

Earlier tip recorded PR #1179 + Vercel gate. See 2026-08-08 entry for current main `d1c45680` / PR #1188.
