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
  res.end = function (...args) {
    const duration = Date.now() - startTime;

    try {
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
          // One-time DDL + statement cache keyed on the db instance
          try {
            if (!req.db.__auditReady) {
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
              req.db.__auditInsert = req.db.prepare(`
                INSERT INTO audit_logs (id, correlation_id, timestamp, user_id, method, path, status, duration_ms, ip, payload)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `);
              req.db.__auditReady = true;
            }

            // Capture stable references before setImmediate
            const stmtRef = req.db.__auditInsert;
            const entrySnapshot = [
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
            ];

            setImmediate(() => {
              try {
                stmtRef.run(...entrySnapshot);
              } catch (e) {
                console.error('[audit] Failed to persist audit log to DB', {
                  error: e.message,
                  stack: e.stack,
                  correlation_id: correlationId,
                  path: req.path,
                  lost_entry_id: logEntry.id,
                  lost_user_id: logEntry.user_id,
                  lost_method: logEntry.method,
                  lost_status: logEntry.status
                });
              }
            });
          } catch (e) {
            console.error('[audit] Failed to prepare audit log for DB', {
              error: e.message,
              stack: e.stack,
              correlation_id: correlationId,
              path: req.path
            });
          }
        }
      }
    } catch (e) {
      console.error('[audit] Audit logging failed', {
        error: e.message,
        stack: e.stack,
        correlation_id: correlationId,
        path: req.path
      });
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
    } else if (value !== null && typeof value === 'object') {
      redacted[key] = redactSensitiveData(value);
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}
