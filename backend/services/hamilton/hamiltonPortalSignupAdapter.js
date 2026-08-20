/**
 * hamiltonPortalSignupAdapter.js
 *
 * The "HANDS" of Portal Autopilot Identity. The autopilot BRAIN
 * (hamiltonPortalAutopilotIdentity) decides WHEN a portal should be registered
 * and provisions the unique master-wrapped password; THIS module performs the
 * actual browser-driven account REGISTRATION on the third-party portal's own
 * signup form and reports a structured `registrationResult` the brain feeds back
 * into its escalation state machine.
 *
 * ── Architecture ──────────────────────────────────────────────────────────────
 *   - A GENERIC heuristic adapter (the default): detect a standard signup form on
 *     the page (email input, password + confirm-password, name/first/last fields,
 *     a "Create account / Sign up" submit button), fill from the identity+profile,
 *     submit, and classify the outcome from the resulting page.
 *   - A PER-HOST adapter REGISTRY keyed by registrable host (eTLD+1) so a specific
 *     portal can override the generic flow with precise selectors / multi-step
 *     steps. Adding a new per-host adapter is a ONE-OBJECT change to
 *     HOST_ADAPTERS. Hosts without an entry fall back to the generic adapter.
 *
 * ── registrationResult contract ───────────────────────────────────────────────
 *   {
 *     status: 'registered' | 'blocked' | 'already_exists'
 *           | 'verification_pending' | 'failed',
 *     blockerType?: <hamiltonBlockerClassifier category, on 'blocked'>,
 *     blocker_kind?: <raw engine-style kind the brain re-classifies>,
 *     blocker_detail?: string,
 *     evidence?: { url, signal, ... },
 *     message?: string,
 *   }
 *   The brain treats anything !== 'registered' (and !== 'already_exists') as a
 *   blocker/handoff via classifyBlocker. `already_exists` means an account is
 *   already on the portal for this identity → use existing-credential login.
 *
 * ── Safety rails (defense in depth — the brain enforces these too) ─────────────
 *   - IDENTITY-PROOFED hosts (isIdentityProofedHost) are NEVER attempted — we
 *     return blocked(identity_proof_required) so the brain routes to co-browse.
 *     Hamilton never fabricates SSN / government-ID / identity proofing.
 *   - Browser automation must be globally enabled (HAMILTON_ENABLE_BROWSER_AUTOMATION)
 *     AND the host allowlisted (HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST). When
 *     not permitted we DON'T launch — we return a state the brain maps to
 *     automation_disabled.
 *   - Any blocker the adapter can't lawfully/technically pass (CAPTCHA, anti-bot,
 *     2FA, ToS-forbids-automation, payment, unknown form) → `blocked` with a
 *     blockerType; the brain drops to the side-by-side co-browse (last resort).
 *   - Registration creates an ACCOUNT only. It NEVER submits an application and
 *     NEVER touches the autosubmit / authorization / payment gates.
 */

import fs from 'node:fs'
import { launchPortalBrowser, REALISTIC_PORTAL_UA } from './browserLaunch.js'
import {
  controlledBetaBrowserContextOptions,
  installControlledBetaBrowserEgressGuard,
  installPortalBrowserEgressGuard,
  isControlledBetaSyntheticBrowserUrl,
  isPublicHttpsPortalUrl,
} from './controlledBetaBrowserPolicy.js'
import { registrableDomain } from './hamiltonPortalCredentialService.js'
import { browserAutomationPermittedForUrl, isBrowserAutomationEnabled } from './hamiltonAutomationOrchestrator.js'
import { isIdentityProofedHost, getPolicyFor } from './hamiltonPortalPolicyRegistry.js'
import { classifyBlocker } from './hamiltonBlockerClassifier.js'
import { hostOfUrl } from './hamiltonMissingCredential.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:hamilton-portal-signup-adapter')

const NAV_TIMEOUT_MS = Number(process.env.HAMILTON_SIGNUP_NAV_TIMEOUT_MS) || 25_000
const STEP_TIMEOUT_MS = Number(process.env.HAMILTON_SIGNUP_STEP_TIMEOUT_MS) || 8_000
// How long to wait, total, for a verification email to land before returning
// verification_pending (the brain then routes to co-browse / leaves it for the
// user). Kept short so the adapter never blocks indefinitely.
const VERIFY_WAIT_MS = Number(process.env.HAMILTON_SIGNUP_VERIFY_WAIT_MS) || 45_000
const VERIFY_POLL_MS = Number(process.env.HAMILTON_SIGNUP_VERIFY_POLL_MS) || 7_000

// No real host-specific account-creation executor has completed an independent
// reviewed adapter contract in this release. Keep the legacy parser/driver
// testable as isolated helpers, but never let a production entry point launch
// it until that contract exists.
export function reviewedPortalSignupExecutionEnabled() { return false }
export function automaticMailboxVerificationEnabled() { return false }

// ── Result helpers ────────────────────────────────────────────────────────────

function ok(status, extra = {}) { return { status, ...extra } }
function blocked(blockerType, { blockerKind = null, detail = null, evidence = null, message = null } = {}) {
  return {
    status: 'blocked',
    blockerType,
    blocker_kind: blockerKind || blockerType,
    blocker_detail: detail || message || blockerType,
    evidence: evidence || null,
    message: message || `Registration blocked: ${blockerType}`,
  }
}

// ── Outcome-signal text matchers (shared by generic + per-host adapters) ───────
// "account already exists" copy → already_exists (use existing-cred login).
const ALREADY_EXISTS_RX = /\b(already\s+(registered|have\s+an?\s+account|exists|in\s+use|taken)|account\s+already|email\s+(is\s+)?already\s+(registered|taken|in\s+use)|an\s+account\s+with\s+(this|that)\s+email|user(name)?\s+(already\s+)?(exists|taken)|duplicate\s+account)\b/i
// "check your email / verify" copy → verification_pending (best-effort verify).
const VERIFY_EMAIL_RX = /\b(verify\s+your\s+e?-?mail|confirm(ation)?\s+(e?-?mail|link|your\s+e?-?mail)|check\s+your\s+(e?-?mail|inbox)|we('|’)?ve\s+sent\s+(you\s+)?an?\s+e?-?mail|activation\s+(e?-?mail|link)|a\s+confirmation\s+(link|e?-?mail)\s+(has\s+been\s+)?sent|please\s+confirm\s+your)\b/i
// success copy (account created / welcome / dashboard).
const SUCCESS_RX = /\b(account\s+(created|registered|has\s+been\s+created)|welcome|registration\s+(complete|successful)|you('|’)?re\s+(all\s+)?(set|registered)|sign(ed)?\s*[-\s]?in|dashboard|my\s+account|thank\s+you\s+for\s+(registering|signing\s+up)|successfully\s+(created|registered))\b/i
const SUCCESS_URL_RX = /\/(dashboard|account|home|welcome|portal|overview|profile|getting-started|onboarding)\b/i

// ── Playwright page primitives (kept defensive — every $ is best-effort) ───────

async function firstSelector(page, selectors) {
  for (const sel of selectors) {
    try {
      const h = await page.$(sel)
      if (h) return h
    } catch { /* try next */ }
  }
  return null
}

async function fillIfPresent(page, selectors, value) {
  if (value === undefined || value === null || String(value).trim() === '') return false
  const handle = await firstSelector(page, selectors)
  if (!handle) return false
  try {
    await handle.fill('')
    await handle.fill(String(value), { timeout: STEP_TIMEOUT_MS })
    return true
  } catch { return false }
}

async function pageText(page) {
  try { return (await page.evaluate(() => document.body?.innerText || '')) || '' }
  catch {
    try { return (await page.content()) || '' } catch { return '' }
  }
}

function safeUrl(page) { try { return page.url() } catch { return '' } }

/**
 * Detect a hard registration BLOCKER on the live page (CAPTCHA, 2FA, payment,
 * anti-bot, terms-forbid). Returns a classifier category or null. Mirrors the
 * autopilot engine's gate heuristics so a portal that gates SIGNUP the same way
 * it gates LOGIN is caught here too.
 */
async function detectSignupBlocker(page) {
  // CAPTCHA / anti-bot widgets.
  const captcha = await firstSelector(page, [
    'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', 'div.g-recaptcha',
    'div[class*="captcha" i]', 'iframe[title*="captcha" i]', 'div[class*="turnstile" i]',
    'iframe[src*="challenges.cloudflare"]',
  ])
  if (captcha) return 'captcha_required'
  // Payment widget on signup (paywalled registration).
  const pay = await firstSelector(page, [
    'input[autocomplete="cc-number"]', 'iframe[src*="stripe.com"]', 'iframe[src*="braintree"]',
    'iframe[title*="card" i]',
  ])
  if (pay) return 'payment_required'
  // OTP / 2FA on signup.
  const otp = await firstSelector(page, [
    'input[autocomplete*="one-time-code"]', 'input[name*="otp" i]', 'input[name*="2fa" i]',
  ])
  if (otp) return 'two_factor_required'
  // Text-driven anti-bot / ToS / blocked copy.
  const text = (await pageText(page)).slice(0, 6000)
  if (text) {
    const cls = classifyBlocker({ text, url: safeUrl(page) })
    if (['portal_anti_bot_block', 'portal_terms_block', 'sso_required'].includes(cls.category)) {
      return cls.category
    }
  }
  return null
}

/**
 * Classify the page AFTER a submit attempt into a registrationResult status.
 * Order: explicit blocker → already_exists → success → verify-email →
 * still-on-a-form (blocked unknown) → unknown.
 */
async function classifyOutcome(page, { beforeUrl } = {}) {
  const blocker = await detectSignupBlocker(page)
  if (blocker) {
    return blocked(blocker, { evidence: { url: safeUrl(page), signal: 'post_submit_gate' } })
  }
  const text = (await pageText(page)).slice(0, 8000)
  const url = safeUrl(page)
  if (ALREADY_EXISTS_RX.test(text)) {
    return ok('already_exists', { evidence: { url, signal: 'already_exists_copy' }, message: 'An account already exists for this email; Hamilton will use the existing login.' })
  }
  if (VERIFY_EMAIL_RX.test(text)) {
    return ok('verification_pending', { evidence: { url, signal: 'verify_email_copy' }, message: 'Account created — the portal asked to verify the email.' })
  }
  if (SUCCESS_RX.test(text) || (SUCCESS_URL_RX.test(url) && (!beforeUrl || url !== beforeUrl))) {
    return ok('registered', { evidence: { url, signal: SUCCESS_URL_RX.test(url) ? 'success_url' : 'success_copy' }, message: 'Account created.' })
  }
  // Validation errors still on the form → ambiguous; let the brain decide via
  // the unknown-form blocker (co-browse) rather than claim success.
  const stillHasPassword = await firstSelector(page, ['input[type="password"]'])
  if (stillHasPassword) {
    // Same signup form is still up (registration didn't take). Surface any
    // visible error text for the audit trail.
    const errText = await visibleErrors(page)
    return blocked('unknown_application_method', {
      blockerKind: 'no_progress',
      detail: errText || 'Signup form still present after submit; outcome unrecognized.',
      evidence: { url, signal: 'form_persisted', errors: errText || null },
      message: 'Hamilton could not confirm the account was created; handing to a side-by-side login.',
    })
  }
  // No password field, no recognizable success/verify copy — treat as registered
  // only when we navigated away; otherwise unknown.
  if (beforeUrl && url && url !== beforeUrl) {
    return ok('registered', { evidence: { url, signal: 'navigated_away' }, message: 'Account created (navigated past the signup form).' })
  }
  return blocked('unknown_application_method', {
    blockerKind: 'no_progress',
    detail: 'Signup outcome could not be determined.',
    evidence: { url, signal: 'indeterminate' },
    message: 'Hamilton could not determine the signup result; handing to a side-by-side login.',
  })
}

async function visibleErrors(page) {
  try {
    const errs = await page.$$eval('[role="alert"], .error, .invalid-feedback, .field-error, [aria-invalid="true"]', (els) => {
      const out = []
      for (const el of els) {
        const t = (el.innerText || '').trim()
        if (t && t.length < 300) out.push(t)
      }
      return out.slice(0, 5)
    })
    return (errs || []).join(' | ') || null
  } catch { return null }
}

// ── Profile → identity field reader ────────────────────────────────────────────

function pick(obj, paths) {
  if (!obj) return undefined
  for (const p of paths) {
    let cur = obj
    let bad = false
    for (const seg of p.split('.')) {
      if (cur === null || cur === undefined) { bad = true; break }
      cur = cur[seg]
    }
    if (!bad && cur !== null && cur !== undefined && String(cur).trim() !== '') return cur
  }
  return undefined
}

/**
 * The identity fields a signup form typically needs, resolved from the profile
 * bundle + the autopilot identity email. Password is the generated, master-wrapped
 * password the brain produced — passed in, never read from the profile.
 */
export function buildSignupIdentity({ profile = {}, identityEmail, password } = {}) {
  const first = pick(profile, ['basic_information.first_name', 'first_name'])
  const last = pick(profile, ['basic_information.last_name', 'last_name'])
  const full = [first, last].filter(Boolean).join(' ') || pick(profile, ['display_name', 'full_name'])
  return {
    email: identityEmail || pick(profile, ['basic_information.email', 'email']) || null,
    password: password || null,
    first_name: first || null,
    last_name: last || null,
    full_name: full || null,
    phone: pick(profile, ['basic_information.phone', 'phone']) || null,
  }
}

// ── GENERIC heuristic adapter ──────────────────────────────────────────────────

const EMAIL_SELECTORS = [
  'input[type="email"]:not([disabled])',
  'input[name*="email" i]:not([disabled])',
  'input[id*="email" i]:not([disabled])',
  'input[autocomplete="email"]:not([disabled])',
  'input[name="username" i]:not([disabled])',
]
const PASSWORD_SELECTORS = [
  'input[type="password"][autocomplete="new-password"]:not([disabled])',
  'input[name*="password" i]:not([name*="confirm" i]):not([disabled])',
  'input[id*="password" i]:not([id*="confirm" i]):not([disabled])',
  'input[type="password"]:not([disabled])',
]
const CONFIRM_PASSWORD_SELECTORS = [
  'input[name*="confirm" i][type="password"]:not([disabled])',
  'input[id*="confirm" i][type="password"]:not([disabled])',
  'input[name*="password" i][name*="2" i][type="password"]:not([disabled])',
  'input[name*="re-enter" i][type="password"]:not([disabled])',
  'input[name*="repeat" i][type="password"]:not([disabled])',
]
const FIRST_NAME_SELECTORS = [
  'input[name*="first" i]:not([disabled])', 'input[id*="first" i]:not([disabled])',
  'input[autocomplete="given-name"]:not([disabled])', 'input[name="fname" i]:not([disabled])',
]
const LAST_NAME_SELECTORS = [
  'input[name*="last" i]:not([disabled])', 'input[id*="last" i]:not([disabled])',
  'input[autocomplete="family-name"]:not([disabled])', 'input[name="lname" i]:not([disabled])',
  'input[name*="surname" i]:not([disabled])',
]
const FULL_NAME_SELECTORS = [
  'input[autocomplete="name"]:not([disabled])',
  'input[name="name" i]:not([disabled])', 'input[id="name" i]:not([disabled])',
  'input[name*="full" i]:not([disabled])',
]
const SUBMIT_SELECTORS = [
  'button[type="submit"]:not([disabled])',
  'input[type="submit"]:not([disabled])',
  'button:has-text("Create account")', 'button:has-text("Sign up")',
  'button:has-text("Sign Up")', 'button:has-text("Register")',
  'button:has-text("Create Account")', 'button:has-text("Get started")',
  'button:has-text("Join")', 'button:has-text("Continue")',
  'a[role="button"]:has-text("Sign up")',
]

/**
 * Generic heuristic signup driver. Detects + fills the standard fields, submits,
 * and classifies the outcome. Returns a registrationResult.
 */
export async function genericSignupAdapter(page, identity, { signupUrl } = {}) {
  // Detect a form: at minimum we need a password field and an email field.
  const emailField = await firstSelector(page, EMAIL_SELECTORS)
  const passField = await firstSelector(page, PASSWORD_SELECTORS)
  if (!emailField || !passField) {
    // No recognizable signup form — could be a JS-gated page, an SSO-only signup,
    // or anti-bot. Re-check for an explicit blocker, else "unknown form".
    const blocker = await detectSignupBlocker(page)
    if (blocker) return blocked(blocker, { evidence: { url: safeUrl(page), signal: 'no_form_gate' } })
    return blocked('unknown_application_method', {
      blockerKind: 'no_progress',
      detail: 'No standard signup form (email + password) detected on the page.',
      evidence: { url: safeUrl(page), signal: 'no_signup_form' },
      message: 'Hamilton could not find a standard signup form; handing to a side-by-side login.',
    })
  }

  // A pre-submit blocker (CAPTCHA shown alongside the form) is still a hard stop.
  const preBlocker = await detectSignupBlocker(page)
  if (preBlocker) return blocked(preBlocker, { evidence: { url: safeUrl(page), signal: 'pre_submit_gate' } })

  // Fill the form.
  await fillIfPresent(page, EMAIL_SELECTORS, identity.email)
  await fillIfPresent(page, PASSWORD_SELECTORS, identity.password)
  await fillIfPresent(page, CONFIRM_PASSWORD_SELECTORS, identity.password)
  // Name: prefer first/last, else a single full-name field.
  const filledFirst = await fillIfPresent(page, FIRST_NAME_SELECTORS, identity.first_name)
  const filledLast = await fillIfPresent(page, LAST_NAME_SELECTORS, identity.last_name)
  if (!filledFirst && !filledLast) {
    await fillIfPresent(page, FULL_NAME_SELECTORS, identity.full_name)
  }
  await fillIfPresent(page, ['input[type="tel"]:not([disabled])', 'input[name*="phone" i]:not([disabled])'], identity.phone)

  // Submit.
  const beforeUrl = safeUrl(page)
  const submit = await firstSelector(page, SUBMIT_SELECTORS)
  if (!submit) {
    return blocked('unknown_application_method', {
      blockerKind: 'no_progress',
      detail: 'Signup form found but no submit / create-account button.',
      evidence: { url: beforeUrl, signal: 'no_submit_button' },
      message: 'Hamilton found a signup form but no submit button; handing to a side-by-side login.',
    })
  }
  try {
    const navWait = page.waitForNavigation({ timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' }).catch(() => null)
    await submit.click({ timeout: STEP_TIMEOUT_MS })
    await Promise.race([navWait, new Promise((r) => setTimeout(r, 2000))])
    await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT_MS }).catch(() => null)
    // Give SPA portals a moment to render the result state.
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => null)
  } catch {
    /* fall through to classification — the page may have changed regardless */
  }

  void signupUrl
  return classifyOutcome(page, { beforeUrl })
}

// ── PER-HOST adapter REGISTRY ──────────────────────────────────────────────────
//
// Keyed by registrable host (eTLD+1). Each entry is { signupUrl?, adapter }.
// `adapter(page, identity, ctx)` returns a registrationResult. Add a new entry =
// one object. Seeded with a few WELL-KNOWN, SIMPLE (non-identity-proofed)
// scholarship/benefit portals whose hosts appear in the provider catalogue /
// policy registry. Each is a thin wrapper over the generic driver with a known
// signup URL — the precise per-step selectors can be hardened later against a
// live capture; until then the generic heuristic still drives the form correctly.
//
// NB: Identity-proofed hosts (studentaid.gov, login.gov, id.me, …) are
// deliberately NOT listed — they must never be auto-registered (the brain + this
// adapter both refuse them).
export const HOST_ADAPTERS = Object.freeze({
  // AwardSpring — common white-label scholarship application platform. Standard
  // email/password signup; no identity proofing.
  'awardspring.com': Object.freeze({
    signupUrl: null, // per-tenant subdomain; the resolved loginUrl is used.
    adapter: genericSignupAdapter,
  }),
  // CommunityForce — scholarship management portal with a standard register form.
  'communityforce.com': Object.freeze({
    signupUrl: null,
    adapter: genericSignupAdapter,
  }),
  // Kaleidoscope (mykaleidoscope) — scholarship platform, standard signup.
  'mykaleidoscope.com': Object.freeze({
    signupUrl: null,
    adapter: genericSignupAdapter,
  }),
  // Scholarship America's Scholarship Manager — standard account creation.
  'scholarsapply.org': Object.freeze({
    signupUrl: null,
    adapter: genericSignupAdapter,
  }),
})

/** Resolve the per-host adapter for a registrable host, or null. */
export function resolveHostAdapter(portalHost) {
  const host = registrableDomain(portalHost) || hostOfUrl(portalHost) || String(portalHost || '').toLowerCase()
  if (!host) return null
  if (HOST_ADAPTERS[host]) return { host, ...HOST_ADAPTERS[host] }
  // suffix match: sub.awardspring.com → awardspring.com
  for (const key of Object.keys(HOST_ADAPTERS)) {
    if (host.endsWith(`.${key}`)) return { host: key, ...HOST_ADAPTERS[key] }
  }
  return null
}

// ── Email verification (best-effort, via John's Graph mailbox) ─────────────────

const CONFIRM_LINK_RX = /https?:\/\/[^\s"'<>)]+(?:verify|confirm|activate|activation|validate|token|signup|register)[^\s"'<>)]*/i

/** Extract the most likely confirmation URL from an email body (HTML or text). */
export function extractConfirmationLink(body) {
  const s = String(body || '')
  // Prefer an href that looks like a confirm/verify link.
  const hrefRx = /href=["']([^"']+)["']/gi
  let m
  const candidates = []
  while ((m = hrefRx.exec(s)) !== null) candidates.push(m[1])
  for (const c of candidates) {
    if (CONFIRM_LINK_RX.test(c)) return c
  }
  // Fall back to a bare URL in the text.
  const bare = s.match(CONFIRM_LINK_RX)
  if (bare) return bare[0]
  // Last resort: any first http link in the email (some portals use opaque URLs).
  const anyLink = candidates.find((c) => /^https?:\/\//i.test(c))
  return anyLink || null
}

/**
 * Best-effort: find the portal's verification email to the autopilot identity
 * address and visit the confirmation link. Returns:
 *   { status: 'registered' }            — link found + visited successfully
 *   { status: 'verification_pending' }  — mailbox unavailable / no link in window
 *
 * Never blocks indefinitely: polls the mailbox for at most VERIFY_WAIT_MS. The
 * Graph provider + browser context are injectable so tests pass fakes (no network).
 */
export async function completeEmailVerification({
  identityEmail, portalHost, browserContext = null,
  outlookProvider = null, now = () => Date.now(),
  waitMs = VERIFY_WAIT_MS, pollMs = VERIFY_POLL_MS,
  // How far back to look for the verification email. Short for the inline
  // post-signup attempt (the mail just arrived); much longer for a later
  // re-check, where the email may have landed hours ago.
  lookbackMs = 10 * 60 * 1000,
} = {}) {
  if (!automaticMailboxVerificationEnabled()) {
    void identityEmail; void portalHost; void browserContext; void outlookProvider
    void now; void waitMs; void pollMs; void lookbackMs
    return ok('verification_pending', {
      message: 'Email activation requires owner action. Hamilton does not read the mailbox or open activation links.',
      blocker_kind: 'manual_email_verification_required',
    })
  }
  if (!identityEmail) {
    return ok('verification_pending', { message: 'No autopilot identity email to verify.' })
  }
  let provider = outlookProvider
  if (!provider) {
    try {
      const { createOutlookProvider } = await import('../john/johnOutlookProvider.js')
      provider = createOutlookProvider()
    } catch { provider = null }
  }
  if (!provider || provider.notConfigured || typeof provider.listInboxMessages !== 'function') {
    return ok('verification_pending', { message: 'Verification mailbox not accessible; left for the user to confirm.' })
  }

  const wantHost = registrableDomain(portalHost) || hostOfUrl(portalHost) || String(portalHost || '').toLowerCase()
  const deadline = now() + Math.max(0, waitMs)
  const sinceIso = new Date(now() - Math.max(60 * 1000, lookbackMs)).toISOString()
  let link = null
  // Poll the inbox a few times within the window. We do NOT sleep below the poll
  // interval more than once past the deadline.
  for (;;) {
    let messages = []
    try {
      const res = await provider.listInboxMessages({ top: 25, sinceIso })
      messages = Array.isArray(res?.messages) ? res.messages : []
    } catch (err) {
      log.warn('verify_inbox_read_failed', { portalHost: wantHost, err: err?.message })
      return ok('verification_pending', { message: 'Could not read the verification mailbox; left for the user.' })
    }
    // Pick emails plausibly from this portal (sender domain or body mentions host).
    for (const msg of messages) {
      const fromAddr = String(msg?.from?.emailAddress?.address || '').toLowerCase()
      const fromDomain = registrableDomain(fromAddr.split('@')[1] || '') || ''
      const body = msg?.body?.content || msg?.bodyPreview || ''
      const mentionsHost = wantHost && (fromDomain === wantHost || String(body).toLowerCase().includes(wantHost))
      const looksVerify = VERIFY_EMAIL_RX.test(`${msg?.subject || ''} ${body}`) || CONFIRM_LINK_RX.test(body)
      if (mentionsHost && looksVerify) {
        const found = extractConfirmationLink(body)
        if (found) { link = found; break }
      }
    }
    if (link) break
    if (now() >= deadline) break
    await new Promise((r) => setTimeout(r, Math.max(500, pollMs)))
    if (now() >= deadline) break
  }

  if (!link) {
    return ok('verification_pending', { message: 'No verification link found in the allotted window; left for the user to confirm.' })
  }

  // Visit the confirmation link in the browser context (reuses the signup
  // context so cookies persist). When no context is available we still report
  // we found the link but can't auto-confirm.
  if (!browserContext) {
    return ok('verification_pending', { message: 'Found a verification link but no browser to visit it; left for the user.', evidence: { link } })
  }
  try {
    const page = await browserContext.newPage()
    try {
      await page.goto(link, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
      const text = (await pageText(page)).slice(0, 4000)
      const confirmed = /\b(verified|confirmed|activated|success|thank\s+you|your\s+e?-?mail\s+(has\s+been\s+)?(verified|confirmed))\b/i.test(text)
        || SUCCESS_URL_RX.test(safeUrl(page))
      if (confirmed) {
        return ok('registered', { message: 'Email verified — account active.', evidence: { link, url: safeUrl(page) } })
      }
      return ok('verification_pending', { message: 'Visited the verification link but could not confirm activation.', evidence: { link, url: safeUrl(page) } })
    } finally {
      try { await page.close() } catch { /* ignore */ }
    }
  } catch (err) {
    return ok('verification_pending', { message: 'Could not visit the verification link.', evidence: { link, error: err?.message } })
  }
}

/**
 * Open a browser context for signup / verification. Tests inject `launchBrowser`;
 * prod imports Playwright. Returns { browser, context } or { error } (an ok(...)
 * failure result) so the caller can bail with a structured status. Shared by
 * registerOnPortal and recheckEmailVerification so the launch/guard logic lives
 * in one place.
 */
async function openBrowserContext(launchBrowser, targetUrl) {
  const isSynthetic = isControlledBetaSyntheticBrowserUrl(targetUrl)
  if (!isSynthetic && !isPublicHttpsPortalUrl(targetUrl)) {
    return { error: ok('failed', {
      blocker_kind: 'unsafe_portal_url',
      blocker_detail: 'Hamilton can only open public HTTPS portals or the reserved test fixture.',
      automation_disabled: true,
      requires_human_handoff: true,
    }) }
  }
  let browser = null
  let context = null
  if (typeof launchBrowser === 'function') {
    const launched = await launchBrowser()
    browser = launched?.browser || launched || null
    context = launched?.context || (browser?.newContext
      ? await browser.newContext(controlledBetaBrowserContextOptions({ userAgent: REALISTIC_PORTAL_UA }))
      : null)
  } else {
    let chromium
    try { ({ chromium } = await import('playwright')) }
    catch (err) {
      return { error: ok('failed', { blocker_kind: 'no_browser', blocker_detail: `Playwright unavailable: ${err?.message || err}`, automation_disabled: true }) }
    }
    const exe = chromium.executablePath?.()
    if (!exe || !fs.existsSync(exe)) {
      return { error: ok('failed', { blocker_kind: 'no_browser', blocker_detail: 'Playwright chromium binary not installed', automation_disabled: true }) }
    }
    ;({ browser } = await launchPortalBrowser(chromium, { targetUrl }))
    context = await browser.newContext(controlledBetaBrowserContextOptions({ userAgent: REALISTIC_PORTAL_UA }))
  }
  if (!context) {
    return { error: ok('failed', { blocker_kind: 'no_browser', blocker_detail: 'No browser context available' }) }
  }
  await (isSynthetic
    ? installControlledBetaBrowserEgressGuard(context)
    : installPortalBrowserEgressGuard(context))
  return { browser, context }
}

async function closeBrowserContext({ browser, context } = {}) {
  try { if (context && context.close) await context.close() } catch { /* ignore */ }
  try { if (browser && browser.close) await browser.close() } catch { /* ignore */ }
}

/**
 * RE-CHECK an account that was created but left unverified: open a fresh browser,
 * poll John's Graph mailbox (a longer lookback than the inline post-signup poll,
 * since the email may have arrived earlier), and click the confirmation link.
 * Returns:
 *   { status: 'registered' }           — the account is now verified/active
 *   { status: 'verification_pending' } — still not verified (mailbox/link absent)
 *   { status: 'failed', automation_disabled }  — automation off / no browser
 *
 * Honors the same identity-proof + ToS + browser-automation gates as
 * registerOnPortal (defense in depth). Never throws.
 */
export async function recheckEmailVerification(db, {
  portalHost, loginUrl = null, identityEmail,
  launchBrowser = null, outlookProvider = null,
  waitMs = VERIFY_POLL_MS, pollMs = VERIFY_POLL_MS,
  lookbackMs = 24 * 60 * 60 * 1000, // look back 24h for an already-delivered email
} = {}) {
  const host = registrableDomain(portalHost) || hostOfUrl(portalHost) || String(portalHost || '').toLowerCase()
  const url = loginUrl || (host ? `https://${host}` : null)
  if (!identityEmail) return ok('verification_pending', { message: 'No autopilot identity email to verify.' })
  if (!reviewedPortalSignupExecutionEnabled()) {
    void db; void launchBrowser; void outlookProvider; void waitMs; void pollMs; void lookbackMs
    return ok('verification_pending', {
      blocker_kind: 'create_portal_account',
      message: 'Open the portal verification email yourself; Hamilton does not read your mailbox or visit account-activation links.',
    })
  }
  // Identity-proofed hosts are never auto-driven.
  if (isIdentityProofedHost(host)) {
    return ok('verification_pending', { message: 'Identity-proofed portal — verification is not auto-driven.' })
  }
  try {
    const policy = await getPolicyFor(db, host).catch(() => null)
    if (policy && (policy.identity_proofed || policy.automation_allowed === false)) {
      return ok('verification_pending', { message: 'Portal policy forbids auto-driving verification.' })
    }
  } catch { /* permissive default */ }
  if (!browserAutomationPermittedForUrl(url, { extraAllowedHosts: [] })) {
    return ok('failed', {
      blocker_kind: 'no_browser',
      blocker_detail: isBrowserAutomationEnabled()
        ? 'Portal host is not on the browser-automation allowlist.'
        : 'Browser automation is disabled (HAMILTON_ENABLE_BROWSER_AUTOMATION).',
      automation_disabled: true,
      message: 'Browser automation not permitted; verification re-check not attempted.',
    })
  }
  let handle = null
  try {
    handle = await openBrowserContext(launchBrowser, url)
    if (handle.error) return handle.error
    const verify = await completeEmailVerification({
      identityEmail, portalHost: host,
      browserContext: handle.context, outlookProvider,
      waitMs, pollMs, lookbackMs,
    }).catch((err) => ok('verification_pending', { message: `Verification re-check failed: ${err?.message || err}` }))
    return verify
  } finally {
    await closeBrowserContext(handle)
  }
}

// ── Top-level entry: register on a portal ──────────────────────────────────────

/**
 * Drive account registration on one portal and return a registrationResult.
 *
 * Safety gates (in order):
 *   1. identity-proofed host → blocked(identity_proof_required), never attempted.
 *   2. policy.automation_allowed === false → blocked(portal_terms_block).
 *   3. browser automation off / host not allowlisted → automation_disabled.
 * Then it launches Playwright (real browser; injectable for tests), navigates to
 * the signup URL, runs the per-host adapter (or the generic heuristic), and — when
 * the portal asked to verify the email — best-effort completes verification via
 * John's Graph mailbox.
 *
 * @param {object} db
 * @param {object} args
 * @param {string} args.portalHost
 * @param {string} args.signupUrl        resolved signup/registration URL
 * @param {object} args.identity         from buildSignupIdentity (email+password+name)
 * @param {object} [args.profile]
 * @param {boolean} [args.dryRun]        plan only — never launch a browser
 * @param {Function} [args.launchBrowser]  injectable Playwright launcher (tests)
 * @param {object}  [args.outlookProvider] injectable Graph mailbox (tests)
 * @returns {Promise<registrationResult>}
 */
export async function registerOnPortal(db, {
  portalHost, signupUrl, identity, profile = {},
  dryRun = false, launchBrowser = null, outlookProvider = null,
  verifyWaitMs = VERIFY_WAIT_MS, verifyPollMs = VERIFY_POLL_MS,
} = {}) {
  const host = registrableDomain(portalHost) || hostOfUrl(portalHost) || String(portalHost || '').toLowerCase()
  const url = signupUrl || (host ? `https://${host}` : null)

  // 1. HARD RAIL: never auto-register an identity-proofed portal.
  if (isIdentityProofedHost(host)) {
    return blocked('identity_proof_required', {
      blockerKind: 'identity_proof',
      detail: 'Identity-proofed portal — account creation requires real identity verification; never auto-registered.',
      evidence: { url, signal: 'identity_proofed_host' },
      message: 'Hamilton will not fabricate identity proofing; sign in once and she takes over.',
    })
  }

  // 2. ToS compliance: a portal whose terms forbid automation is never registered.
  try {
    const policy = await getPolicyFor(db, host).catch(() => null)
    if (policy && policy.identity_proofed) {
      return blocked('identity_proof_required', {
        blockerKind: 'identity_proof',
        detail: 'Portal policy marks this host identity-proofed.',
        evidence: { url, signal: 'policy_identity_proofed' },
      })
    }
    if (policy && policy.automation_allowed === false) {
      return blocked('portal_terms_block', {
        blockerKind: 'portal_terms',
        detail: `Portal terms forbid agent automation (${host}).`,
        evidence: { url, signal: 'policy_forbids_automation' },
      })
    }
  } catch { /* permissive default — continue to the browser gate */ }

  if (!reviewedPortalSignupExecutionEnabled()) {
    void profile; void dryRun; void launchBrowser; void outlookProvider
    void verifyWaitMs; void verifyPollMs; void identity
    return blocked('create_portal_account', {
      blockerKind: 'create_portal_account',
      detail: 'No reviewed portal-account creation adapter is enabled for this host.',
      evidence: { host, signal: 'reviewed_signup_adapter_required' },
      message: 'Create the portal account yourself, then Hamilton can use the saved login.',
    })
  }

  // 3. Browser-automation gate (global flag + host allowlist). Defense in depth:
  // the brain already authorized this host (a profile-declared portal is treated
  // as implicitly allowed at the brain's gate). Here we honor the RAW allowlist
  // strictly — when an operator sets HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST to
  // trial automation on specific hosts, the signup adapter never launches outside
  // it. An empty allowlist (the fleet-wide default) permits any host.
  if (!browserAutomationPermittedForUrl(url, { extraAllowedHosts: [] })) {
    return ok('failed', {
      blocker_kind: 'no_browser',
      blocker_detail: isBrowserAutomationEnabled()
        ? 'Portal host is not on the browser-automation allowlist.'
        : 'Browser automation is disabled (HAMILTON_ENABLE_BROWSER_AUTOMATION).',
      automation_disabled: true,
      message: 'Browser automation not permitted for this host; registration not attempted.',
    })
  }

  if (!identity || !identity.email || !identity.password) {
    return ok('failed', {
      blocker_kind: 'missing_identity',
      blocker_detail: 'No identity email/password available to register with.',
      message: 'Hamilton has no identity to register this portal with.',
    })
  }

  // DRY-RUN / preview: report what WOULD happen without launching a browser.
  if (dryRun) {
    const hostAdapter = resolveHostAdapter(host)
    return ok('planned', {
      message: 'Dry run — registration not executed.',
      plan: {
        host, signupUrl: url,
        adapter: hostAdapter ? `host:${hostAdapter.host}` : 'generic',
        identityEmail: identity.email,
      },
    })
  }

  // Launch a browser. Tests inject `launchBrowser`; prod imports Playwright.
  let browser = null
  let context = null
  try {
    const handle = await openBrowserContext(launchBrowser, url)
    if (handle.error) return handle.error
    browser = handle.browser
    context = handle.context
    const page = await context.newPage()
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }) }
    catch (err) {
      return ok('failed', { blocker_kind: 'navigation_failed', blocker_detail: `Could not open signup page: ${err?.message || err}`, evidence: { url } })
    }

    const hostAdapter = resolveHostAdapter(host)
    const driver = hostAdapter?.adapter || genericSignupAdapter
    let result
    try {
      result = await driver(page, identity, { signupUrl: hostAdapter?.signupUrl || url })
    } catch (err) {
      result = ok('failed', { blocker_kind: 'engine_error', blocker_detail: err?.message || String(err), evidence: { url: safeUrl(page) } })
    }
    result.adapter = hostAdapter ? `host:${hostAdapter.host}` : 'generic'

    // Best-effort email verification when the portal asked for it.
    if (result.status === 'verification_pending') {
      const verify = await completeEmailVerification({
        identityEmail: identity.email, portalHost: host,
        browserContext: context, outlookProvider,
        waitMs: verifyWaitMs, pollMs: verifyPollMs,
      }).catch(() => null)
      if (verify && verify.status === 'registered') {
        return { ...verify, adapter: result.adapter, verified_via: 'graph_mailbox' }
      }
      // still pending — return the pending result for the brain to route.
      return { ...result, verification: verify || { status: 'verification_pending' } }
    }
    return result
  } finally {
    await closeBrowserContext({ browser, context })
  }
}

export const _internal = {
  ALREADY_EXISTS_RX, VERIFY_EMAIL_RX, SUCCESS_RX, SUCCESS_URL_RX, CONFIRM_LINK_RX,
  classifyOutcome, detectSignupBlocker, extractConfirmationLink, buildSignupIdentity,
  EMAIL_SELECTORS, PASSWORD_SELECTORS, SUBMIT_SELECTORS,
}

export default {
  registerOnPortal,
  genericSignupAdapter,
  resolveHostAdapter,
  HOST_ADAPTERS,
  buildSignupIdentity,
  completeEmailVerification,
  recheckEmailVerification,
  extractConfirmationLink,
}
