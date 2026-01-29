# Fragility Map (GrantFlow)

This doc captures **implicit assumptions** that have historically caused regressions (401/404/500 loops, unreadable UI, missing uploads, etc.).

For each assumption:
- **Where it lives**: the file(s) enforcing/depending on it
- **How it breaks**: observed failure mode
- **How we enforce it**: guardrail/test/logging to make failure loud + debuggable

---

## Auth assumptions

### Assumption: Frontend API calls include auth consistently
- **Where it lives**
  - Frontend API wrapper: `src/api/client.js` (`APIClient.fetch`)
  - Backend auth parsing: `backend/server.js` (Authorization Bearer parsing) + `backend/middleware/auth.js` (`ensureAuth`)
- **How it breaks**
  - Any ad-hoc `fetch()` or direct `window.location = "/api/.../download"` bypasses the wrapper ⇒ **missing `Authorization` header** ⇒ **401** on protected endpoints (commonly “download”).
- **How we enforce it**
  - Centralize calls through `src/api/client.js` (no ad-hoc `/api/*` fetches).
  - Dev runtime guard: warn if a request to `/api/*` is sent without auth/credentials (see Phase 1A).
  - Regression test(s): download/auth tests under `tests/unit/*download*.test.mjs`.

### Assumption: API uses bearer tokens; cookies are supplementary
- **Where it lives**
  - `src/api/client.js`: attaches `Authorization: Bearer <token>` and uses `credentials: 'include'`
  - `backend/server.js`: primary auth is `Authorization: Bearer ...` (JWT or admin token). Cookie parsing exists but tokens are not cookie-derived.
- **How it breaks**
  - Download endpoints triggered by browser navigation cannot attach Authorization headers.
- **How we enforce it**
  - Provide authenticated download flows that use fetch + blob (or tokenized download URLs) rather than navigation.
  - Backend can optionally accept an access token via query param **only if explicitly designed** (avoid unless necessary).

### Assumption: App is deployed under a subpath (usually `/grantflow`)
- **Where it lives**
  - Frontend base: `vite.config.ts` (`base`) + `src/config/env.js` (`VITE_APP_BASE`)
  - Backend static hosting: `backend/server.js` (`APP_BASE_PATH`, serves SPA under subpath and mirrors `/uploads`)
- **How it breaks**
  - Mixed absolute/relative URLs ⇒ broken routing, assets, and auth redirects.
- **How we enforce it**
  - Prefer relative `/api/*` and `/uploads/*` in the frontend when possible.
  - Smoke tests must cover the `/grantflow` base path.

---

## UI assumptions (contrast + readability)

### Assumption: Text tokens meet WCAG AA by default
- **Where it lives**
  - Theme CSS vars: `src/index.css` (`--foreground`, `--muted-foreground`, sidebar vars)
  - Tailwind token mapping: `tailwind.config.js` (foreground/muted/etc)
- **How it breaks**
  - Components use low-contrast utility classes (`text-muted-foreground`, `text-slate-400/500`) or opacity-based text (`text-foreground/60`) for **informational labels**, making UI unreadable on light backgrounds.
- **How we enforce it**
  - Global token hardening in `src/index.css` + removal of opacity-based informational text utilities.
  - “Forbidden class” guard (eslint or CI check) for key UI surfaces (dashboard/profile/settings).
  - Regression test exists: `tests/unit/ui-geo-crawl-contrast.test.mjs` (and should be extended when we touch dashboard/profile).

---

## Storage assumptions (uploads)

### Assumption: Uploads live on persistent storage in production
- **Where it lives**
  - `backend/server.js`: upload dir resolution + production fail-fast unless explicitly allowed
  - `backend/utils/uploadsDir.js` → `backend/utils/uploadsPath.js`: shared upload dir logic
- **How it breaks**
  - Ephemeral filesystem/volume reset ⇒ DB points at files that no longer exist ⇒ 404 spam and “broken avatars/downloads”.
- **How we enforce it**
  - Production invariant checks at boot (already present in `backend/server.js`)
  - Startup repair: clear missing avatar URLs to stop 404 storms (already present)
  - Tests:
    - `tests/unit/avatar-upload-and-download.test.mjs` (upload + immediate download)
    - `tests/unit/avatar-upload-persistence-restart.test.mjs` (upload → restart → download still 200)
  - Release gate: `npm run release:gates` includes the restart persistence check.

---

## Data assumptions (profiles, crawlers, opportunities)

### Assumption: Baseline profiles + critical seed tables self-heal
- **Where it lives**
  - `backend/server.js`: `seedBaselineFromRepo`, `ensureDesignatedProfiles`, `ensureUserPreferencesTable`
  - Seed file: `seed/baseline-profiles.json`
- **How it breaks**
  - Missing profiles after DB restore/import ⇒ auth gating blocks non-admin logins and flows collapse.
- **How we enforce it**
  - Seed-on-boot for non-smoke mode (already present)
  - Integrity report + repair guardrails:
    - `GET /api/admin/profiles/integrity` (counts + dangling links + orphan sample + duplicate sample)
    - `POST /api/admin/profiles/integrity/repair` (dry-run by default; audit-logged; can reattach ownership by email signals)
    - Offline runner: `node backend/scripts/profile-integrity-report.mjs`
    - Tests:
      - `tests/unit/admin-profile-integrity-report.test.mjs`
      - `tests/unit/admin-integrity-repair.test.mjs`

### Assumption: Opportunities exist and are discoverable for matching
- **Where it lives**
  - `backend/server.js`: minimum national opportunity enforcement + assistance directory seeding
  - Crawlers/services: `backend/services/*crawler*`, `backend/routes/realCrawlers.js`, `backend/routes/discovery.js`
- **How it breaks**
  - “0 included of X found” outcomes can be caused by ingestion failures, overly strict filtering, or UI counts not mapping to backend fields.
- **How we enforce it**
  - Unit tests already exist under `tests/unit/geo-crawl*.test.mjs`, `tests/unit/real-crawlers*.test.mjs`
  - Add explicit logging/diagnostics when `total_found > 0 && included === 0` (per product rule).

