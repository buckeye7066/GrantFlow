import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const serverSource = fs.readFileSync(new URL('../../backend/server.js', import.meta.url), 'utf8')

test('every Hamilton API family is mounted behind the canonical pipeline entitlement', () => {
  assert.match(serverSource, /const requirePipelineAutomation = enforceTierCapability\(TIER_CAPABILITIES\.PIPELINE_AUTOMATION\)/)
  for (const mount of [
    '/api/hamilton/portal-sync',
    '/api/hamilton/tailored',
  ]) {
    const escaped = mount.replace(/\//g, '\\/')
    assert.match(serverSource, new RegExp(`app\\.use\\('${escaped}', requirePipelineAutomation,`))
  }
  // Safety actions (disable auto-submit, cancel) stay reachable after paid
  // access lapses; the shared-secret inbox bridges and revoke/cancel are
  // exempted at the Hamilton/Yana mounts. Everything else meets the gate.
  assert.match(serverSource, /app\.use\('\/api\/application-tasks', requireApplicationTaskPipelineAutomation,/)
  for (const mount of ['/api/hamilton/automation', '/api/yana/automation']) {
    const escaped = mount.replace(/\//g, '\\/')
    assert.match(serverSource, new RegExp(`app\\.use\\('${escaped}', requireHamiltonPipelineAutomation,`))
  }
  assert.match(serverSource, /bypassEntitlementWhen\(\s*isApplicationTaskEntitlementSafetyAction,\s*requirePipelineAutomation,/)
  assert.match(serverSource, /isHamiltonSharedSecretRoute\(req\) \|\| isHamiltonEntitlementSafetyAction\(req\)/)

  const middlewareSource = fs.readFileSync(
    new URL('../../backend/middleware/entitlements.js', import.meta.url),
    'utf8',
  )
  assert.match(middlewareSource, /new Set\(\['\/sms-inbox', '\/inbox', '\/inbox-status'\]\)/)
  assert.match(middlewareSource, /\^\\\/authorizations\\\/\[\^\/\]\+\\\/revoke\$/)
  assert.match(middlewareSource, /\^\\\/tasks\\\/\[\^\/\]\+\\\/cancel\$/)
  assert.match(middlewareSource, /req\?\.body\?\.enable === false/)
})

test('tier enforcement resolves task and grant identities instead of treating them as profile ids', () => {
  const middlewareSource = fs.readFileSync(
    new URL('../../backend/middleware/entitlements.js', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(middlewareSource, /params\?\.id/)
  assert.match(middlewareSource, /FROM application_tasks WHERE id = \? LIMIT 1/)
  assert.match(middlewareSource, /FROM grants WHERE id = \? LIMIT 1/)
  assert.match(middlewareSource, /await resolveEntitlementProfileId\(req\)/)
})
