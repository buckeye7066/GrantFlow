# 2026-09-15 — P0 production-readiness start

## Session-local evidence

- Repository HEAD `36ca06c1cbaa9263bd0dbd7bf31a6f7ea2e79a2c` has successful
  GitHub deployment records for both Vercel production and Railway production.
  Its required `test` and `test-suite` checks are green.
- A manually dispatched read-only production smoke run
  (`35033997540`) reached the live frontend and API, but failed because
  `/api/profiles/schema` returned 401. The public schema handler itself was
  still present; the earlier-mounted profile-memory router applied its auth
  middleware to every `/api/profiles/*` request before route matching.
- The profile-memory auth middleware is now scoped to
  `/:profileId/memory`, with regression coverage proving memory remains
  authenticated while public sibling profile routes fall through.
- The production smoke now probes the backend `/readyz` mission gate directly
  instead of treating `/api/health` liveness as release readiness. The workflow
  uses `SMOKE_READY_URL` because Vercel intentionally proxies `/api` and
  `/uploads`, not the backend-root `/readyz` route. The workflow exposes that
  value as a required `ready_url` dispatch input so a non-production frontend
  smoke cannot accidentally report the production backend's readiness.
- A manually dispatched read-only Hamilton production probe
  (`35034180374`) completed. All aggregate lifecycle queries ran except
  `submitted_proof_documents`, which the scoped audit role correctly could not
  read because `documents` is denied. This run therefore does **not** establish
  a durable-confirmation count; that outcome remains unknown.
- Direct production HTTP from the task container remains unavailable because
  its CONNECT proxy returns 403. GitHub Actions is the working live-probe path.

## P0 status

1. **Deployment identity:** VERIFIED on 2026-09-16 for merge SHA
   `53b1b70dcc6eb25075136ea3f2699a228f084a4a`: GitHub deployment records report
   success for both Vercel production and Railway production.
2. **Mission gate/catalog freshness:** VERIFIED on that exact deployment by
   read-only workflow run `35039043869`. It reached the production frontend and
   Railway backend and reported `health_status: ok`, `readiness_status: ready`,
   and `profile_schema_checked: true`. This closes the catalog/`/readyz` P0;
   it does not establish discovery, submission, or billing readiness.
3. **Live discovery/Amy/parity:** NOT RUN in this pass. Requires the existing
   authenticated production audit/acceptance path and an approved profile
   cohort.
4. **Hamilton confirmed submission:** UNKNOWN. The aggregate probe is healthy
   except for its intentionally denied document join; no real submission was
   attempted.
5. **Stripe lifecycle:** NOT RUN in this pass.

## Next operator chain

1. Run the authenticated discovery/Amy/parity acceptance cohort and report
   extracted → admitted → surfaced counts, not activity counts.
2. Use an owner-authorized real opportunity for Hamilton end-to-end submission;
   the read-only probe is not submission proof.
3. Run the Stripe lifecycle matrix against an isolated test customer before any
   live billing transition.
