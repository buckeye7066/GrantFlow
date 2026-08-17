# GrantFlow Release Runbook

## Production Environment
- **Frontend**: Vercel (served from `/grantflow`)
- **Backend**: Railway (Dockerfile build + `npm start`)
- **Database**: Postgres (Railway)

## Phase 5 Notes (Deploy sanity + rollback)

- **Single-source config**:
  - **Vercel** routing is defined in `vercel.json` (SPA fallback + `/api` rewrites).
  - **Railway** build/start is defined in `railway.json` + `Dockerfile`.
  - **Railway readiness** is `/readyz`; `/api/health` is a public health summary and is not sufficient production readiness proof.
- **Known incident**:
  - If `app.axiombiolabs.org/grantflow/*` works but `www.axiombiolabs.org/grantflow/login` 404s, you have **domain routing drift** (see **E-001** in `docs/ERROR_LEDGER.md`).

## Core Operations

### 1. Troubleshooting 401/403 Errors
- **Symptom**: User cannot access admin or specific profiles.
- **Check**: 
  - Verify `ADMIN_EMAIL` in Railway matches the user email.
  - Check if the JWT token has expired (clear cookies and re-login).
  - Ensure `user.is_admin` is truthy in the DB if using manual tokens.

### 2. Crawler Stuck or Queue Depth High
- **Symptom**: Jobs remain in `running` or `queued` status for > 2 hours.
- **Action**:
  - Check Railway logs for "Out of Memory" or "Circuit breaker open".
  - If a specific crawler is failing repeatedly, the circuit breaker will trip for 5 minutes.
  - If Geo Crawl jobs are stuck, cancel queued jobs via the Admin UI and redeploy if a running job is wedged.
  - Manually clear the queue if needed: `DELETE FROM crawler_jobs WHERE status IN ('queued', 'running')`.

### 3. Profile Missing Sections
- **Symptom**: Profile page shows "Missing sections" alert.
- **Action**:
  - Click the "Repair Profile" button on the profile overview.
  - Admin can run "Repair All Profiles" from the Admin Dashboard -> Data Integrity tab.
  - Verify via API:
    - `GET /api/profiles/:id/completeness` (includes `missing_keys_by_section`)
    - `POST /api/profiles/:id/repair` (creates missing sections and backfills missing keys)

### 4. Match Quality Debugging
- **Symptom**: Irrelevant matches or low scores for good grants.
- **Action**:
  - Check "Match Confidence" in the Smart Matcher dialog.
  - Ensure the profile has the `narrative`, `organization_details`, and `location_focus` sections fully populated.
  - The scoring engine explicitly penalizes state mismatches and missing 501(c)(3) status.

### 5. Anya Fallback Mode
- **Symptom**: Anya returns "operating in offline mode".
- **Check**:
  - Verify `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` in Railway environment variables.
  - Check LLM provider status pages (OpenAI/Anthropic).
  - Anya will continue to provide gap analysis and recent matches using deterministic logic.

## Deployment Procedure
1. Ensure baseline gate passes: `npm run doctor`.
2. Merge to the deploy branch (recommended: `main`) and let Vercel/Railway build.
3. Verify routing:
   - `/<base>` loads (base is `/grantflow`)
   - `/<base>/` loads (trailing slash must not 404)
   - `/<base>/login` loads (deep refresh)
   - `/<base>/api/health` returns 200 (same-origin rewrite)
   - Recommended automation:
     - `SMOKE_BASE_URL=https://app.axiombiolabs.org SMOKE_BASE_PATH=/grantflow npm run smoke:prod`
4. Verify backend health:
   - `GET https://<railway-service>/readyz` returns 200 with `"status":"ready"`
   - `GET https://<railway-service>/api/health` returns 200 as a public health summary
   - Use `X-Request-Id` to correlate any failures in Railway logs
5. Verify the canonical profile schema endpoint:
   - `GET /api/profiles/schema` (should return full data point list + explanations)

## Rollback (Fast)

### Frontend (Vercel)
- Promote the previous known-good **Production Deployment** in Vercel.
- If the break is domain-related, verify domain assignment and redeploy; rollback won’t fix DNS.

### Backend (Railway)
- Redeploy the previous successful Railway deployment.
- If DB issues are involved:
  - Postgres: do **not** attempt to roll back migrations in prod during an incident; roll forward with a fix or restore from backup.
  - SQLite rollback is only viable if you have a persistent volume + known-good DB file.
  - **Backups are real scripts, not aspiration**: `npm run db:backup` produces a
    verified artifact (SQLite `VACUUM INTO` + integrity_check, or `pg_dump -Fc`)
    under `BACKUP_DIR` (defaults to the persistent volume when present) and
    stamps `system_kv backup_last_run`; `npm run db:restore -- <file>` restores
    it (SQLite: pre-restore safety copy + refuses while the backend holds the
    file; Postgres: `pg_restore --clean --if-exists`). The Sam check
    `ops.backupFreshness` goes red when no verified backup exists within
    `BACKUP_MAX_AGE_HOURS` (48h default) — schedule `db:backup` accordingly.
