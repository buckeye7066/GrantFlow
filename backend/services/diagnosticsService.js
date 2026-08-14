import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { ensureAdminSchemaRepair } from './adminSchemaRepair.js';
import { PAGE_FACT_MIGRATION_COLUMN_NAMES } from '../crawler-os/pageFacts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function rowsFromResult(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.rows)) return result.rows;
  return [];
}

/**
 * Get comprehensive system diagnostics
 * @param {Object} db - Database connection
 * @returns {Object} Diagnostics data
 */
export async function getSystemDiagnostics(db) {
  const timestamp = new Date().toISOString();
  
  // Get app version from git or package.json
  let version = 'unknown';
  try {
    const packageJsonPath = path.resolve(__dirname, '../../package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    version = packageJson.version || 'unknown';
  } catch (error) {
    // Ignore if we can't read package.json
  }
  
  const errors = await getRecentErrors(db);
  // Split benign (expected no-input / skipped) from real failures so the
  // System Status rollup only goes red on genuine errors. `errors` keeps the
  // full annotated list for the detail view; the counts drive status.
  const realErrors = errors.filter((e) => !e.benign);
  const benignErrors = errors.filter((e) => e.benign);

  const diagnostics = {
    timestamp,
    app: {
      env: process.env.NODE_ENV || 'development',
      version,
      node_version: process.version,
      uptime_seconds: Math.round(process.uptime()),
      memory_usage_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    },
    db: await getDatabaseDiagnostics(db),
    env_flags: getEnvironmentFlags(),
    last_activity: await getLastActivity(db),
    // Observability (Agent Observability Rule): surface the LAST full self-heal
    // run so Sam's diagnostics show whether the on-demand heal (nightly sweep /
    // owner.run_self_heal) ran and what it repaired. Boot only runs the
    // lightweight enforceInvariants net; this reflects the full heal. Never
    // throws — null when one has never run.
    self_heal: await getSelfHealDiagnostics(db),
    errors,
    // Canonical, status-driving counts. `real_errors`/`benign_errors` make the
    // benign-vs-real split explicit so the dashboard never reds out on an
    // expected missing_item_request-class skip.
    error_counts: {
      total: errors.length,
      real: realErrors.length,
      benign: benignErrors.length,
    },
    real_errors: realErrors,
    benign_errors: benignErrors,
  };

  return diagnostics;
}

/**
 * Last full self-heal run, compacted for the diagnostics rollup. Reads from the
 * canonical system_kv-backed store (no parallel telemetry). Never throws.
 * @param {Object} db
 * @returns {Promise<Object>}
 */
async function getSelfHealDiagnostics(db) {
  try {
    const { getLastSelfHealRun } = await import('../startup/selfHealStatus.js');
    const last = await getLastSelfHealRun(db);
    if (!last) return { has_run: false };
    return {
      has_run: true,
      ok: last.ok !== false,
      at: last.finished_at ?? last.updated_at ?? last.recorded_at ?? null,
      on_demand: Boolean(last.onDemand),
      total_repaired: Number(last.totalRepaired) || 0,
      failures: Array.isArray(last.failures) ? last.failures.length : 0,
      steps: Array.isArray(last.steps) ? last.steps.length : 0,
    };
  } catch {
    return { has_run: false };
  }
}

/**
 * Get database diagnostics including table counts and schema checks
 * @param {Object} db - Database connection
 * @returns {Object} Database diagnostics
 */
async function getDatabaseDiagnostics(db) {
  if (!db) {
    return {
      ok: false,
      error: 'Database connection unavailable',
    };
  }
  
  try {
    // Test database connectivity
    await db.prepare('SELECT 1').get();
    await ensureAdminSchemaRepair(db);
 
    // For Postgres, `DB_PATH` is irrelevant; the "path" field is only meaningful for SQLite.
    const dialect = db?.dialect || 'unknown'
    const dbPath = dialect === 'sqlite' ? (process.env.DB_PATH || 'data/grantflow.db') : null;
    
    // Check if database is writable by attempting a simple query (SQLite only).
    let writable = null;
    if (dialect === 'sqlite') {
      try {
        // Use db.exec for transaction control keywords, which all major
        // SQLite wrappers (better-sqlite3, sqlite, sqlite3) support.
        if (typeof db.exec === 'function') {
          await Promise.resolve(db.exec('BEGIN IMMEDIATE; ROLLBACK;'));
        } else {
          // Fallback: attempt a harmless write to a temp table and roll back
          await db.prepare("SAVEPOINT _diag_probe").run();
          await db.prepare("RELEASE _diag_probe").run();
        }
        writable = true;
      } catch (error) {
        writable = false;
      }
    }
    
    // Get table counts
    const tables = {
      funding_opportunities: await getTableCount(db, 'funding_opportunities'),
      crawl_logs: await getTableCount(db, 'crawl_logs'),
      grants: await getTableCount(db, 'grants'),
      profiles: await getTableCount(db, 'profiles'),
      users: await getTableCount(db, 'users'),
      organizations: await getTableCount(db, 'organizations'),
      crawler_jobs: await getTableCount(db, 'crawler_jobs'),
    };
    
    // Schema checks for funding_opportunities table
    const schema_checks = await checkFundingOpportunitiesSchema(db);
    
    return {
      ok: true,
      path: dbPath,
      writable,
      tables,
      schema_checks,
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
    };
  }
}

/**
 * Get count of records in a table
 * @param {Object} db - Database connection
 * @param {string} tableName - Name of table
 * @returns {number} Count of records
 */
async function getTableCount(db, tableName) {
  try {
    // Whitelist of allowed table names for additional security
    const allowedTables = [
      'funding_opportunities',
      'crawl_logs',
      'grants',
      'profiles',
      'users',
      'organizations',
      'crawler_jobs',
    ];
    
    // Validate table name is in whitelist
    if (!allowedTables.includes(tableName)) {
      return 0;
    }

    // Postgres does not accept MySQL-style backticks; bare identifiers are safe here because
    // tableName is whitelisted above.
    const countSql =
      db?.dialect === 'postgres'
        ? `SELECT COUNT(*)::bigint AS count FROM ${tableName}`
        : `SELECT COUNT(*) AS count FROM ${tableName}`;
    const result = await db.prepare(countSql).get();
    const raw = result?.count ?? result?.COUNT;
    return Number(raw ?? 0);
  } catch (error) {
    return 0;
  }
}

/**
 * Return the set of columns present on a table and the required columns that
 * are absent. Works for both sqlite (PRAGMA) and postgres
 * (information_schema). Returns empty sets if the table itself is missing;
 * the caller decides whether to flag the table separately via
 * checkTableExists().
 */
async function checkTableColumns(db, tableName, required = []) {
  try {
    if (db?.dialect === 'postgres') {
      const rows = await db
        .prepare(
          `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = $1
          `,
        )
        .all(tableName)
      const has = new Set(rowsFromResult(rows).map((r) => String(r.column_name)))
      return { has, missing: required.filter((c) => !has.has(c)) }
    }
    const rows = await db.prepare(`PRAGMA table_info(${tableName})`).all()
    const has = new Set((rows || []).map((r) => r.name))
    return { has, missing: required.filter((c) => !has.has(c)) }
  } catch {
    /* intentionally ignored: table missing or unreadable — caller flags via checkTableExists */
    return { has: new Set(), missing: required.slice() }
  }
}

async function checkTableExists(db, tableName) {
  try {
    if (db?.dialect === 'postgres') {
      const row = await db
        .prepare(`SELECT to_regclass(current_schema() || '.' || $1) AS regclass`)
        .get(tableName)
      return Boolean(row?.regclass)
    }
    const row = await db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
      )
      .get(tableName)
    return Boolean(row?.name)
  } catch {
    /* intentionally ignored: absence is the signal callers want */
    return false
  }
}

/**
 * Check schema drift across funding_opportunities + grants + crawler_logs.
 *
 * This is the canonical drift detector used by admin.diagnostics,
 * `npm run db:check`, and the boot-time schema-check log line in
 * backend/db/migrate.js. It MUST return `details.missing_columns` as an
 * empty array when the schema is up to date — CI relies on that to block
 * releases from landing with a drifted schema.
 */
export async function checkFundingOpportunitiesSchema(db) {
  const grantsRequired = ['url', 'matched_needs', 'match_decision', 'match_explanation', 'fingerprint', 'fingerprint_version']
  const grantsCheck = await checkTableColumns(db, 'grants', grantsRequired)
  const crawlerLogsExists = await checkTableExists(db, 'crawler_logs')
  // page_fact_cache (migration 145 / pg 0149) — content-addressed page-fact
  // cache, ADDITIVE + unused (Phase 0.2). Registered here so a missed migration
  // shows as schema DRIFT instead of silently absent.
  const pageFactCacheExists = await checkTableExists(db, 'page_fact_cache')

  if (db?.dialect === 'postgres') {
    try {
      // Page-fact provenance columns (migration 144 / pg 0148) come from the
      // pageFacts registry so the drift check can never fall out of sync with
      // what the migration/boot-invariant add. eligibility_bullets pre-existed.
      const targetColumns = ['type', 'evidence_url', 'last_verified_at', 'title', 'sponsor', 'deadline',
        ...PAGE_FACT_MIGRATION_COLUMN_NAMES]

      const rows = await db
        .prepare(
          `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'funding_opportunities'
          `,
        )
        .all()

      const columnNames = new Set(rowsFromResult(rows).map((r) => String(r.column_name)))

      const crawlLogsExistsRow = await db
        .prepare(`SELECT to_regclass(current_schema() || '.crawl_logs') AS regclass`)
        .get()
      const crawlLogsExists = Boolean(crawlLogsExistsRow?.regclass)

      const fundingMissing = targetColumns.filter((col) => !columnNames.has(col))
      const missingColumns = [
        ...fundingMissing.map((c) => `funding_opportunities.${c}`),
        ...grantsCheck.missing.map((c) => `grants.${c}`),
      ]
      const missingTables = []
      if (!crawlerLogsExists) missingTables.push('crawler_logs')
      if (!pageFactCacheExists) missingTables.push('page_fact_cache')

      return {
        funding_opportunities_has_type: columnNames.has('type'),
        funding_opportunities_has_evidence_url: columnNames.has('evidence_url'),
        funding_opportunities_has_last_verified_at: columnNames.has('last_verified_at'),
        funding_opportunities_has_title: columnNames.has('title'),
        funding_opportunities_has_sponsor: columnNames.has('sponsor'),
        funding_opportunities_has_deadline: columnNames.has('deadline'),
        grants_has_url: grantsCheck.has.has('url'),
        grants_has_fingerprint: grantsCheck.has.has('fingerprint'),
        grants_has_match_decision: grantsCheck.has.has('match_decision'),
        grants_has_match_explanation: grantsCheck.has.has('match_explanation'),
        grants_has_matched_needs: grantsCheck.has.has('matched_needs'),
        crawl_logs_exists: crawlLogsExists,
        crawler_logs_exists: crawlerLogsExists,
        details: {
          dialect: 'postgres',
          missing_columns: missingColumns,
          missing_tables: missingTables,
        },
      }
    } catch (error) {
      return {
        error: 'Failed to check schema (postgres)',
        message: error?.message || String(error),
        details: { dialect: 'postgres' },
      }
    }
  }

  try {
    const tableInfo = await db.prepare('PRAGMA table_info(funding_opportunities)').all();
    const columnNames = tableInfo.map(col => col.name);
    
    // Also check if crawl_logs table exists
    let crawlLogsExists = false;
    try {
      await db.prepare('SELECT 1 FROM crawl_logs LIMIT 1').get();
      crawlLogsExists = true;
    } catch (e) {
      crawlLogsExists = false;
    }
    
    const targetColumns = ['type', 'evidence_url', 'last_verified_at', 'title', 'sponsor', 'deadline',
      ...PAGE_FACT_MIGRATION_COLUMN_NAMES];
    const fundingMissing = targetColumns.filter((col) => !columnNames.includes(col));
    const missingColumns = [
      ...fundingMissing.map((c) => `funding_opportunities.${c}`),
      ...grantsCheck.missing.map((c) => `grants.${c}`),
    ];
    const missingTables = [];
    if (!crawlerLogsExists) missingTables.push('crawler_logs');
    if (!pageFactCacheExists) missingTables.push('page_fact_cache');
    return {
      funding_opportunities_has_type: columnNames.includes('type'),
      funding_opportunities_has_evidence_url: columnNames.includes('evidence_url'),
      funding_opportunities_has_last_verified_at: columnNames.includes('last_verified_at'),
      funding_opportunities_has_title: columnNames.includes('title'),
      funding_opportunities_has_sponsor: columnNames.includes('sponsor'),
      funding_opportunities_has_deadline: columnNames.includes('deadline'),
      grants_has_url: grantsCheck.has.has('url'),
      grants_has_fingerprint: grantsCheck.has.has('fingerprint'),
      grants_has_match_decision: grantsCheck.has.has('match_decision'),
      grants_has_match_explanation: grantsCheck.has.has('match_explanation'),
      grants_has_matched_needs: grantsCheck.has.has('matched_needs'),
      crawl_logs_exists: crawlLogsExists,
      crawler_logs_exists: crawlerLogsExists,
      details: {
        dialect: 'sqlite',
        missing_columns: missingColumns,
        missing_tables: missingTables,
      },
    };
  } catch (error) {
    return {
      error: 'Failed to check schema',
      message: error.message,
    };
  }
}

/**
 * Get environment flags (presence of API keys, not their values)
 * @returns {Object} Environment flags
 */
function getEnvironmentFlags() {
  return {
    // Canonical: SAM_GOV_PUBLIC_API_KEY (keep legacy SAM_GOV_API_KEY for backward compatibility)
    SAM_GOV_PUBLIC_API_KEY_present:
      Boolean(process.env.SAM_GOV_PUBLIC_API_KEY || process.env.SAM_GOV_API_KEY),
    GRANTS_GOV_API_KEY_present: Boolean(process.env.GRANTS_GOV_API_KEY),
    SIMPLER_GRANTS_API_KEY_present: Boolean(process.env.SIMPLER_GRANTS_API_KEY),
    API_DATA_GOV_KEY_present: Boolean(process.env.API_DATA_GOV_KEY),
    OPENAI_API_KEY_present: Boolean(process.env.OPENAI_API_KEY),
    ANTHROPIC_API_KEY_present: Boolean(process.env.ANTHROPIC_API_KEY),
    RESEND_API_KEY_present: Boolean(process.env.RESEND_API_KEY),
    FROM_EMAIL_set: Boolean(process.env.FROM_EMAIL),
    AUTH_NOTIFY_ON_LOGIN_enabled: String(process.env.AUTH_NOTIFY_ON_LOGIN || '').toLowerCase() === 'true',
    AUTH_NOTIFY_EMAIL_set: Boolean(process.env.AUTH_NOTIFY_EMAIL),
    ANYA_ADMIN_TOKEN_present: Boolean(process.env.ANYA_ADMIN_TOKEN),
    NODE_ENV: process.env.NODE_ENV || 'development',
    DB_PATH_set: Boolean(process.env.DB_PATH),
    AUTH_PUBLIC_URL_set: Boolean(process.env.AUTH_PUBLIC_URL || process.env.PUBLIC_URL),
    AUTH_FRONTEND_URL_set: Boolean(process.env.AUTH_FRONTEND_URL || process.env.FRONTEND_BASE_URL),
    TWILIO_configured: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
  };
}

/**
 * Get last activity from crawl logs and ingestion
 * @param {Object} db - Database connection
 * @returns {Object} Last activity data
 */
async function getLastActivity(db) {
  if (!db) {
    return {
      last_crawl_log: null,
      last_ingestion: null,
    };
  }
  
  try {
    // Get last crawl log
    const lastCrawlLog = await db.prepare(`
      SELECT source, status, created_at, records_found, records_imported
      FROM crawl_logs
      ORDER BY created_at DESC
      LIMIT 1
    `).get();
    
    // Get last crawler job
    const lastCrawlerJob = await db.prepare(`
      SELECT type, status, completed_at, result_count
      FROM crawler_jobs
      ORDER BY created_at DESC
      LIMIT 1
    `).get();
    
    return {
      last_crawl_log: lastCrawlLog ? {
        source: lastCrawlLog.source,
        status: lastCrawlLog.status,
        ended_at: lastCrawlLog.created_at,
        records_found: lastCrawlLog.records_found || 0,
        records_imported: lastCrawlLog.records_imported || 0,
      } : null,
      last_crawler_job: lastCrawlerJob ? {
        type: lastCrawlerJob.type,
        status: lastCrawlerJob.status,
        ended_at: lastCrawlerJob.completed_at,
        result_count: lastCrawlerJob.result_count || 0,
      } : null,
    };
  } catch (error) {
    return {
      error: 'Failed to get last activity',
      message: error.message,
    };
  }
}

/**
 * Benign / expected crawler outcomes that must NOT count as real errors.
 *
 * Several crawler job types legitimately produce no records and record a
 * "failure" reason that is really a "no input / not applicable / skipped"
 * condition — most notably `missing_item_request` (an item-matching crawler
 * run with no item specified, which simply returns []). Counting these as
 * errors drove the whole System Status to red even though the DB + schema were
 * green. We re-classify them here so genuine failures still surface and still
 * count, while benign skips are reported separately (benign:true) and never
 * drive a red status.
 *
 * Matching is case-insensitive substring on the error/reason text. Keep this
 * list to truly benign "no input / nothing to do" reasons only — anything that
 * indicates a broken adapter, bad key, timeout, or crash must NOT be added.
 */
export const BENIGN_CRAWLER_ERROR_CODES = Object.freeze([
  'missing_item_request',
  'no_item_request',
  'no item request',
  'no item specified',
  'missing_profile',
  'profile_deleted',
  'profile_unhydrated',
  'no_input',
  'no input',
  'nothing to crawl',
  'no_targets',
  'no targets',
  'skipped',
  'noop',
  'not_applicable',
  'no_profile_address',
])

/**
 * True when a crawler job/log error message is one of the known-benign
 * "no input / skipped / not applicable" outcomes rather than a real failure.
 */
export function isBenignCrawlerError(message) {
  if (!message) return false
  const text = String(message).toLowerCase()
  return BENIGN_CRAWLER_ERROR_CODES.some((code) => text.includes(code))
}

/**
 * Get recent errors from crawler jobs and crawl logs
 *
 * Each returned entry carries a `benign` boolean: benign:true marks an
 * EXPECTED no-input/skipped outcome (see isBenignCrawlerError) that must not
 * drive System Status to red. Genuine failures are benign:false.
 * @param {Object} db - Database connection
 * @returns {Array} Recent errors
 */
async function getRecentErrors(db) {
  if (!db) {
    return [];
  }

  const errors = [];
  
  try {
    const since7dPredicate =
      db?.dialect === 'postgres'
        ? `created_at >= (NOW() - INTERVAL '7 days')`
        : `created_at >= datetime('now', '-7 days')`

    // Compute most recent success per type (used to hide stale failures that have already recovered).
    const lastSuccessRows = await db.prepare(`
      SELECT type, MAX(created_at) AS last_success_at
      FROM crawler_jobs
      WHERE status = 'completed'
        AND ${since7dPredicate}
      GROUP BY type
    `).all()

    const lastSuccessByType = new Map()
    ;(lastSuccessRows || []).forEach((row) => {
      if (!row?.type || !row?.last_success_at) return
      lastSuccessByType.set(String(row.type), new Date(row.last_success_at).getTime())
    })

    // Get failed crawler jobs from last 7 days
    const failedJobs = await db.prepare(`
      SELECT id, type, status, profile_id, organization_id, error, created_at
      FROM crawler_jobs
      WHERE status = 'failed'
        AND ${since7dPredicate}
      ORDER BY created_at DESC
      LIMIT 10
    `).all();
    
    failedJobs.forEach(job => {
      const type = String(job.type || '')
      const createdAtMs = job.created_at ? new Date(job.created_at).getTime() : null
      const lastSuccessMs = lastSuccessByType.get(type) ?? null

      // If the crawler type has succeeded after this failure, treat it as "stale" and omit it from the headline list.
      if (createdAtMs && lastSuccessMs && createdAtMs < lastSuccessMs) {
        return
      }

      errors.push({
        scope: 'crawler_job',
        job_id: job.id ?? null,
        crawler_type: job.type,
        status: job.status ?? 'failed',
        profile_id: job.profile_id ?? null,
        organization_id: job.organization_id ?? null,
        message: job.error || 'Unknown error',
        benign: isBenignCrawlerError(job.error),
        time: job.created_at,
      });
    });
    
    // Get error crawl logs from last 7 days
    const errorLogs = await db.prepare(`
      SELECT id, source, status, error_message, created_at
      FROM crawl_logs
      WHERE status = 'error'
        AND ${since7dPredicate}
      ORDER BY created_at DESC
      LIMIT 10
    `).all();
    
    errorLogs.forEach(log => {
      errors.push({
        scope: 'crawl_log',
        log_id: log.id ?? null,
        source: log.source,
        status: log.status ?? 'error',
        message: log.error_message || 'Unknown error',
        benign: isBenignCrawlerError(log.error_message),
        time: log.created_at,
      });
    });
  } catch (error) {
    errors.push({
      scope: 'diagnostics',
      message: `Failed to retrieve errors: ${error.message}`,
      time: new Date().toISOString(),
    });
  }
  
  // Sort by time descending and limit to 20 most recent
  return errors
    .sort((a, b) => new Date(b.time) - new Date(a.time))
    .slice(0, 20);
}

/**
 * Analyze diagnostics and determine system health
 * @param {Object} diagnostics - Diagnostics data
 * @returns {Object} Health analysis
 */
export function analyzeSystemHealth(diagnostics) {
  const issues = [];
  const warnings = [];
  
  // Check database
  if (!diagnostics.db.ok) {
    issues.push('Database connection failed');
  } else {
    // Check for empty tables
    if (diagnostics.db.tables.funding_opportunities === 0) {
      warnings.push('No funding opportunities in database');
    }
    
    // Check schema
    if (diagnostics.db.schema_checks.error) {
      issues.push(
        `Database schema check failed: ${diagnostics.db.schema_checks.message || diagnostics.db.schema_checks.error}`
      );
    } else {
      const missing = diagnostics.db.schema_checks?.details?.missing_columns;
      if (Array.isArray(missing) && missing.length > 0) {
        warnings.push(`funding_opportunities missing columns: ${missing.join(', ')}`);
      } else if (!Array.isArray(missing)) {
        warnings.push('Schema check did not return column details — audit incomplete');
      }
    }
  }
  
  // Check environment
  if (!diagnostics.env_flags.ANTHROPIC_API_KEY_present && !diagnostics.env_flags.OPENAI_API_KEY_present) {
    warnings.push('No AI API key configured (ANTHROPIC_API_KEY or OPENAI_API_KEY)');
  }
  
  // Check for recent REAL errors only. Benign (expected no-input / skipped)
  // crawler outcomes — e.g. missing_item_request — are excluded so they never
  // drive a degraded status.
  if (Array.isArray(diagnostics.errors) && diagnostics.errors.length > 0) {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentRealErrors = diagnostics.errors.filter((e) => {
      if (e.benign) return false;
      const errorTime = new Date(e.time);
      return errorTime > dayAgo;
    });

    if (recentRealErrors.length > 0) {
      warnings.push(`${recentRealErrors.length} error(s) in the last 24 hours`);
    }
  }
  
  // Check last activity
  if (diagnostics.last_activity.last_crawl_log) {
    const lastCrawl = diagnostics.last_activity.last_crawl_log;
    if (lastCrawl.status === 'error' || lastCrawl.status === 'failed') {
      warnings.push(`Last crawl failed: ${lastCrawl.source}`);
    }
  }
  
  // Determine overall status
  let status = 'healthy';
  if (issues.length > 0) {
    status = 'unhealthy';
  } else if (warnings.length > 0) {
    status = 'degraded';
  }
  
  return {
    status,
    issues,
    warnings,
  };
}

/**
 * Get non-admin safe health summary (no sensitive details)
 * @param {Object} db - Database connection
 * @returns {Object} Safe health summary
 */
export async function getSafeHealthSummary(db) {
  const timestamp = new Date().toISOString();
  
  if (!db) {
    return {
      timestamp,
      status: 'error',
      counts: { opportunities: 0, recentFailures: 0 },
      summary: 'Database connection unavailable'
    };
  }
  
  try {
    // Always do a lightweight connectivity check first (required for postgres stability on Railway).
    try {
      if (typeof db.healthcheck === 'function') {
        await db.healthcheck();
      } else {
        await db.prepare('SELECT 1 as ok').get();
      }
    } catch (e) {
      return {
        timestamp,
        status: 'error',
        counts: { opportunities: 0, recentFailures: 0 },
        summary: 'Database healthcheck failed',
        dialect: db.dialect ?? null,
      };
    }

    // Get basic counts
    const opportunitiesCount = await getTableCount(db, 'funding_opportunities');
    
    // Get recent failures (last 24 hours).
    // IMPORTANT: we want /api/health to reflect whether crawlers are currently failing,
    // not how many historical rows happen to be in "failed" state.
    //
    // Strategy:
    // - Compute the latest job per crawler type within the window.
    // - Count a type as "failing" only if its latest job failed.
    // - Exclude non-critical crawler types (e.g. avatar_lookup is cosmetic).
    let recentFailures = 0;
    let recentFailuresTotal = 0;
    let failingTypes = [];
    try {
      // Total failed rows (informational only).
      const failuresTotalSql =
        db?.dialect === 'postgres'
          ? `
              SELECT COUNT(*) as count
              FROM crawler_jobs
              WHERE status = 'failed'
                AND created_at >= (NOW() - INTERVAL '24 hours')
            `
          : `
              SELECT COUNT(*) as count
              FROM crawler_jobs
              WHERE status = 'failed'
                AND created_at >= datetime('now', '-24 hours')
            `;

      const failuresTotal = await db.prepare(failuresTotalSql).get();
      recentFailuresTotal = Number(failuresTotal?.count || 0);

      // Latest job per type within window.
      const latestByTypeSql =
        db?.dialect === 'postgres'
          ? `
              SELECT DISTINCT ON (type)
                type,
                status,
                error,
                created_at
              FROM crawler_jobs
              WHERE created_at >= (NOW() - INTERVAL '24 hours')
              ORDER BY type, created_at DESC
            `
          : `
              SELECT cj.type, cj.status, cj.error, cj.created_at
              FROM crawler_jobs cj
              JOIN (
                SELECT type, MAX(created_at) AS max_created_at
                FROM crawler_jobs
                WHERE created_at >= datetime('now', '-24 hours')
                GROUP BY type
              ) latest
              ON latest.type = cj.type AND latest.max_created_at = cj.created_at
            `;

      const latestRows = await db.prepare(latestByTypeSql).all();
      const nonCriticalTypes = new Set(['avatar_lookup']);

      failingTypes = (latestRows || [])
        .filter((row) => row?.status === 'failed')
        .map((row) => String(row?.type || '').trim())
        .filter((type) => type && !nonCriticalTypes.has(type));

      recentFailures = failingTypes.length;
    } catch (e) {
      // Ignore if crawler_jobs doesn't exist
    }
    
    // Determine status
    //
    // Contract:
    // - Public `/api/health` must return status in { ok, warning, error }
    // - "warning" is still 200 and considered healthy for platform checks
    // - "error" is 500
    let status = 'ok';
    let summary = 'System is operating normally';
    
    if (opportunitiesCount === 0 && recentFailures > 0) {
      status = 'warning';
      summary = `${recentFailures} crawler failure(s) in last 24h; no opportunities ingested`;
    } else if (opportunitiesCount === 0) {
      status = 'warning';
      summary = 'No funding opportunities in database yet';
    } else if (recentFailures > 0) {
      status = 'warning';
      summary = `${recentFailures} crawler failure(s) in last 24h`;
    }
    
    return {
      timestamp,
      status,
      legacy_status: status === 'ok' ? 'healthy' : status === 'warning' ? 'degraded' : 'unhealthy',
      counts: {
        opportunities: opportunitiesCount,
        recentFailures,
        recentFailuresTotal,
      },
      summary,
      failingTypes,
      dialect: db.dialect ?? null,
    };
  } catch (error) {
    return {
      timestamp,
      status: 'error',
      counts: { opportunities: 0, recentFailures: 0 },
      summary: 'Failed to retrieve health information',
      dialect: db?.dialect ?? null,
    };
  }
}
