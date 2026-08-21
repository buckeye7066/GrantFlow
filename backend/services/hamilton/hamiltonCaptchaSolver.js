/**
 * hamiltonCaptchaSolver.js
 *
 * The step BETWEEN "a portal showed a CAPTCHA" and "Hamilton kept going".
 *
 * WHY THIS EXISTS
 * ---------------
 * Owner goal 2026-08-21 (reaffirmed): under FULL AUTOMATION Hamilton finishes
 * submissions in every portal end to end. A CAPTCHA was an unconditional
 * hand-off — the resolver reused a saved session if one existed and otherwise
 * escalated ("Hamilton never solves CAPTCHAs"). That is the right default, and
 * it stays the default. This module adds ONE opt-in path: when the owner has
 * configured a CAPTCHA-solving service key AND the profile is in full
 * automation, Hamilton forwards the challenge to that service, waits a bounded
 * time for a token, and injects it — exactly the shape of the 2FA
 * `attemptAutomatedVerification` gate (bounded, once per gate, never throws,
 * falls through to the SAME hand-off on any failure).
 *
 * This is deliberately vendor-neutral over the widely-used HTTP solver API
 * shape (2captcha / capsolver / anti-captcha all speak it): a `createTask`-style
 * POST returns an id, a `getTaskResult`-style poll returns the token. The owner
 * points it at whichever provider they pay for via env; nothing is hard-wired
 * to one vendor, mirroring the CAPTCHA DETECTOR's own "captchas change; detection
 * must generalize" rule one layer down.
 *
 * WHAT THIS MODULE WILL NOT DO
 * ----------------------------
 * With NO key configured it returns immediately without calling anything, so a
 * deployment that has not opted in behaves exactly as it does today. It never
 * fabricates a token. It never touches identity proofing. And it is gated on
 * `fullAutomation` — the same single consent flag `resolveSubmissionDecision`
 * produces — so it can never run for a profile that did not authorize
 * end-to-end automation.
 */

import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:hamilton-captcha-solver')

const ENV = (typeof process !== 'undefined' && process?.env) ? process.env : {}

// Bounds. A portal that never returns a token must cost a bounded minute and
// then hand off, never spin — the same discipline as the verification gate.
export const DEFAULT_SOLVE_ATTEMPTS = 12
export const DEFAULT_SOLVE_INTERVAL_MS = 5_000
export const MAX_SOLVE_ATTEMPTS = 24
export const MAX_SOLVE_INTERVAL_MS = 15_000

function boundedInt(value, dflt, max) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1) return dflt
  return Math.min(Math.floor(n), max)
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms))
}

/**
 * Is a solver configured for this deployment? The key is the ONLY switch — no
 * key means the whole feature is off and the caller's existing hand-off applies
 * unchanged.
 */
export function isCaptchaSolverConfigured(env = ENV) {
  return Boolean(env.CAPTCHA_SOLVER_API_KEY && String(env.CAPTCHA_SOLVER_API_KEY).trim())
}

/**
 * Read the CAPTCHA's vendor + sitekey off the live page. Vendor-neutral: covers
 * the same families the detector does. Returns null when nothing recognisable
 * is present (an interstitial with no embedded widget → nothing to solve).
 */
export async function readCaptchaChallenge(page) {
  if (!page || typeof page.evaluate !== 'function') return null
  try {
    return await page.evaluate(() => {
      function attr(sel, name) {
        const el = document.querySelector(sel)
        return el ? (el.getAttribute(name) || '') : ''
      }
      // reCAPTCHA / hCaptcha / Turnstile all publish the sitekey as data-sitekey.
      const dataSite = attr('[data-sitekey]', 'data-sitekey')
      const recaptcha = document.querySelector('div.g-recaptcha, iframe[src*="recaptcha"]')
      const hcaptcha = document.querySelector('div.h-captcha, iframe[src*="hcaptcha"]')
      const turnstile = document.querySelector('div.cf-turnstile, iframe[src*="turnstile"]')
      let type = null
      if (recaptcha) type = 'recaptcha'
      else if (hcaptcha) type = 'hcaptcha'
      else if (turnstile) type = 'turnstile'
      const sitekey = dataSite
        || attr('div.g-recaptcha', 'data-sitekey')
        || attr('div.h-captcha', 'data-sitekey')
        || attr('div.cf-turnstile', 'data-sitekey')
      if (!type && !sitekey) return null
      return { type: type || 'unknown', sitekey: sitekey || null, pageUrl: window.location.href }
    })
  } catch {
    return null
  }
}

/**
 * Ask the configured solver service for a token. Vendor-neutral over the common
 * createTask/getTaskResult HTTP shape. Never throws — a failure is a REASON the
 * caller hands off with, not an exception that crashes a run that already
 * filled the whole form.
 */
export async function requestSolverToken(challenge, {
  env = ENV, fetchImpl = globalThis.fetch, now = () => Date.now(),
} = {}) {
  if (!isCaptchaSolverConfigured(env)) return { solved: false, reason: 'no_solver_configured' }
  if (!challenge?.sitekey) return { solved: false, reason: 'no_sitekey_on_page' }
  if (typeof fetchImpl !== 'function') return { solved: false, reason: 'no_fetch' }

  const base = String(env.CAPTCHA_SOLVER_URL || 'https://api.capsolver.com').replace(/\/+$/, '')
  const key = String(env.CAPTCHA_SOLVER_API_KEY).trim()
  const attempts = boundedInt(env.CAPTCHA_SOLVER_ATTEMPTS, DEFAULT_SOLVE_ATTEMPTS, MAX_SOLVE_ATTEMPTS)
  const interval = boundedInt(env.CAPTCHA_SOLVER_INTERVAL_MS, DEFAULT_SOLVE_INTERVAL_MS, MAX_SOLVE_INTERVAL_MS)

  const taskTypeByVendor = {
    recaptcha: 'ReCaptchaV2TaskProxyLess',
    hcaptcha: 'HCaptchaTaskProxyLess',
    turnstile: 'AntiTurnstileTaskProxyLess',
  }
  const taskType = taskTypeByVendor[challenge.type] || 'ReCaptchaV2TaskProxyLess'

  let taskId
  try {
    const createRes = await fetchImpl(`${base}/createTask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientKey: key,
        task: { type: taskType, websiteURL: challenge.pageUrl, websiteKey: challenge.sitekey },
      }),
    })
    const createBody = await createRes.json().catch(() => ({}))
    if (!createRes.ok || createBody?.errorId) {
      return { solved: false, reason: `create_task_failed:${createBody?.errorCode || createRes.status}` }
    }
    taskId = createBody.taskId
    if (!taskId) return { solved: false, reason: 'create_task_no_id' }
  } catch (err) {
    return { solved: false, reason: `create_task_error:${String(err?.message || err).slice(0, 80)}` }
  }

  const deadline = now() + attempts * interval + 5_000
  for (let i = 0; i < attempts; i += 1) {
    await sleep(interval)
    if (now() > deadline) break
    try {
      const pollRes = await fetchImpl(`${base}/getTaskResult`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientKey: key, taskId }),
      })
      const pollBody = await pollRes.json().catch(() => ({}))
      if (pollBody?.errorId) return { solved: false, reason: `poll_failed:${pollBody?.errorCode || 'error'}` }
      if (pollBody?.status === 'ready') {
        const token = pollBody?.solution?.gRecaptchaResponse
          || pollBody?.solution?.token
          || pollBody?.solution?.text
          || null
        if (!token) return { solved: false, reason: 'ready_without_token' }
        return { solved: true, token, vendor: challenge.type, attempts: i + 1 }
      }
      // status 'processing' → keep polling.
    } catch (err) {
      return { solved: false, reason: `poll_error:${String(err?.message || err).slice(0, 80)}` }
    }
  }
  return { solved: false, reason: 'solver_timed_out', attempts }
}

/**
 * Inject a solved token into the page's response fields and fire the change
 * handlers portals listen on. Vendor-neutral: reCAPTCHA/hCaptcha both read a
 * `*-response` textarea; Turnstile reads a hidden `cf-turnstile-response`
 * input. Best-effort — returns whether at least one field was set.
 */
export async function injectCaptchaToken(page, token) {
  if (!page || typeof page.evaluate !== 'function' || !token) return { injected: false }
  try {
    return await page.evaluate((tok) => {
      let set = 0
      const selectors = [
        'textarea#g-recaptcha-response',
        'textarea[name="g-recaptcha-response"]',
        'textarea[name="h-captcha-response"]',
        'input[name="cf-turnstile-response"]',
        'input[name="g-recaptcha-response"]',
      ]
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          el.value = tok
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
          set += 1
        }
      }
      return { injected: set > 0, fields: set }
    }, token)
  } catch {
    return { injected: false }
  }
}

/**
 * The single call site the engine needs, shaped exactly like
 * `attemptAutomatedVerification`: read the challenge, get a token, inject it.
 * Returns `{ solved: true }` only when a real token was obtained AND injected;
 * otherwise `{ solved: false, reason }` so the caller's existing hand-off
 * applies. Never throws. Gated on `fullAutomation` — with it false this returns
 * immediately without reading the page or calling any service.
 */
export async function attemptCaptchaSolve(page, {
  fullAutomation = false, env = ENV, fetchImpl = globalThis.fetch, now = () => Date.now(),
} = {}) {
  if (!fullAutomation) return { solved: false, reason: 'full_automation_off' }
  if (!isCaptchaSolverConfigured(env)) return { solved: false, reason: 'no_solver_configured' }
  const challenge = await readCaptchaChallenge(page)
  if (!challenge) return { solved: false, reason: 'no_solvable_challenge' }
  const result = await requestSolverToken(challenge, { env, fetchImpl, now })
  if (!result.solved) {
    log.info('captcha_solve_failed', { vendor: challenge.type, reason: result.reason })
    return result
  }
  const injected = await injectCaptchaToken(page, result.token)
  if (!injected.injected) return { solved: false, reason: 'token_not_injectable', vendor: challenge.type }
  return { solved: true, vendor: challenge.type, attempts: result.attempts }
}

export default {
  isCaptchaSolverConfigured,
  readCaptchaChallenge,
  requestSolverToken,
  injectCaptchaToken,
  attemptCaptchaSolve,
}
