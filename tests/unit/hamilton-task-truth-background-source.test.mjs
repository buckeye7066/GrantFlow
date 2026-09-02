import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const serverSource = fs.readFileSync(
  new URL('../../backend/server.js', import.meta.url),
  'utf8',
)
const reconciliationSource = fs.readFileSync(
  new URL('../../backend/services/pipelineStrictReconciliation.js', import.meta.url),
  'utf8',
)

test('recurring link verification refreshes the already-readable Hamilton truth snapshot', () => {
  const linkRepair = serverSource.indexOf("console.log('[link-repair] recurring lifecycle pass:'")
  const refresh = serverSource.indexOf('refreshHamiltonTaskTruthAfterLinkVerification(dbInstance', linkRepair)
  assert.ok(linkRepair > 0 && refresh > linkRepair)
  assert.match(serverSource, /actor: 'system:recurring-link-verification'/)
  assert.match(reconciliationSource, /if \(!prior\.available \|\| !prior\.queueReadable \|\| !prior\.cleanup\)/)
  assert.match(reconciliationSource, /status: deferred > 0 \? 'pending_reverification' : 'verified'/)
  assert.match(reconciliationSource, /persistHamiltonTaskTruthSnapshot\(db, summary\)/)
})
