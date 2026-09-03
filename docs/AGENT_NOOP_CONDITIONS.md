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

### Outbound prospect discovery (shipped)
Yana now has a second funnel that finds **NEW** organizations that aren't
GrantFlow clients yet but could benefit (grant-seeking nonprofits), via
ProPublica 990 (`yanaProspectSources.js`). 990 yields a nonprofit's identity but
no contact channel, so `yanaContactEnrichment.js` finds the org's homepage +
email. Honest lifecycle: `discovered → needs_enrichment → qualified`; only
prospects with a real contact channel become qualified leads pushed to John.

**Config to activate (operator):**
- `YANA_ENABLED=true` — master switch.
- `YANA_ALLOW_LIVE_WEB=true` — enables outbound 990 discovery + enrichment
  (default off, mirrors Robert's `ROBERT_ALLOW_LIVE_WEB`). Off ⇒ honest NOOP.
- **Contact enrichment provider:** no web-search provider ships in the repo
  (live web is operator-supplied, exactly like Robert's injected fetcher). Until
  one is wired via `setDefaultContactEnricher(...)`, discovered prospects stay
  `needs_enrichment` (real orgs, no contact yet) — never fabricated contacts.
- `YANA_PROSPECT_LIMIT` (default 100) — prospects scanned per cycle.
- `YANA_ALLOW_LEADS=true` so qualified leads push to John (capped by
  `YANA_DAILY_LEAD_CAP`/`YANA_CAP_WINDOW_HOURS`).

The inbound (own-org) funnel remains data/config as above; lowering
`YANA_QUALIFY_THRESHOLD` only affects that path.

### "N qualified, 0 pushed to John" — now self-explaining
`candidates_qualified` counts every candidate (re-)qualified during the run,
INCLUDING rows that were already forwarded in an earlier run (`pushed_to_john=1`
is never reset — that's the dedup working). So a run can honestly report
`candidates_qualified: 21, leads_pushed_to_john: 0`. The push result now says
which case it is:
- `push_noop_reason: 'no_unpushed_qualified_leads'` — every qualified lead was
  already handed to John (dedup, not lost leads).
- `push_noop_reason: 'cap_reached_in_window'` + `queue_depth` — the rolling
  24h cap (`YANA_DAILY_LEAD_CAP`) is spent; `queue_depth` qualified leads are
  waiting for the window to roll.

### Backlog re-enrichment (shipped)
Stored `needs_enrichment` leads are no longer written once and forgotten: each
discovery run revisits a bounded slice (`YANA_BACKLOG_ENRICH_LIMIT`, default 10;
per-lead retry budget `YANA_BACKLOG_ENRICH_MAX_ATTEMPTS`, default 3) and, when a
REAL published email is found on the org's own site, promotes the lead to
`qualified` with the source page persisted as evidence
(`{ type: 'contact_email_source', source_url }`). Never a fabricated address.

## Hamilton — gated by 48 blockers (data)
Hamilton counts unresolved rows in `hamilton_blockers`
(`backend/services/agentControl/agentAdapters/hamiltonAgentAdapter.js`). The 48
blockers are **real** per-application obstacles (missing docs, login/2FA/CAPTCHA,
payment, attestations, deadlines). Hamilton honestly reports them and does no
unsafe work.

**Action:** review and resolve blockers
(`SELECT blocker_type, COUNT(*) FROM hamilton_blockers WHERE resolved_at IS NULL
GROUP BY blocker_type`), clearing each via the admin Hard Stops UI. Browser
automation requires `HAMILTON_ENABLE_BROWSER_AUTOMATION`; external submission
requires the profile owner's current stored full-automation authorization.

## Pre-flagged (operator, not code)
- **`SAM_GOV_PUBLIC_API_KEY` missing** — operator must set the secret for SAM.gov
  ingestion. Not codeable here.
- **27 unowned profiles** — a data condition to review before any repair. Do not
  auto-repair; review ownership first.
