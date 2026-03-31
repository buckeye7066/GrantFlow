/**
 * queueRecovery.js — Queue/crawler recovery tasks.
 *
 * Called from the `server.on('listening', ...)` handler. Handles:
 *   1. Reset crawler jobs stuck in 'running' from a previous process crash
 *   2. Re-queue jobs that previously failed due to concurrency exhaustion
 *   3. One-time stale-crawler and stale-queued-job cleanup
 *   4. Background queue poller (periodic dispatch of orphaned queued jobs)
 *   5. Queue drain interval (recover jobs orphaned by process restarts)
 *
 * @param {{ db, uploadsDir: string }} args
 */

import { dispatchCrawlerJob, startQueueDrainInterval } from '../services/crawlerDispatcher.js';
import {
  cleanupStaleCrawlers,
  cleanupStaleQueuedJobs,
} from '../services/crawlerConcurrencyGuard.js';

export function runQueueRecovery({ db, uploadsDir }) {
  // ── 1. Reset stuck running jobs ────────────────────────────────────────────
  ;(async () => {
    try {
      if (db.dialect === 'postgres') {
        const r = await db
          .prepare(
            `
              UPDATE crawler_jobs
              SET status = 'failed',
                  error = 'Auto-reset: stuck after server restart',
                  completed_at = NOW()
              WHERE status = 'running'
                AND started_at < (NOW() - INTERVAL '30 minutes')
            `,
          )
          .run();
        if (r?.changes > 0)
          console.log(`[startup] Reset ${r.changes} stuck crawler job(s)`);
      } else {
        const r = db
          .prepare(
            `
              UPDATE crawler_jobs
              SET status = 'failed',
                  error = 'Auto-reset: stuck after server restart',
                  completed_at = datetime('now')
              WHERE status = 'running'
                AND started_at < datetime('now', '-30 minutes')
            `,
          )
          .run();
        if (r?.changes > 0)
          console.log(`[startup] Reset ${r.changes} stuck crawler job(s)`);
      }
    } catch (err) {
      console.error('[startup] Failed to reset stuck jobs:', err?.message || err);
    }
  })();

  // ── 2. Re-queue concurrency-exhausted jobs ─────────────────────────────────
  ;(async () => {
    try {
      const r = await db
        .prepare(
          `
            UPDATE crawler_jobs
            SET status = 'queued',
                error = NULL,
                dispatch_attempts = 0,
                next_dispatch_at = NULL,
                completed_at = NULL
            WHERE status = 'failed'
              AND error = 'Crawler dispatch exhausted due to concurrency limits'
          `,
        )
        .run();
      const count = Number(r?.changes ?? r?.rowCount ?? 0);
      if (count > 0) {
        console.log(
          `[startup] Re-queued ${count} concurrency-exhausted job(s) for retry`,
        );
      }
    } catch (err) {
      console.error(
        '[startup] Failed to re-queue exhausted jobs:',
        err?.message || err,
      );
    }
  })();

  // ── 3. One-time stale-crawler cleanup ─────────────────────────────────────
  ;(async () => {
    try {
      const cleaned = await cleanupStaleCrawlers(db);
      if (cleaned > 0) {
        console.log(
          `[startup] Cleaned ${cleaned} stale crawler job(s) from previous run`,
        );
      }
      const cleanedQueued = await cleanupStaleQueuedJobs(db);
      if (cleanedQueued > 0) {
        console.log(
          `[startup] Cleaned ${cleanedQueued} stale queued job(s) from previous run`,
        );
      }
    } catch (err) {
      console.warn('[startup] Stale crawler cleanup failed:', err?.message);
    }
  })();

  // ── 4. Background queue poller ────────────────────────────────────────────
  const QUEUE_POLL_INTERVAL_MS = Number.parseInt(
    process.env.QUEUE_POLL_INTERVAL_MS || '60000',
    10,
  );
  const queuePollEnabled =
    String(process.env.QUEUE_POLL_ENABLED ?? 'true').toLowerCase() !== 'false';

  if (queuePollEnabled) {
    // Run a staggered startup drain before the regular poller begins.
    _drainQueuedJobsGradually(db, uploadsDir).catch((err) => {
      console.warn('[startup-drain] Staggered drain failed:', err?.message);
    });

    const queuePollHandle = setInterval(async () => {
      try {
        // Clean up stale running jobs before attempting to dispatch
        try {
          await cleanupStaleCrawlers(db);
        } catch (err) {
          console.warn(
            '[queue-poller] Stale crawler cleanup failed (ignored):',
            err?.message,
          );
        }

        // Clean up queued jobs that have been waiting longer than 24 hours
        try {
          const cleanedQueued = await cleanupStaleQueuedJobs(db);
          if (cleanedQueued > 0) {
            console.warn(
              `[queue-poller] Cleaned ${cleanedQueued} stale queued job(s)`,
            );
          }
        } catch (err) {
          console.warn(
            '[queue-poller] Stale queued job cleanup failed (ignored):',
            err?.message,
          );
        }

        const queued = await db
          .prepare(
            `
              SELECT id FROM crawler_jobs
              WHERE status = 'queued'
              ORDER BY created_at ASC
              LIMIT 3
            `,
          )
          .all();
        if (!Array.isArray(queued) || queued.length === 0) return;

        for (const job of queued) {
          try {
            dispatchCrawlerJob({
              db,
              jobId: job.id,
              uploadDir: uploadsDir,
              getOpenAI: null,
            }).catch((e) => console.warn('[background]', e?.message || e));
          } catch {
            // ignore individual dispatch errors
          }
        }
        if (queued.length > 0) {
          console.log(
            `[queue-poller] Dispatched ${queued.length} orphaned queued job(s)`,
          );
        }
      } catch (err) {
        console.error('[queue-poller] Poll error:', err?.message || err);
      }
    }, QUEUE_POLL_INTERVAL_MS);

    process.once('SIGTERM', () => clearInterval(queuePollHandle));
    process.once('SIGINT', () => clearInterval(queuePollHandle));
    console.log(
      `[startup] Background queue poller enabled (every ${QUEUE_POLL_INTERVAL_MS / 1000}s)`,
    );

    // ── 5. Queue drain interval ────────────────────────────────────────────
    const drainIntervalHandle = startQueueDrainInterval(db, uploadsDir, null);
    process.once('SIGTERM', () => clearInterval(drainIntervalHandle));
    process.once('SIGINT', () => clearInterval(drainIntervalHandle));
  } else {
    console.log(
      '[startup] Background queue poller disabled (set QUEUE_POLL_ENABLED=true to enable)',
    );
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function _drainQueuedJobsGradually(dbRef, uploadsDirRef) {
  // Gradually dispatch queued jobs on startup to avoid a stampede that exhausts concurrency.
  const STARTUP_DELAY_MS = Number.parseInt(
    process.env.QUEUE_STARTUP_DELAY_MS || '15000',
    10,
  );
  const STAGGER_DELAY_MS = Number.parseInt(
    process.env.QUEUE_STAGGER_DELAY_MS || '3000',
    10,
  );
  const INITIAL_BATCH = 2;

  await new Promise((r) => setTimeout(r, STARTUP_DELAY_MS));

  let queued;
  try {
    queued = await dbRef
      .prepare(
        `
          SELECT id FROM crawler_jobs
          WHERE status = 'queued'
          ORDER BY created_at ASC
          LIMIT ?
        `,
      )
      .all(INITIAL_BATCH);
  } catch (err) {
    console.warn('[startup-drain] Failed to query queued jobs:', err?.message);
    return;
  }

  if (!Array.isArray(queued) || queued.length === 0) return;

  console.log(
    `[startup-drain] Dispatching ${queued.length} queued job(s) with ${STAGGER_DELAY_MS}ms stagger`,
  );
  for (let i = 0; i < queued.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, STAGGER_DELAY_MS));
    try {
      dispatchCrawlerJob({
        db: dbRef,
        jobId: queued[i].id,
        uploadDir: uploadsDirRef,
        getOpenAI: null,
      }).catch((e) => console.warn('[background]', e?.message || e));
    } catch {
      // ignore individual dispatch errors
    }
  }
}
