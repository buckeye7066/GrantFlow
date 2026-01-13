/**
 * Audit Service
 * 
 * Comprehensive audit logging for production-grade operations.
 * Logs are stored in the database for queryability and retention.
 */

import { randomUUID } from 'crypto'

// Audit event categories
export const AUDIT_CATEGORIES = {
  AUTH: 'auth',
  PROFILE: 'profile',
  GRANT: 'grant',
  CRAWLER: 'crawler',
  ADMIN: 'admin',
  SYSTEM: 'system',
  ANYA: 'anya',
}

// Audit severity levels
export const SEVERITY = {
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  CRITICAL: 'critical',
}

/**
 * Log an audit event to the database
 */
export function logAuditEvent(db, {
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
    // Ensure audit_logs table exists
    ensureAuditTable(db)
    
    const id = randomUUID()
    const detailsJson = details ? JSON.stringify(scrubSensitive(details)) : null
    
    const stmt = db.prepare(`
      INSERT INTO audit_logs (
        id, category, action, severity, user_id, profile_id,
        resource_type, resource_id, details, ip_address, user_agent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    
    stmt.run(
      id,
      category,
      action,
      severity,
      userId,
      profileId,
      resourceType,
      resourceId,
      detailsJson,
      ipAddress,
      userAgent
    )
    
    // Log critical events to console as well
    if (severity === SEVERITY.CRITICAL || severity === SEVERITY.ERROR) {
      console.error(`[Audit][${severity.toUpperCase()}] ${category}:${action}`, {
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

/**
 * Query audit logs
 */
export function queryAuditLogs(db, {
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
    const total = db.prepare(countQuery).get(...params)?.count || 0
    
    // Get paginated results
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
    const logs = db.prepare(query).all(...params, limit, offset)
    
    return {
      logs: logs.map(log => ({
        ...log,
        details: log.details ? JSON.parse(log.details) : null,
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
export function getAuditSummary(db, { days = 7 } = {}) {
  if (!db) return null
  
  try {
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    
    // Events by category
    const byCategory = db.prepare(`
      SELECT category, COUNT(*) as count
      FROM audit_logs
      WHERE created_at >= ?
      GROUP BY category
      ORDER BY count DESC
    `).all(startDate)
    
    // Events by severity
    const bySeverity = db.prepare(`
      SELECT severity, COUNT(*) as count
      FROM audit_logs
      WHERE created_at >= ?
      GROUP BY severity
    `).all(startDate)
    
    // Recent critical events
    const criticalEvents = db.prepare(`
      SELECT *
      FROM audit_logs
      WHERE severity IN ('error', 'critical')
        AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT 20
    `).all(startDate)
    
    // Top users by activity
    const topUsers = db.prepare(`
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
      criticalEvents: criticalEvents.map(e => ({
        ...e,
        details: e.details ? JSON.parse(e.details) : null,
      })),
      topUsers,
    }
  } catch (error) {
    console.error('[Audit] Failed to get summary:', error.message)
    return null
  }
}

/**
 * Ensure audit_logs table exists
 */
function ensureAuditTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
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
    );
    
    CREATE INDEX IF NOT EXISTS idx_audit_category ON audit_logs(category);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
    CREATE INDEX IF NOT EXISTS idx_audit_severity ON audit_logs(severity);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
  `)
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
      
      logAuditEvent(req.db, {
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
      })
      
      originalEnd.apply(res, args)
    }
    
    next()
  }
}

/**
 * Cleanup old audit logs (retention policy)
 */
export function cleanupAuditLogs(db, { retentionDays = 90 } = {}) {
  if (!db) return { deleted: 0 }
  
  try {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString()
    
    const result = db.prepare(`
      DELETE FROM audit_logs
      WHERE created_at < ?
        AND severity NOT IN ('error', 'critical')
    `).run(cutoff)
    
    console.log(`[Audit] Cleaned up ${result.changes} old audit logs`)
    
    return { deleted: result.changes }
  } catch (error) {
    console.error('[Audit] Failed to cleanup logs:', error.message)
    return { deleted: 0 }
  }
}
