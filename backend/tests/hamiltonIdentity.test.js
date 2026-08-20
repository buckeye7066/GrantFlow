/**
 * Hamilton's two-phase portal identity under full automation.
 *
 * Owner order 2026-08-20: signup uses Hamilton's own email/phone so the
 * verification code reaches him; after submission the portal profile is handed
 * over to the applicant, with Hamilton retained as SECONDARY so he can still
 * submit. None of it applies unless full automation is switched on.
 */
import { describe, it, expect } from 'vitest'
import {
  HAMILTON_IDENTITY,
  hamiltonPhoneDigits,
  hasFullAutomation,
  registrationIdentity,
  handoverIdentity,
} from '../config/hamiltonIdentity.js'

const profile = {
  name: 'Anastasia Nicole White',
  full_name: 'Anastasia Nicole White',
  email: 'anastasia@example.org',
  phone: '555-0100',
}
const vaultLogin = {
  full_name: 'Anastasia Nicole White',
  username: 'anastasia@example.org',
  password: 'vault-secret',
  identity_email: 'anastasia@example.org',
}

// `submit_applications` is an authorization TYPE; `allow_auto_submit` and
// `require_human_review` are OPTIONS on the grant row, matching
// resolveSubmissionDecision. Modelling them as types would make this predicate
// permanently false.
const grant = (type, options = {}) => ({
  scope: 'profile', authorization_type: type, revoked_at: null, options,
})
const FULL = [grant('submit_applications', { allow_auto_submit: true })]

describe('hasFullAutomation', () => {
  it('requires the submit TYPE and the auto-submit OPTION', () => {
    expect(hasFullAutomation(FULL)).toBe(true)
    // Authority without the intent flag is not full automation.
    expect(hasFullAutomation([grant('submit_applications')])).toBe(false)
    // The intent flag without submit authority is not either.
    expect(hasFullAutomation([grant('save_drafts', { allow_auto_submit: true })])).toBe(false)
  })

  it('is withheld while the user requires review first', () => {
    expect(hasFullAutomation([
      grant('submit_applications', { allow_auto_submit: true, require_human_review: true }),
    ])).toBe(false)
  })

  it('ignores revoked and non-profile grants', () => {
    const revoked = { ...grant('submit_applications', { allow_auto_submit: true }), revoked_at: '2026-08-01' }
    expect(hasFullAutomation([revoked])).toBe(false)
    const runScoped = {
      scope: 'run', authorization_type: 'submit_applications', options: { allow_auto_submit: true },
    }
    expect(hasFullAutomation([runScoped])).toBe(false)
  })

  it('never infers consent from junk input', () => {
    expect(hasFullAutomation(null)).toBe(false)
    expect(hasFullAutomation([])).toBe(false)
  })
})

describe('registration identity (phase 1)', () => {
  it('registers under the APPLICANT name/login but HAMILTON contact', () => {
    const id = registrationIdentity({ profile, vaultLogin, fullAutomation: true })
    expect(id.fullName).toBe('Anastasia Nicole White')
    expect(id.username).toBe('anastasia@example.org')
    expect(id.password).toBe('vault-secret')
    // The whole point: verification must reach Hamilton.
    expect(id.email).toBe(HAMILTON_IDENTITY.email)
    expect(id.phone).toBe(HAMILTON_IDENTITY.phone)
    expect(id.email).not.toBe(profile.email)
    expect(id.phone).not.toBe(profile.phone)
    expect(id.contactOwner).toBe('hamilton')
  })

  it('does NOT apply when full automation is off', () => {
    expect(registrationIdentity({ profile, vaultLogin, fullAutomation: false })).toBeNull()
  })

  it('exposes a digits-only phone for strict portal fields', () => {
    expect(hamiltonPhoneDigits()).toMatch(/^\d{10,}$/)
    expect(hamiltonPhoneDigits()).not.toMatch(/\D/)
  })
})

describe('handover identity (phase 2)', () => {
  const base = { profile, vaultLogin, fullAutomation: true }

  it('is NOT ready until the account exists AND the application was submitted', () => {
    expect(handoverIdentity({ ...base, accountCreated: false, applicationSubmitted: false }).ready).toBe(false)
    expect(handoverIdentity({ ...base, accountCreated: true, applicationSubmitted: false }).ready).toBe(false)
    expect(handoverIdentity({ ...base, accountCreated: false, applicationSubmitted: true }).ready).toBe(false)
  })

  it('names every blocker rather than failing silently', () => {
    const h = handoverIdentity({ ...base, accountCreated: false, applicationSubmitted: false })
    expect(h.blockers).toHaveLength(2)
    expect(h.blockers.join(' ')).toMatch(/created/)
    expect(h.blockers.join(' ')).toMatch(/submitted/)
  })

  it('hands the primary contact to the applicant', () => {
    const h = handoverIdentity({ ...base, accountCreated: true, applicationSubmitted: true })
    expect(h.ready).toBe(true)
    expect(h.primary.email).toBe('anastasia@example.org')
    expect(h.primary.phone).toBe('555-0100')
  })

  it('KEEPS Hamilton as secondary so submission access survives', () => {
    const h = handoverIdentity({ ...base, accountCreated: true, applicationSubmitted: true })
    expect(h.secondary.email).toBe(HAMILTON_IDENTITY.email)
    expect(h.secondary.phone).toBe(HAMILTON_IDENTITY.phone)
    expect(h.secondary.role).toBe('secondary_contact')
  })

  it('does not hand over while full automation is off', () => {
    const h = handoverIdentity({
      ...base, fullAutomation: false, accountCreated: true, applicationSubmitted: true,
    })
    expect(h.ready).toBe(false)
    expect(h.blockers.join(' ')).toMatch(/full automation/)
  })

  it('refuses to hand over to an empty address', () => {
    const h = handoverIdentity({
      profile: { ...profile, email: '' },
      vaultLogin: { ...vaultLogin, identity_email: '' },
      fullAutomation: true,
      accountCreated: true,
      applicationSubmitted: true,
    })
    expect(h.ready).toBe(false)
    expect(h.blockers.join(' ')).toMatch(/no email/)
  })
})
