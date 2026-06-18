# Agent NOOP conditions — operator config & data (audit 2026-06-18)

Robert, John, and Hamilton can run a clean cycle and still persist no work.
After investigation these are **honest NOOPs** driven by configuration or data,
**not code bugs**. The agents now report *why* they no-op'd. This doc lists the
operator actions that turn each NOOP into real work.

## Robert — "LIVE WEB: blocked" (config)
Live discovery is gated off by default (`backend/services/robert/robertSafety.js`):

- `ROBERT_ENABLED` (default `false`) — master switch
- `ROBERT_ALLOW_LIVE_WEB` (default `false`) — permits the live-web discovery modes

With either off, Robert downgrades to `observe` (read-only) and correctly finds 0.
**Action:** set `ROBERT_ENABLED=true` and `ROBERT_ALLOW_LIVE_WEB=true` to enable
real funding discovery. No code change.

## John — "no upstream leads" (depends on Yana data)
John drafts outreach from leads Yana qualifies. The Yana lead source **is**
registered at boot (`backend/server.js` → `registerLeadSource(makeYanaLeadSource(db))`),
so the wiring is correct. John has nothing to draft because **Yana currently
qualifies 0 leads** (below). When Yana produces qualified leads, John consumes
them automatically.

## Yana — 0 qualified leads (data / product condition)
Investigated in depth. The scoring and qualification are **sound** — the
qualification threshold (`YANA_QUALIFY_THRESHOLD`, default 70) is reachable
*without* an EIN (e.g. email + website + mission + focus_areas = 70). Yana
qualifies 0 because the source pool — `organizations` rows that have a contact
`email` — lacks the website/mission/focus evidence needed to clear the bar.

As of this audit Yana's run summary now reports a `noop_reason` and a
`disqualification_reasons` breakdown (e.g. `no_contact_source×35,
lead_score_below_threshold×5`) so the condition is visible on Mission Control.

**Actions (any of):**
- Populate `organizations` with richer prospect data (email + website + mission +
  focus_areas) — the intended long-term path is a prospect-discovery source.
- Lower `YANA_QUALIFY_THRESHOLD` if the existing data is borderline-acceptable.
- Set `YANA_ENABLED=true` / `YANA_ALLOW_LEADS=true` if not already, so qualified
  leads are pushed to John (capped at `YANA_DAILY_LEAD_CAP`/`YANA_CAP_WINDOW_HOURS`).

No code change unblocks this — it is data/config.

## Hamilton — gated by 48 blockers (data)
Hamilton counts unresolved rows in `hamilton_blockers`
(`backend/services/agentControl/agentAdapters/hamiltonAgentAdapter.js`). The 48
blockers are **real** per-application obstacles (missing docs, login/2FA/CAPTCHA,
payment, attestations, deadlines). Hamilton honestly reports them and does no
unsafe work.

**Action:** review and resolve blockers
(`SELECT blocker_type, COUNT(*) FROM hamilton_blockers WHERE resolved_at IS NULL
GROUP BY blocker_type`), clearing each via the admin Hard Stops UI. Browser
automation also requires `HAMILTON_ENABLE_BROWSER_AUTOMATION` (+ host allowlist)
and `HAMILTON_ALLOW_AUTOSUBMIT` per existing config.

## Pre-flagged (operator, not code)
- **`SAM_GOV_PUBLIC_API_KEY` missing** — operator must set the secret for SAM.gov
  ingestion. Not codeable here.
- **27 unowned profiles** — a data condition to review before any repair. Do not
  auto-repair; review ownership first.
