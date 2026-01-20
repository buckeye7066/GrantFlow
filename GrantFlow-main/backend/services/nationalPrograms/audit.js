import path from 'path'
import { promises as fs } from 'fs'
import { scrubPII } from '../../utils/piiScrubber.js'

const REPO_ROOT = path.resolve(process.cwd())

export async function auditLog(entry) {
  const auditDir = path.join(REPO_ROOT, 'backend', 'data', 'audit')
  await fs.mkdir(auditDir, { recursive: true })

  const logFile = path.join(auditDir, 'national-programs-crawler.log')
  const safeEntry = {
    timestamp: new Date().toISOString(),
    ...entry,
  }

  // scrub in case caller accidentally includes PII-ish strings
  const line = scrubPII(JSON.stringify(safeEntry)) + '\n'
  await fs.appendFile(logFile, line, 'utf8')
}

