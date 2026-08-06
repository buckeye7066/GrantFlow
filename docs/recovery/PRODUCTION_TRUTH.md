# PRODUCTION TRUTH — GrantFlow

Last live verification: **2026-08-06**. The probe time was not retained, so
freshness is day-level only. Nothing in this block is inferred from CI or source.

| Fact | Value | Evidence |
| --- | --- | --- |
| GitHub production baseline | `ac578a7c24f07a5613ac518276dd6ffe04da9559` (`main`) | verified `origin/main` |
| Vercel production | `dpl_HovrhTy1NrKnq8bNwj4zzjYaYxPx`, `READY`, https://app.axiombiolabs.org | Vercel deployment metadata |
| Vercel-routed backend API | `ac578a7c24f07a5613ac518276dd6ffe04da9559` | `GET https://app.axiombiolabs.org/api/version`; this is the Railway rewrite, not frontend source evidence |
| Railway API | `ac578a7c24f07a5613ac518276dd6ffe04da9559`, branch `main` | `GET https://grantflow-production.up.railway.app/api/version`; buildTime `2026-08-06T16:29:51Z` |
| Railway runtime | Node `v20.20.2` | version payload |
| Readiness | `ok:true`, `status:ready`, `dialect:postgres`, `pipeline_status:healthy`, `mission_gate:passed` | Railway `/readyz` |
| Vercel frontend source SHA | **UNKNOWN for this baseline** | the retained Vercel receipt proves `READY` and deployment id, but not its Git source SHA |

This proves the deployed backend baseline and a ready Vercel deployment only.
It does not prove frontend/backend exact-SHA convergence, nor that the current
dirty working tree has been merged, released, or deployed. Future releases must
pass `production-deployment-proof.mjs`, which now compares the Vercel-emitted
frontend receipt independently from the Railway API version.

## Historical 2026-08-03 deployment evidence

### What this deploy contains (merged + live-verified 2026-08-03)

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

### Limitations measured 2026-08-03; current status requires revalidation

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
- Ledger inspection coverage: 71 of 3,629 readable files (2.0%) at `fc30ee3f`
  (11 previously-inspected files honestly reset after content changed). The
  ledger does not reconcile with `ac578a7` and must be regenerated only after
  the next clean source commit.
