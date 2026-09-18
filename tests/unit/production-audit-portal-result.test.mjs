import fs from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import * as audit from '../../scripts/production-audit/app-audit.mjs'
const scope = { requested: true, profileIds: ['synthetic-profile'], hosts: ['portal.invalid'] }
const complete = { profile_id: 'synthetic-profile', portal_host: 'portal.invalid', http_status: 200, body_ok: true, needs_session: false, outcome: 'read_completed' }
test('requested portal acceptance cannot pass a 401, false body success, missing session, or absent result', () => {
  assert.equal(typeof audit.assessPortalReads, 'function', 'portal outcomes must participate in the release gate')
  for (const result of [
    { ...complete, http_status: 401, body_ok: false, outcome: 'refused_or_failed' },
    { ...complete, body_ok: false },
    { ...complete, needs_session: true, outcome: 'needs_session' },
    { ...complete, profile_id: 'different-profile' },
  ]) assert.equal(audit.assessPortalReads([result], scope).ok, false)
  assert.equal(audit.assessPortalReads([], scope).ok, false)
  assert.equal(audit.assessPortalReads([complete, complete], scope).ok, false)
  assert.equal(audit.assessPortalReads([complete], scope).ok, true)
  assert.equal(audit.assessPortalReads([], { requested: false }).ok, true)
})

test('the live audit wires portal results into its failure exit after preserving evidence', () => {
  const source = fs.readFileSync('scripts/production-audit/app-audit.mjs', 'utf8')
  assert.match(source, /const \{ page, capturePage \} = await createAuditPages\(context\)/)
  assert.match(source, /apiPostRead\('\/api\/hamilton\/portal-sync\/read'/)
  assert.match(source, /assessment: portalReadAssessment/)
  assert.match(source, /if \(!portalReadAssessment.ok\) \{[\s\S]*?process.exit\(1\)/)
})
