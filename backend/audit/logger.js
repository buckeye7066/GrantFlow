import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs/promises'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const LOG_PATH = path.resolve(__dirname, 'document_ingestion.log')

/**
 * Log audit trail for document ingestion changes
 */
export async function logAudit(auditEntry) {
  const timestamp = new Date().toISOString()
  
  const logEntry = {
    timestamp,
    documentId: auditEntry.documentId,
    entity: auditEntry.entity,
    recordId: auditEntry.recordId,
    action: auditEntry.action,
    before: auditEntry.before,
    after: auditEntry.after,
    changes: auditEntry.changes,
  }
  
  const logLine = JSON.stringify(logEntry) + '\n'
  
  try {
    await fs.appendFile(LOG_PATH, logLine, 'utf-8')
  } catch (error) {
    console.error('Failed to write audit log:', error.message)
  }
}

/**
 * Read recent audit logs
 */
export async function getRecentAuditLogs(limit = 100) {
  try {
    const content = await fs.readFile(LOG_PATH, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    const logs = lines.slice(-limit).map(line => JSON.parse(line))
    return logs.reverse()
  } catch (error) {
    if (error.code === 'ENOENT') {
      return []
    }
    throw error
  }
}

export default {
  logAudit,
  getRecentAuditLogs,
}
