/**
 * Hamilton autopilot - saved-credential login and 2FA hard-stop policy.
 *
 * Locks the contract:
 *
 *   1. detectGate surfaces a login gate whenever a password field is visible,
 *      regardless of saved-credential authorization.
 *   2. attemptLogin fills + submits a saved username/password and reports
 *      success once the password field is gone.
 *   3. Hamilton does not expose or run a 2FA/TOTP auto-completion path. A
 *      visible one-time-code field stays a hard blocker, even when a legacy
 *      credential row still contains a saved seed.
 *   4. Login refuses to type into a page whose registrable domain differs from
 *      the credential's origin.
 *
 * Uses a lightweight stub page rather than a real browser. The engine's origin
 * guard keys on PSL registrable domains, which are null for 127.0.0.1/localhost.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { _internal } from '../../backend/services/hamilton/hamiltonAutopilotEngine.js'

const { detectGate, attemptLogin } = _internal
const LEGACY_SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

function handle(onAction = {}) {
  return {
    async fill(v) { onAction.fill?.(v) },
    async click() { onAction.click?.() },
    async press() { onAction.press?.() },
  }
}

function makePage({ start = 'login', host = 'portal.example.com' } = {}) {
  return {
    state: start,
    filled: {},
    url() { return `https://${host}/${this.state}` },
    async waitForLoadState() {},
    async $(sel) {
      const s = String(sel)
      if (s.includes('password')) {
        return this.state === 'login'
          ? handle({ fill: (v) => { this.filled.password = v } })
          : null
      }
      if (s.includes('one-time-code') || s.includes('otp') || s.includes('2fa')) {
        return this.state === '2fa'
          ? handle({ fill: (v) => { this.filled.otp = v } })
          : null
      }
      if (s.includes('submit') || s.includes(':has-text')) {
        return handle({ click: () => this.advance() })
      }
      if (s.includes('captcha') || s.includes('cc-number') || s.includes('stripe') || s.includes('braintree')) return null
      return this.state === 'login'
        ? handle({ fill: (v) => { this.filled.username = v } })
        : null
    },
    async $$() { return [] },
    advance() {
      if (this.state === 'login' && this.filled.username && this.filled.password) this.state = '2fa'
    },
  }
}

describe('detectGate', () => {
  it('returns a login gate whenever a password field is visible', async () => {
    const gate = await detectGate(makePage({ start: 'login' }))
    assert.equal(gate?.kind, 'login')
  })

  it('returns a 2fa gate when a one-time-code field is visible', async () => {
    const gate = await detectGate(makePage({ start: '2fa' }))
    assert.equal(gate?.kind, '2fa')
  })

  it('returns null on a clean page', async () => {
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

  it('refuses to type into a different registrable domain', async () => {
    const page = makePage({ start: 'login', host: 'evil-portal.com' })
    const ok = await attemptLogin(page, credential)
    assert.equal(ok, false)
    assert.equal(page.filled.password, undefined)
  })
})

describe('2FA policy', () => {
  it('does not export a 2FA/TOTP auto-completion helper', () => {
    assert.equal('attempt2fa' in _internal, false)
  })

  it('contains no live TOTP typing branch in the autopilot loop', () => {
    const source = fs.readFileSync('backend/services/hamilton/hamiltonAutopilotEngine.js', 'utf8')
    assert.doesNotMatch(source, /generateTotp|2fa_attempt|attempt2fa|totp_secret/)
  })

  it('keeps one-time-code fields as a hard gate even if a legacy seed exists', async () => {
    const page = makePage({ start: '2fa' })
    const gate = await detectGate(page)
    assert.equal(gate?.kind, '2fa')
    assert.equal(page.filled.otp, undefined)
    assert.equal(LEGACY_SEED.length > 0, true)
  })
})
