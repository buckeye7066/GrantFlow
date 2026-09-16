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
3. **Live discovery/Amy/parity:** APPROVED, NOT YET RUN. On 2026-09-16 the owner
   selected one named production profile in the private task channel. The name
   is deliberately absent from source control. The protected audit previously
   accepted only opaque profile IDs; the follow-up adds an exact-name resolver
   inside the read-only GitHub environment. It fails closed on zero/multiple active matches,
   masks the resolved ID, and never broadens the audit beyond that one profile.
   Run `35046484059` proved the database guard but stopped before the audit because
   the owner-provided first name was not a full display-name match. The resolver
   now also accepts a unique first-name match, prefers an exact display-name match,
   and still fails closed rather than selecting among multiple candidates.
   Run `35048264827` then passed scope resolution, the read-only database audit,
   and the live-process authority gate. Its browser lane exposed a transport bug:
   the SPA keeps its bearer token in memory, while the audit's direct API reads
   sent only the refresh cookie and received 401. The browser audit now retains
   the password-login access token only inside the browser realm and attaches it
   only to its allowlisted read requests; no token enters logs or artifacts.
   Run `35049461469` showed the frontend proxy returns no refresh token (HTTP 204),
   so the audit now retains the access token from the canonical password-login
   response itself instead of assuming the proxy carries the backend cookie.
   Run `35050544072` then established the remaining blocker precisely:
   `password_login_http_401_invalid_credentials`. The protected audit secrets
   require operator rotation; this is external configuration, not an application
   auth transport defect. The workflow now uploads its sanitized evidence before
   re-failing the job so database/Amy findings are not discarded by that blocker.
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
