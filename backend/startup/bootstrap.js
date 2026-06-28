/**
 * bootstrap.js — Boot-critical startup tasks.
 *
 * Handles:
 *   1. Upload storage health validation
 *   2. Database connection validation
 *   3. Runtime secrets restoration
 *   4. Schema auto-migration (SQLite dev) and column additions
 *   5. Core-table self-heal (SQLite)
 *   6. Crawler-jobs CHECK-constraint rebuild (SQLite)
 *   7. JWT secret resolution
 *
 * @param {{ db, uploadsDir: string, legacyUploadsDir: string, baseDir: string }} args
 * @returns {{ storageStatus: object, EFFECTIVE_JWT_SECRET: string }}
 */

import fs from 'fs';
import { join } from 'path';
import { decryptRuntimeSecret } from '../utils/runtimeSecrets.js';
import { ensureUploadsDirWritable, isLikelyPersistentPath } from '../utils/uploadsDir.js';
import { getJwtSecretOrThrow } from '../config/env.js';

export async function runBootstrap({ db, uploadsDir, legacyUploadsDir, baseDir }) {
  // ── 1. Upload storage health ─────────────────────────────────────────────
  const isProdEnv = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  const allowEphemeralUploads =
    String(process.env.ALLOW_EPHEMERAL_UPLOADS || '').toLowerCase() === 'true';

  let storageStatus = {
    uploads_dir: uploadsDir,
    legacy_uploads_dir: legacyUploadsDir,
    writable: false,
    likely_persistent: isLikelyPersistentPath(uploadsDir),
    status: 'unknown',
    last_error: null,
    checked_at: new Date().toISOString(),
  };

  try {
    const writable = await ensureUploadsDirWritable(uploadsDir);
    storageStatus = {
      ...storageStatus,
      writable: Boolean(writable?.ok),
      last_error: writable?.ok ? null : writable?.error || 'uploads_unwritable',
      checked_at: new Date().toISOString(),
    };

    if (isProdEnv) {
      const missingEnv = !String(process.env.UPLOADS_DIR || '').trim();
      const persistentOk = storageStatus.likely_persistent === true;
      const writableOk = storageStatus.writable === true;

      if (
        (missingEnv || !persistentOk || !writableOk) &&
        !allowEphemeralUploads
      ) {
        const reason = missingEnv
          ? 'UPLOADS_DIR is required in production'
          : !persistentOk
            ? `UPLOADS_DIR is not a likely persistent mount: ${uploadsDir}`
            : `UPLOADS_DIR is not writable: ${uploadsDir}`;
        console.error(
          '[storage] FATAL: refusing to boot with non-persistent uploads storage',
          {
            reason,
            uploadsDir,
            missingEnv,
            likely_persistent: storageStatus.likely_persistent,
            writable: storageStatus.writable,
            last_error: storageStatus.last_error,
          },
        );
        // Allow graceful cleanup before exit
        await new Promise(resolve => setTimeout(resolve, 100));
        throw new Error('Storage validation failed in production');
      }

      if (missingEnv || !persistentOk || !writableOk) {
        storageStatus = { ...storageStatus, status: 'degraded' };
        console.error('[storage] DEGRADED upload storage', {
          uploadsDir,
          missingEnv,
          likely_persistent: storageStatus.likely_persistent,
          writable: storageStatus.writable,
          last_error: storageStatus.last_error,
        });
      } else {
        storageStatus = { ...storageStatus, status: 'ok' };
      }
    } else {
      storageStatus = {
        ...storageStatus,
        status: storageStatus.writable ? 'ok' : 'degraded',
      };
    }
  } catch (error) {
    storageStatus = {
      ...storageStatus,
      status: 'error',
      writable: false,
      last_error: error?.message || String(error),
      checked_at: new Date().toISOString(),
    };
    if (isProdEnv) {
      console.error('[storage] FATAL upload storage error:', storageStatus.last_error);
      throw new Error('Storage validation failed in production');
    }
    console.error(
      '[storage] Upload storage unavailable (dev mode continuing):',
      storageStatus.last_error,
    );
  }

  // ── 2. Database connection validation ────────────────────────────────────
  try {
    console.info('[database] Validating database connection...');
    const hc = await db.healthcheck();
    if (!hc?.ok) {
      throw new Error(hc?.error || 'Database healthcheck failed');
    }
    console.info('[database] Database connection validated successfully', {
      dialect: db.dialect,
      path: db.path ?? null,
    });
  } catch (dbError) {
    console.error('[database] CRITICAL: Failed to initialize database:', dbError);
    // Production safety: do not hard-exit. Keep the process alive so `/api/health` and
    // admin diagnostics can surface the failure reason.
    console.error('[database] Continuing startup in degraded mode (DB unavailable).');
  }

  // ── 3. Runtime secrets restoration ───────────────────────────────────────
  // Load persisted runtime secrets (encrypted) if missing from environment.
  const shouldAutoMigrate =
    String(process.env.DB_AUTO_MIGRATE || '').toLowerCase() === 'true' ||
    (db.dialect === 'sqlite' && process.env.NODE_ENV !== 'production');

  try {
    async function restoreRuntimeSecretIfMissing(key) {
      const current = String(process.env[key] || '').trim();
      const looksMissing = !current || current.includes('*');
      if (!looksMissing) return;

      const row = await db
        .prepare(
          `
            SELECT value_ciphertext, iv, tag, updated_at
            FROM app_runtime_secrets
            WHERE key = ?
            LIMIT 1
          `,
        )
        .get(key);

      if (row?.value_ciphertext && row?.iv && row?.tag) {
        const restored = decryptRuntimeSecret(row);
        if (restored && String(restored).trim()) {
          process.env[key] = String(restored).trim();
          console.info(`[startup] Restored ${key} from app_runtime_secrets`, {
            updated_at: row.updated_at ?? null,
            ...(key === 'OPENAI_API_KEY'
              ? { prefix: `${String(process.env[key]).slice(0, 7)}...` }
              : {}),
          });
        }
      }
    }

    await restoreRuntimeSecretIfMissing('OPENAI_API_KEY');
    await restoreRuntimeSecretIfMissing('RESEND_API_KEY');
    await restoreRuntimeSecretIfMissing('ANTHROPIC_API_KEY');
    await restoreRuntimeSecretIfMissing('ANYA_ADMIN_TOKEN');
    await restoreRuntimeSecretIfMissing('SAM_GOV_PUBLIC_API_KEY');
    await restoreRuntimeSecretIfMissing('SIMPLER_GRANTS_API_KEY');
    await restoreRuntimeSecretIfMissing('API_DATA_GOV_KEY');
    await restoreRuntimeSecretIfMissing('GRANTS_GOV_API_KEY');
  } catch (error) {
    console.warn('[startup] Failed to restore runtime secrets:', error?.message || error);
  }

  // ── 4. Schema auto-migration ──────────────────────────────────────────────
  // Table and column names are validated against a whitelist for security.
  const allowedMigrations = [
    { table: 'profiles', column: 'avatar_url', type: 'TEXT' },
    {
      table: 'profiles',
      column: 'user_id',
      type: 'TEXT REFERENCES users(id) ON DELETE SET NULL',
    },
    { table: 'crawler_jobs', column: 'result_meta', type: 'TEXT' },
    { table: 'crawler_jobs', column: 'retry_count', type: 'INTEGER DEFAULT 0' },
    { table: 'crawler_jobs', column: 'last_retry_at', type: 'DATETIME' },
    // Crawler stability metadata (idempotency + snapshots + dispatch backpressure)
    { table: 'crawler_jobs', column: 'profile_context_snapshot', type: 'TEXT' },
    { table: 'crawler_jobs', column: 'idempotency_key', type: 'TEXT' },
    { table: 'crawler_jobs', column: 'dispatch_attempts', type: 'INTEGER DEFAULT 0' },
    { table: 'crawler_jobs', column: 'next_dispatch_at', type: 'DATETIME' },
    // Heartbeat for long-running jobs (prevents stale cleanup of active jobs)
    { table: 'crawler_jobs', column: 'last_heartbeat_at', type: 'DATETIME' },
    // Positive classification for "REAL" opportunity invariants
    {
      table: 'funding_opportunities',
      column: 'record_origin',
      type: "TEXT DEFAULT 'live_crawl'",
    },
    { table: 'funding_opportunities', column: 'evidence_url', type: 'TEXT' },
    { table: 'funding_opportunities', column: 'last_verified_at', type: 'DATETIME' },
    // Production reality gate (priority #1): discovery vs verification are tracked
    // separately. Crawlers may NOT stamp last_verified_at without a real probe.
    { table: 'funding_opportunities', column: 'discovered_at', type: 'DATETIME' },
    { table: 'funding_opportunities', column: 'verification_method', type: 'TEXT' },
    { table: 'funding_opportunities', column: 'verified_by', type: 'TEXT' },
    { table: 'funding_opportunities', column: 'verification_error', type: 'TEXT' },
    { table: 'funding_opportunities', column: 'link_status_code', type: 'INTEGER' },
    // Reality gate phase 1.2: per-row classification + source trust tier
    // (migration 068). Lets the consumer/UI layer label results consistently
    // ("direct grant" vs "directory" vs "school portal") without re-deriving.
    { table: 'funding_opportunities', column: 'opportunity_kind', type: 'TEXT' },
    { table: 'funding_opportunities', column: 'source_trust_tier', type: 'TEXT' },
    // Link documents to per-school university applications (student profiles)
    { table: 'documents', column: 'university_application_id', type: 'TEXT' },
    { table: 'documents', column: 'university_application_name', type: 'TEXT' },
    // Password auth (first-login password setup + password login)
    { table: 'users', column: 'password_hash', type: 'TEXT' },
    // Grant application guidance (how to apply)
    { table: 'grants', column: 'application_method', type: 'TEXT' },
    { table: 'grants', column: 'application_steps', type: 'TEXT' },
    { table: 'grants', column: 'contact_name', type: 'TEXT' },
    { table: 'grants', column: 'contact_email', type: 'TEXT' },
    { table: 'grants', column: 'contact_phone', type: 'TEXT' },
    // Loan/grants filtering (realCrawlers buildCandidateOpportunityQuery)
    { table: 'funding_opportunities', column: 'is_loan', type: 'INTEGER DEFAULT 0' },
    // Crawl metadata analysis blob (migration 032 / crawl metadata)
    { table: 'crawl_metadata', column: 'analysis_json', type: 'TEXT' },
    // Match decision metadata (migration 036) — canonical from matchEngine.js
    { table: 'grants', column: 'match_decision', type: 'TEXT' },
    { table: 'grants', column: 'match_explanation', type: 'TEXT' },
    { table: 'grants', column: 'matched_needs', type: "TEXT DEFAULT '[]'" },
    { table: 'grants', column: 'eligibility_status', type: 'TEXT' },
    { table: 'grants', column: 'ineligibility_reasons', type: "TEXT DEFAULT '[]'" },
    { table: 'grants', column: 'profile_fingerprint', type: 'TEXT' },
    { table: 'grants', column: 'opportunity_fingerprint', type: 'TEXT' },
    { table: 'grants', column: 'matcher_version', type: 'TEXT' },
    { table: 'grants', column: 'evaluated_at', type: 'DATETIME' },
    { table: 'grants', column: 'match_confidence', type: 'INTEGER' },
    // Funding opportunities normalized eligibility (migration 036)
    { table: 'funding_opportunities', column: 'entity_types_allowed', type: "TEXT DEFAULT '[]'" },
    { table: 'funding_opportunities', column: 'need_types_supported', type: "TEXT DEFAULT '[]'" },
    { table: 'funding_opportunities', column: 'deadline_status', type: 'TEXT' },
    { table: 'funding_opportunities', column: 'official_source_type', type: 'TEXT' },
    { table: 'funding_opportunities', column: 'source_trust_score', type: 'INTEGER' },
    { table: 'funding_opportunities', column: 'opportunity_fingerprint', type: 'TEXT' },
    // Profile fingerprint and normalized snapshot (migration 036)
    { table: 'profiles', column: 'profile_fingerprint', type: 'TEXT' },
    { table: 'profiles', column: 'normalized_snapshot', type: 'TEXT' },
  ];

  const validTables = new Set([
    'profiles',
    'crawler_jobs',
    'users',
    'organizations',
    'grants',
    'funding_opportunities',
    'documents',
    'crawl_metadata',
  ]);
  const validColumnPattern = /^[a-z_]+$/;

  // Apply full schema first so fresh DBs (e.g. unit tests) have base tables.
  if (shouldAutoMigrate) {
    const schemaPath = join(baseDir, 'db', 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      try {
        const schema = fs.readFileSync(schemaPath, 'utf8');
        await db.exec(schema);
        console.info('[database] Schema applied (auto-migrate enabled)', {
          dialect: db.dialect,
        });
      } catch (schemaError) {
        console.error('[database] Error running schema migrations:', schemaError);
      }
    }
  }

  // Additional validation for column type to prevent injection. Shared by the
  // SQLite and Postgres self-heal branches below.
  const allowedTypes = new Set(['TEXT', 'INTEGER', 'DATETIME', 'TEXT DEFAULT \'live_crawl\'', 'INTEGER DEFAULT 0', 'TEXT REFERENCES users(id) ON DELETE SET NULL', "TEXT DEFAULT '[]'"]);

  // Add columns that may be missing (SQLite-only legacy auto-migration).
  if (db.dialect === 'sqlite') {
    allowedMigrations.forEach(({ table, column, type }) => {
      if (!validTables.has(table) || !validColumnPattern.test(column)) {
        console.error(`Migration error: Invalid table "${table}" or column "${column}"`);
        return;
      }
      if (!allowedTypes.has(type)) {
        console.error(`Migration error: Invalid type "${type}"`);
        return;
      }
      try {
        const stmt = db.prepare('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + type); stmt.run();
      } catch (error) {
        if (!error.message.includes('duplicate column')) {
          console.warn(`Migration warning for ${table}.${column}:`, error.message);
        }
      }
    });
  } else {
    // Postgres: the numbered migration chain is the primary schema mechanism,
    // but PARTIAL drift leaves individual columns missing whenever a migration
    // aborted partway — e.g. migration 036 tried to ADD an already-existing
    // grants.match_decision, threw "column already exists", and never reached
    // grants.eligibility_status. The matcher's "save to pipeline" write then
    // 500s on every run with `column "eligibility_status" of relation "grants"
    // does not exist`. ADD COLUMN IF NOT EXISTS is idempotent and metadata-only
    // (no table rewrite for nullable/defaulted columns), so we self-heal each
    // column independently and one pre-existing column can never abort the rest.
    let ensured = 0;
    for (const { table, column, type } of allowedMigrations) {
      if (!validTables.has(table) || !validColumnPattern.test(column)) {
        console.error(`Migration error: Invalid table "${table}" or column "${column}"`);
        continue;
      }
      if (!allowedTypes.has(type)) {
        console.error(`Migration error: Invalid type "${type}"`);
        continue;
      }
      // Postgres has no DATETIME type; map it to TIMESTAMPTZ to match the
      // canonical schema's timestamp columns.
      const pgType = type === 'DATETIME' ? 'TIMESTAMPTZ' : type;
      try {
        await db.exec('ALTER TABLE ' + table + ' ADD COLUMN IF NOT EXISTS ' + column + ' ' + pgType);
        ensured += 1;
      } catch (error) {
        console.warn(`[database] PG column self-heal warning for ${table}.${column}:`, error?.message || error);
      }
    }
    console.info(`[database] Postgres column self-heal complete (ADD COLUMN IF NOT EXISTS across ${ensured} column(s))`);
  }

  // ── 5. Core-table self-heal (SQLite) ──────────────────────────────────────
  if (db.dialect === 'sqlite') {
    try {
      let missingCore = false;
      const tablesToCheck = [
        'profiles',
        'profile_sections',
        'documents',
        'crawler_jobs',
        'users',
      ];
      for (const table of tablesToCheck) {
        try {
          const stmt = db.prepare('SELECT 1 FROM ' + table + ' LIMIT 1'); stmt.get();
        } catch (error) {
          const msg = String(error?.message || error);
          if (msg.includes('no such table') || msg.includes('SQLITE_ERROR')) {
            missingCore = true;
            console.warn(
              '[database] Detected missing core table; will apply schema.sql',
              { table, error: msg },
            );
            break;
          } else {
            // Log unexpected database errors that might indicate corruption
            console.error('[database] Unexpected error checking table:', { table, error: msg });
          }
        }
      }

      if (missingCore) {
        const schemaPath = join(baseDir, 'db', 'schema.sql');
        if (fs.existsSync(schemaPath)) {
          const schema = fs.readFileSync(schemaPath, 'utf8');
          await db.exec(schema);
          console.info('[database] Schema applied (self-heal)', { dialect: db.dialect });
        } else {
          console.error(
            '[database] schema.sql missing; cannot self-heal sqlite schema',
            { schemaPath },
          );
        }
      }
    } catch (error) {
      console.error(
        '[database] Failed during sqlite schema self-heal:',
        error?.message || error,
      );
    }
  }

  // ── 6. Crawler-jobs CHECK-constraint rebuild (SQLite) ────────────────────
  if (db.dialect === 'sqlite') {
    _ensureCrawlerJobsSupportsAllTypes(db);
  }

  // ── 7. JWT secret resolution ─────────────────────────────────────────────
  let EFFECTIVE_JWT_SECRET;
  try {
    EFFECTIVE_JWT_SECRET = getJwtSecretOrThrow(process.env);
  } catch (err) {
    console.error(`FATAL ERROR: ${err.message}`);
    throw new Error('Storage validation failed in production');
  }

  // ── 8. Opportunity reality gate (production) ─────────────────────────────
  //
  // Mission rule: a "verified" opportunity must have actually been verified.
  // Contract:
  //   * In production, URL verification is DEFAULT-ON. If
  //     URL_VERIFICATION_ENABLED is unset we set it to 'true' on
  //     `process.env` so every downstream consumer sees it on.
  //   * The only way to boot production with verification disabled is to
  //     EXPLICITLY set URL_VERIFICATION_ENABLED=false AND set
  //     GRANTFLOW_SKIP_VERIFICATION_GATE=true (or NODE_ENV=test, etc.).
  //   * Tests/seeds opt out via NODE_ENV=test, GRANTFLOW_SEED_MODE=true, or
  //     ALLOW_EPHEMERAL_SQLITE=true.
  const verifEnvRaw = String(process.env.URL_VERIFICATION_ENABLED || '').toLowerCase();
  const verifExplicitlyDisabled = verifEnvRaw === 'false' || verifEnvRaw === '0' || verifEnvRaw === 'no';
  const verifExplicitlyEnabled = verifEnvRaw === 'true' || verifEnvRaw === '1' || verifEnvRaw === 'yes';
  const skipGate =
    String(process.env.GRANTFLOW_SKIP_VERIFICATION_GATE || '').toLowerCase() === 'true' ||
    String(process.env.NODE_ENV || '').toLowerCase() === 'test' ||
    String(process.env.GRANTFLOW_SEED_MODE || '').toLowerCase() === 'true' ||
    String(process.env.ALLOW_EPHEMERAL_SQLITE || '').toLowerCase() === 'true';

  if (isProdEnv && verifExplicitlyDisabled && !skipGate) {
    console.error(
      '[reality-gate] FATAL: URL_VERIFICATION_ENABLED is explicitly false in production.\n' +
        '  Either remove URL_VERIFICATION_ENABLED=false or set\n' +
        '  GRANTFLOW_SKIP_VERIFICATION_GATE=true to acknowledge a seed/import boot.\n' +
        '  Mission rule: opportunities must be verified before being shown as real funding.'
    );
    throw new Error('URL verification gate failed in production');
  }

  if (isProdEnv && !verifExplicitlyEnabled && !verifExplicitlyDisabled) {
    process.env.URL_VERIFICATION_ENABLED = 'true';
    console.info(
      '[reality-gate] URL_VERIFICATION_ENABLED defaulted to true (production mission rule).'
    );
  }

  const urlVerifEnabled =
    String(process.env.URL_VERIFICATION_ENABLED || '').toLowerCase() === 'true';

  if (!isProdEnv && !urlVerifEnabled && !skipGate) {
    console.warn(
      '[reality-gate] URL_VERIFICATION_ENABLED is not set. Live URL probing will be skipped at ingest.\n' +
        '  Set URL_VERIFICATION_ENABLED=true to enable, or GRANTFLOW_SKIP_VERIFICATION_GATE=true to silence this warning.'
    );
  }

  return {
    storageStatus,
    EFFECTIVE_JWT_SECRET,
    realityGate: {
      url_verification_enabled: urlVerifEnabled,
      gate_skipped: skipGate,
      production: isProdEnv,
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _ensureCrawlerJobsSupportsAllTypes(db) {
  // SQLite-only safety: older local DBs may have an outdated CHECK constraint on
  // crawler_jobs.type. If it rejects any currently-supported type, rebuild the table.
  const testTypes = [
    'local',
    'scholarship',
    'health_resources',
    'comprehensive',
    'national',
    'item_search',
    'item_gift_search',
    'avatar_lookup',
    'document_ingest',
    'pipeline_automation',
    'profile_enrichment',
    'national_zip_scan',
  ];
  let needsRebuild = false;

  for (const type of testTypes) {
    try {
      // Validate type matches expected pattern
      if (!/^[a-z_]+$/.test(type)) {
        console.error(`Invalid test type: ${type}`);
        continue;
      }
      const testId = `__schema_test_${type}__`;
      db.prepare(
        `INSERT INTO crawler_jobs (id, type, status) VALUES (?, ?, 'queued')`,
      ).run(testId, type);
      const stmt = db.prepare('DELETE FROM crawler_jobs WHERE id = ?'); stmt.run(testId);
    } catch (error) {
      if (error?.message && error.message.includes('CHECK constraint failed')) {
        needsRebuild = true;
        break;
      }
    }
  }

  if (!needsRebuild) return;

  const rebuild = db.transaction(() => {
    db.prepare(
      `
        CREATE TABLE crawler_jobs_new (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          started_at DATETIME,
          completed_at DATETIME,
          type TEXT NOT NULL CHECK(type IN (
            'local',
            'scholarship',
            'health_resources',
            'comprehensive',
            'national',
            'item_search',
            'item_gift_search',
            'avatar_lookup',
            'document_ingest',
            'pipeline_automation',
            'profile_enrichment',
            'national_zip_scan'
          )),
          status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN (
            'queued',
            'running',
            'completed',
            'failed',
            'cancelled'
          )),
          profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
          organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
          parameters TEXT DEFAULT '{}',
          profile_context_snapshot TEXT,
          idempotency_key TEXT,
          result_count INTEGER DEFAULT 0,
          result_meta TEXT,
          error TEXT,
          requested_by TEXT,
          dispatch_attempts INTEGER DEFAULT 0,
          next_dispatch_at DATETIME,
          retry_count INTEGER DEFAULT 0,
          last_retry_at DATETIME
        )
      `,
    ).run();

    db.prepare(
      `
        INSERT INTO crawler_jobs_new (
          id, created_at, started_at, completed_at, type, status,
          profile_id, organization_id, parameters, profile_context_snapshot,
          idempotency_key, result_count, result_meta, error, requested_by,
          dispatch_attempts, next_dispatch_at, retry_count, last_retry_at
        )
        SELECT
          id, created_at, started_at, completed_at, type, status,
          profile_id, organization_id, parameters,
          NULL as profile_context_snapshot,
          NULL as idempotency_key,
          result_count, result_meta, error, requested_by,
          0 as dispatch_attempts,
          NULL as next_dispatch_at,
          COALESCE(retry_count, 0),
          last_retry_at
        FROM crawler_jobs
      `,
    ).run();

    db.prepare('DROP TABLE crawler_jobs').run();
    db.prepare('ALTER TABLE crawler_jobs_new RENAME TO crawler_jobs').run();
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_crawler_jobs_status ON crawler_jobs(status)',
    ).run();
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_crawler_jobs_profile ON crawler_jobs(profile_id)',
    ).run();
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_crawler_jobs_type ON crawler_jobs(type)',
    ).run();
    db.prepare(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_crawler_jobs_idempotency ON crawler_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL',
    ).run();
  });

  rebuild();
}
