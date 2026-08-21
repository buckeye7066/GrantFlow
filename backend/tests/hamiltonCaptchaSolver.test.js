/**
 * CAPTCHA SOLVING UNDER FULL AUTOMATION, OWNER-OPT-IN ONLY (owner goal
 * 2026-08-21: "finish submissions in every portal e2e completely autonomous").
 *
 * The DEFAULT is unchanged: with no solver key configured, a CAPTCHA remains
 * the human hand-off it always was (the resolver reuses a saved session or
 * escalates). This module adds one opt-in path — a key + full automation —
 * mirroring the 2FA verification gate: bounded, once per gate, never throws,
 * falls through to the same hand-off on any failure.
 *
 * Every "solves" test fails on the pre-change code (the module did not exist);
 * every "hands off" test encodes the unchanged default.
 */
import { describe, it, expect } from 'vitest'
import {
  isCaptchaSolverConfigured,
  readCaptchaChallenge,
  requestSolverToken,
  injectCaptchaToken,
  attemptCaptchaSolve,
} from '../services/hamilton/hamiltonCaptchaSolver.js'

const KEY_ENV = { CAPTCHA_SOLVER_API_KEY: 'test-key', CAPTCHA_SOLVER_INTERVAL_MS: '1' }

// A fake Playwright-ish page whose evaluate() runs the passed fn against a tiny
// DOM stub. The functions this module passes to evaluate only touch
// document.querySelector/querySelectorAll and window.location, so a minimal
// stub is enough and keeps the test hermetic.
function fakePage({ sitekey = null, vendor = null, responseFields = [] } = {}) {
  const nodes = []
  if (vendor === 'recaptcha') nodes.push({ sel: 'div.g-recaptcha', sitekey })
  if (vendor === 'hcaptcha') nodes.push({ sel: 'div.h-captcha', sitekey })
  if (vendor === 'turnstile') nodes.push({ sel: 'div.cf-turnstile', sitekey })
  const fieldEls = responseFields.map((sel) => ({ sel, value: '', events: [] }))
  const doc = {
    querySelector(sel) {
      if (sel === '[data-sitekey]' && sitekey) return { getAttribute: () => sitekey }
      const n = nodes.find((x) => sel.includes(x.sel.split('.')[1] || x.sel))
      if (sel.includes('recaptcha') && vendor === 'recaptcha') return {}
      if (sel.includes('hcaptcha') && vendor === 'hcaptcha') return {}
      if (sel.includes('turnstile') && vendor === 'turnstile') return {}
      if (n) return { getAttribute: () => n.sitekey }
      return null
    },
    querySelectorAll(sel) {
      return fieldEls.filter((f) => f.sel === sel).map((f) => ({
        set value(v) { f.value = v }, get value() { return f.value },
        dispatchEvent(e) { f.events.push(e?.type); return true },
      }))
    },
  }
  return {
    _fieldEls: fieldEls,
    async evaluate(fn, arg) {
      const g = globalThis
      const savedDoc = g.document, savedWin = g.window
      g.document = doc
      g.window = { location: { href: 'https://portal.example.org/apply' } }
      try { return await fn(arg) } finally { g.document = savedDoc; g.window = savedWin }
    },
  }
}

describe('isCaptchaSolverConfigured — the key is the only switch', () => {
  it('false with no key, true with a key', () => {
    expect(isCaptchaSolverConfigured({})).toBe(false)
    expect(isCaptchaSolverConfigured({ CAPTCHA_SOLVER_API_KEY: '  ' })).toBe(false)
    expect(isCaptchaSolverConfigured({ CAPTCHA_SOLVER_API_KEY: 'k' })).toBe(true)
  })
})

describe('readCaptchaChallenge', () => {
  it('reads vendor + sitekey off the page', async () => {
    const c = await readCaptchaChallenge(fakePage({ vendor: 'recaptcha', sitekey: '6Lc_test' }))
    expect(c).toMatchObject({ type: 'recaptcha', sitekey: '6Lc_test' })
  })
  it('returns null when no widget is present', async () => {
    expect(await readCaptchaChallenge(fakePage({}))).toBeNull()
  })
})

describe('attemptCaptchaSolve — the single call site', () => {
  it('does nothing without full automation (the unchanged default)', async () => {
    const res = await attemptCaptchaSolve(fakePage({ vendor: 'recaptcha', sitekey: 'k' }), { fullAutomation: false, env: KEY_ENV })
    expect(res).toEqual({ solved: false, reason: 'full_automation_off' })
  })
  it('does nothing with full automation but NO key (the unchanged default)', async () => {
    const res = await attemptCaptchaSolve(fakePage({ vendor: 'recaptcha', sitekey: 'k' }), { fullAutomation: true, env: {} })
    expect(res).toEqual({ solved: false, reason: 'no_solver_configured' })
  })
  it('hands off when the page has no solvable challenge', async () => {
    const res = await attemptCaptchaSolve(fakePage({}), { fullAutomation: true, env: KEY_ENV, fetchImpl: async () => ({}) })
    expect(res.solved).toBe(false)
    expect(res.reason).toBe('no_solvable_challenge')
  })

  it('solves and injects with key + full automation + a live solver', async () => {
    const calls = []
    const fetchImpl = async (url, opts) => {
      calls.push(url)
      if (url.endsWith('/createTask')) return { ok: true, json: async () => ({ taskId: 'T1' }) }
      if (url.endsWith('/getTaskResult')) return { ok: true, json: async () => ({ status: 'ready', solution: { gRecaptchaResponse: 'TOKEN123' } }) }
      throw new Error('unexpected url ' + url)
    }
    const page = fakePage({ vendor: 'recaptcha', sitekey: '6Lc_test', responseFields: ['textarea[name="g-recaptcha-response"]'] })
    const res = await attemptCaptchaSolve(page, { fullAutomation: true, env: KEY_ENV, fetchImpl })
    expect(res.solved).toBe(true)
    expect(res.vendor).toBe('recaptcha')
    expect(calls.some((u) => u.endsWith('/createTask'))).toBe(true)
    expect(page._fieldEls[0].value).toBe('TOKEN123')
    expect(page._fieldEls[0].events).toContain('change')
  })

  it('hands off (never throws) when the solver service errors', async () => {
    const fetchImpl = async (url) => (url.endsWith('/createTask')
      ? { ok: false, status: 402, json: async () => ({ errorId: 1, errorCode: 'ERROR_ZERO_BALANCE' }) }
      : { ok: true, json: async () => ({}) })
    const page = fakePage({ vendor: 'recaptcha', sitekey: 'k' })
    const res = await attemptCaptchaSolve(page, { fullAutomation: true, env: KEY_ENV, fetchImpl })
    expect(res.solved).toBe(false)
    expect(res.reason).toContain('create_task_failed')
  })

  it('reports a token it obtained but could not inject as unsolved', async () => {
    const fetchImpl = async (url) => (url.endsWith('/createTask')
      ? { ok: true, json: async () => ({ taskId: 'T1' }) }
      : { ok: true, json: async () => ({ status: 'ready', solution: { token: 'TOK' } }) })
    // No response field on the page → injection sets nothing.
    const page = fakePage({ vendor: 'turnstile', sitekey: 'k', responseFields: [] })
    const res = await attemptCaptchaSolve(page, { fullAutomation: true, env: KEY_ENV, fetchImpl })
    expect(res.solved).toBe(false)
    expect(res.reason).toBe('token_not_injectable')
  })
})

describe('requestSolverToken', () => {
  it('refuses without a key or without a sitekey', async () => {
    expect((await requestSolverToken({ sitekey: 'k' }, { env: {} })).reason).toBe('no_solver_configured')
    expect((await requestSolverToken({ sitekey: null }, { env: KEY_ENV })).reason).toBe('no_sitekey_on_page')
  })
})

describe('injectCaptchaToken', () => {
  it('sets the response field and fires change', async () => {
    const page = fakePage({ responseFields: ['input[name="cf-turnstile-response"]'] })
    const r = await injectCaptchaToken(page, 'ABC')
    expect(r.injected).toBe(true)
    expect(page._fieldEls[0].value).toBe('ABC')
  })
  it('reports not-injected when there is no field and never throws', async () => {
    const r = await injectCaptchaToken(fakePage({ responseFields: [] }), 'ABC')
    expect(r.injected).toBe(false)
  })
})
