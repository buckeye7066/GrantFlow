import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
    errors: await getRecentErrors(db),
  };
  
  return diagnostics;
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
 
    // For Postgres, `DB_PATH` is irrelevant; the "path" field is only meaningful for SQLite.
    const dialect = db?.dialect || 'unknown'
    const dbPath = dialect === 'sqlite' ? (process.env.DB_PATH || 'data/grantflow.db') : null;
    
    // Check if database is writable by attempting a simple query (SQLite only).
    let writable = dialect === 'sqlite';
    if (dialect === 'sqlite') {
      try {
        await db.prepare('SELECT COUNT(*) FROM sqlite_master').get();
        // writable already set to true above
      } catch (error) {
        writable = false;
      }
    } else {
      writable = null
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
    
    const result = await db.prepare(`SELECT COUNT(*) as count FROM \`${tableName}\``).get();
    return Number(result?.count || 0);
  } catch (error) {
    return 0;
  }
}

/**
 * Check funding_opportunities table schema for required columns
 * @param {Object} db - Database connection
 * @returns {Object} Schema check results
 */
async function checkFundingOpportunitiesSchema(db) {
  if (db?.dialect === 'postgres') {
    try {
      const targetColumns = ['type', 'evidence_url', 'last_verified_at', 'title', 'sponsor', 'deadline']

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

      const columnNames = new Set((rows || []).map((r) => String(r.column_name)))

      const crawlLogsExistsRow = await db
        .prepare(`SELECT to_regclass(current_schema() || '.crawl_logs') AS regclass`)
        .get()
      const crawlLogsExists = Boolean(crawlLogsExistsRow?.regclass)

      return {
        funding_opportunities_has_type: columnNames.has('type'),
        funding_opportunities_has_evidence_url: columnNames.has('evidence_url'),
        funding_opportunities_has_last_verified_at: columnNames.has('last_verified_at'),
        funding_opportunities_has_title: columnNames.has('title'),
        funding_opportunities_has_sponsor: columnNames.has('sponsor'),
        funding_opportunities_has_deadline: columnNames.has('deadline'),
        crawl_logs_exists: crawlLogsExists,
        details: {
          dialect: 'postgres',
          missing_columns: targetColumns.filter((col) => !columnNames.has(col)),
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
    
    return {
      funding_opportunities_has_type: columnNames.includes('type'),
      funding_opportunities_has_evidence_url: columnNames.includes('evidence_url'),
      funding_opportunities_has_last_verified_at: columnNames.includes('last_verified_at'),
      funding_opportunities_has_title: columnNames.includes('title'),
      funding_opportunities_has_sponsor: columnNames.includes('sponsor'),
      funding_opportunities_has_deadline: columnNames.includes('deadline'),
      crawl_logs_exists: crawlLogsExists,
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
 * Get recent errors from crawler jobs and crawl logs
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
      issues.push('Database schema check failed');
    }
  }
  
  // Check environment
  if (!diagnostics.env_flags.ANTHROPIC_API_KEY_present && !diagnostics.env_flags.OPENAI_API_KEY_present) {
    warnings.push('No AI API key configured (ANTHROPIC_API_KEY or OPENAI_API_KEY)');
  }
  
  // Check for recent errors
  if (diagnostics.errors.length > 0) {
    const recentErrors = diagnostics.errors.filter(e => {
      const errorTime = new Date(e.time);
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      return errorTime > dayAgo;
    });
    
    if (recentErrors.length > 0) {
      warnings.push(`${recentErrors.length} error(s) in the last 24 hours`);
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
