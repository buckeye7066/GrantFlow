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
  `/uploads`, not the backend-root `/readyz` route.
- A manually dispatched read-only Hamilton production probe
  (`35034180374`) completed. All aggregate lifecycle queries ran except
  `submitted_proof_documents`, which the scoped audit role correctly could not
  read because `documents` is denied. This run therefore does **not** establish
  a durable-confirmation count; that outcome remains unknown.
- Direct production HTTP from the task container remains unavailable because
  its CONNECT proxy returns 403. GitHub Actions is the working live-probe path.

## P0 status

1. **Deployment identity:** VERIFIED for the starting HEAD through GitHub's
   deployment records; this branch's corrective commit is not deployed yet.
2. **Mission gate/catalog freshness:** UNKNOWN until this correction is merged
   and the updated read-only smoke reports the live `/readyz` result. Do not
   infer readiness from `/api/health`.
3. **Live discovery/Amy/parity:** NOT RUN in this pass. Requires the existing
   authenticated production audit/acceptance path and an approved profile
   cohort.
4. **Hamilton confirmed submission:** UNKNOWN. The aggregate probe is healthy
   except for its intentionally denied document join; no real submission was
   attempted.
5. **Stripe lifecycle:** NOT RUN in this pass.

## Next operator chain

1. Merge and deploy the smoke/auth-scope correction after exact-head CI.
2. Dispatch `prod-smoke.yml`; preserve the `/readyz` body when red.
3. If the blocker is catalog verification, run the admin asynchronous verifier,
   poll its matching `run_id` to a terminal state, and repeat until the canonical
   95% complete-visible / 100% visible-direct thresholds pass. Never lower the
   thresholds.
4. Run the authenticated discovery/Amy/parity acceptance cohort and report
   extracted → admitted → surfaced counts, not activity counts.
5. Use an owner-authorized real opportunity for Hamilton end-to-end submission;
   the read-only probe is not submission proof.
