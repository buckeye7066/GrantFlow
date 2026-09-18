import fs from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import * as audit from '../../scripts/production-audit/app-audit.mjs'
const scope = { requested: true, profileIds: ['synthetic-profile'], hosts: ['portal.invalid'] }
const complete = { profile_id: 'synthetic-profile', portal_host: 'portal.invalid', http_status: 200, body_ok: true, needs_session: false, read_access: 'authenticated', outcome: 'read_completed' }
test('requested portal acceptance cannot pass a 401, false body success, missing session, or absent result', () => {
  assert.equal(typeof audit.assessPortalReads, 'function', 'portal outcomes must participate in the release gate')
  for (const result of [
    { ...complete, http_status: 401, body_ok: false, outcome: 'refused_or_failed' },
    { ...complete, body_ok: false },
    { ...complete, hit_login_wall: true },
    ...['signin_wall', 'blocked', 'unknown', null].map(read_access => ({ ...complete, read_access })),
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

test('HTTP 200 with a sign-in wall is retained as a failed portal authentication', () => {
  assert.equal(typeof audit.summarizePortalRead, 'function')
  const wall = audit.summarizePortalRead({ status: 200, body: { ok: true, hit_login_wall: true, read: { access: 'signin_wall' } } })
  assert.equal(wall.body_ok, true)
  assert.equal(wall.hit_login_wall, true)
  assert.equal(wall.needs_session, true)
  assert.equal(wall.outcome, 'needs_session')
  const unknown = audit.summarizePortalRead({ status: 200, body: { ok: true, read: { access: null } } })
  assert.equal(unknown.outcome, 'access_unproven')
  assert.equal(audit.summarizePortalRead({ status: 401, body: { ok: true, read: { access: 'authenticated' } } }).outcome, 'refused_or_failed')
  assert.equal(audit.summarizePortalRead({ status: 200, body: { ok: true, read: { access: 'authenticated', fields_found: 0 } } }).outcome, 'read_completed')
})
test('audit report distinguishes a read-only database role from an internal portal pull', () => {
  const source = fs.readFileSync('scripts/production-audit/validate-artifact.mjs', 'utf8')
  assert.doesNotMatch(source, /No production row was created, changed, or deleted/)
  assert.match(source, /portal pulls can update internal/)
})

test('portal network policy binds exact origin, profile, host, and a valid request body', () => {
  const origin = 'https://audit.example.invalid'
  const url = origin + '/api/hamilton/portal-sync/read'
  const opts = { auditOrigin: origin, allowPortalRead: true, allowedPortalHosts: ['portal.invalid'],
    allowedProfileIds: ['synthetic-profile'], requestBody: { profileId: 'synthetic-profile', portalHost: 'portal.invalid' } }
  assert.equal(audit.classify('POST', url, opts).allow, true)
  assert.equal(audit.classify('POST', 'https://other.invalid/api/hamilton/portal-sync/read', opts).allow, false)
  for (const requestBody of [null, {}, [], 'bad-json', { profileId: 'other', portalHost: 'portal.invalid' },
    { profileId: 'synthetic-profile', portalHost: 'unrequested.invalid' },
    { profileId: 'synthetic-profile', portalHost: 'portal.invalid', direction: 'write' }]) {
    assert.equal(audit.classify('POST', url, { ...opts, requestBody }).allow, false)
  }
  assert.equal(audit.classify('POST', url, { ...opts, auditOrigin: null }).allow, false)
  assert.equal(audit.classify('POST', origin + '/mutate?next=/api/auth/password/login', opts).allow, false)
  assert.equal(audit.classify('POST', 'https://other.invalid/api/auth/password/login', opts).allow, false)
  assert.equal(audit.classify('POST', origin + '/api/auth/password/login', opts).allow, true)
})

test('audit scope is normalized once so duplicate portal inputs cannot trigger duplicate pulls', () => {
  assert.equal(typeof audit.parseArgs, 'function')
  const args = audit.parseArgs(['--profiles', 'p1,p1, p2', '--portal-hosts', 'Tennessee.edu,tennessee.edu, portal.invalid', '--portal-reads'])
  assert.deepEqual(args.profiles, ['p1', 'p2'])
  assert.deepEqual(args.portalHosts, ['tennessee.edu', 'portal.invalid'])
})
