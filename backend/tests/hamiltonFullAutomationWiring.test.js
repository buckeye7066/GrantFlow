/**
 * Hamilton's full-automation path, WIRED.
 *
 * Three modules existed, passed their own tests, and had no caller at all:
 * `registrationIdentity()` (so Hamilton's PHONE was consumed by nothing),
 * `findVerificationCode()` (so a 2FA wall still took the needs_user handoff),
 * and any real Graph token provider (so the email lane could only ever report
 * "no Graph token provider configured").
 *
 * These tests exercise the WIRING, not the modules — the helpers below are the
 * exact functions the live signup path calls — and every one of them asserts the
 * off-state too: with full automation OFF nothing may change.
 */
import { describe, it, expect, vi } from 'vitest'
import { HAMILTON_IDENTITY, hamiltonPhoneDigits } from '../config/hamiltonIdentity.js'
import { buildPhaseOneSignupIdentity } from '../services/hamilton/hamiltonPortalAutopilotIdentity.js'
import {
  buildSignupIdentity,
  answerVerificationCodeWall,
  _internal as signupInternal,
} from '../services/hamilton/hamiltonPortalSignupAdapter.js'
import {
  pollForVerificationCode,
  enterVerificationCode,
  attemptAutomatedVerification,
  MAX_CODE_ATTEMPTS,
} from '../services/hamilton/hamiltonVerificationGate.js'
import {
  makeHamiltonGraphTokenProvider,
  hamiltonGraphStatus,
  hamiltonGraphBlockerReason,
} from '../services/hamilton/hamiltonGraphToken.js'

const PROFILE = {
  basic_information: {
    first_name: 'Dana',
    last_name: 'Reyes',
    email: 'dana.reyes@example.org',
    phone: '(615) 555-0134',
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// ITEM 1 — registrationIdentity() now has a caller, and the PHONE is consumed.
// ─────────────────────────────────────────────────────────────────────────────

describe('PHASE 1 registration identity (registrationIdentity is wired)', () => {
  it('submits the APPLICANT\'S login with HAMILTON\'S email AND phone', () => {
    const identity = buildPhaseOneSignupIdentity({
      profile: PROFILE,
      identityEmail: HAMILTON_IDENTITY.email,
      password: 'generated-master-wrapped-pw',
      vaultStatus: { identity_email: 'vault@example.org' },
      fullAutomation: true,
    })
    // The account belongs to the applicant.
    expect(identity.first_name).toBe('Dana')
    expect(identity.last_name).toBe('Reyes')
    expect(identity.full_name).toBe('Dana Reyes')
    expect(identity.password).toBe('generated-master-wrapped-pw')
    // The contact channels belong to Hamilton — this is the whole point.
    expect(identity.email).toBe(HAMILTON_IDENTITY.email)
    expect(identity.phone).toBe(HAMILTON_IDENTITY.phone)
    expect(identity.contact_owner).toBe('hamilton')
  })

  it('carries the DIGITS-ONLY phone for portals that reject punctuation', () => {
    const identity = buildPhaseOneSignupIdentity({
      profile: PROFILE, identityEmail: HAMILTON_IDENTITY.email, password: 'pw', fullAutomation: true,
    })
    expect(identity.phone_digits).toBe(hamiltonPhoneDigits())
    expect(identity.phone_digits).toMatch(/^\d{10,}$/)
    expect(identity.phone_digits).not.toMatch(/\D/)
  })

  it('with full automation OFF, behaves EXACTLY as it does today', () => {
    const identity = buildPhaseOneSignupIdentity({
      profile: PROFILE,
      identityEmail: 'dana.reyes@example.org',
      password: 'pw',
      vaultStatus: { identity_email: 'vault@example.org' },
      fullAutomation: false,
    })
    expect(identity.email).toBe('dana.reyes@example.org')
    expect(identity.phone).toBe('(615) 555-0134')
    expect(identity.contact_owner).toBe('applicant')
    // No digits fallback exists off-state, so the phone fill is byte-for-byte
    // what it always was.
    expect(identity.phone_digits).toBeNull()
    // And it matches the pre-policy builder exactly.
    const legacy = buildSignupIdentity({
      profile: PROFILE, identityEmail: 'dana.reyes@example.org', password: 'pw',
    })
    expect(identity).toEqual(legacy)
  })

  it('never lets a NON-registration object redirect the contact channels', () => {
    const identity = buildSignupIdentity({
      profile: PROFILE,
      identityEmail: 'dana.reyes@example.org',
      password: 'pw',
      // A handover-phase object must not be mistaken for a registration one.
      registration: { phase: 'handover', email: 'attacker@example.com', phone: '000' },
    })
    expect(identity.email).toBe('dana.reyes@example.org')
    expect(identity.phone).toBe('(615) 555-0134')
    expect(identity.contact_owner).toBe('applicant')
  })
})

describe('the phone FIELD is actually filled, with a digits retry', () => {
  // Minimal Playwright-shaped page: one phone input that keeps only digits.
  function pageWithPhoneField({ stripsPunctuation }) {
    let value = ''
    const handle = {
      fill: vi.fn(async (v) => { value = stripsPunctuation ? String(v).replace(/\D+/g, '') : String(v) }),
      inputValue: async () => value,
    }
    return {
      page: { $: async (sel) => (/tel|phone/i.test(sel) ? handle : null) },
      handle,
      read: () => value,
    }
  }

  it('retries with digits when the portal strips punctuation (full automation)', async () => {
    const { page, read } = pageWithPhoneField({ stripsPunctuation: true })
    const identity = buildPhaseOneSignupIdentity({
      profile: PROFILE, identityEmail: HAMILTON_IDENTITY.email, password: 'pw', fullAutomation: true,
    })
    const out = await signupInternal.fillPhoneField(page, identity)
    expect(out.used).toBe('digits')
    expect(read()).toBe(hamiltonPhoneDigits())
  })

  it('keeps the formatted number when the portal accepts it', async () => {
    const { page, read } = pageWithPhoneField({ stripsPunctuation: false })
    const identity = buildPhaseOneSignupIdentity({
      profile: PROFILE, identityEmail: HAMILTON_IDENTITY.email, password: 'pw', fullAutomation: true,
    })
    const out = await signupInternal.fillPhoneField(page, identity)
    expect(out.used).toBe('formatted')
    expect(read()).toBe(HAMILTON_IDENTITY.phone)
  })

  it('OFF-STATE: an applicant-owned phone is never retried with digits', async () => {
    const { page, handle } = pageWithPhoneField({ stripsPunctuation: true })
    const identity = buildPhaseOneSignupIdentity({
      profile: PROFILE, identityEmail: 'dana.reyes@example.org', password: 'pw', fullAutomation: false,
    })
    const out = await signupInternal.fillPhoneField(page, identity)
    expect(out.used).toBe('formatted')
    // fill('') + fill(value) once — no second attempt.
    expect(handle.fill).toHaveBeenCalledTimes(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ITEM 3 — findVerificationCode() now has a caller on the signup path.
// ─────────────────────────────────────────────────────────────────────────────

describe('the bounded verification-code poll', () => {
  it('reads NOTHING when full automation is off', async () => {
    const findCode = vi.fn()
    const out = await pollForVerificationCode({}, { fullAutomation: false, findCode })
    expect(out.code).toBeNull()
    expect(findCode).not.toHaveBeenCalled()
    expect(out.reason).toMatch(/full automation is not enabled/)
  })

  it('returns the first code either channel produces', async () => {
    const findCode = vi.fn()
      .mockResolvedValueOnce({ code: null, reason: 'no fresh verification code from the phone' })
      .mockResolvedValueOnce({ code: '481920', source: 'sms' })
    const out = await pollForVerificationCode({}, {
      fullAutomation: true, attempts: 4, intervalMs: 0, sleep: async () => {}, findCode,
    })
    expect(out.code).toBe('481920')
    expect(out.attempts).toBe(2)
    expect(findCode).toHaveBeenCalledTimes(2)
  })

  it('is BOUNDED — it can never become an unbounded loop', async () => {
    const findCode = vi.fn().mockResolvedValue({ code: null, reason: 'nothing yet' })
    const out = await pollForVerificationCode({}, {
      // A mis-set env asking for a thousand attempts is clamped.
      fullAutomation: true, attempts: 1000, intervalMs: 999_999, sleep: async () => {}, findCode,
    })
    expect(out.code).toBeNull()
    expect(findCode).toHaveBeenCalledTimes(MAX_CODE_ATTEMPTS)
    expect(out.reason).toMatch(/nothing yet/)
  })

  it('carries the channel REASON through so a miss is explainable', async () => {
    const findCode = vi.fn().mockResolvedValue({
      code: null, reason: 'sms: no fresh code | email: no Graph token provider configured',
    })
    const out = await pollForVerificationCode({}, {
      fullAutomation: true, attempts: 1, intervalMs: 0, findCode,
    })
    expect(out.reason).toMatch(/no Graph token provider configured/)
  })

  it('a thrown lookup is a REASON, never a crash', async () => {
    const findCode = vi.fn().mockRejectedValue(new Error('db exploded'))
    const out = await pollForVerificationCode({}, {
      fullAutomation: true, attempts: 1, intervalMs: 0, findCode,
    })
    expect(out.code).toBeNull()
    expect(out.reason).toMatch(/db exploded/)
  })
})

describe('entering the code', () => {
  function codePage() {
    let value = ''
    const field = { fill: async (v) => { value = String(v) }, press: async () => {} }
    const submit = { click: vi.fn(async () => {}) }
    return {
      page: {
        $: async (sel) => {
          if (/one-time-code|otp|verification|code/i.test(sel)) return field
          if (/submit|Verify|Confirm|Continue|Next/i.test(sel)) return submit
          return null
        },
        url: () => 'https://portal.invalid/verify',
      },
      submit,
      read: () => value,
    }
  }

  it('types the code that ACTUALLY arrived and submits it', async () => {
    const { page, submit, read } = codePage()
    const out = await enterVerificationCode(page, '481920')
    expect(out).toEqual({ entered: true, submitted: true })
    expect(read()).toBe('481920')
    expect(submit.click).toHaveBeenCalledOnce()
  })

  it('REFUSES to type an empty/absent code — a code is never fabricated', async () => {
    const { page, submit } = codePage()
    for (const bad of [null, undefined, '', '   ']) {
      const out = await enterVerificationCode(page, bad)
      expect(out.entered).toBe(false)
    }
    expect(submit.click).not.toHaveBeenCalled()
  })

  it('reports honestly when the page has no code field', async () => {
    const out = await enterVerificationCode({ $: async () => null }, '481920')
    expect(out.entered).toBe(false)
    expect(out.reason).toMatch(/no verification-code field/)
  })
})

describe('the signup code WALL is answered (the live registerOnPortal step)', () => {
  const pendingResult = {
    status: 'verification_pending',
    adapter: 'generic',
    message: 'Account created — the portal asked to verify the email.',
  }

  // A faithful fake: the code form is REPLACED once the code is submitted, the
  // way a real portal advances past the wall. Leaving the OTP input on the page
  // forever would make re-classification see a 2FA gate that is no longer there.
  function pageAfterCode(finalText) {
    let value = ''
    let submitted = false
    const field = { fill: async (v) => { value = String(v) }, press: async () => {} }
    const submit = { click: async () => { submitted = true } }
    return {
      $: async (sel) => {
        if (/password/i.test(sel)) return null
        if (/recaptcha|hcaptcha|captcha|turnstile|cloudflare|cc-number|stripe|braintree|card/i.test(sel)) return null
        const isCodeField = /one-time-code|otp|verif|securitycode|security_code|2fa|\bcode\b/i.test(sel)
        if (isCodeField) return submitted ? null : field
        if (/submit|Verify|Confirm|Continue|Next/i.test(sel)) return submitted ? null : submit
        return null
      },
      $$eval: async () => [],
      evaluate: async () => finalText,
      content: async () => finalText,
      url: () => 'https://portal.invalid/dashboard',
      waitForNavigation: async () => null,
      waitForLoadState: async () => null,
      read: () => value,
    }
  }

  it('clears the wall and RE-CLASSIFIES the page when a code arrives', async () => {
    const page = pageAfterCode('Welcome — your account has been created.')
    const out = await answerVerificationCodeWall({}, page, { ...pendingResult }, {
      fullAutomation: true,
      verificationCodeOptions: {
        attempts: 1, intervalMs: 0,
        findCode: async () => ({ code: '481920', source: 'sms' }),
      },
    })
    expect(out.status).toBe('registered')
    expect(out.verified_via).toBe('hamilton_sms')
    expect(out.verification_code.entered).toBe(true)
    expect(page.read()).toBe('481920')
  })

  it('FALLS BACK to the existing handoff when no code arrives — and says why', async () => {
    const page = pageAfterCode('Check your email to verify your account.')
    const out = await answerVerificationCodeWall({}, page, { ...pendingResult }, {
      fullAutomation: true,
      verificationCodeOptions: {
        attempts: 2, intervalMs: 0, sleep: async () => {},
        findCode: async () => ({ code: null, reason: 'no fresh verification code from the phone' }),
      },
    })
    // Unchanged status → the brain's existing needs_user/waiting handoff applies.
    expect(out.status).toBe('verification_pending')
    expect(out.verification_code.entered).toBe(false)
    expect(out.verification_code.attempted).toBe(true)
    expect(out.verification_code.reason).toMatch(/no fresh verification code/)
  })

  it('answers a 2FA-on-signup BLOCK, not just an email wall', async () => {
    const page = pageAfterCode('You are signed in.')
    const out = await answerVerificationCodeWall({}, page, {
      status: 'blocked', blockerType: 'two_factor_required', blocker_kind: 'two_factor_required', adapter: 'generic',
    }, {
      fullAutomation: true,
      verificationCodeOptions: { attempts: 1, intervalMs: 0, findCode: async () => ({ code: '224180', source: 'email' }) },
    })
    expect(out.status).toBe('registered')
    expect(out.verified_via).toBe('hamilton_email')
  })

  it('OFF-STATE: with full automation off the result is returned untouched', async () => {
    const page = pageAfterCode('Check your email to verify your account.')
    const findCode = vi.fn()
    const input = { ...pendingResult }
    const out = await answerVerificationCodeWall({}, page, input, {
      fullAutomation: false,
      verificationCodeOptions: { attempts: 1, intervalMs: 0, findCode },
    })
    expect(out).toBe(input)
    expect(out.verification_code).toBeUndefined()
    expect(findCode).not.toHaveBeenCalled()
  })

  it('a NON-wall result is never touched, even under full automation', async () => {
    const registered = { status: 'registered', adapter: 'generic' }
    const out = await answerVerificationCodeWall({}, pageAfterCode('welcome'), registered, { fullAutomation: true })
    expect(out).toBe(registered)
  })

  it('a code that is read but cannot be SUBMITTED is not claimed as verified', async () => {
    const gate = await attemptAutomatedVerification({}, { $: async () => null }, {
      fullAutomation: true, attempts: 1, intervalMs: 0,
      findCode: async () => ({ code: '481920', source: 'sms' }),
    })
    expect(gate.verified).toBe(false)
    expect(gate.code_found).toBe(true)
    expect(gate.reason).toMatch(/no verification-code field/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ITEM 6 — the Graph token provider is joined to the real credential config.
// ─────────────────────────────────────────────────────────────────────────────

describe('the Hamilton Graph token provider', () => {
  const READY = { msTenantId: 'tenant', msClientId: 'client', msClientSecret: 'secret' }

  it('reports exactly which env var is missing, and does not crash', () => {
    const s = hamiltonGraphStatus({ msTenantId: '', msClientId: 'c', msClientSecret: 's' })
    expect(s.ready).toBe(false)
    expect(s.missing).toContain('MICROSOFT_TENANT_ID')
    expect(hamiltonGraphBlockerReason(s)).toMatch(/MICROSOFT_TENANT_ID/)
  })

  it('degrades to an honest REASON string rather than a crash', async () => {
    const { readEmailCode } = await import('../services/hamilton/hamiltonVerificationCodes.js')
    const getToken = makeHamiltonGraphTokenProvider({ config: { msTenantId: '', msClientId: '', msClientSecret: '' } })
    const out = await readEmailCode({ getToken, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) })
    expect(out.code).toBeNull()
    expect(out.reason).toMatch(/graph token failed/)
    expect(out.reason).toMatch(/MICROSOFT_TENANT_ID/)
  })

  it('requests an app-only token against the SAME registration the product uses', async () => {
    let seenUrl = null
    let seenBody = null
    const getToken = makeHamiltonGraphTokenProvider({
      config: READY,
      fetchImpl: async (url, opts) => {
        seenUrl = String(url); seenBody = String(opts?.body || '')
        return { ok: true, json: async () => ({ access_token: 'tok-1', expires_in: 3600 }) }
      },
    })
    expect(await getToken()).toBe('tok-1')
    expect(seenUrl).toMatch(/login\.microsoftonline\.com\/tenant\/oauth2\/v2\.0\/token/)
    expect(seenBody).toMatch(/grant_type=client_credentials/)
    expect(seenBody).toMatch(/graph\.microsoft\.com%2F\.default/)
  })

  it('MEMOIZES so a bounded poll does not mint a token per attempt', async () => {
    let calls = 0
    const getToken = makeHamiltonGraphTokenProvider({
      config: READY,
      fetchImpl: async () => { calls += 1; return { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) } },
    })
    await getToken(); await getToken(); await getToken()
    expect(calls).toBe(1)
  })

  it('never leaks the response body on a failure', async () => {
    const getToken = makeHamiltonGraphTokenProvider({
      config: READY,
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'client_secret=secret' }),
    })
    await expect(getToken()).rejects.toThrow(/Graph token request failed: 401/)
    await expect(getToken()).rejects.not.toThrow(/secret/)
  })

  it('feeds readEmailCode a REAL bearer token end to end', async () => {
    const { readEmailCode } = await import('../services/hamilton/hamiltonVerificationCodes.js')
    const getToken = makeHamiltonGraphTokenProvider({
      config: READY,
      fetchImpl: async () => ({ ok: true, json: async () => ({ access_token: 'bearer-xyz', expires_in: 3600 }) }),
    })
    let auth = null
    const out = await readEmailCode({
      getToken,
      fetchImpl: async (_url, opts) => {
        auth = opts?.headers?.Authorization
        return { ok: true, status: 200, json: async () => ({ value: [{
          subject: 'Verify your account',
          bodyPreview: 'Your verification code is 224180',
          receivedDateTime: new Date().toISOString(),
        }] }) }
      },
    })
    expect(auth).toBe('Bearer bearer-xyz')
    expect(out.code).toBe('224180')
    expect(out.source).toBe('email')
  })
})
