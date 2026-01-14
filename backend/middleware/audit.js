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
          req.db.prepare(`
            INSERT INTO crawler_jobs (id, type, status, parameters, requested_by, result_meta)
            VALUES (?, 'audit_log', 'completed', ?, ?, ?)
          `).run(
            logEntry.id, 
            JSON.stringify({ path: logEntry.path, method: logEntry.method }),
            logEntry.user_id,
            JSON.stringify(logEntry)
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
    if (sensitiveKeys.some(sk => key.toLowerCase().includes(sensitiveKeys))) {
      redacted[key] = '[REDACTED]';
    } else if (typeof value === 'object') {
      redacted[key] = redactSensitiveData(value);
    } else {
      redacted[key] = value;
    }
  }
  
  return redacted;
}
