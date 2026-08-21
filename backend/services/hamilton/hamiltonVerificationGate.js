/**
 * hamiltonVerificationGate.js
 *
 * The step BETWEEN "a portal asked for a one-time code" and "Hamilton typed it".
 *
 * WHY THIS EXISTS
 * ---------------
 * `hamiltonVerificationCodes.js` can READ the codes portal signup sends to
 * Hamilton's own mailbox and phone, and `hamiltonIdentity.js` decides that under
 * full automation signup registers under those channels. Neither of them had a
 * caller: an email/SMS verification wall still took the `needs_user` handoff,
 * so the two modules that exist precisely to clear that wall never ran.
 *
 * This module is the missing middle. It does exactly two things:
 *
 *   POLL  - ask `findVerificationCode` a BOUNDED number of times, spaced out,
 *           because the code is in flight when the wall appears. Bounded is the
 *           load-bearing word: a portal that never sends a code must cost a
 *           couple of minutes and then hand off, never spin.
 *
 *   ENTER - type the code that was actually READ into the page's code field and
 *           submit it.
 *
 * WHAT THIS MODULE WILL NOT DO
 * ----------------------------
 * It never fabricates a code. `enterVerificationCode` types only a string that
 * came back from `findVerificationCode`; there is no path here that invents,
 * guesses, or brute-forces one. When no code arrives, every function returns a
 * REASON and the caller's existing `needs_user` handoff applies unchanged.
 *
 * It is gated on `fullAutomation`. With the profile's full-automation consent
 * off, `pollForVerificationCode` returns immediately without reading anything -
 * Hamilton's mailbox is only consulted for a profile that authorized him to
 * register under it in the first place.
 *
 * It never touches identity PROOFING. An SSN / government ID / FSA ID /
 * Login.gov / ID.me wall is not a one-time code and is refused upstream by
 * `isIdentityProofedHost` before this module is ever reached.
 */
import { findVerificationCode } from './hamiltonVerificationCodes.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:hamilton-verification-gate')

/**
 * Bounds. The env vars tune the cadence for a slow portal; the HARD ceilings
 * below are what make "bounded" a property of the code rather than of the
 * deployment - a mis-set env can never turn this into an unbounded loop.
 */
export const DEFAULT_CODE_ATTEMPTS = 5
export const DEFAULT_CODE_INTERVAL_MS = 20_000
export const MAX_CODE_ATTEMPTS = 10
export const MAX_CODE_INTERVAL_MS = 60_000

function boundedAttempts(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CODE_ATTEMPTS
  return Math.min(Math.floor(n), MAX_CODE_ATTEMPTS)
}

function boundedInterval(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CODE_INTERVAL_MS
  return Math.min(Math.floor(n), MAX_CODE_INTERVAL_MS)
}

/** Attempts/interval resolved from env, already clamped. */
export function configuredCodePolling() {
  return {
    attempts: boundedAttempts(process.env.HAMILTON_VERIFICATION_CODE_ATTEMPTS ?? DEFAULT_CODE_ATTEMPTS),
    intervalMs: boundedInterval(process.env.HAMILTON_VERIFICATION_CODE_INTERVAL_MS ?? DEFAULT_CODE_INTERVAL_MS),
  }
}

/** Where a one-time code is typed. Ordered most-specific first. */
export const CODE_INPUT_SELECTORS = Object.freeze([
  'input[autocomplete="one-time-code"]:not([disabled])',
  'input[autocomplete*="one-time-code"]:not([disabled])',
  'input[name*="otp" i]:not([disabled])',
  'input[name*="one_time" i]:not([disabled])',
  'input[name*="onetime" i]:not([disabled])',
  'input[name*="verification" i]:not([disabled])',
  'input[name*="verify" i]:not([disabled])',
  'input[name*="securitycode" i]:not([disabled])',
  'input[name*="security_code" i]:not([disabled])',
  'input[name*="2fa" i]:not([disabled])',
  'input[id*="otp" i]:not([disabled])',
  'input[id*="verification" i]:not([disabled])',
  'input[name*="code" i]:not([name*="zip" i]):not([name*="postal" i]):not([name*="country" i]):not([name*="area" i]):not([disabled])',
  'input[id*="code" i]:not([id*="zip" i]):not([id*="postal" i]):not([id*="country" i]):not([disabled])',
])

/** The button that submits the typed code. */
export const CODE_SUBMIT_SELECTORS = Object.freeze([
  'button[type="submit"]:not([disabled])',
  'input[type="submit"]:not([disabled])',
  'button:has-text("Verify")',
  'button:has-text("Submit code")',
  'button:has-text("Confirm")',
  'button:has-text("Continue")',
  'button:has-text("Next")',
])

async function firstHandle(page, selectors) {
  for (const sel of selectors) {
    try {
      const h = await page.$(sel)
      if (h) return h
    } catch { /* try the next selector */ }
  }
  return null
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Ask both channels for a fresh code, a BOUNDED number of times.
 *
 * Returns `{ code, source, receivedAt, attempts }` on success, or
 * `{ code: null, reason, attempts }`. Never throws, never loops forever, and
 * never reads anything at all when full automation is off.
 *
 * @param {object} db
 * @param {object} opts
 * @param {boolean} opts.fullAutomation   profile consent (hasFullAutomation)
 * @param {number}  [opts.attempts]       clamped to MAX_CODE_ATTEMPTS
 * @param {number}  [opts.intervalMs]     clamped to MAX_CODE_INTERVAL_MS
 * @param {Function}[opts.sleep]          injectable delay (tests)
 * @param {Function}[opts.findCode]       injectable reader (tests)
 * @param {Function}[opts.getToken]       Graph token provider for the email lane
 */
export async function pollForVerificationCode(db, {
  fullAutomation = false,
  attempts = undefined,
  intervalMs = undefined,
  sleep = defaultSleep,
  findCode = findVerificationCode,
  ...codeOpts
} = {}) {
  if (!fullAutomation) {
    return { code: null, reason: 'full automation is not enabled for this profile', attempts: 0 }
  }
  const configured = configuredCodePolling()
  const maxAttempts = boundedAttempts(attempts ?? configured.attempts)
  const wait = boundedInterval(intervalMs ?? configured.intervalMs)

  let lastReason = 'no attempt was made'
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1 && wait > 0) await sleep(wait)
    let found
    try {
      found = await findCode(db, codeOpts)
    } catch (err) {
      found = { code: null, reason: `code lookup failed: ${err?.message || err}` }
    }
    if (found && found.code) {
      log.info('verification_code_found', { source: found.source || null, attempt })
      return { ...found, attempts: attempt }
    }
    lastReason = found?.reason || 'no code found'
  }
  return {
    code: null,
    attempts: maxAttempts,
    reason: `no verification code after ${maxAttempts} attempt(s): ${lastReason}`,
  }
}

/**
 * Type a code that was ACTUALLY READ into the page and submit it.
 *
 * Refuses an empty/blank code outright - there is deliberately no way to reach
 * a portal auth form from here without a string a channel handed back.
 */
export async function enterVerificationCode(page, code) {
  const value = String(code ?? '').trim()
  if (!value) return { entered: false, reason: 'no code to enter' }
  if (!page) return { entered: false, reason: 'no page to enter the code on' }

  const field = await firstHandle(page, CODE_INPUT_SELECTORS)
  if (!field) return { entered: false, reason: 'no verification-code field found on the page' }
  try {
    await field.fill('')
    await field.fill(value)
  } catch (err) {
    return { entered: false, reason: `could not type the code: ${err?.message || err}` }
  }

  const submit = await firstHandle(page, CODE_SUBMIT_SELECTORS)
  if (!submit) {
    // Some portals auto-submit a complete code. Try Enter, then report honestly.
    try { await field.press('Enter') } catch { /* nothing more to try */ }
    return { entered: true, submitted: false, reason: 'code entered; no submit button found' }
  }
  try {
    const navWait = page.waitForNavigation
      ? page.waitForNavigation({ timeout: 20_000, waitUntil: 'domcontentloaded' }).catch(() => null)
      : Promise.resolve(null)
    await submit.click()
    await Promise.race([navWait, defaultSleep(1500)])
    if (page.waitForLoadState) {
      await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => null)
    }
  } catch (err) {
    return { entered: true, submitted: false, reason: `code entered but submit failed: ${err?.message || err}` }
  }
  return { entered: true, submitted: true }
}

/**
 * Poll for a code and, if one arrives, enter it. The single call site a signup
 * or login driver needs.
 *
 * Returns `{ verified: true, source }` when a real code was read AND submitted,
 * otherwise `{ verified: false, reason, ... }` so the caller keeps its existing
 * `needs_user` handoff. Never throws.
 */
export async function attemptAutomatedVerification(db, page, opts = {}) {
  const found = await pollForVerificationCode(db, opts)
  if (!found.code) {
    return { verified: false, code_found: false, attempts: found.attempts, reason: found.reason }
  }
  const typed = await enterVerificationCode(page, found.code)
  if (!typed.entered || !typed.submitted) {
    return {
      verified: false,
      code_found: true,
      source: found.source || null,
      attempts: found.attempts,
      reason: typed.reason || 'the code was read but could not be submitted',
    }
  }
  return {
    verified: true,
    code_found: true,
    source: found.source || null,
    receivedAt: found.receivedAt || null,
    attempts: found.attempts,
  }
}

export default {
  pollForVerificationCode,
  enterVerificationCode,
  attemptAutomatedVerification,
  configuredCodePolling,
  CODE_INPUT_SELECTORS,
  CODE_SUBMIT_SELECTORS,
}
