import path from 'path'
import { promises as fs } from 'fs'
import { scrubPII } from '../../utils/piiScrubber.js'
import { AUDIT_CATEGORIES, SEVERITY, logAuditEvent } from '../auditService.js'
import { createLogger } from '../../utils/logger.js'
const log = createLogger('audit')

const REPO_ROOT = path.resolve(process.cwd())

function isProdEnv() {
  const nodeEnv = String(process.env.NODE_ENV || '').toLowerCase()
  const deployEnv = String(process.env.DEPLOY_ENV || '').toLowerCase()
  return nodeEnv === 'production' || deployEnv === 'production'
}

export async function auditLog(entry, { db = null, actorUserId = null, actorRole = 'system' } = {}) {
  const safeEntry = {
    timestamp: new Date().toISOString(),
    actor_role: actorRole,
    ...entry,
  }

  if (db) {
    try {
      logAuditEvent(db, {
        category: AUDIT_CATEGORIES.SYSTEM,
        action: 'national_programs.audit',
        severity: SEVERITY.INFO,
        userId: actorUserId,
        resourceType: 'national_programs',
        resourceId: null,
        details: safeEntry,
      })
      return
    } catch (error) {
      // fall through to platform logs
      console.warn('[nationalPrograms.audit] db write failed:', error?.message || error)
    }
  }

  // Durable fallback: platform logs
  log.info('[audit][national-programs]', scrubPII(JSON.stringify(safeEntry)))

  // Dev-only filesystem sink (explicit opt-in)
  if (!isProdEnv() && String(process.env.ALLOW_DEV_FILESYSTEM_AUDIT_LOGS || '').toLowerCase() === 'true') {
    try {
      const auditDir = path.join(REPO_ROOT, 'backend', 'data', 'audit')
      await fs.mkdir(auditDir, { recursive: true })
      const logFile = path.join(auditDir, 'national-programs-crawler.log')
      await fs.appendFile(logFile, scrubPII(JSON.stringify(safeEntry)) + '\n', 'utf8')
    } catch {
      // best-effort
    }
  }
}

