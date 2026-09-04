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
  assert.match(serverSource, /app\.use\('\/api\/application-tasks', requireApplicationTaskPipelineAutomation,/)
  for (const mount of ['/api/hamilton/automation', '/api/yana/automation']) {
    const escaped = mount.replace(/\//g, '\\/')
    assert.match(serverSource, new RegExp(`app\\.use\\('${escaped}', requireHamiltonPipelineAutomation,`))
  }
  assert.match(serverSource, /path === '\/sms-inbox' \|\| path === '\/inbox' \|\| path === '\/inbox-status'/)
  assert.match(serverSource, /req\.body\?\.enable === false/)
  assert.match(serverSource, /\^\\\/authorizations\\\/\[\^\/\]\+\\\/revoke\$/)
  assert.match(serverSource, /\^\\\/tasks\\\/\[\^\/\]\+\\\/cancel\$/)
})

test('Hamilton engine entry point enforces the pipeline entitlement', () => {
  const source = fs.readFileSync(
    new URL('../../backend/services/hamilton/hamiltonAutomationOrchestrator.js', import.meta.url),
    'utf8',
  )
  assert.match(source, /async function assertPipelineAutomationEntitlement/)
  assert.match(source, /await assertPipelineAutomationEntitlement\(db, resolvedProfileId, userId\)/)
  assert.match(source, /CAPABILITY_KEYS\.PIPELINE_AUTOMATION/)
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
