/**
 * Audit Logging Middleware
 * Records significant actions for compliance and debugging.
 * Redacts PII/PHI.
 */

import { randomUUID } from 'crypto';

export function auditLogger(req, res, next) {
  const correlationId = randomUUID();
  req.correlationId = correlationId;
  
  const startTime = Date.now();
  
  // Intercept completion
  const originalEnd = res.end;
  res.end = function(...args) {
    const duration = Date.now() - startTime;
    
    // Only log significant events (mutations, admin actions, or errors)
    const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    const isAdminAction = req.path.startsWith('/api/admin');
    const isError = res.statusCode >= 400;
    
    if (isMutation || isAdminAction || isError) {
      const logEntry = {
        id: randomUUID(),
        correlation_id: correlationId,
        timestamp: new Date().toISOString(),
        user_id: req.user?.userId || req.user?.id || 'guest',
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: duration,
        ip: req.ip || req.headers['x-forwarded-for'],
        // Redacted payload
        payload: redactSensitiveData(req.body)
      };
      
      // For now, we'll log to console and optionally to a DB table if it exists
      console.log(`[AUDIT] ${JSON.stringify(logEntry)}`);
      
      if (req.db) {
        try {
          // Create audit_logs table if it doesn't exist
          req.db.prepare(`
            CREATE TABLE IF NOT EXISTS audit_logs (
              id TEXT PRIMARY KEY,
              correlation_id TEXT,
              timestamp TEXT,
              user_id TEXT,
              method TEXT,
              path TEXT,
              status INTEGER,
              duration_ms INTEGER,
              ip TEXT,
              payload TEXT
            )
          `).run();
          
          req.db.prepare(`
            INSERT INTO audit_logs (id, correlation_id, timestamp, user_id, method, path, status, duration_ms, ip, payload)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            logEntry.id,
            logEntry.correlation_id,
            logEntry.timestamp,
            logEntry.user_id,
            logEntry.method,
            logEntry.path,
            logEntry.status,
            logEntry.duration_ms,
            logEntry.ip,
            JSON.stringify(logEntry.payload)
          );
        } catch (e) {
          // Fallback if table structure doesn't match or fails
          console.warn('[audit] Failed to persist audit log to DB', e.message);
        }
      }
    }
    
    return originalEnd.apply(this, args);
  };
  
  next();
}

function redactSensitiveData(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  
  const sensitiveKeys = ['password', 'token', 'secret', 'ssn', 'ein', 'uei', 'email', 'phone', 'address'];
  const redacted = Array.isArray(obj) ? [] : {};
  
  for (const [key, value] of Object.entries(obj)) {
    if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
      redacted[key] = '[REDACTED]';
    } else if (typeof value === 'object') {
      redacted[key] = redactSensitiveData(value);
    } else {
      redacted[key] = value;
    }
  }
  
  return redacted;
}
