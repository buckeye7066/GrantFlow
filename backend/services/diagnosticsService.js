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
export function getSystemDiagnostics(db) {
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
    db: getDatabaseDiagnostics(db),
    env_flags: getEnvironmentFlags(),
    last_activity: getLastActivity(db),
    errors: getRecentErrors(db),
  };
  
  return diagnostics;
}

/**
 * Get database diagnostics including table counts and schema checks
 * @param {Object} db - Database connection
 * @returns {Object} Database diagnostics
 */
function getDatabaseDiagnostics(db) {
  if (!db) {
    return {
      ok: false,
      error: 'Database connection unavailable',
    };
  }
  
  try {
    // Test database connectivity
    db.prepare('SELECT 1').get();
    
    // Get database file path
    const dbPath = process.env.DB_PATH || 'data/grantflow.db';
    
    // Check if database is writable by attempting a simple query
    let writable = true;
    try {
      db.prepare('SELECT COUNT(*) FROM sqlite_master').get();
    } catch (error) {
      writable = false;
    }
    
    // Get table counts
    const tables = {
      funding_opportunities: getTableCount(db, 'funding_opportunities'),
      crawl_logs: getTableCount(db, 'crawl_logs'),
      grants: getTableCount(db, 'grants'),
      profiles: getTableCount(db, 'profiles'),
      users: getTableCount(db, 'users'),
      organizations: getTableCount(db, 'organizations'),
      crawler_jobs: getTableCount(db, 'crawler_jobs'),
    };
    
    // Schema checks for funding_opportunities table
    const schema_checks = checkFundingOpportunitiesSchema(db);
    
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
function getTableCount(db, tableName) {
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
    
    const result = db.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get();
    return result?.count || 0;
  } catch (error) {
    return 0;
  }
}

/**
 * Check funding_opportunities table schema for required columns
 * @param {Object} db - Database connection
 * @returns {Object} Schema check results
 */
function checkFundingOpportunitiesSchema(db) {
  try {
    const tableInfo = db.prepare('PRAGMA table_info(funding_opportunities)').all();
    const columnNames = tableInfo.map(col => col.name);
    
    // Also check if crawl_logs table exists
    let crawlLogsExists = false;
    try {
      db.prepare('SELECT 1 FROM crawl_logs LIMIT 1').get();
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
    SAM_GOV_API_KEY_present: Boolean(process.env.SAM_GOV_API_KEY) || 'optional',
    OPENAI_API_KEY_present: Boolean(process.env.OPENAI_API_KEY),
    ANTHROPIC_API_KEY_present: Boolean(process.env.ANTHROPIC_API_KEY),
    ANYA_ADMIN_TOKEN_present: Boolean(process.env.ANYA_ADMIN_TOKEN) || 'optional',
    NODE_ENV: process.env.NODE_ENV || 'development',
    DB_PATH_set: Boolean(process.env.DB_PATH),
  };
}

/**
 * Get last activity from crawl logs and ingestion
 * @param {Object} db - Database connection
 * @returns {Object} Last activity data
 */
function getLastActivity(db) {
  if (!db) {
    return {
      last_crawl_log: null,
      last_ingestion: null,
    };
  }
  
  try {
    // Get last crawl log
    const lastCrawlLog = db.prepare(`
      SELECT source, status, created_at, records_found, records_imported
      FROM crawl_logs
      ORDER BY created_at DESC
      LIMIT 1
    `).get();
    
    // Get last crawler job
    const lastCrawlerJob = db.prepare(`
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
function getRecentErrors(db) {
  if (!db) {
    return [];
  }
  
  const errors = [];
  
  try {
    // Get failed crawler jobs from last 7 days
    const failedJobs = db.prepare(`
      SELECT id, type, status, profile_id, organization_id, error, created_at
      FROM crawler_jobs
      WHERE status = 'failed'
        AND created_at >= datetime('now', '-7 days')
      ORDER BY created_at DESC
      LIMIT 10
    `).all();
    
    failedJobs.forEach(job => {
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
    const errorLogs = db.prepare(`
      SELECT id, source, status, error_message, created_at
      FROM crawl_logs
      WHERE status = 'error'
        AND created_at >= datetime('now', '-7 days')
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
export function getSafeHealthSummary(db) {
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
    // Get basic counts
    const opportunitiesCount = getTableCount(db, 'funding_opportunities');
    
    // Get recent failures count (last 24 hours)
    let recentFailures = 0;
    try {
      const failures = db.prepare(`
        SELECT COUNT(*) as count
        FROM crawler_jobs
        WHERE status = 'failed'
          AND created_at >= datetime('now', '-24 hours')
      `).get();
      recentFailures = failures?.count || 0;
    } catch (e) {
      // Ignore if crawler_jobs doesn't exist
    }
    
    // Determine status
    let status = 'healthy';
    let summary = 'System is operating normally';
    
    if (opportunitiesCount === 0 && recentFailures > 0) {
      status = 'degraded';
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
      counts: {
        opportunities: opportunitiesCount,
        recentFailures,
      },
      summary,
    };
  } catch (error) {
    return {
      timestamp,
      status: 'error',
      counts: { opportunities: 0, recentFailures: 0 },
      summary: 'Failed to retrieve health information'
    };
  }
}
