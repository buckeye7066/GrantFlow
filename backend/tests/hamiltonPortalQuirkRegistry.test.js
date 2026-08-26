/**
 * Anya portal-quirk learning loop. Lane 1 (autonomous DATA registry) validates
 * to data-only handlers and can never carry code/url/injection; Lane 2 (code)
 * is only proposed to the owner when a quirk recurs across many hosts.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  validateQuirkHandler, setQuirkHandler, getPortalQuirkHandlers, recordObservedQuirk, hostKey,
} from '../services/hamilton/hamiltonPortalQuirkRegistry.js'
import { classifyQuirk, observePortalQuirks } from '../services/hamilton/hamiltonPortalQuirkObserver.js'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'a'.repeat(64)
const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')

describe('validateQuirkHandler — DATA only, never code', () => {
  it('accepts the valid data-only kinds', () => {
    expect(validateQuirkHandler({ kind: 'checkbox_rule', match: 'I am 18 or older', action: 'age_affirmation' }).ok).toBe(true)
    expect(validateQuirkHandler({ kind: 'field_meaning', match: 'expected graduation', action: 'grad_date' }).ok).toBe(true)
    expect(validateQuirkHandler({ kind: 'date_format', match: 'dob', format: 'MM/DD/YYYY' }).ok).toBe(true)
    expect(validateQuirkHandler({ kind: 'submit_selector', selector: 'button#continue' }).ok).toBe(true)
  })
  it('REJECTS code / injection / url / unknown action', () => {
    expect(validateQuirkHandler({ kind: 'checkbox_rule', match: '<script>x()', action: 'age_affirmation' }).ok).toBe(false)
    expect(validateQuirkHandler({ kind: 'checkbox_rule', match: 'ok', action: 'run_arbitrary_code' }).ok).toBe(false)
    expect(validateQuirkHandler({ kind: 'submit_selector', selector: 'javascript:alert(1)' }).ok).toBe(false)
    expect(validateQuirkHandler({ kind: 'submit_selector', selector: 'a=`${evil}`' }).ok).toBe(false)
    expect(validateQuirkHandler({ kind: 'eval', match: 'x' }).ok).toBe(false)
    expect(validateQuirkHandler({ kind: 'field_meaning', match: 'x', action: 'ssn_exfiltrate' }).ok).toBe(false)
  })
})

describe('hostKey', () => {
  it('normalizes a url or bare host to eTLD+1', () => {
    expect(hostKey('https://www.usbank.com/about/scholarship-form.html')).toBe('usbank.com')
    expect(hostKey('apply.coolidgescholars.org')).toBe('coolidgescholars.org')
  })
})

describe('classifyQuirk (Lane 1 derivation)', () => {
  it('turns the U.S. Bank age checkbox into an age_affirmation rule', () => {
    expect(classifyQuirk('validation', 'I am 18 years old or older.: Please check this box if you want to proceed. | I am 17 years old…'))
      .toMatchObject({ kind: 'checkbox_rule', action: 'age_affirmation' })
  })
  it('classifies citizenship/enrollment and agree boxes', () => {
    expect(classifyQuirk('validation', 'I certify I am a U.S. citizen or permanent resident: field is required').action).toBe('eligibility_affirmation')
    expect(classifyQuirk('validation', 'I agree to the terms and conditions: this field is required').action).toBe('attestation_agree')
  })
  it('does not classify a non-validation block', () => {
    expect(classifyQuirk('captcha', 'CAPTCHA present')).toBeNull()
    expect(classifyQuirk('login', 'sign in required')).toBeNull()
  })
})

describe('registry round-trip + observer', () => {
  let db
  beforeEach(async () => {
    const sqlite = new Database(':memory:')
    sqlite.exec(`CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME);`)
    db = wrapSqlite(sqlite)
  })

  it('setQuirkHandler persists a valid handler and rejects an invalid one', async () => {
    expect((await setQuirkHandler(db, 'usbank.com', { kind: 'checkbox_rule', match: 'I am 18 or older', action: 'age_affirmation' })).ok).toBe(true)
    expect((await setQuirkHandler(db, 'usbank.com', { kind: 'checkbox_rule', match: 'x', action: 'BAD' })).ok).toBe(false)
    const handlers = await getPortalQuirkHandlers(db, 'https://www.usbank.com/form')
    expect(handlers).toHaveLength(1)
    expect(handlers[0]).toMatchObject({ kind: 'checkbox_rule', action: 'age_affirmation' })
  })

  it('observePortalQuirks writes Lane 1 handlers and raises a Lane 2 brief only across hosts', async () => {
    // Same age-checkbox quirk on THREE different hosts → cross-host → Lane 2.
    const detail = 'I am 18 years old or older.: Please check this box if you want to proceed.'
    const runs = [
      { host: 'usbank.com', blocker_kind: 'validation', detail },
      { host: 'examplefund.org', blocker_kind: 'validation', detail },
      { host: 'thirdscholar.com', blocker_kind: 'validation', detail },
    ]
    const res = await observePortalQuirks(db, { runs, minCrossHost: 3 })
    expect(res.observed).toBe(3)
    expect(res.lane1_written).toBe(3) // each host got a data rule (autonomous)
    expect(res.lane2_briefs).toHaveLength(1) // the recurring pattern → one owner decision brief
    expect(res.lane2_briefs[0].patch_authored_by_anya).toBe(false)
    // Re-run is idempotent: no duplicate brief.
    const again = await observePortalQuirks(db, { runs, minCrossHost: 3 })
    expect(again.lane2_briefs).toHaveLength(0)
  })

  it('does NOT raise Lane 2 for a single-host quirk', async () => {
    await recordObservedQuirk(db, { host: 'onlyone.com', blockerKind: 'validation', sample: 'weird one-off' })
    const res = await observePortalQuirks(db, { runs: [{ host: 'onlyone.com', blocker_kind: 'validation', detail: 'weird one-off checkbox required' }], minCrossHost: 3 })
    expect(res.lane2_briefs).toHaveLength(0)
  })
})
