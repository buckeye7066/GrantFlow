/**
 * Hamilton autopilot — saved-credential login + authenticator-app (TOTP) 2FA.
 *
 * Locks the contract that was broken before this fix:
 *
 *   1. detectGate surfaces a login gate whenever a password field is visible
 *      — REGARDLESS of saved-credential authorization. (The old code suppressed
 *      the gate when use_saved_credentials_reference was on, which made the
 *      saved-login auto-fill — and therefore 2FA — unreachable.)
 *   2. attemptLogin fills + submits a saved username/password and reports
 *      success once the password field is gone.
 *   3. attempt2fa derives the live TOTP code from the saved seed, types it into
 *      the one-time-code field(s), submits, and reports success once the OTP
 *      field is gone.
 *   4. Both refuse to type into a page whose registrable domain differs from
 *      the credential's (origin-safety guard).
 *
 * Uses a lightweight stub `page` rather than a real browser: the engine's
 * origin guard keys on PSL registrable domains, which are null for
 * 127.0.0.1/localhost, so a real mock server can't exercise these paths. The
 * stub runs the exact same selector logic deterministically.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { _internal } from '../../backend/services/hamilton/hamiltonAutopilotEngine.js'
import { generateTotp } from '../../backend/services/hamilton/hamiltonTotp.js'

const { detectGate, attemptLogin, attempt2fa } = _internal
const SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

function handle(onAction = {}) {
  return {
    async fill(v) { onAction.fill?.(v) },
    async click() { onAction.click?.() },
    async press() { onAction.press?.() },
  }
}

/**
 * Stub of a portal that walks login → 2fa → done. State advances when the
 * submit button is "clicked" with the right inputs present, mirroring a real
 * server. `host` lets us simulate the origin-safety mismatch.
 */
function makePage({ start = 'login', host = 'portal.example.com' } = {}) {
  const page = {
    state: start,
    filled: {},
    url() { return `https://${host}/${this.state}` },
    async waitForLoadState() {},
    async $(sel) {
      const s = String(sel)
      if (s.includes('password')) return this.state === 'login' ? handle({ fill: (v) => { this.filled.password = v } }) : null
      if (s.includes('one-time-code') || s.includes('otp') || s.includes('2fa')) {
        return this.state === '2fa' ? handle({ fill: (v) => { this.filled.otp = v } }) : null
      }
      if (s.includes('submit') || s.includes(':has-text')) {
        return handle({ click: () => this.advance() })
      }
      if (s.includes('captcha') || s.includes('cc-number') || s.includes('stripe') || s.includes('braintree')) return null
      // Remaining selectors are the username/email/text field candidates.
      return this.state === 'login' ? handle({ fill: (v) => { this.filled.username = v } }) : null
    },
    async $$(sel) {
      const s = String(sel)
      if ((s.includes('one-time-code') || s.includes('otp') || s.includes('2fa')) && this.state === '2fa') {
        return [handle({ fill: (v) => { this.filled.otp = v } })]
      }
      return []
    },
    advance() {
      if (this.state === 'login' && this.filled.username && this.filled.password) this.state = '2fa'
      else if (this.state === '2fa' && this.filled.otp === generateTotp(SEED)) this.state = 'done'
    },
  }
  return page
}

describe('detectGate — login gate is no longer suppressed by authorization', () => {
  it('returns a login gate whenever a password field is visible', async () => {
    const gate = await detectGate(makePage({ start: 'login' }))
    assert.equal(gate?.kind, 'login')
  })

  it('returns a 2fa gate when a one-time-code field is visible', async () => {
    const gate = await detectGate(makePage({ start: '2fa' }))
    assert.equal(gate?.kind, '2fa')
  })

  it('returns null on a clean page (no gate)', async () => {
    const gate = await detectGate(makePage({ start: 'done' }))
    assert.equal(gate, null)
  })
})

describe('attemptLogin', () => {
  const credential = { username: 'student@example.com', password: 'pw-123456', portal_host: 'portal.example.com' }

  it('fills the saved login, submits, and reports success', async () => {
    const page = makePage({ start: 'login' })
    const ok = await attemptLogin(page, credential)
    assert.equal(ok, true)
    assert.equal(page.filled.username, 'student@example.com')
    assert.equal(page.filled.password, 'pw-123456')
    assert.equal(page.state, '2fa', 'advanced past the login form')
  })

  it('refuses to type into a different registrable domain (origin guard)', async () => {
    const page = makePage({ start: 'login', host: 'evil-portal.com' })
    const ok = await attemptLogin(page, credential)
    assert.equal(ok, false)
    assert.equal(page.filled.password, undefined, 'never filled the password on a foreign origin')
  })
})

describe('attempt2fa', () => {
  const credential = { username: 'u', password: 'p', portal_host: 'portal.example.com', totp_secret: SEED }

  it('derives the live TOTP code, fills it, submits, and reports success', async () => {
    const page = makePage({ start: '2fa' })
    const ok = await attempt2fa(page, credential)
    assert.equal(ok, true)
    assert.equal(page.filled.otp, generateTotp(SEED), 'typed the correct authenticator code')
    assert.equal(page.state, 'done', 'cleared the 2FA gate')
  })

  it('returns false when no TOTP seed is saved (other 2FA factor → hard-stop)', async () => {
    const page = makePage({ start: '2fa' })
    const ok = await attempt2fa(page, { ...credential, totp_secret: null })
    assert.equal(ok, false)
    assert.equal(page.filled.otp, undefined)
  })

  it('refuses to type a code into a different registrable domain (origin guard)', async () => {
    const page = makePage({ start: '2fa', host: 'evil-portal.com' })
    const ok = await attempt2fa(page, credential)
    assert.equal(ok, false)
    assert.equal(page.filled.otp, undefined)
  })
})
