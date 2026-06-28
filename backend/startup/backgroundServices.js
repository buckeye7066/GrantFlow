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
    console.warn('[FeatureFlags] Failed to initialize:', err.message);
  }

  // ── 4b. Seed curated NATIONAL_PROGRAMS into funding_opportunities ────────
  // Guarantees the professional-development / CE / licensure-remediation /
  // workforce-development funders we just added to nationalPrograms.js are
  // matchable on a brand-new deployment, before any periodic crawler run.
  // Idempotent: each row has a stable source_id and upsert-by-source_id
  // means re-running has no effect.
  setTimeout(() => {
    import('../services/seed/seedNationalPrograms.js')
      .then(async ({ seedNationalPrograms }) => {
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
      })
      .catch((err) => {
        console.warn(
          '[seed] Failed to load national programs seeder:',
          err?.message || err,
        );
      });
  }, 3000);

  // ── 4c. Seed curated SCHOLARSHIPS into funding_opportunities ──────────────
  // Pushes services/shared/data/scholarships.js (TN HOPE / Promise / TSAA /
  // STEP UP / Aspire, Federal Pell / FSEOG, off-campus / room-and-board
  // scholarships, forensic / STEM / heritage funds) into the catalog so
  // queries like "off-campus living expenses at MTSU" return real student
  // aid rows from the first request — not "0 results" until a crawl runs.
  setTimeout(() => {
    import('../services/seed/seedScholarships.js')
      .then(async ({ seedScholarships }) => {
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
      })
      .catch((err) => {
        console.warn(
          '[seed] Failed to load scholarships seeder:',
          err?.message || err,
        );
      });
  }, 3500);

  // ── 5. Startup smoke crawlers (production, opt-in) ─────────────────────────
  const startupSmokeEnabled = _parseBoolEnv(process.env.STARTUP_SMOKE_CRAWL_ENABLED) === true;
  if (startupSmokeEnabled) {
    setTimeout(() => {
      _scheduleCrawlerSmokeJobs({ db, uploadsDir }).catch((e) =>
        console.warn('[background]', e?.message || e),
      );
    }, 10_000);
    console.info(
      '[startup] Startup smoke crawlers enabled (STARTUP_SMOKE_CRAWL_ENABLED=true)',
    );
  } else {
    console.info(
      '[startup] Startup smoke crawlers disabled (set STARTUP_SMOKE_CRAWL_ENABLED=true to enable)',
    );
  }

  // ── 6. Auto profile de-duplication (production, once per deploy) ──────────
  setTimeout(() => {
    _scheduleAutoProfileDedupe({ db }).catch((err) => {
      console.warn('[auto-dedupe] failed:', err?.message || String(err));
    });
  }, 20_000);

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
  setTimeout(() => {
    import('../services/anyaAutonomousScheduler.js')
      .then(({ runOnStartup, startBackgroundCodeCrawlAndRepair }) => {
        if (process.env.ANYA_RUN_ON_STARTUP === 'true') {
          console.log('[Anya] Starting autonomous operations on server startup...');
          runOnStartup(db).catch((err) => {
            console.error('[Anya] Failed to complete autonomous operations:', err);
          });
        } else {
          runStartupOperations(db).catch((err) => {
            console.error('[Anya] Failed to complete crawler operations:', err);
          });
        }

        // Wire up the scheduled runner (e.g. daily at 3 AM).
        if (process.env.ANYA_RUN_ON_SCHEDULE === 'true') {
          const SCHEDULE_CHECK_MS = 30 * 60 * 1000;
          setInterval(() => {
            import('../services/anyaAutonomousScheduler.js')
              .then(({ checkSchedule }) => {
                checkSchedule(db).catch((err) => {
                  console.error(
                    '[Anya] Scheduled check failed:',
                    err?.message || err,
                  );
                });
              })
              .catch((e) => console.warn('[background]', e?.message || e));
          }, SCHEDULE_CHECK_MS);
          console.log('[Anya] Scheduled runner enabled (checking every 30 min)');
        }

        // Daily profile-aware auto-discovery (independent of ANYA_AUTONOMOUS_*).
        if (process.env.AUTO_DISCOVERY_DAILY_ENABLED === 'true') {
          const SCHEDULE_CHECK_MS = 30 * 60 * 1000;
          setInterval(() => {
            import('../services/scheduledAutoDiscovery.js')
              .then(({ checkScheduledAutoDiscovery }) => {
                checkScheduledAutoDiscovery(db, { uploadDir: uploadsDir }).catch((err) => {
                  console.error(
                    '[scheduled-auto-discovery] Scheduled check failed:',
                    err?.message || err,
                  );
                });
              })
              .catch((e) => console.warn('[background]', e?.message || e));
          }, SCHEDULE_CHECK_MS);
          console.log(
            '[scheduled-auto-discovery] Daily profile-aware discovery enabled (checking every 30 min)',
          );
        }

        // Recurring background code-crawl-and-repair every 60 minutes.
        if (typeof startBackgroundCodeCrawlAndRepair === 'function') {
          const CODE_CRAWL_INTERVAL_MS = 60 * 60 * 1000;
          setInterval(() => {
            startBackgroundCodeCrawlAndRepair({ db });
          }, CODE_CRAWL_INTERVAL_MS);
          console.log(
            '[Anya] Background code-crawl-and-repair timer started (every 60 min)',
          );
        }
      })
      .catch((err) => {
        console.error(
          '[Anya] Failed to import autonomous scheduler:',
          err?.message || err,
        );
        // Fallback: run basic startup crawlers even if scheduler fails to import.
        runStartupOperations(db).catch((crawlErr) => {
          console.error(
            '[Anya] Failed to complete crawler operations:',
            crawlErr,
          );
        });
      });
  }, 5000);

  // ── 8b. Auto-trigger geo crawl on startup ─────────────────────────────────
  // Ensures geo crawl runs on every deploy, not just on admin login.
  // Respects the existing cooldown logic inside scheduleAdminGeoCrawlOnLogin.
  setTimeout(() => {
    scheduleAdminGeoCrawlOnLogin(
      db,
      { role: 'admin', is_admin: true, id: 'startup_auto' },
      {},
    )
      .then((result) => {
        if (result.scheduled) {
          console.log(`[startup] Auto geo crawl scheduled: job=${result.job_id}`);
        } else {
          console.log(`[startup] Auto geo crawl skipped: ${result.reason}`);
        }
      })
      .catch((err) => {
        console.warn('[startup] Auto geo crawl failed:', err?.message || err);
      });
  }, 15000);

  // ── 8c. Nightly email→grant sync (Outlook inbox → catalog) ────────────────
  // Reads dr.johnwhite@axiombiolabs.org each night at 21:00 America/New_York
  // and parses grant emails into the catalog. No-ops gracefully if the mailbox
  // /Graph creds aren't configured. Disable with EMAIL_GRANTS_SYNC_ENABLED=false.
  setTimeout(() => {
    import('../services/emailGrants/emailGrantScheduler.js')
      .then(({ startEmailGrantSyncScheduler }) => {
        const r = startEmailGrantSyncScheduler({ db });
        console.log('[email-grants] nightly sync:', JSON.stringify(r));
      })
      .catch((err) => {
        console.warn('[email-grants] scheduler failed to start:', err?.message || err);
      });
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
  // Delayed 30s to ensure all routes are registered before endpoint probing.
  setTimeout(() => {
    import('../services/anyaStartupAudit.js')
      .then(({ triggerStartupAudit }) => {
        triggerStartupAudit(db, { port: actualPort });
      })
      .catch((err) => {
        console.warn('[codeGuard] Failed to start audit:', err?.message || err);
      });
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

    setTimeout(() => {
      import('../services/nationalPrograms/continuousRunner.js')
        .then(({ startNationalProgramsCrawler }) => {
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
        })
        .catch((err) => {
          console.error(
            '[NationalPrograms] Failed to start continuous crawler:',
            err?.message || err,
          );
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
          JSON.stringify({ max_results: 1, match_threshold: 80, save_to_database: false }),
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
      // If job insertion fails after profile was created, clean up the smoke profile
      // so it does not persist as an orphan with status 'smoke_test'.
      try {
        await db.prepare(deleteProfileSql).run(profileId);
      } catch {
        // best-effort cleanup
      }
      throw jobError;
    }

    // Fire-and-forget dispatch (non-blocking).
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
  // Goal: delete duplicate profiles automatically without requiring a human to click buttons.
  // Runs once per deployed SHA in production only.
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

  // Skip if we already ran on this deploy SHA (best-effort via audit_logs).
  try {
    const exists = db
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

      // Safety: skip if multiple distinct non-null users or organizations are involved.
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
