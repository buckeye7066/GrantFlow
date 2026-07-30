import fs from 'node:fs'

const file = 'backend/routes/linkBacklogRepair.js'
let source = fs.readFileSync(file, 'utf8')
const signature = 'link_backlog_shared_scheduler_lock'
if (source.includes(signature)) {
  console.log('[source-materialization] link backlog route lock already present')
} else {
  function replaceOnce(pattern, replacement, label) {
    const matches = source.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)) || []
    if (matches.length !== 1) throw new Error(`${label}: expected one match, found ${matches.length}`)
    source = source.replace(pattern, replacement)
  }
  replaceOnce(
    /import \{ createLogger \} from '\.\.\/utils\/logger\.js'/,
    `import { createLogger } from '../utils/logger.js'
import { runWithSchedulerLock } from '../services/schedulerLock.js'`,
    'Shared lock import',
  )
  replaceOnce(
    /    const result = await repairBrokenDirectBatch\(req\.db, \{\n      limit: req\.body\?\.limit,\n      concurrency: req\.body\?\.concurrency,\n      timeoutMs: req\.body\?\.timeout_ms,\n      cycleId,\n      verifiedBy: cycleId\n        \? `admin-link-repair:\$\{cycleId\}`\n        : `admin-link-repair:\$\{actor\}`,\n    \}\)\n    res\.set\('Cache-Control', 'no-store'\)\n    return res\.json\(result\)/,
    `    // link_backlog_shared_scheduler_lock: admin and recurring passes share
    // one lease, preventing duplicate probes and last-writer races.
    const result = await runWithSchedulerLock(req.db, {
      lockName: 'link-verification',
      ttlMs: 30 * 60 * 1000,
      logger: log,
      acquiredBy: cycleId ? \`admin-link-repair:\${cycleId}\` : \`admin-link-repair:\${actor}\`,
    }, () => repairBrokenDirectBatch(req.db, {
      limit: req.body?.limit,
      concurrency: req.body?.concurrency,
      timeoutMs: req.body?.timeout_ms,
      pendingRetryAfterMs: req.body?.pending_retry_after_ms,
      cycleId,
      verifiedBy: cycleId
        ? \`admin-link-repair:\${cycleId}\`
        : \`admin-link-repair:\${actor}\`,
    }))
    res.set('Cache-Control', 'no-store')
    if (result?.skipped) {
      return res.status(409).json({
        ok: false,
        error: 'LINK_REPAIR_ALREADY_RUNNING',
        reason: result.reason,
        lock_name: result.lockName,
      })
    }
    return res.json(result)`,
    'Admin route shared lock',
  )
  fs.writeFileSync(file, source)
  console.log('[source-materialization] link backlog admin route shares verifier lock')
}
