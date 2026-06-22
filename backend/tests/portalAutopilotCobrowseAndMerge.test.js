/**
 * Tests for the three owner-required Portal Autopilot pieces:
 *
 *  (A) ESCALATION ORDERING — side-by-side co-browse is the LAST resort. Terminal
 *      autopilot states (identity-proofing, needs_user/automation-exhausted) are
 *      decorated with resolution='side_by_side_cobrowse' + a launch target, while
 *      states automation handled (auto_provisioned / has_existing_credentials) are
 *      NOT (resolution=null) — co-browse is never offered before automation runs.
 *
 *  (B) TRUTHFUL MERGED — markPortalMerged refuses an unconfirmed merge (no proof),
 *      so a portal can never be silently/loosely marked merged.
 *
 *  (C) CAN'T-AUTO-MERGE LABELING — a terminal portal is plainly flagged
 *      canAutoMerge=false and routed to the co-browse launch target.
 */

import { describe, it, expect, beforeEach } from 'vitest'

process.env.RUNTIME_SECRETS_KEY = 'c'.repeat(64)
process.env.HAMILTON_ADMIN_VAULT_PROFILE_ID = 'owner-vault'
delete process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION
delete process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST

const Database = (await import('better-sqlite3')).default

const {
  setMasterPassphrase, lockVault, _resetMasterVaultSchemaCache, _resetUnlockCache,
} = await import('../services/hamilton/hamiltonPortalMasterVault.js')
const {
  saveCredential, _resetCredentialSchemaCache,
} = await import('../services/hamilton/hamiltonPortalCredentialService.js')
const {
  runAutopilotIdentityForPortal, describeAutopilotStateForPortal,
  AUTOPILOT_STATE, RESOLUTION,
} = await import('../services/hamilton/hamiltonPortalAutopilotIdentity.js')
const {
  PORTAL_STATUS, markPortalMerged, markPortalComplete, getPortalStatus,
  ensurePortalCompletionSchema, _resetPortalCompletionSchemaCache,
} = await import('../services/hamilton/portalCompletionStore.js')

function makeDb() {
  return new Database(':memory:')
}

describe('(A) escalation ordering — co-browse is the LAST resort', () => {
  let db
  beforeEach(() => {
    db = makeDb()
    _resetMasterVaultSchemaCache()
    _resetCredentialSchemaCache()
    _resetUnlockCache()
  })

  it('an EXISTING-credential portal is NOT offered co-browse (automation handled it)', async () => {
    await saveCredential(db, {
      userId: 'u1', profileId: 'pA', portalHost: 'awardspring.com',
      username: 'student@example.com', password: 'already-set',
    })
    await setMasterPassphrase(db, { profileId: 'pA', passphrase: 'master-pass-1' })
    const r = await runAutopilotIdentityForPortal(db, { profileId: 'pA', userId: 'u1', portalHost: 'awardspring.com' })
    expect(r.state).toBe(AUTOPILOT_STATE.HAS_EXISTING_CREDENTIALS)
    expect(r.resolution).toBe(RESOLUTION.NONE)
    expect(r.cobrowse).toBeUndefined()
  })

  it('an IDENTITY-PROOFED portal IS the last resort → side-by-side co-browse target', async () => {
    await setMasterPassphrase(db, { profileId: 'pA', passphrase: 'master-pass-1' })
    const r = await runAutopilotIdentityForPortal(db, {
      profileId: 'pA', userId: 'u1', portalHost: 'studentaid.gov', loginUrl: 'https://studentaid.gov/login',
    })
    expect(r.state).toBe(AUTOPILOT_STATE.IDENTITY_PROOF_REQUIRED)
    expect(r.resolution).toBe(RESOLUTION.SIDE_BY_SIDE_COBROWSE)
    expect(r.canAutoMerge).toBe(false)
    expect(r.cobrowse?.host).toBe('studentaid.gov')
    expect(r.cobrowse?.loginUrl).toBe('https://studentaid.gov/login')
  })

  it('"ready to auto-provision" is NOT a co-browse terminal (automation not yet exhausted)', async () => {
    // Passphrase set + unlocked + no existing login + not identity-proofed →
    // describe returns needs_user enum but is pending-automation, not terminal.
    await setMasterPassphrase(db, { profileId: 'pA', passphrase: 'master-pass-1' })
    const st = await describeAutopilotStateForPortal(db, {
      profileId: 'pA', portalHost: 'communityforce.com',
    })
    expect(st.state).toBe(AUTOPILOT_STATE.NEEDS_USER)
    expect(st.resolution).toBe(RESOLUTION.NONE)
    expect(st.canAutoMerge).toBe(true)
  })

  it('a ToS-forbidden portal (no passphrase) IS routed to co-browse (cant auto-merge)', async () => {
    // commonapp.org has automation_allowed:false in the seed policy → terminal.
    const st = await describeAutopilotStateForPortal(db, {
      profileId: 'pNoPass', portalHost: 'commonapp.org', loginUrl: 'https://www.commonapp.org/',
    })
    expect(st.state).toBe(AUTOPILOT_STATE.NEEDS_USER)
    expect(st.resolution).toBe(RESOLUTION.SIDE_BY_SIDE_COBROWSE)
    expect(st.canAutoMerge).toBe(false)
    expect(st.cobrowse?.host).toBe('commonapp.org')
  })
})

describe('(B) truthful merged — markPortalMerged refuses an unconfirmed merge', () => {
  let db
  beforeEach(async () => {
    db = makeDb()
    _resetPortalCompletionSchemaCache()
    await ensurePortalCompletionSchema(db)
  })

  it('REFUSES a bare merge with no confirmation / proof (returns null, leaves not-merged)', async () => {
    const row = await markPortalMerged(db, { profileId: 'p1', portalHost: 'awardspring.com', source: 'auto' })
    expect(row).toBeNull()
    // The portal is NOT merged → still reminder-eligible.
    const after = await getPortalStatus(db, 'p1', 'awardspring.com')
    expect(after === null || after.status !== PORTAL_STATUS.MERGED).toBe(true)
  })

  it('ACCEPTS a merge with explicit human confirmation', async () => {
    const row = await markPortalMerged(db, { profileId: 'p1', portalHost: 'awardspring.com', confirmed: true })
    expect(row.status).toBe(PORTAL_STATUS.MERGED)
    expect(row.merged_at).toBeTruthy()
    expect(row.evidence).toBe('human_confirmed')
  })

  it('ACCEPTS a merge backed by a real sync-run / document proof', async () => {
    const row = await markPortalMerged(db, { profileId: 'p1', portalHost: 'awardspring.com', syncRunId: 'run-123' })
    expect(row.status).toBe(PORTAL_STATUS.MERGED)
    expect(row.evidence).toBe('portal_sync_run:run-123')
  })

  it('a confirmed merge still wins over a later "complete" (no regression)', async () => {
    await markPortalMerged(db, { profileId: 'p1', portalHost: 'studentaid.gov', confirmed: true })
    const after = await markPortalComplete(db, { profileId: 'p1', portalHost: 'studentaid.gov' })
    expect(after.status).toBe(PORTAL_STATUS.MERGED)
  })
})
