import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addSyntheticHamiltonNetworkSurface, prepareSyntheticHamiltonEgress } from './helpers/hamiltonBrowserHarness.mjs'

import {
  _resetCloudInputRateLimits,
  consumeCloudInputRateLimit,
  setCloudLoginPrivateHeaders,
  validateCloudLoginInputEvent,
} from '../routes/hamiltonAutomation.js'
import {
  cancelCloudLogin,
  getCloudLoginMeta,
  startCloudLogin,
} from '../services/hamilton/hamiltonCloudLogin.js'

const sessions = []

function fakeLaunch({ navigationError = null } = {}) {
  let context
  const page = {
    goto: async () => { if (navigationError) throw navigationError },
    url: () => navigationError ? 'about:blank' : 'https://portal.example.org/resume/BearerPathSecret?token=QuerySecret#OtpSecret',
    on: () => {},
    isClosed: () => false,
    context: () => context,
  }
  context = {
    newPage: async () => page,
    pages: () => [page],
    on: () => {},
  }
  addSyntheticHamiltonNetworkSurface(context)
  const browser = { newContext: async () => context, close: vi.fn(async () => {}) }
  return async () => ({ browser, engine: 'fake' })
}

beforeEach(() => {
  _resetCloudInputRateLimits()
  process.env.HAMILTON_CLOUD_LOGIN_PROVIDER = 'self_hosted'
  process.env.HAMILTON_CLOUD_LOGIN_ENABLED = 'true'
})

afterEach(async () => {
  while (sessions.length) await cancelCloudLogin(sessions.pop())
  delete process.env.HAMILTON_CLOUD_LOGIN_PROVIDER
  delete process.env.HAMILTON_CLOUD_LOGIN_ENABLED
})

describe('Hamilton live-login privacy boundary', () => {
  it('uses isolated user/profile/session rate buckets and rejects control floods without echoing text', () => {
    const scope = { userId: 'u1', profileId: 'p1', liveSessionId: 'live-1', type: 'char', nowMs: 1_000 }
    for (let index = 0; index < 120; index += 1) {
      expect(consumeCloudInputRateLimit(scope).allowed).toBe(true)
    }
    expect(consumeCloudInputRateLimit(scope)).toMatchObject({ allowed: false, lane: 'control_or_text' })
    expect(consumeCloudInputRateLimit({ ...scope, liveSessionId: 'live-2' }).allowed).toBe(true)
    expect(consumeCloudInputRateLimit({ ...scope, userId: 'u2' }).allowed).toBe(true)

    const secret = 'OTP-123456-password-canary'
    const invalid = validateCloudLoginInputEvent({ type: 'char', text: secret.repeat(200) })
    expect(invalid).toEqual({ ok: false, reason: 'event_too_large' })
    expect(JSON.stringify(invalid)).not.toContain(secret)
  })

  it('marks frames and input responses private/no-store and disables stream buffering', () => {
    const headers = new Map()
    const res = { setHeader: (name, value) => headers.set(String(name).toLowerCase(), String(value)) }
    setCloudLoginPrivateHeaders(res, { stream: true })
    expect(headers.get('cache-control')).toContain('private')
    expect(headers.get('cache-control')).toContain('no-store')
    expect(headers.get('referrer-policy')).toBe('no-referrer')
    expect(headers.get('x-content-type-options')).toBe('nosniff')
    expect(headers.get('x-accel-buffering')).toBe('no')
    expect(headers.get('content-encoding')).toBe('identity')
  })

  it('never returns or retains tokenized login paths in exposed metadata or navigation failures', async () => {
    const secretUrl = 'https://portal.example.org/resume/BearerPathSecret?token=QuerySecret#OtpSecret'
    const failed = await startCloudLogin({
      userId: 'u1', profileId: 'p1', portalHost: 'portal.example.org', loginUrl: secretUrl,
      launchBrowser: fakeLaunch({ navigationError: new Error(`failed ${secretUrl}`) }),
      prepareBrowserEgress: prepareSyntheticHamiltonEgress,
    })
    expect(failed).toMatchObject({ ok: false, reason: 'navigation_failed', detail: 'portal_navigation_failed' })
    expect(JSON.stringify(failed)).not.toMatch(/BearerPathSecret|QuerySecret|OtpSecret/)

    const started = await startCloudLogin({
      userId: 'u1', profileId: 'p1', portalHost: 'portal.example.org', loginUrl: secretUrl,
      launchBrowser: fakeLaunch(),
      prepareBrowserEgress: prepareSyntheticHamiltonEgress,
    })
    expect(started.ok).toBe(true)
    sessions.push(started.liveSessionId)
    const meta = getCloudLoginMeta(started.liveSessionId)
    expect(meta.loginUrl).toBe('https://portal.example.org')
    expect(JSON.stringify(meta)).not.toMatch(/BearerPathSecret|QuerySecret|OtpSecret/)
  })
})
