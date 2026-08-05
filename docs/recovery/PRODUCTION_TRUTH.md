# PRODUCTION TRUTH — GrantFlow

Last live verification: **2026-08-03T20:57Z** (all probes run against the live
environment at that moment; nothing below is inferred from CI or code).

| Fact | Value | Evidence |
|---|---|---|
| Railway (API) commit | `fc30ee3fd4a0a2fc01321690d085ef02c2e6a38b` (main) | `GET /api/version` on grantflow-production.up.railway.app, buildTime 2026-08-03T20:57:30Z |
| Vercel → Railway routing | working | `GET https://app.axiombiolabs.org/api/version` → 200 |
| Liveness | 200 | `GET /healthz` |
| Readiness | `ok:true, status:ready, dialect:postgres, pipeline_status:healthy, mission_gate:passed` | `GET /readyz` |
| Node | v20.20.2 | version payload |

## What this deploy contains (merged + live-verified 2026-08-03)

- **#1152** `3e15e08b` — lockfile fix for the day's high-severity `undici`/`ip-address`
  advisories (was failing the Audit gate on every open PR fleet-wide).
- **#1149** `f07b3ffe` — source-materialization stack REMOVED (~5,100 lines, 8 npm
  hooks, 2 Docker build steps). **The running production image was built by the new
  materializer-free Dockerfile and passes readiness + mission gate — this is the
  live proof, not just CI.** FAILURE_REGISTER F-01 → FIXED (live-verified).
- **#1150** `148dd4f2` — audit gate: FILE_AUDIT ledger + generator/verify,
  EXECUTING_SYSTEM_MAP, FAILURE_REGISTER, SIMPLIFICATION_LEDGER.
- **#1151** `fc30ee3f` — packetPdf chromium launches carry the shared container args
  (F-07). DEPLOYED as part of this image; the specific OOM-avoidance behavior is
  exercised the next time a packet PDF renders in prod (not separately probed —
  labeled DEPLOYED, not live-verified).

## Known limitations / open items at this timestamp

- Mission metrics unchanged by this deploy: Google-parity 47.1/100 (2026-08-03 read),
  last autopilot submission 2026-07-04, 70 authorized tasks stalled. These need the
  F-02/F-03 slices (display second-authorities; catalog re-adjudication sweep), not
  infrastructure work.
- F-02 (17 second-authority hazards) OPEN — another agent has an in-flight branch on
  the display-funnel trust surface; do not collide.
- F-03 (rolling-snapshot re-adjudication) OPEN, sequenced after F-02.
- F-04 (/healthz never touches the DB post-boot; platform gates on liveness only),
  F-05 (swallowed migration failures), F-06 (dead schedulers incl. unreachable
  emailGrantScheduler) OPEN.
- Ledger inspection coverage: 71 of 3,558 readable files (2.0%) at `fc30ee3f`
  (11 previously-inspected files honestly reset after content changed).
