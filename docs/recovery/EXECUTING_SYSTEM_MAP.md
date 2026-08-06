# EXECUTING SYSTEM MAP — GrantFlow

> **Historical code-trace snapshot.** This map is anchored to the commit below;
> use `PRODUCTION_TRUTH.md` and the current release manifest for deployed/runtime
> facts. Re-trace changed paths before relying on a line or image reference.

Audit anchor: `9dfbfaff7189746ed354ea06181799cda4e88db4` (origin/main, 2026-08-03).
Method: read-only code trace of the files cited below at the anchor SHA. Every claim
here is a claim about the COMMITTED code; live-environment convergence (which SHA
Railway/Vercel actually serve) is tracked separately in `PRODUCTION_TRUTH.md`.

Status legend: VERIFIED-BY-READ (traced in code this audit) · UNKNOWN (not yet traced).
Sections 1–8: VERIFIED-BY-READ. Build/materialization path and data path: pending
their own audit passes (see FILE_AUDIT.csv inspection state).

## 1. Boot sequence

### 1.1 Container layer
- Image `node:20-slim`, two stages; runtime installs `poppler-utils` + `tesseract-ocr` (Dockerfile:45-47).
- Playwright chromium + OS deps in `/ms-playwright` (~300 MB) (Dockerfile:61-65).
- `ENTRYPOINT grantflow-entrypoint`, `CMD node backend/start.js` (Dockerfile:83-92).
- Entrypoint mkdirs `$UPLOADS_DIR /app/data /app/uploads`; chown when root (docker-entrypoint.sh:4-16).
- Privilege drop: probe-then-exec `setpriv --reuid=node` so app is PID 1 (SIGTERM forwarding);
  fallback `su node` leaves root as PID 1, logged (docker-entrypoint.sh:26-33).
- Docker HEALTHCHECK → `/healthz` every 30 s (Dockerfile:89-90). Railway overrides start
  command, healthcheck `/healthz`, timeout 300 s, restart ALWAYS max 10 (railway.json:7-14).

### 1.2 backend/start.js (thin wrapper — does NOT run migrations)
- `unhandledRejection` → log + capture, STAY ALIVE (deliberate anti-502) (start.js:12-21).
- `uncaughtException` → capture, flush, exit 1 (start.js:23-32).
- dotenv + observability, then `await import('./server.js')` is the whole boot (start.js:142).
- Migrations have exactly one owner: server.js (comment start.js:144-145).

### 1.3 backend/server.js top-level (all BEFORE app.listen)
Ordered: ~70 route imports (many lazyRouter) → static SPA/uploads → `await db.healthcheck()`
(failure = degraded mode, NOT exit; server.js:719-735) → boot schema policy →
runtime-secrets key init (**prod hard-exit on failure**, :747-767) → secret restore →
optional `db.exec(schema.sql)` + positive 8-table probe (:866-921) →
`runPendingMigrationsOnBoot()` (default ON; per-file catch-and-continue, failures left
unstamped, reported as DRIFT; **outer catch logs only** :939-946, db/migrate.js:383-421) →
**`ensureSchemaInvariants` — 28 DDL steps** (registry ensureSchemaInvariants.js:1242-1294) →
prod-only `quarantineUnverifiedDirectOpportunities` (gates /readyz mission gate, :973-989) →
`recordAutomationPosture` → John lead-source registration → SQLite legacy ALTERs →
seed/link pass (`seedBaselineFromRepo`, `ensureDesignatedProfiles`, `linkAllProfilesToAdmin`,
`ensureProfileOrgLinks`, `repairInvalidDocumentStatuses`, `repairMissingUploadAvatars`,
:1308-1372) → middleware + route mounting (:2343-2435) → SIGTERM/SIGINT graceful shutdown
(15 s) → **app.listen**, keepAliveTimeout 620 s (anti-proxy-502) (:2994-3006).

### 1.4 After `listening` (deferred, not awaited)
Two handlers. Handler 1 (:3020-3035): `runEnforceInvariants` + qualified pipeline promotion,
both setImmediate + .catch (history: awaiting the sweep pre-listen caused the 2026-07-16
502/deploy-crash loop — comment :1019-1035). Handler 2 (:3051-4301): the scheduler fleet (§3).

## 2. Boot invariant sweeps
- `ensureSchemaInvariants`: 28 DDL-only steps, blocks listen, no network. Heaviest: perf_indexes.
- `runEnforceInvariants` (enforceInvariants.js:8739-9070, file is 9,121 lines): **54 sequential
  data-repair steps** after listen. Six do EGRESS at boot: amount_enrichment (grants.gov API +
  page fetch, 10 rows/20 s), grant_direct_amount (10/20 s), dead_url_repair (4/20 s),
  source_url_self_repair (3/20 s + web search), application_url_rescue (8/20 s + web search),
  john_draft_plausibility (**Microsoft Graph draft DELETE**, 200 cap). SQL steps bounded
  500–2000 rows. Realistic wall-clock: multi-minute background pass on prod Postgres.
  Outcome → `system_kv.enforce_invariants_last_run` (:9052-9068), read by Sam.
- `runSelfHeal` (selfHeal.js:55) is NOT on the boot path; reachable via nightly sweep + Anya
  on-demand; calls runEnforceInvariants as its own step (:482).

## 3. Scheduler inventory (server.js listening handler; gate = SMOKE_MODE || DISABLE_BACKGROUND_SERVICES)
ON by default: boot invariant sweep; post-listen promotion; profile-portals pre-resolve (6 h);
county-cache warm; **Amy training (24 h interval + 90 s overdue catch-up, target 100 synthetic
profiles/day, crawls + persists)**; agent-control lock sweeper (5 min); PG CHECK self-heals ×3;
stuck-job reset/requeue/stale cleanup; **Hamilton restart recovery** (always, :3381-3391);
queue startup drain + **queue poller (60 s)** + drain interval (60 s); matching self-check;
feature flags; auto profile dedupe (+20 s, MERGES duplicate profiles); **Anya autonomous ops
(+5 s) + 30-min scheduled check**; deadline cron (02:00 local); **link verification (6 h,
batch 200, live HTTP)**; weekly link report (Mon 06:00 ET); Hamilton weekly digest (Mon 08:00 ET);
Monday portal reminder (09:00 ET); **nightly maintenance sweep 04:00 ET** (see below);
nightly qualified promotion (04:00 ET); **Sam full code sweep 05:00 ET**; **Anya daily owner
report 09:00 ET**; EVA maintenance (hourly); Anya health service (30 min); Anya brain cleanup
(daily); audit-log sink; Robert AUTOSEED (+5 min — runs even with ROBERT_ENABLED=false,
robertSafety.js:45-55).
OFF by default: Robert full, Yana, Sam scheduler, John, Yana outreach, startup smoke crawlers,
national-programs crawler, billing automation, Hamilton scheduler (needs HAMILTON_RUN_ON_SCHEDULE
+ HAMILTON_ENABLE_BROWSER_AUTOMATION).
Module-level timers (armed at import): Hamilton cloud-login session sweeper
(hamiltonCloudLogin.js:142), per-session keyframe streamer, response-cache eviction,
SSE heartbeats, crawler-job heartbeats.

Nightly 04:00 ET sweep chain (nightlySweep.js:52-290): SMS-consent expiry → runSelfHealOnDemand
(re-runs all 54 invariants) → profile coverage sweep + autoheal → web-parity benchmark (live
web) → Amy competitive research (web+LLM) → amount enrichment night budget (120/300 s) →
gap-email drafts (off) → Amy synthetic reaper → disk prune → Sam observe/dryRun + HTTP probe.

**Dead schedulers (tree carries them, ZERO runtime importers):** startup/backgroundServices.js
(749 lines, 3 intervals, starts emailGrantScheduler → therefore the email-grant poller NEVER
runs), startup/queueRecovery.js, crawler-os/scheduler.js, services/anyaBootstrap.js,
startup/bootstrap.js (594 lines). Deletion candidates → SIMPLIFICATION_LEDGER.

## 4. Process inventory
Browsers — six launch sites, TWO launchers:
- Canonical: services/hamilton/browserLaunch.js (`CHROMIUM_CONTAINER_ARGS` incl.
  --disable-dev-shm-usage; channel:'chromium' full build w/ headless-shell fallback; shared
  REALISTIC_PORTAL_UA). Used by: hamiltonAutopilotEngine, hamiltonCloudLogin,
  hamiltonPortalSignupAdapter, hamiltonSessionKeepAlive, portalSync/index.
- Bespoke: hamiltonApplicationPacketGenerator.js:477-480 (container args, no channel) and
  **services/packetPdf.js:26,:50 — bare `chromium.launch({headless:true})`, NO container args**
  (missing --disable-dev-shm-usage/--no-sandbox; documented exception covers args-less local
  HTML rendering but this drops the args entirely — OOM-risk finding).
OCR/PDF: pdftotext (20 s timeout), pdftoppm (120 s, 150 dpi), tesseract.js WASM worker —
NOTE: Dockerfile installs native tesseract-ocr but runtime uses the JS worker (image-size
finding). Other spawns: sqlite→pg migration child (flag-gated), Anya `node --check`,
Sam git/gh/npx, version-route git rev-parse (blocking, cached).

## 5. Health model
- `/healthz` = liveness + schema-bootstrap flags from app.locals ONLY — **no live DB query**
  (routes/health.js:221-247). A container whose DB dies after boot stays 200 forever.
- `/readyz` = live DB query → required schema → JWT-secret strength → uploads writable →
  prod mission gate (routes/health.js:290-369).
- `/api/version` (+ `/api/health/deployment` with bootId + matcherVersion), storage/data-
  readiness/alerts/mission endpoints.
- **Railway and Docker both probe /healthz (liveness). NOTHING platform-side gates on /readyz** —
  traffic is routed to instances readiness would refuse. /readyz is exercised only by Sam's
  internal probe + tests. Documented live symptom: healthz=200 while readyz=502
  (server.js:1025-1030).

## 6. Deployment topology
- Vercel: build `npm run release:gates`, output dist (vercel.json:3-5).
- Rewrites (ordered): host-gated `(app|www|grantflow).axiombiolabs.org` → proxy `/api` +
  `/uploads` (+ `/grantflow/*` twins) to grantflow-production.up.railway.app; ALL other hosts
  (previews) → `/api/preview-backend-disabled` = **HTTP 503 stub** (previews are frontend-only
  by design); SPA fallbacks exclude `assets/` so missing hashed assets 404 (vercel.json:7-34).
- Headers: HSTS preload, XFO DENY, CSP; `/api/*` no-store; assets immutable 1 y.
- Client base-URL logic forces same-origin on axiombiolabs.* unless VITE_FORCE_RAILWAY_API
  (src/config/env.js:54-134). Railway container also serves the SPA + uploads.

## 7. Boot-time mutation surface (no request required)
Pre-listen: schema exec, pending migrations, runtime-secret row rewrite, 28 DDL steps,
prod quarantine sweep, posture write, profile/org seed+link (up to 5000 rows), document-status
+ avatar repairs, service-catalog seed, PG CHECK drops/adds.
Post-listen: **54 data-repair steps incl. match-row deletes, pipeline purges, task
cancel/requeue, profile creation, income/display-name rewrites, Outlook draft DELETEs (Graph)**;
qualified promotion; stuck-job resets; orphaned-task reconcile; auto profile-dedupe MERGE;
queue drain → live crawling; Anya autonomous ops; link verification (200-row live HTTP);
Robert autoseed (USASpending/ProPublica egress); Amy catch-up (up to 100 synthetic profiles +
crawls); deadline expiry.

## 8. Swallowed-failure choke points at boot (§3.3 targets)
1. db.healthcheck failure → degraded mode, process lives (server.js:729-735).
2. schema exec throw → flag + continue (mitigated by positive table probe :890-920).
3. **runPendingMigrationsOnBoot throw → console.error only** (:943-945); per-file failures
   leave files unstamped, only "schema check: DRIFT" records it.
4. ensureSchemaInvariants: steps NOT individually try/caught in the loop — a throwing step
   aborts the REMAINING steps into the outer catch (ensureSchemaInvariants.js:1279-1292).
5. Mission-gate quarantine throw → warn; /readyz fails closed, /healthz does not.
6. **runEnforceInvariants double-swallow** (:1045-1050, :3024-3026); durable signal only
   `system_kv.enforce_invariants_last_run`, itself written inside bare `catch {}`.
7. Per-step `{ok:false}` results: failed count logged, **nothing gates on it** — a step can
   fail every boot forever.
8. Post-seed repairs: one warn for three repairs.
9. Baseline-seed: two nested swallows.
10. PG CHECK self-heal → "skipped" warn; later inserts fail silently downstream.
11. Audit-log sink insert → bare catch {} (durable warn/error logs can vanish).
12. Global unhandledRejection keeps process alive (deliberate; background scheduler
    rejections invisible except logs).
Hard-fail exits: runtime-secret key init (prod), listen bind error, Anya tool-registry
duplicate ids (prod), uncaughtException.
Also: nightly qualified-promotion call site is the one ET job not wrapped in
runWithSchedulerLock at the call site (lock lives inside the fn instead) — consistency note.

## 9. Build/materialization path (VERIFIED-BY-READ + empirical run 2026-08-03)
8 npm lifecycle hooks (prepare/predev/prebuild/preunit/pretest/prebackend/prestart/
prerelease:gates) + Docker build ran `scripts/materialize-production-source.mjs`:
a 27-module, ~5,100-line signature-driven patch stack able to rewrite 45 TRACKED
files (none git-ignored), including two of its own patch modules. At the anchor it
is INERT (patched state committed; zero content diff when run in a clean worktree —
empirically verified) and BROKEN (full regeneration path would crash on
already-transformed anchors; its incremental verification gate is unreachable due to
a `process.exit(0)` in one module — empirically verified: final verification line
never prints). Deterministic given the hard-coded module order; order-dependent by
design (one module re-indents anchors for the next; one overwrites a predecessor's
gate line). Disposition: REMOVAL (branch `recovery/remove-source-materialization`) —
see FAILURE_REGISTER F-01 and SIMPLIFICATION_LEDGER.

## 10. Match-decision authority map (VERIFIED-BY-READ, census 2026-08-03)
Canonical: `backend/services/matchEngine.js` (`scoreOpportunity` :2461,
`makeDecision` :3672, `computeMatchDecision` :4203). Well-behaved adapters: the
crawler-os facade, catalogRescoreSweep, the 8 recall-link boot nets,
grantScoreBackfill, qualifiedPipelinePromotion, qualifiesForDisplay,
fundingSourceQueries.
**17 second-authority hazards remain** (can overturn/contradict the engine) — full
detail in FAILURE_REGISTER F-02. Read-path gate chain for
`GET /api/profiles/:id/funding-sources` runs TEN gates after the engine: SQL lane
filters → needFirst re-score WITH DB WRITE (GET mutates scores) → strict relevance
net (every soft rule hard-drops) → trust gate → live-decision drop → needFirst again
+ loose dedup → geo-stub drop → qualifiesForDisplay → canonical dedup + not_a_grant
hidden bucket → frontend floor/dedup (no ACCEPT bypass). Score scales in play:
data_point_v1 (current), legacy 0-100 (retired, still hardcoded in 3 live consumers),
Instrumentl fit % (display), item-need score, vnext EV, two dormant rival scales.

## Open sections (pending audit passes)
- §Data path detail (profile → thesis → crawl → classify → match → display → task → submit).
- §Live convergence: current Railway/Vercel SHAs, /api/version read (PRODUCTION_TRUTH.md).
