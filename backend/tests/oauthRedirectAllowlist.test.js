/**
 * SECURITY: OAuth post-login redirect_to must not trust Origin/Referer.
 *
 * Concrete attack this pins closed:
 *   1. Attacker hosts https://evil.example with
 *        <a href="https://api…/api/auth/google?redirect_to=https://evil.example/steal">
 *   2. Victim clicks — browser sends Referer: https://evil.example/…
 *   3. Old sanitizeRedirectTarget ADDED the Referer origin to its allowlist,
 *      stored redirect_to=evil.example, and after Google login redirected to
 *      evil.example#handoff=<one-time-session-capability>.
 *   4. Attacker's page POSTs /oauth/complete with that handoff and receives
 *      the victim's access token.
 *
 * Mutation-verified: restoring Origin/Referer into the allowlist fails the
 * "Referer must not admit a foreign redirect_to" assertion below.
 */

import { describe, expect, it, afterEach } from 'vitest'
import {
  sanitizeRedirectTarget,
  configuredAuthOrigins,
  inferFrontendBaseUrl,
} from '../routes/auth.js'

const ORIG_ENV = { ...process.env }

function fakeReq({ origin = null, referer = null, host = 'api.axiombiolabs.org' } = {}) {
  return {
    protocol: 'https',
    headers: {},
    get(name) {
      const key = String(name).toLowerCase()
      if (key === 'origin') return origin
      if (key === 'referer') return referer
      if (key === 'host') return host
      return undefined
    },
  }
}

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIG_ENV)) delete process.env[key]
  }
  Object.assign(process.env, ORIG_ENV)
})

describe('sanitizeRedirectTarget — configured origins only', () => {
  it('admits a redirect_to on the configured frontend origin', () => {
    process.env.AUTH_FRONTEND_URL = 'https://app.axiombiolabs.org'
    const req = fakeReq({ referer: 'https://evil.example/phish' })
    const target = 'https://app.axiombiolabs.org/auth/callback'
    expect(sanitizeRedirectTarget(req, target)).toBe(target)
  })

  it('REFUSES a foreign redirect_to even when Referer matches the attacker origin', () => {
    process.env.AUTH_FRONTEND_URL = 'https://app.axiombiolabs.org'
    const req = fakeReq({ referer: 'https://evil.example/phish' })
    const stolen = sanitizeRedirectTarget(req, 'https://evil.example/steal')
    expect(stolen).not.toMatch(/evil\.example/)
    // Falls back to a configured / default frontend — never the attacker.
    expect(configuredAuthOrigins(req).has(new URL(stolen).origin)).toBe(true)
  })

  it('REFUSES a foreign redirect_to even when Origin matches the attacker origin', () => {
    process.env.AUTH_FRONTEND_URL = 'https://app.axiombiolabs.org'
    const req = fakeReq({ origin: 'https://evil.example' })
    const stolen = sanitizeRedirectTarget(req, 'https://evil.example/steal')
    expect(stolen).not.toMatch(/evil\.example/)
    expect(configuredAuthOrigins(req).has(new URL(stolen).origin)).toBe(true)
  })

  it('never grows the allowlist from request headers', () => {
    process.env.AUTH_FRONTEND_URL = 'https://app.axiombiolabs.org'
    const req = fakeReq({
      origin: 'https://evil.example',
      referer: 'https://evil.example/phish',
    })
    expect(configuredAuthOrigins(req).has('https://evil.example')).toBe(false)
  })
})

describe('inferFrontendBaseUrl — Origin only when already allowlisted', () => {
  it('ignores an unlisted Origin when AUTH_FRONTEND_URL is unset', () => {
    delete process.env.AUTH_FRONTEND_URL
    delete process.env.FRONTEND_BASE_URL
    const req = fakeReq({ origin: 'https://evil.example', host: 'api.axiombiolabs.org' })
    expect(inferFrontendBaseUrl(req)).not.toMatch(/evil\.example/)
  })

  it('accepts a localhost Origin that is already on the allowlist (Vite dev)', () => {
    delete process.env.AUTH_FRONTEND_URL
    delete process.env.FRONTEND_BASE_URL
    const req = fakeReq({ origin: 'http://localhost:5173', host: 'localhost:3001' })
    expect(inferFrontendBaseUrl(req)).toBe('http://localhost:5173')
  })
})
