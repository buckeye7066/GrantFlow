/**
 * Owner order 2026-09-05: a registered institution scholarship portal with no
 * way in must park as a LOGIN wall that names the missing vault kinds — never
 * end as "found no application form" after a pointless browser launch.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { resolveOwnPortalAccess, ssoCredentialFromVault } from '../services/hamilton/hamiltonOwnPortalAccess.js'
import { resolveInstitutionScholarshipPortal } from '../config/institutionScholarshipPortals.js'

const mtsu = resolveInstitutionScholarshipPortal('Middle Tennessee State University')

describe('resolveOwnPortalAccess', () => {
  it('a registered portal with no session, no login and no SSO in the vault is a login wall naming the kinds', () => {
    const r = resolveOwnPortalAccess({ ownPortal: mtsu, vaultKinds: [{ kind: 'date_of_birth' }] })
    expect(r).not.toBeNull()
    expect(r.blocker_kind).toBe('login')
    expect(r.missing_kinds).toEqual(['sso_username', 'sso_password'])
    expect(r.blocker_detail).toMatch(/PipelineMT/)
    expect(r.blocker_detail).toMatch(/did not open the browser/)
    expect(r.credential_use_unauthorized).toBe(false)
  })

  it('half a pair is still no way in — only the missing half is asked for', () => {
    const r = resolveOwnPortalAccess({ ownPortal: mtsu, vaultKinds: ['sso_username'] })
    expect(r.missing_kinds).toEqual(['sso_password'])
  })

  it('a saved session is a way in', () => {
    expect(resolveOwnPortalAccess({ ownPortal: mtsu, storageState: { cookies: [] } })).toBeNull()
  })

  it('a usable portal credential is a way in', () => {
    expect(resolveOwnPortalAccess({ ownPortal: mtsu, loginCredential: { username: 'u', password: 'p' } })).toBeNull()
  })

  it('the vault SSO pair is a way in only under credential consent; without it the wall says so', () => {
    const kinds = ['sso_username', 'sso_password']
    expect(resolveOwnPortalAccess({ ownPortal: mtsu, vaultKinds: kinds, credentialUseAuthorized: true })).toBeNull()
    const r = resolveOwnPortalAccess({ ownPortal: mtsu, vaultKinds: kinds, credentialUseAuthorized: false })
    expect(r.blocker_kind).toBe('login')
    expect(r.missing_kinds).toEqual([])
    expect(r.credential_use_unauthorized).toBe(true)
    expect(r.blocker_detail).toMatch(/not authorized/)
  })

  it('a source that is NOT an own-institution portal is never touched', () => {
    expect(resolveOwnPortalAccess({ ownPortal: null })).toBeNull()
  })
})

describe('ssoCredentialFromVault', () => {
  it('bridges the vault SSO pair into the engine credential shape scoped to the portal host', () => {
    const c = ssoCredentialFromVault({ ownPortal: mtsu, identityValues: { sso_username: 'student', sso_password: 'pw', ssn: '000' } })
    expect(c).toEqual(expect.objectContaining({ username: 'student', password: 'pw', portal_host: 'mtsu.scholarships.ngwebsolutions.com', source: 'identity_vault_sso' }))
  })
  it('never invents a credential from half a pair', () => {
    expect(ssoCredentialFromVault({ ownPortal: mtsu, identityValues: { sso_username: 'student' } })).toBeNull()
    expect(ssoCredentialFromVault({ ownPortal: mtsu, identityValues: null })).toBeNull()
  })
})

describe('orchestrator wiring (source-order tripwire)', () => {
  it('decides own-portal access BEFORE the known-wall fast-skip (so signup recovery never targets a school SSO) and before any browser launch', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../services/hamilton/hamiltonAutomationOrchestrator.js'), 'utf8')
    const ownGate = src.indexOf('resolveOwnPortalAccess({')
    const fastSkip = src.indexOf('const priorKind = await latestFinishedBlockerKind(')
    const engine = src.indexOf('engineResult = await runAutopilot({')
    expect(ownGate).toBeGreaterThan(0)
    expect(ownGate).toBeLessThan(fastSkip)
    expect(fastSkip).toBeLessThan(engine)
    // The fast-skip must yield to an own-portal verdict.
    expect(src).toMatch(/if \(!knownAuthWallKind && !loginCredential && !storageState\) \{/)
    // The ask for the missing vault kinds goes out with the wall.
    const gateBlock = src.slice(ownGate, fastSkip)
    expect(gateBlock).toMatch(/emitIdentityRequest\(db, \{/)
    expect(gateBlock).toMatch(/ssoCredentialFromVault\(\{/)
  })
})
