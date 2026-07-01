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
import { SUPERSEDED_CRAWLER_JOB_TYPES } from '../../shared/supersededCrawlerTypes.js';

export function runQueueRecovery({ db, uploadsDir }) {
  // ── 1. Reset stuck running jobs ────────────────────────────────────────────
  ;(async () => {
    try {
      const isPostgres = db?.dialect === 'postgres';
      // Use a longer threshold for comprehensive/geo jobs (4h) vs regular jobs (30m)
      // to avoid prematurely killing long-running geo crawls on restart.
      const r = await db
        .prepare(
          isPostgres
            ? `
                UPDATE crawler_jobs
                SET status = 'failed',
                    error = 'Auto-reset: stuck after server restart',
                    completed_at = NOW()
                WHERE status = 'running'
                  AND started_at < (NOW() - INTERVAL '30 minutes')
                  AND NOT (type = 'comprehensive' AND started_at > (NOW() - INTERVAL '4 hours'))
              `
            : `
                UPDATE crawler_jobs
                SET status = 'failed',
                    error = 'Auto-reset: stuck after server restart',
                    completed_at = datetime('now')
                WHERE status = 'running'
                  AND started_at < datetime('now', '-30 minutes')
                  AND NOT (type = 'comprehensive' AND started_at > datetime('now', '-4 hours'))
              `,
        )
        .run();
      const count = Number(r?.changes ?? r?.rowCount ?? 0);
      if (count > 0)
        console.log(`[startup] Reset ${count} stuck crawler job(s)`);
    } catch (err) {
      console.error('[startup] Failed to reset stuck jobs:', err?.message || err);
    }
  })();

  // ── 1b. Reconcile stale 'running' Robert runs ─────────────────────────────
  // robert_runs only clears 'running' on completeRun(); a mid-run crash/deploy
  // leaves an orphan forever (the charter audit found 2 stuck for 5+ days), and
  // Mission Control then reads Robert as perpetually mid-run. Mark runs that
  // have been 'running' for >2h as failed. (better-sqlite3 ignores unknown
  // tables gracefully via the try/catch.)
  ;(async () => {
    try {
      const isPostgres = db?.dialect === 'postgres';
      const r = await db
        .prepare(
          isPostgres
            ? `UPDATE robert_runs SET status = 'failed', error = 'reconciled_stale_running', completed_at = NOW()
                WHERE status = 'running' AND started_at < (NOW() - INTERVAL '2 hours')`
            : `UPDATE robert_runs SET status = 'failed', error = 'reconciled_stale_running', completed_at = datetime('now')
                WHERE status = 'running' AND started_at < datetime('now', '-2 hours')`,
        )
        .run();
      const count = Number(r?.changes ?? r?.rowCount ?? 0);
      if (count > 0) console.log(`[startup] Reconciled ${count} stale 'running' Robert run(s)`);
    } catch (err) {
      console.warn('[startup] Robert stale-run reconcile failed (non-fatal):', err?.message || err);
    }
  })();

  // ── 2. Re-queue concurrency-exhausted jobs ─────────────────────────────────
  // Bounded: never resurrect retired discovery types, and never resurrect a job
  // older than 24h. Without these caps a failed job could be re-queued on every
  // boot forever, re-orphan, and flood the panel with failures.
  ;(async () => {
    try {
      const isPostgres = db?.dialect === 'postgres';
      const supersededPlaceholders =
        SUPERSEDED_CRAWLER_JOB_TYPES.length > 0
          ? SUPERSEDED_CRAWLER_JOB_TYPES.map(() => '?').join(', ')
          : null;
      const supersededClause = supersededPlaceholders
        ? `AND type NOT IN (${supersededPlaceholders})`
        : '';
      const ageClause = isPostgres
        ? `AND created_at > (NOW() - INTERVAL '24 hours')`
        : `AND datetime(created_at) > datetime('now', '-24 hours')`;
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
              ${supersededClause}
              ${ageClause}
          `,
        )
        .run(...SUPERSEDED_CRAWLER_JOB_TYPES);
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
            await dispatchCrawlerJob({
              db,
              jobId: job.id,
              uploadDir: uploadsDir,
              getOpenAI: null,
            }).catch((e) => console.warn('[queue-poller] Dispatch error for job', job.id, e?.message || e));
          } catch (err) {
            console.warn('[queue-poller] Sync dispatch error for job', job.id, err?.message || err);
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
      await dispatchCrawlerJob({
        db: dbRef,
        jobId: queued[i].id,
        uploadDir: uploadsDirRef,
        getOpenAI: null,
      }).catch((e) => console.warn('[startup-drain] Dispatch error for job', queued[i].id, e?.message || e));
    } catch (err) {
      console.warn('[startup-drain] Sync dispatch error for job', queued[i].id, err?.message || err);
    }
  }
}
