/**
 * backgroundServices.js — Optional background schedulers and autonomous services.
 *
 * Called from the `server.on('listening', ...)` handler. Handles:
 *   1. Postgres CHECK-constraint auto-heal
 *   2. Pipeline self-check (count active trusted funding opportunities)
 *   3. Internal base-URL registration (for Anya function tests)
 *   4. Feature-flags initialization
 *   5. Startup smoke crawlers (production-only, opt-in)
 *   6. Auto profile de-duplication (production-only, once per deploy)
 *   7. Server-startup audit-log event
 *   8. Anya autonomous scheduler startup + scheduled runner + code-crawl timer
 *   9. Anya background health service (single call — duplicate removed)
 *  10. National programs continuous crawler (opt-in)
 *
 * @param {{ db, uploadsDir: string, actualPort: number|string, loggedCorsOrigins: string[] }} args
 */

import crypto from 'crypto';
import { startHealthService } from '../services/anyaHealthService.js';
import { initializeFeatureFlags } from '../services/featureFlagService.js';
import { logAuditEvent, AUDIT_CATEGORIES, SEVERITY } from '../services/auditService.js';
import { runStartupOperations } from '../services/anyaStartupOperations.js';
import { allowedOriginCheckSQL } from '../utils/recordOrigins.js';
import { dispatchCrawlerJob } from '../services/crawlerDispatcher.js';
import { scheduleAdminGeoCrawlOnLogin } from '../services/adminGeoCrawlOnLogin.js';
import {
  findDuplicateProfileGroups,
  mergeProfiles,
} from '../services/profileDedupeService.js';
import { DEFAULT_MIN_SCORE, SCORE_SCALE_ID } from '../config/matchThresholds.js';

const trackedIntervals = new Set();
let shutdownHooksInstalled = false;

function _trackInterval(handle) {
  if (!handle) return handle;
  trackedIntervals.add(handle);
  handle.unref?.();
  if (!shutdownHooksInstalled) {
    shutdownHooksInstalled = true;
    const stopIntervals = () => {
      for (const timer of trackedIntervals) clearInterval(timer);
      trackedIntervals.clear();
    };
    process.once('SIGTERM', stopIntervals);
    process.once('SIGINT', stopIntervals);
  }
  return handle;
}

/**
 * Start a non-overlapping async interval. A slow run is never allowed to stack
 * a second copy on top of itself; failures are consumed and surfaced with the
 * scheduler name so they cannot become process-level unhandled rejections.
 */
export function startGuardedBackgroundInterval({ name, intervalMs, task }) {
  if (!Number.isFinite(intervalMs) || intervalMs < 1) {
    throw new Error(`${name || 'background interval'} requires a positive intervalMs`);
  }
  if (typeof task !== 'function') {
    throw new Error(`${name || 'background interval'} requires a task function`);
  }

  let inFlight = false;
  const tick = async () => {
    if (inFlight) {
      console.warn(`[background:${name}] previous run still in flight; skipping overlapping tick`);
      return { skipped: true, reason: 'already_running' };
    }
    inFlight = true;
    try {
      await task();
      return { skipped: false, ok: true };
    } catch (error) {
      console.error(`[background:${name}] run failed:`, error?.message || error);
      return { skipped: false, ok: false, error };
    } finally {
      inFlight = false;
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, intervalMs);
  _trackInterval(handle);
  return { handle, tick };
}

function _scheduleBackgroundTimeout(task, delayMs) {
  const handle = setTimeout(() => {
    Promise.resolve()
      .then(task)
      .catch((error) => console.error('[background:timeout] task failed:', error?.message || error));
  }, delayMs);
  handle.unref?.();
  return handle;
}

export function startBackgroundServices({ db, uploadsDir, actualPort, loggedCorsOrigins }) {
  // ── 1. Postgres CHECK-constraint auto-heal ────────────────────────────────
  if (db.dialect === 'postgres') {
    (async () => {
      try {
        await db.exec(`
          ALTER TABLE funding_opportunities
            DROP CONSTRAINT IF EXISTS funding_opportunities_record_origin_check;
          ALTER TABLE funding_opportunities
            ADD CONSTRAINT funding_opportunities_record_origin_check
            CHECK (${allowedOriginCheckSQL()});
        `);
        console.log('[startup] record_origin CHECK constraint verified/expanded');
      } catch (e) {
        console.warn('[startup] record_origin constraint fix skipped:', e?.message);
      }

      try {
        // Keep this self-heal in lock-step with shared/pipelineStages.js +
        // backend/db/postgres/migrations/0072_grants_status_canonical_pipeline.sql.
        await db.exec(`
          ALTER TABLE grants DROP CONSTRAINT IF EXISTS grants_status_check;
          ALTER TABLE grants ADD CONSTRAINT grants_status_check CHECK (status IN (
            -- Canonical 11-stage pipeline (RC-13)
            'discovered','saved','interested','gathering_documents',
            'drafting','ready_to_submit','submitted','follow_up',
            'awarded','declined','archived',
            -- Legacy stages preserved for back-compat
            'discovery','auto_applied','application_prep','revision',
            'portal','pending_review','report','declined_no_review',
            'closed','app_prep','under_review','rejected','deadline_passed'
          ));
        `);
        console.log('[startup] grants status CHECK constraint verified/expanded');
      } catch (e) {
        console.warn('[startup] grants status constraint fix skipped:', e?.message);
      }
    })().catch(err => {
      console.error('[startup] Postgres constraint setup failed:', err?.message || err);
    });
  }

  // ── 2. Pipeline self-check ─────────────────────────────────────────────────
  (async () => {
    try {
      const { trustedOriginClause, trustedSourceClause } = await import(
        '../utils/recordOrigins.js'
      );
      const activeVal = db.dialect === 'postgres' ? 'TRUE' : '1';
      const count = await db
        .prepare(
          `
            SELECT COUNT(*) AS n FROM funding_opportunities
            WHERE is_active = ${activeVal}
              AND ${trustedOriginClause()}
              AND ${trustedSourceClause()}
          `,
        )
        .get();
      const n = Number(count?.n ?? 0);
      if (n === 0) {
        console.warn(
          '[startup][WARN] 0 active trusted funding opportunities — users will see no matches',
        );
      } else {
        console.log(
          `[startup] ${n} active trusted funding opportunities ready for matching`,
        );
      }
    } catch (err) {
      console.error('[startup] Pipeline self-check failed:', err?.message || err);
    }
  })();

  // ── 3. Internal base-URL registration ─────────────────────────────────────
  try {
    globalThis.__grantflow_internal_base_url = `http://127.0.0.1:${actualPort}`;
  } catch {
    // best-effort only
  }

  // ── 4. Feature-flags initialization ───────────────────────────────────────
  try {
    initializeFeatureFlags(db);
    console.log('[FeatureFlags] Initialized successfully');
  } catch (err) {
    console.warn('[FeatureFlags] Failed to initialize:', err?.message || err);
  }

  // ── 4b. Seed curated NATIONAL_PROGRAMS into funding_opportunities ────────
  _scheduleBackgroundTimeout(async () => {
    const { seedNationalPrograms } = await import('../services/seed/seedNationalPrograms.js');
    const result = await seedNationalPrograms(db, { skipUrlVerification: true });
    if (result?.error) {
      console.warn(
        `[seed] National programs seed failed: ${result.error} (attempted ${result.attempted}).`,
      );
      return;
    }
    if ((result?.inserted ?? 0) > 0) {
      console.log(
        `[seed] National programs: upserted ${result.inserted}/${result.attempted} curated rows.`,
      );
    } else {
      console.log(
        `[seed] National programs: no new rows (already present), attempted ${result?.attempted ?? 0}.`,
      );
    }
  }, 3000);

  // ── 4c. Seed curated SCHOLARSHIPS into funding_opportunities ──────────────
  _scheduleBackgroundTimeout(async () => {
    const { seedScholarships } = await import('../services/seed/seedScholarships.js');
    const result = await seedScholarships(db, { skipUrlVerification: true });
    if (result?.error) {
      console.warn(
        `[seed] Scholarships seed failed: ${result.error} (attempted ${result.attempted}).`,
      );
      return;
    }
    if ((result?.inserted ?? 0) > 0) {
      console.log(
        `[seed] Scholarships: upserted ${result.inserted}/${result.attempted} curated rows.`,
      );
    } else {
      console.log(
        `[seed] Scholarships: no new rows (already present), attempted ${result?.attempted ?? 0}.`,
      );
    }
  }, 3500);

  // ── 5. Startup smoke crawlers (production, opt-in) ─────────────────────────
  const startupSmokeEnabled = _parseBoolEnv(process.env.STARTUP_SMOKE_CRAWL_ENABLED) === true;
  if (startupSmokeEnabled) {
    _scheduleBackgroundTimeout(
      () => _scheduleCrawlerSmokeJobs({ db, uploadsDir }),
      10_000,
    );
    console.info(
      '[startup] Startup smoke crawlers enabled (STARTUP_SMOKE_CRAWL_ENABLED=true)',
    );
  } else {
    console.info(
      '[startup] Startup smoke crawlers disabled (set STARTUP_SMOKE_CRAWL_ENABLED=true to enable)',
    );
  }

  // ── 6. Auto profile de-duplication (production, once per deploy) ──────────
  _scheduleBackgroundTimeout(() => _scheduleAutoProfileDedupe({ db }), 20_000);

  // ── 7. Server-startup audit-log event ─────────────────────────────────────
  try {
    void logAuditEvent(db, {
      category: AUDIT_CATEGORIES.SYSTEM,
      action: 'server_startup',
      severity: SEVERITY.INFO,
      details: {
        port: actualPort,
        environment: process.env.NODE_ENV || 'development',
        corsOrigins: loggedCorsOrigins,
      },
    }).catch((error) => {
      console.warn('[startup] server_startup audit log failed:', error?.message || error);
    });
  } catch {
    // Non-critical — do not fail server startup
  }

  // ── 8. Anya autonomous scheduler ──────────────────────────────────────────
  _scheduleBackgroundTimeout(async () => {
    const { runOnStartup, startBackgroundCodeCrawlAndRepair, checkSchedule } = await import(
      '../services/anyaAutonomousScheduler.js'
    );

    if (process.env.ANYA_RUN_ON_STARTUP === 'true') {
      console.log('[Anya] Starting autonomous operations on server startup...');
      void runOnStartup(db).catch((err) => {
        console.error('[Anya] Failed to complete autonomous operations:', err?.message || err);
      });
    } else {
      void runStartupOperations(db).catch((err) => {
        console.error('[Anya] Failed to complete crawler operations:', err?.message || err);
      });
    }

    // Wire up the scheduled runner (e.g. daily at 3 AM). The guard guarantees
    // a slow check cannot overlap the next 30-minute tick.
    if (process.env.ANYA_RUN_ON_SCHEDULE === 'true') {
      startGuardedBackgroundInterval({
        name: 'anya-schedule-check',
        intervalMs: 30 * 60 * 1000,
        task: () => checkSchedule(db),
      });
      console.log('[Anya] Scheduled runner enabled (checking every 30 min)');
    }

    // Daily profile-aware auto-discovery (independent of ANYA_AUTONOMOUS_*).
    if (process.env.AUTO_DISCOVERY_DAILY_ENABLED === 'true') {
      startGuardedBackgroundInterval({
        name: 'scheduled-auto-discovery',
        intervalMs: 30 * 60 * 1000,
        task: async () => {
          const { checkScheduledAutoDiscovery } = await import('../services/scheduledAutoDiscovery.js');
          await checkScheduledAutoDiscovery(db, { uploadDir: uploadsDir });
        },
      });
      console.log(
        '[scheduled-auto-discovery] Daily profile-aware discovery enabled (checking every 30 min)',
      );
    }

    // Recurring background code-crawl-and-repair every 60 minutes. Its returned
    // promise is awaited by the guarded interval, so failures are contained and
    // a long repair cannot stack another repair on top of itself.
    if (typeof startBackgroundCodeCrawlAndRepair === 'function') {
      startGuardedBackgroundInterval({
        name: 'anya-code-crawl-repair',
        intervalMs: 60 * 60 * 1000,
        task: () => startBackgroundCodeCrawlAndRepair({ db }),
      });
      console.log(
        '[Anya] Background code-crawl-and-repair timer started (every 60 min)',
      );
    }
  }, 5000);

  // ── 8b. Auto-trigger geo crawl on startup ─────────────────────────────────
  _scheduleBackgroundTimeout(async () => {
    const result = await scheduleAdminGeoCrawlOnLogin(
      db,
      { role: 'admin', is_admin: true, id: 'startup_auto' },
      {},
    );
    if (result.scheduled) {
      console.log(`[startup] Auto geo crawl scheduled: job=${result.job_id}`);
    } else {
      console.log(`[startup] Auto geo crawl skipped: ${result.reason}`);
    }
  }, 15000);

  // ── 8c. Nightly email→grant sync (Outlook inbox → catalog) ────────────────
  _scheduleBackgroundTimeout(async () => {
    const { startEmailGrantSyncScheduler } = await import(
      '../services/emailGrants/emailGrantScheduler.js'
    );
    const r = startEmailGrantSyncScheduler({ db });
    console.log('[email-grants] nightly sync:', JSON.stringify(r));
  }, 6000);

  // ── 9. Anya background health service (single call) ───────────────────────
  try {
    startHealthService(db);
  } catch (err) {
    console.error(
      '[AnyaHealth] Failed to start health service:',
      err?.message || err,
    );
  }

  // ── 10. CodeGuard startup audit (Anya's system health brain) ─────────────
  _scheduleBackgroundTimeout(async () => {
    const { triggerStartupAudit } = await import('../services/anyaStartupAudit.js');
    await triggerStartupAudit(db, { port: actualPort });
  }, 30_000);

  // ── 11. National programs continuous crawler (opt-in) ─────────────────────
  if (process.env.NATIONAL_PROGRAMS_CRAWLER_ENABLED === 'true') {
    const intervalMinutes = Number.parseInt(
      process.env.NATIONAL_PROGRAMS_CRAWLER_INTERVAL_MINUTES || '360',
      10,
    );
    const maxUrls = Number.parseInt(
      process.env.NATIONAL_PROGRAMS_MAX_URLS || '200',
      10,
    );
    const maxDepth = Number.parseInt(
      process.env.NATIONAL_PROGRAMS_MAX_DEPTH || '2',
      10,
    );

    _scheduleBackgroundTimeout(async () => {
      const { startNationalProgramsCrawler } = await import(
        '../services/nationalPrograms/continuousRunner.js'
      );
      console.log(
        `[NationalPrograms] Continuous crawler enabled (every ${intervalMinutes} minutes, maxUrls=${maxUrls}, maxDepth=${maxDepth})`,
      );
      startNationalProgramsCrawler({
        db,
        uploadDir: uploadsDir,
        intervalMinutes,
        maxUrls,
        maxDepth,
      });
    }, 8000);
  } else {
    console.log(
      '[NationalPrograms] Continuous crawler disabled (set NATIONAL_PROGRAMS_CRAWLER_ENABLED=true to enable)',
    );
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _resolveBuildSha() {
  return (
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.GIT_COMMIT_SHA ||
    process.env.COMMIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    null
  );
}

function _parseBoolEnv(value) {
  if ((value === null || value === undefined)) return null;
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
  return null;
}

async function _scheduleCrawlerSmokeJobs({ db, uploadsDir }) {
  // Goal: prove crawlers can run end-to-end on the currently deployed build.
  if (process.env.NODE_ENV !== 'production') return;

  const sha = _resolveBuildSha();
  const suffix = (sha ? String(sha).slice(0, 8) : crypto.randomUUID().slice(0, 8)).replace(
    /[^a-z0-9_-]/gi,
    '',
  );

  const profileId = `smoke-profile-${suffix}`;
  const documentId = `smoke-document-${suffix}`;
  const comprehensiveJobId = `smoke-comprehensive-${suffix}`;
  const documentIngestJobId = `smoke-document-ingest-${suffix}`;
  const scholarshipJobId = `smoke-scholarship-${suffix}`;

  const insertProfileSql =
    db?.dialect === 'postgres'
      ? `
          INSERT INTO profiles (id, display_name, primary_type, status, tags)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (id) DO NOTHING
        `
      : `
          INSERT OR IGNORE INTO profiles (id, display_name, primary_type, status, tags)
          VALUES (?, ?, ?, ?, ?)
        `;

  const deleteProfileSql = 'DELETE FROM profiles WHERE id = ?';

  const insertDocumentSql =
    db?.dialect === 'postgres'
      ? `
          INSERT INTO documents (id, profile_id, name, type, extracted_text, processing_status, status)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO NOTHING
        `
      : `
          INSERT OR IGNORE INTO documents (id, profile_id, name, type, extracted_text, processing_status, status)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `;

  const insertJobSql =
    db?.dialect === 'postgres'
      ? `
          INSERT INTO crawler_jobs (id, type, status, profile_id, parameters, requested_by)
          VALUES (?, ?, 'queued', ?, ?, ?)
          ON CONFLICT (id) DO NOTHING
        `
      : `
          INSERT OR IGNORE INTO crawler_jobs (id, type, status, profile_id, parameters, requested_by)
          VALUES (?, ?, 'queued', ?, ?, ?)
        `;

  try {
    await db
      .prepare(insertProfileSql)
      .run(profileId, 'GrantFlow Smoke Profile', 'college_student', 'smoke_test', JSON.stringify(['student']));

    try {
      await db
        .prepare(insertDocumentSql)
        .run(
          documentId,
          profileId,
          `smoke-${suffix}.txt`,
          'source_material',
          'GrantFlow smoke document (no PII).',
          'pending',
          'draft',
        );

      await db
        .prepare(insertJobSql)
        .run(
          comprehensiveJobId,
          'comprehensive',
          profileId,
          JSON.stringify({
            max_results: 1,
            match_threshold: DEFAULT_MIN_SCORE,
            score_scale_id: SCORE_SCALE_ID,
            save_to_database: false,
          }),
          'system-smoke',
        );

      await db
        .prepare(insertJobSql)
        .run(
          scholarshipJobId,
          'scholarship',
          profileId,
          JSON.stringify({ limit: 1, save_to_database: false }),
          'system-smoke',
        );

      await db
        .prepare(insertJobSql)
        .run(
          documentIngestJobId,
          'document_ingest',
          profileId,
          JSON.stringify({ document_id: documentId, skip_ai: true, save_to_database: false }),
          'system-smoke',
        );
    } catch (jobError) {
      try {
        await db.prepare(deleteProfileSql).run(profileId);
      } catch {
        // best-effort cleanup
      }
      throw jobError;
    }

    dispatchCrawlerJob({
      db,
      jobId: comprehensiveJobId,
      uploadDir: uploadsDir,
      getOpenAI: null,
    }).catch((e) => console.warn('[background]', e?.message || e));
    dispatchCrawlerJob({
      db,
      jobId: scholarshipJobId,
      uploadDir: uploadsDir,
      getOpenAI: null,
    }).catch((e) => console.warn('[background]', e?.message || e));
    dispatchCrawlerJob({
      db,
      jobId: documentIngestJobId,
      uploadDir: uploadsDir,
      getOpenAI: null,
    }).catch((e) => console.warn('[background]', e?.message || e));
  } catch (error) {
    console.warn(
      '[smoke] Failed to schedule crawler smoke jobs:',
      error?.message || String(error),
    );
  }
}

async function _scheduleAutoProfileDedupe({ db }) {
  if (process.env.NODE_ENV !== 'production') return;
  if (!db) return;

  const sha = _resolveBuildSha();
  const runId = sha
    ? `auto-dedupe-${String(sha).slice(0, 12)}`
    : `auto-dedupe-${crypto.randomUUID().slice(0, 12)}`;
  console.info('[auto-dedupe] starting', {
    runId,
    sha: sha ? String(sha).slice(0, 12) : null,
  });

  try {
    const exists = await db
      .prepare(
        `
          SELECT 1
          FROM audit_logs
          WHERE category = 'admin'
            AND action = 'auto_profile_dedupe'
            AND resource_id = ?
          LIMIT 1
        `,
      )
      .get(runId);
    if (exists) {
      console.info('[auto-dedupe] already ran for this deploy; skipping', { runId });
      return;
    }
  } catch {
    // audit_logs may not exist yet; proceed.
  }

  const startedAt = Date.now();
  let mergedGroups = 0;
  let mergedLosers = 0;
  let skippedGroups = 0;

  try {
    const report = await findDuplicateProfileGroups(db, {
      strategy: 'exact_name',
      limitGroups: 500,
      minGroupSize: 2,
      includeInactive: false,
    });

    for (const group of report?.groups || []) {
      const winner = group?.winner;
      const losers = Array.isArray(group?.losers) ? group.losers : [];
      if (!winner?.id || losers.length === 0) continue;

      const userIds = new Set(
        [winner.user_id, ...losers.map((l) => l.user_id)]
          .filter(Boolean)
          .map(String),
      );
      const orgIds = new Set(
        [winner.organization_id, ...losers.map((l) => l.organization_id)]
          .filter(Boolean)
          .map(String),
      );
      if (userIds.size > 1 || orgIds.size > 1) {
        skippedGroups += 1;
        console.info('[auto-dedupe] skipped group (conflicting links)', {
          runId,
          key: group.key,
          winnerId: winner.id,
          loserCount: losers.length,
          userIds: Array.from(userIds),
          orgIds: Array.from(orgIds),
        });
        try {
          await logAuditEvent(db, {
            category: AUDIT_CATEGORIES.ADMIN,
            action: 'auto_profile_dedupe_skipped',
            severity: SEVERITY.WARNING,
            resourceType: 'profile',
            resourceId: winner.id,
            details: {
              run_id: runId,
              group_key: group.key,
              reason: 'conflicting user_id and/or organization_id across group',
              user_ids: Array.from(userIds),
              organization_ids: Array.from(orgIds),
              winner_id: winner.id,
              loser_ids: losers.map((l) => l.id),
            },
          });
        } catch (auditErr) {
          console.warn('[auto-dedupe] audit logging failed:', auditErr?.message);
        }
        continue;
      }

      const loserIds = losers.map((l) => l.id).filter(Boolean);
      try {
        await mergeProfiles(db, {
          winnerId: winner.id,
          loserIds,
          dryRun: false,
          actorUserId: null,
        });
        mergedGroups += 1;
        mergedLosers += loserIds.length;
        console.info('[auto-dedupe] merged group', {
          runId,
          key: group.key,
          winnerId: winner.id,
          loserCount: loserIds.length,
        });
        await logAuditEvent(db, {
          category: AUDIT_CATEGORIES.ADMIN,
          action: 'auto_profile_merge',
          severity: SEVERITY.INFO,
          resourceType: 'profile',
          resourceId: winner.id,
          details: {
            run_id: runId,
            group_key: group.key,
            winner_id: winner.id,
            loser_ids: loserIds,
          },
        });
      } catch (mergeError) {
        skippedGroups += 1;
        console.warn('[auto-dedupe] merge failed', {
          runId,
          key: group.key,
          winnerId: winner.id,
          loserCount: loserIds.length,
          error: mergeError?.message || String(mergeError),
        });
        await logAuditEvent(db, {
          category: AUDIT_CATEGORIES.ADMIN,
          action: 'auto_profile_merge_failed',
          severity: SEVERITY.ERROR,
          resourceType: 'profile',
          resourceId: winner.id,
          details: {
            run_id: runId,
            group_key: group.key,
            winner_id: winner.id,
            loser_ids: loserIds,
            error: mergeError?.message || String(mergeError),
          },
        });
      }
    }
  } finally {
    await logAuditEvent(db, {
      category: AUDIT_CATEGORIES.ADMIN,
      action: 'auto_profile_dedupe',
      severity: SEVERITY.INFO,
      resourceType: 'system',
      resourceId: runId,
      details: {
        sha: sha || null,
        merged_groups: mergedGroups,
        merged_losers: mergedLosers,
        skipped_groups: skippedGroups,
        duration_seconds: Math.max(
          0,
          Math.round((Date.now() - startedAt) / 1000),
        ),
      },
    });
    console.info('[auto-dedupe] finished', {
      runId,
      mergedGroups,
      mergedLosers,
      skippedGroups,
      durationSeconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
    });
  }
}
