# Agent Mission Control

Admin dashboard that shows what each GrantFlow agent is doing across the
system — activity, productivity, outcomes, errors, recent events.

## Quick reference

- **Page:** Admin Panel → **Mission Control** tab (`/Admin` → `agents`).
- **Component:** `src/components/admin/AdminAgentMissionControl.jsx`.
- **API root:** `/api/admin/agent-telemetry/*` (admin-only).
- **Default range:** last 24 hours; 7d / 30d selectable from filter bar.
- **Auto-refresh:** 45 s by default, throttled to one in-flight refresh,
  paused while the page is hidden, toggleable per-session.

## Agents covered

| Agent | Tagline | Primary metrics |
|---|---|---|
| **Anya** | User Assistance | interactions, sessions, tool invocations, unique users |
| **Sam** | Production Readiness | checks run, errors found, errors resolved, failed gates |
| **Robert** | Funding Discovery | sources checked, opportunities found / verified / ingested, recommendations, accepted |
| **Yana** | Client Discovery | websites checked, leads found / qualified / sent to John, conversion rate |
| **John** | Outreach Drafts | drafts created (24h), daily capacity remaining, blocked, alias review, suppression hits |

## Dashboard sections

1. **Agent overview cards** — one card per agent showing health, install
   state, success rate, error count, and the agent's primary metrics.
2. **Agent system health** — health badge per agent + which expected
   tables are present / missing per agent + presence of unified
   `agent_activity_events` and `agent_daily_rollups` tables.
3. **Yana lead funnel** — websites checked → lead candidates → qualified
   → sent to John → John drafts created. Headline answers "how many
   pages did Yana look at vs how many leads she sent John?".
4. **John draft metrics** — used / total / remaining of the daily 50-draft
   cap, plus blocked counts, alias review queue, suppression hits, and a
   ranked block-reason breakdown.
5. **Robert opportunity discovery** — funnel from sources to ingested to
   accepted into pipelines, plus the rejection breakdown (dead link,
   placeholder, loan, matching funds, expired, etc.).
6. **Robert opportunity map** — state-level bar chart of ingested
   opportunities; click a state to see top categories and example
   opportunities. Cities and unknown-location counts shown alongside.
7. **Anya interaction panel** — metadata only by default: sessions,
   interactions, tool calls, recent users, mode breakdown
   (`copilot` / `admin_ops` / `code_advisor`), top tools. Message
   content is never returned by the API.
8. **Sam findings panel** — open / resolved findings filtered by
   severity (critical / high / medium / low) with file paths and a
   structured details view (secrets redacted server-side).
9. **Activity timeline** — chronological event stream pulled from the
   unified `agent_activity_events` table when available, otherwise
   synthesised from per-agent tables (`john_email_drafts`, `anya_runs`,
   …) so the timeline still works on partial deployments.

## Filters

| Filter | Values |
|---|---|
| Range | `24h`, `7d`, `30d`, `custom` (`?start=` `?end=`) |
| Agent | `all`, `anya`, `sam`, `robert`, `yana`, `john` |
| Status | `all`, `succeeded`, `failed`, `blocked`, `warning` |
| Severity (Sam) | `critical`, `high`, `medium`, `low` |

The filter bar also exposes:

- **Refresh** button (manual)
- **Auto-refresh** checkbox (default on, 45 s, paused when page hidden)
- "Last refreshed at …" timestamp

## API endpoints

All endpoints require an authenticated admin (`ensureAuth + ensureAdmin`).
Non-admin requests get `401` / `403` with no body. Admin queries are
wrapped in `withProfileScope({ actorRole: 'admin_global' })` so the
profile-scope guard at `backend/db/scopedQuery.js` correctly bypasses the
tenant filter for cross-profile reads (e.g. `anya_sessions`).

| Method | Path | Returns |
|---|---|---|
| GET | `/api/admin/agent-telemetry/summary` | `{ ok, range, agents: { anya, sam, robert, yana, john } }` |
| GET | `/api/admin/agent-telemetry/timeline` | `{ ok, events, source: 'unified' \| 'synthetic' }` |
| GET | `/api/admin/agent-telemetry/yana` | `{ ok, summary, funnel }` |
| GET | `/api/admin/agent-telemetry/robert` | `{ ok, summary, funnel }` |
| GET | `/api/admin/agent-telemetry/robert/map` | `{ ok, by_state, by_city, unknown_count }` |
| GET | `/api/admin/agent-telemetry/sam` | `{ ok, summary, findings: { findings, counts } }` |
| GET | `/api/admin/agent-telemetry/anya` | `{ ok, summary, panel }` |
| GET | `/api/admin/agent-telemetry/john` | `{ ok, summary }` |
| GET | `/api/admin/agent-telemetry/health` | `{ ok, overall, agents, diagnostics, unified_table_present, rollup_table_present }` |

Query params accepted on every endpoint:
`?range=24h|7d|30d`, `?start=`, `?end=`, `?agent=`, `?status=`,
`?severity=`, `?profile_id=`, `?state=`, `?limit=`.

Errors degrade to `{ ok: false, error, detail }` with HTTP 200 so the
dashboard renders an empty panel instead of a hard fail.

## Metric definitions

### Yana

```text
websites_checked      = SUM(yana_runs.urls_fetched) over range
leads_found           = SUM(yana_runs.leads_found) or COUNT(yana_lead_candidates)
leads_qualified       = COUNT(yana_lead_candidates WHERE qualification_status='qualified')
leads_sent_to_john    = COUNT(yana_john_queue)
leads_rejected        = COUNT(yana_lead_candidates WHERE rejection_reason IS NOT NULL)
lead_conversion_rate  = leads_sent_to_john / NULLIF(websites_checked, 0)
```

### John

```text
drafts_created        = COUNT(john_email_drafts WHERE draft_status IN
                          ('created','needs_review','needs_sender_alias_review'))
drafts_blocked        = COUNT(john_email_drafts WHERE draft_status='blocked')
drafts_created_24h    = drafts_created restricted to last 24 hours
daily_capacity_total  = JOHN_MAX_DRAFTS_PER_24H (default 50)
daily_capacity_remaining = max(0, daily_capacity_total - drafts_created_24h)
suppression_hits      = COUNT(john_email_drafts WHERE block_reason='suppressed')
alias_status          = john_alias_checks ORDER BY checked_at DESC LIMIT 1
```

### Robert

```text
sources_checked       = SUM(robert_runs.sources_checked)
opportunities_found   = SUM(robert_runs.candidates_found) or COUNT(robert_opportunity_candidates)
opportunities_verified  = COUNT(robert_opportunity_candidates WHERE verification_status='verified')
opportunities_ingested  = COUNT(robert_opportunity_candidates WHERE ingested_opportunity_id IS NOT NULL)
profile_recommendations = COUNT(robert_profile_recommendations)
pipeline_acceptances    = COUNT(robert_profile_recommendations WHERE recommendation_status='accepted')
general_pool_only       = max(0, opportunities_verified - profile_recommendations)
rejection_reasons       = grouped count of robert_opportunity_candidates.rejection_reason
```

### Robert map

```text
by_state[]   = group ingested opportunities by UPPER(state)
                with category breakdown + 5 example titles per state
by_city[]    = group ingested opportunities by (state, city) (top 200)
unknown_count = ingested opportunities with no state, city, or lat/lng
```

### Sam

```text
checks_run            = COUNT(sam_runs)
errors_found          = sum of severity counts (critical+high+medium+low)
critical_errors       = COUNT(sam_findings WHERE severity='critical')
errors_resolved       = COUNT(sam_findings WHERE status='resolved')
failed_gates          = COUNT(sam_findings WHERE event_type='gate_failed')
severity_breakdown    = { critical, high, medium, low, info }
```

Findings include `details_json`, but `secret`/`token`/`password`/
`authorization`/`api_key`/`bearer` keys are redacted before responding.

### Anya

```text
interactions          = COUNT(anya_messages)
unique_users          = COUNT(DISTINCT anya_runs.user_id WHERE user_id IS NOT NULL)
sessions              = COUNT(anya_sessions)
tool_invocations      = COUNT(anya_tool_usage)
modes                 = grouped count of anya_runs.mode
recent_users          = list of (user_id, profile_id, sessions, last_at)
most_used_tools       = top 10 by anya_tool_usage.tool_name
```

## Privacy rules

- **Anya messages are never returned** by the API. The panel surfaces
  counts and modes only. Any future "expand this user's messages"
  affordance must run through a separate endpoint with its own access
  controls.
- **Sam findings redact secrets** server-side
  (`backend/services/agentTelemetry/agentTelemetryAggregator.js#redactSecrets`).
  Keys matching `/secret|token|password|api[-_ ]?key|authorization|bearer/i`
  are replaced with `[REDACTED]` before the JSON ever leaves the
  server, and the response is also free of full email bodies, OAuth
  tokens, and DB connection strings by virtue of never querying them.
- **No tenant data leaks.** Routes wrap their work in
  `withProfileScope({ actorRole: 'admin_global' })`. The profile-scope
  guard logs cross-tenant reads against the admin context only.

## Graceful degradation

The dashboard is designed to load even when **none** of the agent
tables exist yet:

- `tableExists(db, name)` is consulted before every per-agent query.
  Missing tables → return zeros, `installed: false`, `health: not_installed`.
- `health.diagnostics` lists exactly which expected tables are present /
  missing per agent, so an admin can see what to install next.
- The unified `agent_activity_events` and `agent_daily_rollups` tables
  are created by migration `084_agent_telemetry.sql` (sqlite) and
  `0080_agent_telemetry.sql` (postgres). Both are idempotent.
- If the unified events table is missing too, the timeline endpoint
  falls back to synthesising events from `john_email_drafts` and
  `anya_runs` so admins still see an activity stream.

## Adding a new agent metric

1. Add the metric to the relevant aggregator function in
   `backend/services/agentTelemetry/agentTelemetryAggregator.js` —
   guard the read with `tableExists()` and add the value to the
   agent's `primary_metrics` object.
2. Add the metric to the metric definitions section above.
3. Surface the metric in the relevant card / panel under
   `src/components/admin/agents/`.
4. Add a unit test in `tests/unit/agent-telemetry-aggregator.test.mjs`
   that seeds the table fixture and asserts the new metric value.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Card shows "not installed" but agent code exists | The agent's tables haven't been migrated yet — check `health.diagnostics.<agent>.missing_tables`. |
| Robert map is empty but Robert ran | Robert ingested rows but didn't set state/city/lat/lng — they fall under `unknown_count`. |
| Anya panel empty for an active user | Anya has not run since the start of the selected range — widen to 7d or 30d. |
| Sam findings count > 0 but list empty | Filter selection (severity / status) excludes them — clear filters. |
| Health endpoint returns `not_installed` overall | None of the per-agent tables exist on this database. Run the agents' own migrations. |
| 401 / 403 from telemetry endpoints | The user is not an admin in the DB; check `users.role` / admin allowlist. |

## Tests

- `tests/unit/agent-telemetry-store.test.mjs` — store, table-exists,
  rollup upserts, missing-table no-ops.
- `tests/unit/agent-telemetry-aggregator.test.mjs` — per-agent
  metrics, John 50/24h cap, Robert map grouping, Sam secret redaction,
  Anya privacy.
- `tests/unit/agent-telemetry-service.test.mjs` — service-layer shape,
  graceful degradation, partial-install handling.
- `tests/unit/agent-telemetry-routes.test.mjs` — admin gating, no
  secrets in payload, 200-with-empty-body when tables missing.

## Future enhancements

- Real US-states choropleth in place of the bar-chart heatmap.
- WebSocket / SSE push for the activity timeline (currently 45 s poll).
- Per-agent quality scoring once Sam's auditor lands.
- Alert routing on critical findings (currently dashboard-only).
