# GrantFlow Operational Investigation Report

> **SUPERSEDED / HISTORICAL — verified stale 2026-08-14.** Both findings below
> describe a since-fixed point-in-time state and no longer match the current
> codebase: `backend/db/schema.sql`'s `record_origin` CHECK constraint now
> allows 22 values (not the 4-value set this report started from), and
> `backend/startup/queueRecovery.js` runs a real `setInterval`-based queue
> poller (`QUEUE_POLL_INTERVAL_MS`, default 60s) — the "no persistent worker
> process" finding in §2 is no longer true. Kept for historical context only;
> do not treat this file as a description of the current system.

## 1. record_origin CHECK Constraint Mismatch (CRITICAL — Root Cause of Insert Failures)

### The constraint (defined in `0001_init.sql` and `schema.sql`):
```sql
CHECK(record_origin IN ('live_crawl','curated_verified','manual','synthetic'))
```

### Values actually used in the codebase — 5 are NOT in the constraint:

| Value | Source File | Status |
|---|---|---|
| `'live_crawl'` | healthResourcesCrawler.js, crawlerOpportunityContract.js | ✅ Allowed |
| `'curated_verified'` | comprehensiveCrawlerOptimized.js, itemCrawler.js, itemGiftCrawler.js | ✅ Allowed |
| `'synthetic'` | countyFundingCrawler.js | ✅ Allowed |
| `'manual'` | (referenced in constraint) | ✅ Allowed |
| **`'funding_api'`** | **grantsDotGovCrawler.js:214** | ❌ **VIOLATES CONSTRAINT** |
| **`'url_import'`** | **extractOpportunitiesFromDocumentText.js:56** | ❌ **VIOLATES CONSTRAINT** |
| **`'directory_resource'`** | **crawlerOpportunityContract.js:227** (fallback for `opportunity_type === 'program'`) | ❌ **VIOLATES CONSTRAINT** |
| **`'directory:health_resources'`** | **healthResourcesCrawler.js:490** | ❌ **VIOLATES CONSTRAINT** |
| **`'directory:student_grants'`** | **studentGrantsCrawler.js:508** | ❌ **VIOLATES CONSTRAINT** |

### Impact
Every INSERT into `funding_opportunities` with one of the 5 invalid values throws a CHECK constraint violation. In Postgres this aborts the transaction; in SQLite it throws SQLITE_CONSTRAINT. This silently kills the `bulkUpsertFundingOpportunities` call, which means:

- **Grants.gov results** (`funding_api`) are never persisted
- **Health resource directory entries** (`directory:health_resources`) are never persisted
- **Student grant directory entries** (`directory:student_grants`) are never persisted
- **Document-extracted opportunities** (`url_import`) are never persisted
- **Any opportunity where `opportunity_type === 'program'`** and no explicit `record_origin` was set (`directory_resource` fallback) fails

### Fix
Migration `0034_expand_record_origin_check.sql` (created in this PR) drops and recreates the constraint with all 9 values. Run it against the production Postgres database immediately.

---

## 2. Job Queue Worker Is Dead — Architecture Problem (CRITICAL)

### Finding: There IS no persistent worker process.

The Railway deployment runs a single service (`npm start` → `node backend/start.js`), which starts only the HTTP server. There is **no background job poller**.

**How jobs currently work:**
- API endpoints call `dispatchCrawlerJob({ db, jobId, ... })` fire-and-forget
- `dispatchCrawlerJob` reads the job from the DB, marks it `running`, and executes the handler inline (in the same Node process as the HTTP server)
- If the process restarts mid-job, the job stays `running` forever (becomes a "stuck" job)
- If a job is INSERT'd into `crawler_jobs` with status `queued` but no API endpoint calls `dispatchCrawlerJob` for it, **it sits in `queued` forever**

**The only other mechanism** is `backend/scripts/process-queue.mjs` — a one-shot batch script that:
1. Reads 5 queued jobs
2. Dispatches them (fire-and-forget)
3. Waits 33 seconds
4. Prints status
5. **Exits**

This script is **not referenced anywhere** in the Railway config, Dockerfile, or Procfile. It is never run in production.

### Why the worker has been "dead" for 17+ days
The `/api/crawlers/health` endpoint reports `worker_online: false` when it finds jobs stuck in `running` for >2 hours. Since there is no crash recovery or stale-job reaper running periodically, once a job gets stuck (e.g., due to a deployment restart), it stays stuck forever, causing the health check to permanently report the worker as dead.

### Recommendations

**Short-term** (unblock immediately):
```sql
-- Reset all stuck jobs so the health check goes green
UPDATE crawler_jobs
SET status = 'failed',
    error = 'Reset: stuck in running state after deploy',
    completed_at = NOW()
WHERE status = 'running'
  AND started_at < NOW() - INTERVAL '2 hours';
```

**Medium-term** (add a startup recovery sweep in `server.js`):
```javascript
// Add near the end of server startup, after the HTTP server is listening:
// Reset any jobs stuck in 'running' from a previous process crash.
try {
  const stuckPredicate = db.dialect === 'postgres'
    ? "started_at < (NOW() - INTERVAL '30 minutes')"
    : "started_at < datetime('now', '-30 minutes')"
  const result = await db.prepare(`
    UPDATE crawler_jobs
    SET status = 'failed',
        error = 'Auto-reset: stuck after server restart',
        completed_at = ${db.dialect === 'postgres' ? 'NOW()' : "datetime('now')"}
    WHERE status = 'running'
      AND ${stuckPredicate}
  `).run()
  if (result.changes > 0) {
    console.log(`[startup] Reset ${result.changes} stuck crawler job(s)`)
  }
} catch (err) {
  console.error('[startup] Failed to reset stuck jobs:', err.message)
}
```

**Long-term** (proper background worker):
Add a `setInterval`-based poller in `server.js` that periodically checks for queued jobs and dispatches them:
```javascript
const QUEUE_POLL_INTERVAL_MS = 30_000 // 30 seconds
setInterval(async () => {
  try {
    const queued = await db.prepare(`
      SELECT id FROM crawler_jobs
      WHERE status = 'queued'
      ORDER BY created_at ASC
      LIMIT 3
    `).all()
    for (const job of queued) {
      dispatchCrawlerJob({ db, jobId: job.id, uploadDir, getOpenAI: null }).catch(() => {})
    }
  } catch (err) {
    console.error('[queue-poller] Error:', err.message)
  }
}, QUEUE_POLL_INTERVAL_MS)
```

Or, better yet, add a separate Railway service for the worker with its own `railway.json`.

---

## 3. Railway Deployment Configuration

### Current state
- **Single service**: `npm start` → HTTP server only
- **No worker service**: No Procfile, no separate Railway service for background jobs
- **Restart policy**: `ALWAYS` with max 10 retries — good, but doesn't help with job recovery
- **Health check**: `/api/health` with 120s timeout — only checks HTTP, not job health

### Potential OOM/crash vectors
1. The `dispatchCrawlerJob` runs crawler handlers **in the same process** as the HTTP server. A memory-hungry crawler (e.g., comprehensive crawl processing hundreds of results) can OOM the HTTP server, taking down the entire service.
2. The `JOB_TIMEOUT_MS` default is 30 minutes — a single hanging crawler can block for half an hour before being killed.
3. No memory limit configuration in `railway.json`.

---

## 4. Summary of Fixes in This PR

| File | Change |
|---|---|
| `backend/db/postgres/migrations/0034_expand_record_origin_check.sql` | Drops and recreates CHECK constraint with all 9 values |
| `backend/db/migrations/030_expand_record_origin_check.sql` | SQLite no-op (constraint enforced in Postgres only) |
| `backend/db/schema.sql` | Updated constraint for fresh installs |
| `backend/routes/realCrawlers.js` | Route-level consent gating for clinicaltrials.gov (from previous commit) |

### Immediate action items (manual):
1. **Run migration 0034** against production Postgres
2. **Reset stuck jobs** with the SQL above
3. **Verify** with: `SELECT record_origin, COUNT(*) FROM funding_opportunities GROUP BY record_origin`
