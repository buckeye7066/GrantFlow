# GrantFlow Release Runbook

## Production Environment
- **Frontend**: Vercel (`www.axiombiolabs.org/grantflow`)
- **Backend**: Railway (`grantflow-production.up.railway.app`)
- **Database**: SQLite (Railway persistent volume)

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
  - Use `POST /api/admin/national-crawl/stop` to force stop a Geo Crawl.
  - Manually clear the queue if needed: `DELETE FROM crawler_jobs WHERE status IN ('queued', 'running')`.

### 3. Profile Missing Sections
- **Symptom**: Profile page shows "Missing sections" alert.
- **Action**:
  - Click the "Repair Profile" button on the profile overview.
  - Admin can run "Repair All Profiles" from the Admin Dashboard -> Data Integrity tab.

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
1. Ensure all tests pass: `npm run lint && npm run build`.
2. Push to `main` branch (Vercel and Railway will auto-deploy).
3. Verify `/api/crawlers/health` returns `worker_online: true`.
4. Run a smoke test login and profile creation.
