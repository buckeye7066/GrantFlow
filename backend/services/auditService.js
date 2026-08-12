/**
 * Audit Service
 * 
 * Comprehensive audit logging for production-grade operations.
 * Logs are stored in the database for queryability and retention.
 */

import { randomUUID } from 'crypto'
import { createLogger, sanitizeLogValue } from '../utils/logger.js'
const log = createLogger('auditService')

// Audit event categories
export const AUDIT_CATEGORIES = {
  AUTH: 'auth',
  PROFILE: 'profile',
  GRANT: 'grant',
  CRAWLER: 'crawler',
  ADMIN: 'admin',
  SYSTEM: 'system',
  ANYA: 'anya',
  USER_ACTIVITY: 'user_activity',
}

// Audit severity levels
export const SEVERITY = {
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  CRITICAL: 'critical',
}

function isThenable(value) {
  return Boolean(value && typeof value.then === 'function')
}

function fireAndForget(value) {
  if (!isThenable(value)) return
  value.catch((error) => {
    // Never throw from audit logging; keep it best-effort.
    console.warn('[Audit] async failure:', error?.message || error)
  })
}

/**
 * Log an audit event to the database
 */
export async function logAuditEvent(db, {
  category,
  action,
  severity = SEVERITY.INFO,
  userId = null,
  profileId = null,
  resourceType = null,
  resourceId = null,
  details = null,
  ipAddress = null,
  userAgent = null,
}) {
  if (!db) {
    console.warn('[Audit] No database connection, skipping audit log')
    return null
  }
  
  try {
    // Ensure audit_logs table exists (best-effort).
    // This is intentionally safe to call on every write; both sqlite + postgres use IF NOT EXISTS.
    await ensureAuditTable(db)
    
    const id = randomUUID()
    const scrubbed = details ? scrubSensitive(details) : null
    const detailsPayload =
      db.dialect === 'postgres'
        ? scrubbed // store as JSONB
        : scrubbed
          ? JSON.stringify(scrubbed)
          : null
    
    const stmt = db.prepare(`
      INSERT INTO audit_logs (
        id, category, action, severity, user_id, profile_id,
        resource_type, resource_id, details, ip_address, user_agent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    
    const write = stmt.run(
      id,
      category,
      action,
      severity,
      userId,
      profileId,
      resourceType,
      resourceId,
      detailsPayload,
      ipAddress,
      userAgent
    )
    // Await if the driver returns a Promise (async adapters); otherwise the
    // synchronous RunResult from better-sqlite3 is already committed.
    if (write && typeof write.then === 'function') {
      await write
    }
    
    // Log critical events to console as well
    if (severity === SEVERITY.CRITICAL || severity === SEVERITY.ERROR) {
      // CodeQL js/log-injection (#604): category/action are caller-supplied
      // strings with no whitelist at this shared choke point.
      console.error('[Audit][%s] %s:%s', severity.toUpperCase(), sanitizeLogValue(category), sanitizeLogValue(action), {
        userId,
        resourceType,
        resourceId,
      })
    }
    
    return id
  } catch (error) {
    console.error('[Audit] Failed to log event:', error.message)
    return null
  }
}

function coerceCount(value) {
  if ((value === null || value === undefined)) return 0
  if (typeof value === 'number') return value
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function parseDetailsValue(raw) {
  if ((raw === null || raw === undefined)) return null
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Query audit logs
 */
export async function queryAuditLogs(db, {
  category = null,
  action = null,
  severity = null,
  userId = null,
  resourceType = null,
  resourceId = null,
  startDate = null,
  endDate = null,
  limit = 100,
  offset = 0,
} = {}) {
  if (!db) return { logs: [], total: 0 }
  
  try {
    let query = 'SELECT * FROM audit_logs WHERE 1=1'
    let countQuery = 'SELECT COUNT(*) as count FROM audit_logs WHERE 1=1'
    const params = []
    
    if (category) {
      query += ' AND category = ?'
      countQuery += ' AND category = ?'
      params.push(category)
    }
    
    if (action) {
      query += ' AND action = ?'
      countQuery += ' AND action = ?'
      params.push(action)
    }
    
    if (severity) {
      query += ' AND severity = ?'
      countQuery += ' AND severity = ?'
      params.push(severity)
    }
    
    if (userId) {
      query += ' AND user_id = ?'
      countQuery += ' AND user_id = ?'
      params.push(userId)
    }
    
    if (resourceType) {
      query += ' AND resource_type = ?'
      countQuery += ' AND resource_type = ?'
      params.push(resourceType)
    }
    
    if (resourceId) {
      query += ' AND resource_id = ?'
      countQuery += ' AND resource_id = ?'
      params.push(resourceId)
    }
    
    if (startDate) {
      query += ' AND created_at >= ?'
      countQuery += ' AND created_at >= ?'
      params.push(startDate)
    }
    
    if (endDate) {
      query += ' AND created_at <= ?'
      countQuery += ' AND created_at <= ?'
      params.push(endDate)
    }
    
    // Get total count
    const totalRow = await db.prepare(countQuery).get(...params)
    const total = coerceCount(totalRow?.count)
    
    // Get paginated results
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
    const logs = await db.prepare(query).all(...params, limit, offset)
    
    return {
      logs: (logs || []).map(log => ({
        ...log,
        details: parseDetailsValue(log.details),
      })),
      total,
      limit,
      offset,
    }
  } catch (error) {
    console.error('[Audit] Failed to query logs:', error.message)
    return { logs: [], total: 0 }
  }
}

/**
 * Get audit summary stats
 */
export async function getAuditSummary(db, { days = 7 } = {}) {
  if (!db) return null
  
  try {
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    
    // Events by category
    const byCategory = await db.prepare(`
      SELECT category, COUNT(*) as count
      FROM audit_logs
      WHERE created_at >= ?
      GROUP BY category
      ORDER BY count DESC
    `).all(startDate)
    
    // Events by severity
    const bySeverity = await db.prepare(`
      SELECT severity, COUNT(*) as count
      FROM audit_logs
      WHERE created_at >= ?
      GROUP BY severity
    `).all(startDate)
    
    // Recent critical events
    const criticalEvents = await db.prepare(`
      SELECT *
      FROM audit_logs
      WHERE severity IN ('error', 'critical')
        AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT 20
    `).all(startDate)
    
    // Top users by activity
    const topUsers = await db.prepare(`
      SELECT user_id, COUNT(*) as count
      FROM audit_logs
      WHERE user_id IS NOT NULL
        AND created_at >= ?
      GROUP BY user_id
      ORDER BY count DESC
      LIMIT 10
    `).all(startDate)
    
    return {
      period: `${days} days`,
      startDate,
      byCategory,
      bySeverity,
      criticalEvents: (criticalEvents || []).map(e => ({
        ...e,
        details: parseDetailsValue(e.details),
      })),
      topUsers,
    }
  } catch (error) {
    console.error('[Audit] Failed to get summary:', error.message)
    return null
  }
}

/**
 * Ensure audit_logs table exists.
 *
 * Cached per-db (WeakMap): the DDL is idempotent but was being re-run on EVERY
 * logAuditEvent call — including the high-frequency client page-view write that
 * fires on every navigation. On Postgres that meant 6 catalog-touching DDL
 * statements per request, which under load slowed the write enough to blow the
 * proxy timeout and surface to the client as a 503. Running it once per process
 * (per db handle) removes that hot-path cost. _resetAuditTableCache() is for
 * tests that recreate in-memory databases.
 */
const auditTableReady = new WeakMap()
export function _resetAuditTableCache() {
  // WeakMap has no clear(); callers in tests use fresh db objects anyway. This
  // exists so a test can force a re-ensure on the SAME db handle if needed.
  if (arguments.length && arguments[0]) auditTableReady.delete(arguments[0])
}

async function ensureAuditTable(db) {
  if (!db) return
  if (auditTableReady.get(db)) return
  if (db?.dialect === 'postgres') {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT now(),
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        severity TEXT DEFAULT 'info',
        user_id TEXT,
        profile_id TEXT,
        resource_type TEXT,
        resource_id TEXT,
        details JSONB,
        ip_address TEXT,
        user_agent TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_audit_category ON audit_logs(category);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
      CREATE INDEX IF NOT EXISTS idx_audit_severity ON audit_logs(severity);
      CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
    `)
    auditTableReady.set(db, true)
    return
  }

  // sqlite
  const stmts = [
    `CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        severity TEXT DEFAULT 'info',
        user_id TEXT,
        profile_id TEXT,
        resource_type TEXT,
        resource_id TEXT,
        details TEXT,
        ip_address TEXT,
        user_agent TEXT
      )`,
    `CREATE INDEX IF NOT EXISTS idx_audit_category ON audit_logs(category)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_severity ON audit_logs(severity)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at)`,
  ]
  for (const sql of stmts) {
    await db.exec(sql)
  }
  auditTableReady.set(db, true)
}

/**
 * Scrub sensitive data from audit details
 */
function scrubSensitive(obj) {
  if (!obj || typeof obj !== 'object') return obj
  
  const sensitiveKeys = [
    'password', 'token', 'secret', 'api_key', 'apiKey',
    'ssn', 'social_security', 'credit_card', 'card_number',
    'authorization', 'auth_token', 'refresh_token',
  ]
  
  const scrubbed = Array.isArray(obj) ? [...obj] : { ...obj }
  
  for (const [key, value] of Object.entries(scrubbed)) {
    const lowerKey = key.toLowerCase()
    if (sensitiveKeys.some(sk => lowerKey.includes(sk))) {
      scrubbed[key] = '[REDACTED]'
    } else if (typeof value === 'object' && value !== null) {
      scrubbed[key] = scrubSensitive(value)
    }
  }
  
  return scrubbed
}

/**
 * Helper to create audit middleware for Express routes
 */
export function createAuditMiddleware(category, action) {
  return (req, res, next) => {
    const originalEnd = res.end
    const startTime = Date.now()
    
    res.end = function(...args) {
      const duration = Date.now() - startTime
      const severity = res.statusCode >= 500 ? SEVERITY.ERROR 
        : res.statusCode >= 400 ? SEVERITY.WARNING 
        : SEVERITY.INFO
      
      fireAndForget(logAuditEvent(req.db, {
        category,
        action,
        severity,
        userId: req.user?.userId || req.user?.id,
        profileId: req.user?.profileId,
        resourceType: req.params?.resourceType,
        resourceId: req.params?.id || req.params?.profileId,
        details: {
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          duration,
        },
        ipAddress: req.ip || req.connection?.remoteAddress,
        userAgent: req.get('user-agent'),
      }))
      
      originalEnd.apply(res, args)
    }
    
    next()
  }
}

/**
 * Cleanup old audit logs (retention policy)
 */
export async function cleanupAuditLogs(db, { retentionDays = 90 } = {}) {
  if (!db) return { deleted: 0 }
  
  try {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString()
    
    const result = await db.prepare(`
      DELETE FROM audit_logs
      WHERE created_at < ?
        AND severity NOT IN ('error', 'critical')
    `).run(cutoff)
    
    log.info(`[Audit] Cleaned up ${result.changes} old audit logs`)
    
    return { deleted: result.changes }
  } catch (error) {
    console.error('[Audit] Failed to cleanup logs:', error.message)
    return { deleted: 0 }
  }
}
