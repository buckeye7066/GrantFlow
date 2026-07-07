# Robert — Funding Discovery Agent

Robert is GrantFlow's dedicated background **Funding Discovery Agent**.
His job is to find real funding sources on the public internet —
official portals, foundation pages, school portals, government
directories, fire-department grant pages, and other legitimate
public sources — and surface useful matches to the profiles GrantFlow
already knows about.

Robert never replaces Anya, never replaces Sam, and never invents new
scoring. Every accept/reject and policy decision is delegated to the
existing canonical GrantFlow services.

**Evolved role (2026-07):** Robert grows pillar 2 of the product thesis
("80+ official lanes, simultaneously, continuously" — see
`docs/canonical_rules.md` "The product thesis" and `docs/AGENTS.md`). A lane
the registry lacks is a **structural gap** on the adapter wishlist, never a
silent miss — Robert's source discovery is how those gaps get retired: a
discovered, verified source feeds the lane/source registry, and a shipped
lane closes its wishlist item. Web-parity benchmark failures that trace to a
missing source are demand signals for Robert's search planning.

## What Robert is

| Aspect | Robert | Anya | Sam |
|---|---|---|---|
| Role | Funding discovery & profile recommendations | User/admin grant workflow assistant | Production-readiness / code health |
| Talks to users? | No, only via toasts when a verified opportunity matches a profile | Yes, conversational | No |
| Writes opportunities? | Yes, via canonical ingestion ONLY | No | No |
| Writes code? | No | No, except admin autonomous actions | Yes, gated safe-fix only |
| Mutates the user pipeline? | NEVER without user click | Only on user request | No |

## What Robert is NOT

- A user-facing chat assistant.
- A code-fixing agent.
- A production-readiness agent.
- A grant-writing agent.
- A replacement for Anya, Sam, or the canonical match engine.

## Architecture rule (do not break)

Robert MUST use the canonical GrantFlow path:

```
profile context  → buildCanonicalSignals / normalizeProfile
opportunity raw  → robertOpportunityNormalizer.normalizeForCanonicalInsert
                ↓
              Robert pre-flight (cheap drop of placeholders/loans/SE-URLs/expired)
                ↓
              enforceOpportunityPolicy   (backend/services/crawlers/opportunityPolicy.js)
                ↓
              validateOpportunity        (backend/services/opportunityValidator.js)
                ↓
              reviewOpportunity          (backend/services/reviewerAgent.js)
                ↓
              assessReality              (backend/services/opportunityRealityGate.js)
                ↓
              checkUrl (optional, only with ROBERT_ALLOW_LIVE_WEB=true)
                ↓
              upsertFundingOpportunity   (backend/services/opportunityInserter.js)
                ↓
              computeMatchDecision       (backend/services/matchEngine.js)
                ↓
              Robert recommendation queue (per profile)
                ↓
              user toast → Add / Decline / View Details
                ↓
              saveToProfilePipeline      (backend/services/opportunityMatcher.js)
```

## Operating modes

| Mode | Reads | Writes opps | Calls live web |
|---|---|---|---|
| `observe` (default) | yes | no | no |
| `discover-sources` | yes | no | only with `ROBERT_ALLOW_SOURCE_DISCOVERY=true` |
| `discover-opportunities` | yes | no until verified | only with `ROBERT_ALLOW_LIVE_WEB=true` |
| `verify` | yes | no | optional |
| `ingest` | yes | yes (delegated) | optional |
| `match` | yes | no | no |
| `recommend` | yes | yes (recs only, no pipeline) | no |
| `full-cycle` | yes | yes (delegated) | only with all gates on |

Default mode is `observe`, default state is **disabled**.

## Environment variables

```
ROBERT_ENABLED=false
ROBERT_RUN_ON_STARTUP=false
ROBERT_RUN_ON_SCHEDULE=false
ROBERT_SCHEDULE=0 * * * *
ROBERT_MODE=observe

ROBERT_MAX_SOURCES_PER_RUN=25
ROBERT_MAX_URLS_PER_SOURCE=20
ROBERT_MAX_OPPORTUNITIES_PER_RUN=100
ROBERT_MAX_PROFILES_PER_RUN=50
ROBERT_TIMEOUT_MS=15000

ROBERT_ALLOW_LIVE_WEB=false
ROBERT_ALLOW_SEARCH_ENGINE=false
ROBERT_ALLOW_SOURCE_DISCOVERY=false
ROBERT_PERSIST_CANDIDATES=true
ROBERT_AUTO_INGEST_VERIFIED=false

ROBERT_MIN_SOURCE_TRUST=60
ROBERT_REQUIRE_REAL_APPLICATION_URL=true
ROBERT_RESPECT_ROBOTS=true
ROBERT_USER_AGENT=GrantFlowRobertBot/1.0
ROBERT_RATE_LIMIT_PER_DOMAIN_PER_HOUR=60
ROBERT_FAIL_OPEN=false

ROBERT_RECOMMENDATION_TOASTS_ENABLED=true
ROBERT_MAX_TOASTS_PER_PROFILE_PER_DAY=5
ROBERT_MIN_TOAST_MATCH_SCORE=70
ROBERT_ALLOW_REVIEW_MATCH_TOASTS=true
ROBERT_BATCH_LOW_PRIORITY_RECOMMENDATIONS=true
ROBERT_RECOMMENDATION_POLL_INTERVAL_MS=30000
ROBERT_RECOMMENDATION_LIVE_STREAM_ENABLED=true
ROBERT_RECOMMENDATION_QUEUE_ON_LOGIN=true
```

To turn Robert on for a real production cycle you need ALL of:

```
ROBERT_ENABLED=true
ROBERT_ALLOW_LIVE_WEB=true
ROBERT_AUTO_INGEST_VERIFIED=true
ROBERT_RUN_ON_SCHEDULE=true
```

Anything less keeps Robert in safe / advisory / observe mode.

## Safety defaults

- Disabled.
- Observe mode.
- No live web.
- No auto-ingestion.
- No profile pipeline insertion without explicit user click.
- No user-visible opportunity until policy + validator + reviewer + reality + (optional) link gates pass.
- Domain rate limited.
- Robots-respected (when configured).
- Search-engine result URLs are never accepted as direct opportunity URLs.
- Placeholder, example, test domains are rejected at the URL layer before the canonical chain.

## Data model

| Table | Purpose |
|---|---|
| `robert_runs` | Orchestration history (mode, status, counters, summary) |
| `robert_source_candidates` | Discovered source pages awaiting admin review |
| `robert_opportunity_candidates` | Extracted opportunity candidates (pre-verification) |
| `robert_profile_coverage` | Per-profile coverage / gap snapshot |
| `robert_profile_recommendations` | Pending profile-specific suggestions (toast queue) |
| `robert_domain_rate_limits` | Per-domain hourly fetch governor |

Migrations:
- SQLite: `backend/db/migrations/081_robert_tables.sql`
- Postgres: `backend/db/postgres/migrations/0077_robert_tables.sql`
- Bootstrap: `backend/db/schema.sql` (idempotent CREATE)

## Recommendation queue behavior

When Robert verifies an opportunity that matches one or more profiles:

1. The opportunity is stored in the **general resources pool**
   (`funding_opportunities` via canonical `upsertFundingOpportunity`).
2. A **pending recommendation** is created in
   `robert_profile_recommendations` for each matching profile.
3. A toast / login-queue notification is queued for the affected profile.

User clicks `Yes, Add to Pipeline`:
- Robert calls the canonical `saveToProfilePipeline` — NOT a custom path.
- Recommendation is marked `accepted`.
- The opportunity stays in the general pool.

User clicks `No, Keep in Resources`:
- Recommendation is marked `declined`.
- Opportunity stays in the general pool.
- Robert never re-shows the same opportunity for that profile unless
  the agent explicitly supersedes the declined row (used only when an
  opportunity has materially changed).

User clicks `View Details`:
- Recommendation is marked `viewed`.
- The accept/decline actions remain available.

If no profile fits a verified opportunity, Robert keeps it in the
general pool only and never toasts.

## Live toast & login delivery

There is **no SSE infrastructure** in GrantFlow today, so Robert uses
durable polling that the existing auth scheme can support cleanly:

- Frontend: `RobertRecommendationListener` mounts in `Layout.jsx` after
  auth state is loaded and the active profile is known.
- The listener fetches `/api/robert/recommendations/stream?since=...&active_profile_id=...` on:
  - login,
  - active-profile change,
  - reconnect,
  - and on a configurable polling interval (default 30 s).
- Every recommendation that's shown locally is immediately POSTed to
  `/api/robert/recommendations/:id/delivered`, so the server keeps a
  durable record and can recover missed live events when the user
  reconnects.

If the project later adds SSE/WebSocket infrastructure, the listener
will adopt it through the same `transport:` field on the stream
response.

## API endpoints

### Public
```
GET /api/robert/health
```

### Admin (`req.ctx.isAdmin === true` OR ADMIN/ROBERT_ADMIN_TOKEN)
```
GET  /api/robert/status
POST /api/robert/run
POST /api/robert/analyze-coverage
POST /api/robert/discover-sources
POST /api/robert/discover-opportunities
POST /api/robert/verify-candidates
POST /api/robert/ingest-verified
POST /api/robert/match-new
POST /api/robert/recommend
GET  /api/robert/runs
GET  /api/robert/runs/:runId
GET  /api/robert/source-candidates
POST /api/robert/source-candidates/:id/approve
POST /api/robert/source-candidates/:id/reject
GET  /api/robert/opportunity-candidates
POST /api/robert/opportunity-candidates/:id/approve-ingest
POST /api/robert/opportunity-candidates/:id/reject
```

### Authenticated profile-scoped (uses `ensureProfileAccess`)
```
GET  /api/robert/recommendations
GET  /api/robert/recommendations/deliverable
GET  /api/robert/recommendations/stream
GET  /api/robert/recommendations/:id
POST /api/robert/recommendations/:id/accept
POST /api/robert/recommendations/:id/decline
POST /api/robert/recommendations/:id/viewed
POST /api/robert/recommendations/:id/dismiss
POST /api/robert/recommendations/:id/delivered
```

## Scheduler

`backend/services/robert/robertScheduler.js`:

- Disabled unless `ROBERT_ENABLED=true`.
- Runs on startup only if `ROBERT_RUN_ON_STARTUP=true`.
- Runs on schedule only if `ROBERT_RUN_ON_SCHEDULE=true`.
- Uses an in-memory lock so two runs never overlap.
- Survives Robert errors without crashing the server.
- Schedule parser supports the common cases (hourly, daily-at-hour) and
  defaults to hourly on anything else.

## Reviewing rejected candidates

`GET /api/robert/opportunity-candidates?verification_status=rejected`
returns the candidates Robert dropped, with `verification_reasons_json`
explaining why (`placeholder_url`, `loan_like`, `matching_funds`,
`expired_deadline`, `dead_link`, etc.). Use this to spot a junk source
that should be rejected at the source level via:

```
POST /api/robert/source-candidates/:id/reject
```

## Production deployment guidance

1. Apply migrations (SQLite/Postgres) and confirm `robert_runs` exists.
2. Leave Robert disabled while you watch traffic patterns.
3. Turn on `ROBERT_ENABLED=true` + `ROBERT_RUN_ON_SCHEDULE=true` once
   you have configured a `searchProvider` and `opportunityAdapter` for
   your real source set (Robert ships without live web — by design).
4. Watch `GET /api/robert/runs` and `GET /api/robert/opportunity-candidates`
   in the admin console for the first few cycles before enabling
   `ROBERT_AUTO_INGEST_VERIFIED=true`.
5. Recommendation toasts can be globally disabled by setting
   `ROBERT_RECOMMENDATION_TOASTS_ENABLED=false` without touching
   anything else.
