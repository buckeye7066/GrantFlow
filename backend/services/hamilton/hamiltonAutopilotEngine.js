/**
 * hamiltonAutopilotEngine.js
 *
 * Hamilton Autopilot — user-authorized **unattended** Playwright completion.
 *
 * Flow (no review stops on the normal path):
 *   1. Open the application URL in a fresh chromium context (or reuse a
 *      saved storageState when use_saved_session is authorized).
 *   2. Detect login / 2FA / CAPTCHA / payment / signature / attestation
 *      gates. Any of these is a HARD BLOCKER — Hamilton saves progress and
 *      stops with `blocker_kind`.
 *   3. Inspect the visible form fields and map them from the profile
 *      with the deterministic mapper below.
 *   4. Fill every mapped field. Generate narrative answers from
 *      profile essays when `generate_narratives` is authorized.
 *   5. Upload authorized documents into file inputs that match by name.
 *   6. Click Next/Continue/Save Draft on multi-page forms and repeat
 *      from step 3 until either:
 *         - Hamilton sees a Submit button AND `submit_applications` is
 *           authorized AND no blocker shows up → click Submit.
 *         - Hamilton sees a Submit button AND `submit_applications` is NOT
 *           authorized → click Save Draft (if available, and if
 *           `save_drafts` is authorized) and stop with status
 *           `completed_draft`.
 *         - Validation errors persist after one round of corrections →
 *           HARD BLOCKER (`blocker_kind=validation`).
 *   7. After submission, capture only a minimized, typed receipt observation.
 *
 * Hamilton NEVER:
 *   - solves CAPTCHA or signs anything.
 *   - completes a 2FA challenge. The user may clear 2FA themselves and save
 *     the resulting trusted browser session, but Hamilton never derives, types,
 *     intercepts, or replays a live MFA code.
 *   - clicks legal/accuracy/terms/release/signature attestations.
 *   - bypasses an anti-bot challenge.
 *
 * Profile is provided pre-loaded; no database read during the run.
 */

import fs from 'node:fs'
import crypto from 'node:crypto'
import { launchGuardedPortalBrowser, REALISTIC_PORTAL_UA } from './browserLaunch.js'
import { registrableDomain } from './hamiltonPortalCredentialService.js'
import { triagePage, PAGE_SURFACES } from './listingPageTriage.js'
import { buildTargetScopedAnswerSnapshot } from './hamiltonApplicationAnswerSnapshot.js'
import {
  assertHamiltonActionPageAllowed,
  assertHamiltonLivePageAllowed,
  navigateHamiltonPortalPage,
  prepareHamiltonBrowserEgress,
  runHamiltonPageAction,
} from './hamiltonBrowserNetworkGuard.js'
import {
  adapterAllowsUrl,
  assessAdapterPostClickObservation,
  clickReviewedSubmitControl,
  extractIdentityBoundAdapterReceipt,
  fillReviewedFieldContract,
  inspectReviewedSubmitControl,
  verifyReviewedFieldExecution,
} from './hamiltonSubmissionAdapterExecutor.js'

const NAV_TIMEOUT_MS = Number(process.env.HAMILTON_AUTOPILOT_NAV_TIMEOUT_MS) || 25_000
const STEP_TIMEOUT_MS = Number(process.env.HAMILTON_AUTOPILOT_STEP_TIMEOUT_MS) || 8_000
const MAX_PAGES = Number(process.env.HAMILTON_AUTOPILOT_MAX_PAGES) || 12

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex')
}

/**
 * The raw triage snapshot is ephemeral browser input. It can contain account
 * names, balances, page text, and bearer-like URLs, so only a value-free shape
 * may cross the engine persistence/API boundary.
 */
export function sanitizeListingSnapshotForPersistence(snapshot = {}) {
  let portalOrigin = null
  try {
    const parsed = new URL(String(snapshot?.url || ''))
    if (parsed.protocol === 'https:') portalOrigin = parsed.origin
  } catch { portalOrigin = null }
  const text = String(snapshot?.text || '')
  const title = String(snapshot?.title || '')
  const links = Array.isArray(snapshot?.links) ? snapshot.links : []
  return Object.freeze({
    portal_origin: portalOrigin,
    field_count: Math.max(0, Number(snapshot?.fieldCount) || 0),
    link_count: links.length,
    text_length: text.length,
    text_sha256: text ? sha256Text(text) : null,
    title_sha256: title ? sha256Text(title) : null,
    content_retained: false,
  })
}

function safeFailureCode(error, fallback = 'authorization_unavailable') {
  const candidates = [error?.code, error?.message]
  for (const candidate of candidates) {
    const value = String(candidate || '').trim()
    if (/^[a-z][a-z0-9_.-]*(?::[a-z0-9_.-]+)?$/i.test(value)
        && !/(password|passcode|otp|totp|mfa|secret|credential|cookie|token)/i.test(value)) {
      return value
    }
  }
  return fallback
}

function safePortalUrl(value, submissionAdapter = null) {
  try {
    const parsed = new URL(String(value))
    if (parsed.protocol !== 'https:') return null
    const origin = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`
    const path = parsed.pathname || '/'
    const adapterOriginMatches = parsed.protocol === 'https:'
      && !parsed.username && !parsed.password && (!parsed.port || parsed.port === '443')
      && parsed.hostname.toLowerCase() === String(submissionAdapter?.portal_host || '').toLowerCase()
      && Array.isArray(submissionAdapter?.allowed_origins)
      && submissionAdapter.allowed_origins.includes(`https://${parsed.hostname.toLowerCase()}`)
    const reviewedPrefix = adapterOriginMatches && Array.isArray(submissionAdapter?.allowed_path_prefixes)
      ? submissionAdapter.allowed_path_prefixes
        .map((value) => String(value || '').replace(/\/+$/, '') || '/')
        .find((prefix) => prefix === '/' || path === prefix || path.startsWith(`${prefix}/`))
      : null
    // Application/resume identifiers commonly live in path segments as well
    // as query strings. Persist only the origin, or the adapter's reviewed
    // static prefix when one is available; the exact executable locator is
    // encrypted and hash-bound by the submission-attempt store.
    return `${origin}${reviewedPrefix && reviewedPrefix !== '/' ? reviewedPrefix : '/'}`
  } catch {
    return null
  }
}

function exactAdapterApplicationReference(portalUrl, submissionAdapter) {
  const expectedKey = String(submissionAdapter?.status_query?.query_parameter || '').toLowerCase()
  if (!expectedKey) return null
  try {
    const parsed = new URL(String(portalUrl))
    const values = [...parsed.searchParams.entries()]
      .filter(([key]) => key.toLowerCase() === expectedKey)
      .map(([, value]) => String(value || '').trim())
      .filter(Boolean)
    return values.length === 1 ? values[0] : null
  } catch { return null }
}

const TRACE_TEXT_KEYS = new Set([
  'step', 'kind', 'status', 'reason', 'key', 'fid', 'outcome', 'confirmation_evidence',
])
const TRACE_SENSITIVE_KEY_RX = /(text|message|detail|error|value|answer|label|title|username|password|passcode|otp|token|query|html|body|essay|income|address|email|phone)/i

function sanitizeTraceValue(value, key = '', depth = 0) {
  if (depth > 5) return '[depth-limited]'
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeTraceValue(item, key, depth + 1))
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([childKey, child]) => (
      [childKey, sanitizeTraceValue(child, childKey, depth + 1)]
    )))
  }
  const text = String(value)
  if (/url|uri|href|from|to/i.test(key) || /^https?:\/\//i.test(text)) {
    const safe = safePortalUrl(text)
    return safe ? { portal_url: safe, original_sha256: sha256Text(text) } : '[invalid-url]'
  }
  if (TRACE_TEXT_KEYS.has(key) && /^[a-z0-9_.:-]{1,100}$/i.test(text)) return text
  if (TRACE_SENSITIVE_KEY_RX.test(key)) return { redacted: true, sha256: sha256Text(text), length: text.length }
  return { redacted: true, sha256: sha256Text(text), length: text.length }
}

function createRedactionSafeTrace() {
  const trace = []
  Object.defineProperty(trace, 'push', {
    enumerable: false,
    value: (...entries) => Array.prototype.push.apply(trace, entries.map((entry) => sanitizeTraceValue(entry))),
  })
  return trace
}

// Deterministic field-key rules. Matches against name, id, label, and
// nearby placeholder/aria-label text. `_S_` below stands for "any
// separator" — whitespace, underscore, or dash — so that HTML form
// `name="first_name"` matches the same rule as a label "First Name".
const _S_ = '[\\s_\\-]*'
const FIELD_RULES = Object.freeze([
  { key: 'first_name',      patterns: [new RegExp(`first${_S_}name`, 'i'), new RegExp(`given${_S_}name`, 'i'), /^fname$/i] },
  { key: 'last_name',       patterns: [new RegExp(`last${_S_}name`, 'i'), /surname/i, new RegExp(`family${_S_}name`, 'i'), /^lname$/i] },
  { key: 'full_name',       patterns: [new RegExp(`full${_S_}name`, 'i'), /^name$/i] },
  { key: 'email',           patterns: [/^e[-\s_]?mail$/i, new RegExp(`email${_S_}address`, 'i'), /\bemail\b/i] },
  { key: 'phone',           patterns: [/phone/i, /telephone/i, /^tel$/i, /mobile/i, /cell/i] },
  { key: 'address1',        patterns: [new RegExp(`address${_S_}(1|line${_S_}1)?$`, 'i'), /^street/i] },
  { key: 'address2',        patterns: [new RegExp(`address${_S_}(2|line${_S_}2)`, 'i'), /apt|suite|unit/i] },
  { key: 'city',            patterns: [/^city$/i, /town/i] },
  { key: 'state',           patterns: [/^state$/i, /province/i] },
  { key: 'zip',             patterns: [/zip/i, /postal/i] },
  { key: 'country',         patterns: [/country/i] },
  { key: 'school',          patterns: [/school/i, /college|university|institution/i] },
  { key: 'major',           patterns: [/major/i, new RegExp(`program|degree${_S_}program|field${_S_}of${_S_}study`, 'i')] },
  { key: 'degree_level',    patterns: [new RegExp(`degree${_S_}(level|sought)?`, 'i'), /classification/i] },
  { key: 'student_id',      patterns: [new RegExp(`student${_S_}id|m[#\\-]?number|university${_S_}id`, 'i')] },
  { key: 'gpa',             patterns: [/^gpa$/i, new RegExp(`grade${_S_}point`, 'i')] },
  { key: 'act_score',       patterns: [/^act/i] },
  { key: 'sat_score',       patterns: [/^sat/i] },
  { key: 'expected_graduation', patterns: [new RegExp(`expected${_S_}graduation`, 'i'), new RegExp(`graduation${_S_}(date|year)`, 'i')] },
  { key: 'household_income',patterns: [new RegExp(`household${_S_}income`, 'i'), new RegExp(`family${_S_}income`, 'i'), new RegExp(`annual${_S_}income`, 'i')] },
  { key: 'household_size',  patterns: [new RegExp(`household${_S_}size`, 'i')] },
  { key: 'fafsa_efc',       patterns: [new RegExp(`efc|expected${_S_}family${_S_}contribution|sai\\b`, 'i')] },
  { key: 'essay',           patterns: [new RegExp(`essay|personal${_S_}statement|tell${_S_}us${_S_}about|why${_S_}do${_S_}you|describe`, 'i')], multiline: true },
  { key: 'goals',           patterns: [new RegExp(`career${_S_}goals|future${_S_}plans|after${_S_}graduation`, 'i')], multiline: true },
])

// Legal/accuracy/terms text is NEVER accepted from a fuzzy standing grant.
// Kept as an empty exported list for compatibility with callers/tests that
// inspect the engine policy. A future mechanical acknowledgement must use an
// exact normalized-text hash scoped to portal/task/version/expiry instead.
const STANDING_ATTESTATION_PATTERNS = Object.freeze([])

// Hard-blocker labels Hamilton NEVER auto-checks.
const HARD_ATTESTATION_PATTERNS = [
  /electronic\s*signature/i,
  /sign\s*(here|below|name)/i,
  /penalty\s*of\s*perjury/i,
  /under\s*oath/i,
  /digital\s*signature/i,
  /information.*(true|accurate|correct).*best\s*of.*knowledge/i,
  /authorize.*(verify|release|confirm).*information/i,
  /agree.*terms.*conditions/i,
  /understand.*may\s*be\s*disqualif/i,
  /\b(?:certify|attest|represent|warrant)\b/i,
  /\b(?:release|waive|indemnif|hold\s+harmless)\b/i,
]

const SUBMIT_BUTTON_PATTERNS = [/^submit/i, /finalize/i, /apply\s*now/i, /complete\s*application/i, /send\s*application/i]
const NEXT_BUTTON_PATTERNS   = [/^next/i, /continue/i, /proceed/i, /save\s*&\s*continue/i]
const DRAFT_BUTTON_PATTERNS  = [/save\s*draft/i, /save\s*&\s*exit/i, /save\s*for\s*later/i]

// ── Profile reader (mirrors mapping in packet generator) ─────────────

function readProfileValues(profile, target = {}) {
  return buildTargetScopedAnswerSnapshot({ profile, ...target }).values
}

// Keys the MBA-drafted narrative may override. Deliberately ONLY the long-form
// keys: short factual fields (name, address, income, …) must always be the
// profile's verbatim values, never generated text.
const NARRATIVE_OVERRIDE_KEYS = Object.freeze(['essay', 'goals'])

/**
 * Merge MBA-level narrative answers (from hamiltonFullProposalGenerator via the
 * orchestrator) over the profile-derived values — long-form keys only.
 */
function applyNarrativeAnswers(valuesByKey, narrativeAnswers) {
  if (!narrativeAnswers || typeof narrativeAnswers !== 'object') return valuesByKey
  for (const key of NARRATIVE_OVERRIDE_KEYS) {
    const v = narrativeAnswers[key]
    if (v !== undefined && v !== null && String(v).trim() !== '') valuesByKey[key] = String(v)
  }
  return valuesByKey
}

// ── Form / field helpers (Playwright) ────────────────────────────────

async function detectFields(page) {
  // Pull every visible input/select/textarea on the page along with the
  // text we need for matching. Done in one evaluate() call to avoid N
  // round-trips.
  return await page.evaluate(() => {
    function visible(el) {
      if (!el) return false
      const r = el.getBoundingClientRect()
      const cs = window.getComputedStyle(el)
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'
    }
    function nearbyLabel(el) {
      if (!el) return ''
      // <label for="…">
      if (el.id) {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
        if (lab) return lab.textContent || ''
      }
      // wrapped <label>…<input/>…</label>
      const parentLabel = el.closest('label')
      if (parentLabel) return parentLabel.textContent || ''
      // nearest preceding label-ish text
      let prev = el.previousElementSibling
      while (prev) {
        if (/^(label|span|div|p)$/i.test(prev.tagName) && prev.textContent && prev.textContent.trim().length < 200) {
          return prev.textContent
        }
        prev = prev.previousElementSibling
      }
      return ''
    }
    const out = []
    const all = document.querySelectorAll('input, textarea, select')
    let idx = 0
    for (const el of all) {
      if (!visible(el)) continue
      const tag = el.tagName.toLowerCase()
      const type = (el.getAttribute('type') || '').toLowerCase()
      if (tag === 'input' && (type === 'hidden' || type === 'submit' || type === 'button' || type === 'image')) continue
      el.setAttribute('data-hamilton-fid', `f${idx}`)
      out.push({
        fid: `f${idx}`,
        tag, type,
        name: el.getAttribute('name') || '',
        id: el.id || '',
        placeholder: el.getAttribute('placeholder') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        label: (nearbyLabel(el) || '').trim().slice(0, 200),
        required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
        value: el.value ?? null,
        checked: typeof el.checked === 'boolean' ? el.checked : null,
        reviewedAnswerKey: el.getAttribute('data-hamilton-reviewed-answer-key') || null,
      })
      idx += 1
    }
    return out
  })
}

function matchFieldKey(field) {
  const candidates = [field.name, field.id, field.placeholder, field.ariaLabel, field.label]
    .filter(Boolean).join(' ').toLowerCase()
  if (!candidates) return null
  for (const rule of FIELD_RULES) {
    if (rule.patterns.some((rx) => rx.test(candidates))) return rule
  }
  return null
}

async function fillFieldByFid(page, fid, value) {
  const sel = `[data-hamilton-fid="${fid}"]`
  const handle = await page.$(sel)
  if (!handle) return false
  const tag = await handle.evaluate((el) => el.tagName.toLowerCase())
  const type = await handle.evaluate((el) => (el.getAttribute('type') || '').toLowerCase())
  if (tag === 'select') {
    try { await handle.selectOption({ label: String(value) }) } catch {
      try { await handle.selectOption(String(value)) } catch { return false }
    }
    return true
  }
  if (type === 'checkbox' || type === 'radio') {
    if (value === true || /^(true|yes|on|1)$/i.test(String(value))) {
      try { await handle.check({ force: false }) } catch { return false }
      return true
    }
    return false
  }
  if (type === 'file') {
    try { await handle.setInputFiles(String(value)) } catch { return false }
    return true
  }
  try {
    await handle.fill('')
    await handle.fill(String(value), { timeout: STEP_TIMEOUT_MS })
    return true
  } catch { return false }
}

async function detectButtons(page, patterns) {
  return await page.$$eval('button, input[type="button"], input[type="submit"], a[role="button"]', (els, { rxList }) => {
    const out = []
    for (const el of els) {
      const text = (el.innerText || el.value || '').trim()
      if (!text) continue
      for (const r of rxList) {
        const re = new RegExp(r.source, r.flags)
        if (re.test(text)) {
          // Form context: a submit-looking control that is not part of a real
          // <form> with fillable fields is usually page chrome or a navigation
          // link on an informational page — NOT an application-form submit.
          // The main loop uses this to avoid hunting stray "Submit"/"Apply
          // now" controls on pages that have no application form at all.
          const form = el.closest('form')
          let formFieldCount = 0
          if (form) {
            for (const f of form.querySelectorAll('input, textarea, select')) {
              const t = (f.getAttribute('type') || '').toLowerCase()
              if (f.tagName.toLowerCase() === 'input'
                && (t === 'hidden' || t === 'submit' || t === 'button' || t === 'image')) continue
              formFieldCount += 1
            }
          }
          el.setAttribute('data-hamilton-btn', `b${out.length}`)
          out.push({ bid: `b${out.length}`, text, inForm: !!form, formFieldCount })
          break
        }
      }
    }
    return out
  }, { rxList: patterns.map((p) => ({ source: p.source, flags: p.flags })) })
}

/**
 * Truthfulness gate for the submit hunt (no-form informational pages).
 *
 * A "Submit"/"Apply now"-labelled control only counts as an APPLICATION submit
 * when Hamilton actually worked an application form on this run:
 *   - she filled at least one recognised field (`anyFieldFilled`), OR
 *   - the control lives inside a real <form> element that has fillable fields.
 *
 * Informational pages (e.g. a university's financial-aid overview page) often
 * carry stray submit-looking chrome or "Apply Now" nav links. Hunting those and
 * hard-failing with click_failed misreported "this page has no application
 * form" as an engine failure. Pure function — unit-tested directly.
 */
function actionableSubmitButtons(submitButtons, { anyFieldFilled = false, recognizedFieldCount = 0 } = {}) {
  const list = Array.isArray(submitButtons) ? submitButtons : []
  if (anyFieldFilled) return list
  // Nothing was filled this run. The only legitimate submit here is a
  // PREFILLED application form (a resumed draft) — and a real application
  // form still exposes fields the inspector RECOGNIZES. `formFieldCount`
  // alone counts RAW inputs, which is how a newsletter/search widget's email
  // box qualified its own "Submit" button on an informational page with ZERO
  // recognized application fields (TN HOPE, prod 2026-08-03) — Hamilton
  // attempted to submit a page she never worked, and only the click failing
  // kept the run honest. No recognized fields + nothing filled = there is no
  // application being submitted; degrade to the no_application_form path.
  if (Number(recognizedFieldCount) <= 0) return []
  return list.filter((b) => b && b.inForm && Number(b.formFieldCount) > 0)
}

async function clickButtonByBid(page, bid) {
  const sel = `[data-hamilton-btn="${bid}"]`
  const h = await page.$(sel)
  if (!h) return false
  // Race: a true navigation OR a load-state change OR just a settled
  // wait. Single-page apps may not fire `framenavigated`; multi-page
  // forms (the common case for funding portals) do. We wait at least
  // until either a navigation event resolves or 1.5s elapses, and we
  // tolerate either path.
  try {
    const navWait = page.waitForNavigation({ timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' }).catch(() => null)
    await h.click({ timeout: STEP_TIMEOUT_MS })
    await Promise.race([
      navWait,
      new Promise((r) => setTimeout(r, 1500)),
    ])
    await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT_MS }).catch(() => null)
    return true
  } catch {
    return false
  }
}

/**
 * Best-effort login using a saved credential. Fills the username + password
 * fields on the current login form and submits. Returns true when the resulting
 * page no longer shows a password field (heuristic for a successful sign-in).
 * Generic across portals — if it can't find/submit the form it returns false
 * and Hamilton falls back to the normal login hard-stop. Never logs the values.
 */
async function attemptLogin(page, credential) {
  try {
    const username = credential?.username
    const password = credential?.password
    if (!username || !password) return false
    // Origin safety: only type a saved credential into a page whose host shares
    // the credential's registrable domain (eTLD+1). Defeats a portal that
    // redirects mid-flow to an attacker origin before the login form. Re-checked
    // here against the LIVE page.url() right before any field is touched.
    const allowedDomain = registrableDomain(credential?.portal_host)
    let currentDomain = null
    try { currentDomain = registrableDomain(new URL(page.url()).hostname) } catch { return false }
    if (!allowedDomain || currentDomain !== allowedDomain) {
      return false
    }
    const userSelectors = [
      'input[autocomplete="username"]:not([disabled])',
      'input[type="email"]:not([disabled])',
      'input[name*="user" i]:not([disabled])',
      'input[id*="user" i]:not([disabled])',
      'input[name*="email" i]:not([disabled])',
      'input[id*="email" i]:not([disabled])',
      'input[name*="login" i]:not([disabled])',
      'input[type="text"]:not([disabled])',
    ]
    let userField = null
    for (const sel of userSelectors) {
      userField = await page.$(sel).catch(() => null)
      if (userField) break
    }
    const passField = await page.$('input[type="password"]:not([disabled])').catch(() => null)
    if (!userField || !passField) return false
    await userField.fill(String(username), { timeout: 5000 }).catch(() => {})
    await passField.fill(String(password), { timeout: 5000 }).catch(() => {})

    let clicked = false
    for (const sel of ['button[type="submit"]:not([disabled])', 'input[type="submit"]:not([disabled])']) {
      const b = await page.$(sel).catch(() => null)
      if (b) { await b.click({ timeout: 5000 }).catch(() => {}); clicked = true; break }
    }
    if (!clicked) {
      const b = await page.$('button:has-text("Log in"), button:has-text("Sign in"), button:has-text("Login"), button:has-text("Continue")').catch(() => null)
      if (b) { await b.click({ timeout: 5000 }).catch(() => {}); clicked = true }
    }
    if (!clicked) await passField.press('Enter').catch(() => {})

    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
    const stillPassword = await page.$('input[type="password"]:not([disabled])').catch(() => null)
    return !stillPassword
  } catch {
    return false
  }
}

// Full-page bot-protection interstitial signatures. This is the WHOLE-PAGE
// challenge (Cloudflare "managed challenge", Akamai/DataDome/PerimeterX bot
// walls) that REPLACES the application before it loads — distinct from an
// embedded captcha WIDGET on an otherwise-real page (that stays `captcha`).
// Vendor-agnostic on purpose (owner's standing rule): these phrasings and the
// low-content shape generalize across bot-protection vendors, so a NEW vendor
// still classifies as bot_protected instead of dead-ending as login/no_progress.
//
// STRONG phrases are specific enough to a bot-wall that they never appear in a
// real scholarship application, so they classify on their own. BRAND signals
// ("Ray ID", "Cloudflare", "Attention Required") are weaker — a real page could
// mention them in a footer — so they only classify when the page is also
// low-content (an interstitial has essentially no application on it).
const BOT_WALL_STRONG_RX = /performing security verification|verifying you are (a human|not a bot)|checking (your|the) browser before (you )?(access|continue|proceed)|this website uses a security service to protect|needs to review the security of your connection|enable javascript and cookies to continue|verify you are a human by completing|additional security check is required to access/i
const BOT_WALL_BRAND_RX = /\bray id:?\b|\bcf-ray\b|\bcloudflare\b|attention required!|\b(akamai|datadome|perimeterx|imperva incapsula)\b/i
// An interstitial that has replaced the app is short — a real application page,
// even a login screen, carries far more visible text than a challenge shell.
const BOT_WALL_LOW_CONTENT_CHARS = 2000

async function readBotWallSignals(page) {
  // Guarded so a minimal fake `page` (tests, or a partially-torn-down context)
  // that lacks title()/$eval never throws — optional-call + reject-safe.
  let title = ''
  let bodyText = ''
  try { title = String((await Promise.resolve(page.title?.())) || '') } catch { /* ignore */ }
  try {
    bodyText = String((await Promise.resolve(
      page.$eval?.('body', (el) => (el && (el.innerText || el.textContent)) || ''),
    )) || '')
  } catch { /* ignore */ }
  const url = (() => { try { return page.url() } catch { return '' } })()
  return { title, bodyText, url }
}

// Full-page bot-protection interstitial? Returns a gate or null. Exported via
// _internal for direct testing against the verbatim challenge text.
async function detectBotWall(page) {
  const { title, bodyText, url } = await readBotWallSignals(page)
  const hay = `${title} ${bodyText} ${url}`
  if (BOT_WALL_STRONG_RX.test(hay)) {
    return { kind: 'bot_protected', detail: 'Site bot-protection (e.g. Cloudflare) blocked automated access' }
  }
  // Brand-only signal must be corroborated by the low-content interstitial shape
  // so a real page mentioning a vendor in its footer is not misclassified.
  if (BOT_WALL_BRAND_RX.test(hay) && bodyText.trim().length > 0 && bodyText.trim().length < BOT_WALL_LOW_CONTENT_CHARS) {
    return { kind: 'bot_protected', detail: 'Site bot-protection (e.g. Cloudflare) blocked automated access' }
  }
  return null
}

async function detectGate(page) {
  // Full-page bot-protection interstitial FIRST — it replaces the whole app, so
  // a bot-wall must win over the login/captcha/field heuristics (a challenge
  // shell can otherwise look like "no progress" or a bare login). This is OUR
  // reachability problem (datacenter IP / fingerprint), so the orchestrator must
  // NOT expire a saved session on it — see the bot_protected handling there.
  const botWall = await detectBotWall(page)
  if (botWall) return botWall
  // Login: a visible password field, OR a URL containing /login|/signin.
  //
  // We ALWAYS surface a detected login as a gate and let the main loop decide
  // what to do: if the user saved a credential for this portal Hamilton types
  // it in (attemptLogin); otherwise it's a hard-stop. Suppressing the gate when
  // saved-credential use was authorized (the old behaviour) was a bug — it
  // disabled the very auto-login the authorization was meant to enable, because
  // the handler is keyed on this gate firing. A restored session that is still
  // valid shows no password field, so this never spuriously fires for it.
  const url = (() => { try { return page.url() } catch { return '' } })()
  const hasPassword = await page.$('input[type="password"]:not([disabled])').catch(() => null)
  if (hasPassword) {
    const onLoginUrl = /\/(login|signin|sso|cas|shibboleth)/i.test(url)
    return { kind: 'login', detail: onLoginUrl ? `Login required at ${url}` : 'Password input visible — login required' }
  }
  // 2FA / OTP heuristics.
  const hasOtp = await page.$('input[autocomplete*="one-time-code"], input[name*="otp"], input[name*="2fa"]').catch(() => null)
  if (hasOtp) return { kind: '2fa', detail: 'One-time code input visible' }
  // CAPTCHA heuristics — vendor-agnostic on purpose (owner: "if the captcha
  // changes every time, can he evolve with it?"). Covers reCAPTCHA, hCaptcha,
  // Cloudflare Turnstile/managed challenges, FunCaptcha/Arkose, and the
  // generic signatures most custom widgets share (a data-sitekey attribute or
  // "captcha"/"challenge" in the element class/id/iframe URL/title) — so a
  // NEW vendor still classifies as a captcha gate instead of dead-ending as
  // no_progress/validation.
  const hasCaptcha = await page.$(
    'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], iframe[src*="challenges.cloudflare.com"], ' +
    'iframe[src*="arkoselabs"], iframe[src*="funcaptcha"], iframe[src*="captcha" i], iframe[title*="challenge" i], iframe[title*="captcha" i], ' +
    'div.g-recaptcha, div.h-captcha, div.cf-turnstile, [data-sitekey], div[class*="captcha" i], div[id*="captcha" i]',
  ).catch(() => null)
  if (hasCaptcha) return { kind: 'captcha', detail: 'CAPTCHA / human-verification challenge present' }
  // Payment.
  const hasPayment = await page.$('input[autocomplete="cc-number"], iframe[src*="stripe.com"], iframe[src*="braintree"]').catch(() => null)
  if (hasPayment) return { kind: 'payment', detail: 'Payment widget visible' }
  return null
}

async function detectAttestationGate(page, { authorizations }) {
  // Find checkbox labels that look like legal attestations or signatures.
  const items = await page.$$eval('input[type="checkbox"]', (els) => {
    const out = []
    for (const el of els) {
      const id = el.id
      const name = el.getAttribute('name') || ''
      let labelText = ''
      if (id) {
        const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`)
        if (lab) labelText = lab.textContent || ''
      }
      if (!labelText) {
        const parentLab = el.closest('label')
        if (parentLab) labelText = parentLab.textContent || ''
      }
      out.push({ id, name, label: (labelText || '').trim() })
    }
    return out
  }).catch(() => [])
  for (const it of items) {
    const text = `${it.name} ${it.label}`
    if (HARD_ATTESTATION_PATTERNS.some((rx) => rx.test(text))) {
      const kind = /sign|signature|under\s*oath|perjury/i.test(text)
        ? 'signature'
        : /terms|conditions/i.test(text)
          ? 'terms'
          : /release|waive|indemnif|hold\s+harmless/i.test(text)
            ? 'release'
            : 'attestation'
      return {
        kind,
        detail: `Human review required for the exact ${kind} text: "${(it.label || it.name).slice(0, 120)}"`,
      }
    }
  }
  void authorizations
  return null
}

async function detectValidationErrors(page) {
  return await page.$$eval('[role="alert"], .error, .invalid-feedback, .field-error, [aria-invalid="true"]', (els) => {
    const out = []
    for (const el of els) {
      const text = (el.innerText || '').trim()
      if (text && text.length < 400) out.push(text)
    }
    return out
  }).catch(() => [])
}

function summarisePageState(page, fields, buttons) {
  return {
    url: (() => { try { return page.url() } catch { return null } })(),
    field_count: fields.length,
    button_options: buttons.map((b) => b.text),
  }
}

// Caps for the triage snapshot handed to listingDecomposition. Text is bounded
// so the enumeration prompt stays in budget; the NGWeb catalog is ~323k chars.
const TRIAGE_TEXT_CAP = 60_000
const TRIAGE_LINK_CAP = 200

/**
 * Collect the page shape listingPageTriage needs at a dead-end: title, visible
 * anchors (href+text), and innerText — all capped, never throwing. This runs
 * ONLY where the engine already failed to fill/advance, so it adds no cost to
 * the normal fill path.
 */
async function collectTriageSnapshot(page, fieldCount) {
  let url = null
  try { url = page.url() } catch { url = null }
  let title = ''
  let links = []
  let text = ''
  try {
    const snap = await page.evaluate((cap) => ({
      title: document.title || '',
      text: (document.body?.innerText || '').slice(0, cap),
      links: Array.from(document.querySelectorAll('a[href]')).map((a) => ({
        href: a.href,
        text: (a.textContent || '').trim().slice(0, 200),
      })),
    }), TRIAGE_TEXT_CAP)
    title = String(snap?.title || '').slice(0, 300)
    text = String(snap?.text || '')
    links = Array.isArray(snap?.links) ? snap.links.slice(0, TRIAGE_LINK_CAP) : []
  } catch { /* best-effort; empty snapshot triages as NO_APPLICATION_SURFACE */ }
  return { url, title, fieldCount: Number(fieldCount) || 0, links, text }
}

/**
 * At a dead-end (nothing fillable / no advance button), classify the page. When
 * it is a LISTING of real awards, return a `listing_page` blocker carrying the
 * snapshot so the orchestrator can decompose it into per-award candidates;
 * otherwise return null and let the caller terminate honestly. Conservative
 * about FORM — a page with real fillable fields is never reclassified here.
 */
async function triageDeadEnd(page, fieldCount) {
  const snapshot = await collectTriageSnapshot(page, fieldCount)
  const t = triagePage(snapshot)
  if (t.surface !== PAGE_SURFACES.LISTING) return null
  return {
    listing_snapshot: snapshot,
    triage: { signals: t.signals, award_links: t.award_links },
  }
}

function normalizeConfirmationCandidate(value) {
  return String(value || '').trim().replace(/^[#:\s.-]+/, '').replace(/[.,;:)]+$/, '')
}

function isPlausibleConfirmationReference(value, { explicit = false } = {}) {
  const candidate = normalizeConfirmationCandidate(value)
  if (!candidate || candidate.length < 6 || candidate.length > 80) return false
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(candidate)) return false
  if (/^[a-z]+$/.test(candidate)) return false
  if (/\b(designed|through|submit|submitted|application|confirmation|reference|number|thanks)\b/i.test(candidate)) return false
  if (explicit) return true
  return /\d/.test(candidate)
}

// A pre-existing draft "Application ID" is not receipt evidence. Generic
// extraction therefore accepts only labels whose semantics expressly concern
// confirmation, receipt, tracking, or submission.
const CONFIRMATION_LABELS = 'confirmation|reference|ref|submission|receipt|tracking'

function extractConfirmationReference(text) {
  const haystack = String(text || '').replace(/\s+/g, ' ')
  const explicit = haystack.match(new RegExp(
    `\\b(?:${CONFIRMATION_LABELS})\\s*(?:number|no\\.?|#|id|code)\\s*[:#.-]?\\s*([A-Za-z0-9][A-Za-z0-9-]{5,})\\b`, 'i',
  ))
  if (explicit && isPlausibleConfirmationReference(explicit[1], { explicit: true })) {
    return normalizeConfirmationCandidate(explicit[1])
  }
  const generic = haystack.match(new RegExp(
    `\\b(?:${CONFIRMATION_LABELS})\\b[\\s#:.]*([A-Za-z0-9][A-Za-z0-9-]{5,})\\b`, 'i',
  ))
  if (generic && isPlausibleConfirmationReference(generic[1], { explicit: false })) {
    return normalizeConfirmationCandidate(generic[1])
  }
  return null
}

function extractTypedConfirmationReference(text) {
  const haystack = String(text || '').replace(/\s+/g, ' ')
  const explicit = haystack.match(new RegExp(
    `\\b(${CONFIRMATION_LABELS})\\s*(number|no\\.?|#|id|code)\\s*[:#.-]?\\s*([A-Za-z0-9][A-Za-z0-9-]{5,})\\b`, 'i',
  ))
  if (!explicit || !isPlausibleConfirmationReference(explicit[3], { explicit: true })) return null
  return {
    reference: normalizeConfirmationCandidate(explicit[3]),
    reference_kind: /tracking/i.test(explicit[1])
      ? 'tracking'
      : /receipt/i.test(explicit[1])
        ? 'receipt'
        : /submission/i.test(explicit[1])
          ? 'submission'
          : 'confirmation',
    extraction_rule: `explicit_label:${String(explicit[1]).toLowerCase()}_${String(explicit[2]).toLowerCase().replace(/[^a-z]+/g, '')}`,
  }
}

// A submission id printed in the POST-submit URL (?confirmationId=…,
// /confirmation/<id>). Treated as explicit (a query key / path keyword named the
// value, so a digitless all-caps id is fine) but still length/charset/word-guard
// checked, so a `?ref=home` (too short) or a prose word never passes.
const CONFIRMATION_URL_KEYS = new Set([
  'confirmationid', 'confirmation', 'confirmationnumber', 'confirmationno',
  'submissionid', 'submission', 'referenceid',
  'reference', 'refid', 'trackingid', 'tracking', 'receiptid', 'receipt', 'conf', 'ref',
])
const CONFIRMATION_URL_PATH_KEYWORDS =
  /^(confirmation|confirmations|confirm|submission|submissions|submitted|receipt|receipts|reference)$/i

function extractConfirmationReferenceFromUrl(url) {
  if (!url) return null
  let parsed
  try { parsed = new URL(url) } catch { return null }

  for (const [rawKey, value] of parsed.searchParams.entries()) {
    const key = String(rawKey).toLowerCase().replace(/[_-]/g, '')
    if (CONFIRMATION_URL_KEYS.has(key) && isPlausibleConfirmationReference(value, { explicit: true })) {
      return normalizeConfirmationCandidate(value)
    }
  }

  const segments = parsed.pathname.split('/').filter(Boolean)
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (CONFIRMATION_URL_PATH_KEYWORDS.test(segments[i])) {
      const value = decodeURIComponent(segments[i + 1])
      if (isPlausibleConfirmationReference(value, { explicit: true })) {
        return normalizeConfirmationCandidate(value)
      }
    }
  }
  return null
}

// A receipt ACKNOWLEDGEMENT ("your application has been received", "thank you
// for your submission"). This is corroborating evidence a submit landed on a
// real confirmation page — it is NOT a reference and NEVER fabricates one; it is
// recorded as a boolean signal only.
const RECEIPT_ACK_RX = new RegExp(
  [
    '\\b(?:your|the)?\\s*application\\s+(?:has been|was)\\s+(?:successfully\\s+)?(?:received|submitted|accepted)\\b',
    '\\bthank you for (?:your )?(?:application|submission|applying|submitting)\\b',
    '\\b(?:your )?submission (?:was|is)?\\s*(?:successful|complete|completed|received|confirmed)\\b',
    "\\bwe(?:'ve| have) received your (?:application|submission)\\b",
    '\\bapplication (?:successfully )?(?:received|submitted)\\b',
  ].join('|'),
  'i',
)

function detectReceiptAcknowledgement(text) {
  return RECEIPT_ACK_RX.test(String(text || ''))
}

/**
 * Truthfulness of a submit click (owner addendum 2026-08-03): "clicked
 * submit" and "portal confirmed receipt" are different facts. A run may only
 * claim status=submitted with captured evidence — a portal-issued reference
 * (confirmed receipt) or at least the final-page screenshot (submit completed,
 * receipt to be verified). No evidence at all → the caller must report a
 * blocker, never a submission. Pure function — unit-tested directly.
 */
function assessSubmissionEvidence(conf, preClick = null) {
  if (!conf?.reference || !conf?.reference_kind || !conf?.extraction_rule) {
    return { ok: false, confirmation_evidence: 'none' }
  }
  if (conf.received_acknowledgement !== true) return { ok: false, confirmation_evidence: 'none' }
  if (preClick?.reference && preClick.reference === conf.reference) return { ok: false, confirmation_evidence: 'none' }
  if (!preClick?.page_fingerprint || preClick.page_fingerprint === conf.page_fingerprint) {
    return { ok: false, confirmation_evidence: 'none' }
  }
  if (conf?.reference && conf?.extraction_rule) return { ok: true, confirmation_evidence: 'portal_reference' }
  return { ok: false, confirmation_evidence: 'none' }
}

function buildHumanGateCheckpoint({ pageUrl, startUrl, pagesVisited, filledCount, answerSnapshotHash }) {
  return {
    observed_url: safePortalUrl(pageUrl),
    resume_url: safePortalUrl(startUrl),
    pages_visited: pagesVisited,
    progress_durably_saved: false,
    same_context_resumable: false,
    resume_strategy: filledCount > 0 ? 'restart_and_refill_frozen_snapshot' : 'restart_auth_probe',
    answer_snapshot_hash: answerSnapshotHash,
    requires_positive_gate_probe: true,
  }
}

async function captureConfirmation(page, screenshotsDir, {
  afterTimestamp = null,
  submissionAdapter = null,
  expectedApplicationReference = null,
  now = new Date(),
} = {}) {
  const url = (() => { try { return safePortalUrl(page.url(), submissionAdapter) } catch { return null } })()
  const adapterOriginValid = !submissionAdapter || adapterAllowsUrl(submissionAdapter, page.url())
  if (!adapterOriginValid) {
    return {
      url,
      reference: null,
      reference_kind: null,
      extraction_rule: null,
      captured_at: new Date(now).toISOString(),
      evidence_clock_valid: false,
      received_acknowledgement: false,
      page_fingerprint: sha256Text('reviewed-adapter-origin-mismatch'),
    }
  }
  const bodyText = await page.locator('body').innerText({ timeout: 2500 }).catch(() => '')
  const adapted = submissionAdapter
    ? await extractIdentityBoundAdapterReceipt(page, submissionAdapter, expectedApplicationReference)
    : null
  // A reviewed adapter is an executable boundary, not merely permission to
  // fall back to generic page-wide heuristics. Its receipt must come from the
  // exact identity-bound container; otherwise another application shown on a
  // dashboard could be mistaken for this attempt.
  const typed = submissionAdapter ? adapted : extractTypedConfirmationReference(bodyText)
  const receivedAcknowledgement = submissionAdapter
    ? adapted?.received_acknowledgement === true
    : detectReceiptAcknowledgement(bodyText)
  // Full-page screenshots/HTML can persist SSNs, DOB, income, uploaded file
  // names, session tokens, and hidden form values. The engine intentionally
  // retains only a structured, explicitly-labelled receipt candidate. Portal-
  // specific adapters may separately ingest a confirmation PDF through the
  // encrypted document pipeline, but this generic path never stores raw pages.
  void screenshotsDir
  const capturedAt = new Date(now).toISOString()
  const dispatchedAt = Date.parse(afterTimestamp)
  return {
    url,
    reference: typed?.reference || null,
    reference_kind: typed?.reference_kind || null,
    extraction_rule: typed?.extraction_rule || null,
    captured_at: capturedAt,
    evidence_clock_valid: !Number.isFinite(dispatchedAt) || Date.parse(capturedAt) > dispatchedAt,
    received_acknowledgement: receivedAcknowledgement,
    // Hash only; body text never leaves this function or enters logs/audit.
    page_fingerprint: adapted?.page_fingerprint || crypto.createHash('sha256').update(bodyText).digest('hex'),
  }
}

// ── Main loop ────────────────────────────────────────────────────────

/**
 * Run Hamilton Autopilot against a target URL.
 *
 * @param {object} arg
 * @param {string} arg.url               application URL
 * @param {object} arg.profile           pre-loaded profile bundle
 * @param {object} arg.authorizations    boolean flags from hamiltonPreflight.readAuthorizations
 * @param {Array<{path:string,kind:string}>} [arg.documents]  authorized uploads
 * @param {string} [arg.storageStatePath] optional saved Playwright storage state
 * @param {boolean} [arg.allowAutoSubmit] defaults to authorizations.submit_applications
 * @returns {Promise<{
 *   status: 'submitted'|'completed_draft'|'blocked'|'failed',
 *   blocker_kind?: string, blocker_detail?: string,
 *   filled_fields: Array<{key:string, fid:string, value:string}>,
 *   pages_visited: number,
 *   confirmation_reference?: string|null,
 *   confirmation_screenshot_path?: string|null,
 *   confirmation_page_html_path?: string|null,
 *   confirmation_page_text?: string,
 *   confirmation_received_acknowledgement?: boolean,
 *   confirmation_url?: string|null,
 *   trace: Array<{step:string, detail?:any}>,
 * }>}
 */
export async function runAutopilot({
  url,
  profile,
  authorizations,
  documents = [],
  storageStatePath = null,
  storageState = null,
  allowAutoSubmit = null,
  loginCredential = null,
  headless = true,
  screenshotsDir = null,
  sessionSink = null,
  // MBA-level long-form answers drafted by hamiltonFullProposalGenerator
  // (buildPortalNarrativeAnswers). Only the narrative keys below may be
  // overridden — short factual fields (name, address, …) always come from
  // the profile verbatim. Falls back to the profile's raw essays when absent.
  narrativeAnswers = null,
  answerSnapshot = null,
  attemptContext = null,
  beforeExternalAction = null,
  submissionAdapter = null,
  // Test-only dependency seam. Production ignores this unless NODE_ENV=test;
  // it lets regressions exercise missing runtimes/binaries without mutating the
  // installed Playwright package or opening a browser.
  _testRuntime = null,
} = {}) {
  if (!url) throw new Error('url required')
  if (!profile) throw new Error('profile required')
  if (!authorizations) throw new Error('authorizations required')
  const finalAllowSubmit = allowAutoSubmit === null ? Boolean(authorizations.submit_applications) : Boolean(allowAutoSubmit)

  const trace = createRedactionSafeTrace()
  const filled = []
  let loggedIn = false
  let loginAttempted = false

  const guard = async (action, detail = {}) => {
    if (typeof beforeExternalAction !== 'function') throw new Error('external_action_guard_required')
    return beforeExternalAction({ action, attempt: attemptContext, detail })
  }

  try {
    await guard('browser_launch', { portal_url: url })
    if ((storageState && typeof storageState === 'object') || (storageStatePath && fs.existsSync(storageStatePath))) {
      await guard('use_saved_session', { portal_url: url })
    }
  } catch (error) {
    const reason = safeFailureCode(error)
    return {
      status: 'blocked',
      blocker_kind: 'authorization_guard',
      blocker_detail: `Hamilton did not open the portal because the server-side authorization guard refused the action (${reason}).`,
      filled_fields: filled,
      pages_visited: 0,
      trace,
    }
  }

  let browserEgress
  try {
    const prepareEgress = process.env.NODE_ENV === 'test' && _testRuntime?.prepareBrowserEgress
      ? _testRuntime.prepareBrowserEgress
      : prepareHamiltonBrowserEgress
    browserEgress = await prepareEgress({ targetUrl: url, submissionAdapter })
  } catch (error) {
    return {
      status: 'blocked',
      blocker_kind: 'unsafe_portal_target',
      blocker_detail: `Hamilton refused the portal network target (${safeFailureCode(error, 'browser_network_guard_refused')}).`,
      filled_fields: filled,
      pages_visited: 0,
      trace,
    }
  }

  let chromium
  try {
    if (process.env.NODE_ENV === 'test' && _testRuntime?.playwrightUnavailable === true) {
      throw new Error('synthetic_runtime_unavailable')
    }
    if (process.env.NODE_ENV === 'test' && _testRuntime?.chromium) chromium = _testRuntime.chromium
    else ({ chromium } = await import('playwright'))
  } catch {
    return { status: 'human_action_required', blocker_kind: 'no_browser', blocker_detail: 'The browser automation runtime is unavailable. The application remains retryable and no portal dispatch occurred.', filled_fields: filled, pages_visited: 0, trace }
  }
  const exe = chromium.executablePath?.()
  const executableExists = process.env.NODE_ENV === 'test' && _testRuntime?.executableExists
    ? _testRuntime.executableExists
    : fs.existsSync
  if (!exe || !executableExists(exe)) {
    return { status: 'human_action_required', blocker_kind: 'no_browser', blocker_detail: 'The browser binary is unavailable. The application remains retryable and no portal dispatch occurred.', filled_fields: filled, pages_visited: 0, trace }
  }

  // Prefer an in-memory storageState OBJECT (the durable, DB-backed session a
  // user imported after clearing 2FA themselves) — it survives Railway's
  // ephemeral filesystem, unlike an on-disk path. Fall back to a path if given.
  // UA matches the capture-time fingerprint (REALISTIC_PORTAL_UA) so a WAF that
  // bound the session cookies to it accepts the replay.
  const contextOptions = {
    userAgent: REALISTIC_PORTAL_UA,
    ...browserEgress.context_options,
  }
  if (storageState && typeof storageState === 'object') {
    contextOptions.storageState = storageState
  } else if (storageStatePath && fs.existsSync(storageStatePath)) {
    contextOptions.storageState = storageStatePath
  }
  // Guard the setup path: if newContext/newPage throws (e.g. /dev/shm memory
  // pressure), the already-launched Chromium must not leak — the main
  // try/finally below only covers code after both exist.
  let context
  let page
  let browser
  try {
    const launchBrowser = process.env.NODE_ENV === 'test' && _testRuntime?.launchGuardedPortalBrowser
      ? _testRuntime.launchGuardedPortalBrowser
      : launchGuardedPortalBrowser
    const launched = await launchBrowser(chromium, {
      targetUrl: url,
      submissionAdapter,
      headless,
      contextOptions,
      prepareEgress: async () => browserEgress,
    })
    browser = launched.browser
    context = launched.context
    page = await context.newPage()
  } catch (setupErr) {
    await Promise.resolve(browser?.close?.()).catch(() => {})
    return {
      status: 'human_action_required', blocker_kind: 'browser_setup_failed',
      blocker_detail: 'Hamilton could not create a network-confined portal browser context. The application remains retryable and no portal dispatch occurred.',
      error_fingerprint: sha256Text(setupErr?.message || String(setupErr)),
      filled_fields: filled, pages_visited: 0, trace,
    }
  }
  const resolvedAnswerSnapshot = answerSnapshot || buildTargetScopedAnswerSnapshot({
    profile, portalUrl: url, narrativeAnswers,
  })
  const valuesByKey = resolvedAnswerSnapshot.values
  const expectedApplicationReference = submissionAdapter
    ? exactAdapterApplicationReference(url, submissionAdapter)
    : null
  try {
    trace.push({ step: 'navigate', detail: { url } })
    await navigateHamiltonPortalPage(page, url, browserEgress, {
      waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS,
    })

    let pagesVisited = 0
    while (pagesVisited < MAX_PAGES) {
      pagesVisited += 1
      assertHamiltonLivePageAllowed(page, browserEgress)
      trace.push({ step: 'page', detail: { index: pagesVisited, url: (() => { try { return page.url() } catch { return null } })() } })

      const gate = await detectGate(page)
      if (gate) {
        // Saved-login path: when Hamilton hits a login gate and the user saved a
        // login for this portal, type it into the portal's own login form and
        // continue — instead of hard-stopping. Tried at most once.
        if (gate.kind === 'login' && loginCredential && !loginAttempted) {
          try {
            assertHamiltonActionPageAllowed(page, browserEgress, 'credential')
          } catch {
            return {
              status: 'human_action_required', blocker_kind: 'login',
              blocker_detail: 'The portal moved login to an unreviewed path. Hamilton did not enter the saved username or password.',
              checkpoint: buildHumanGateCheckpoint({
                pageUrl: page.url(), startUrl: url, pagesVisited, filledCount: filled.length,
                answerSnapshotHash: resolvedAnswerSnapshot.hash,
              }),
              filled_fields: filled, pages_visited: pagesVisited, trace,
            }
          }
          loginAttempted = true
          trace.push({ step: 'login_attempt', detail: { username: '***' } })
          try {
            await guard('use_credential', { portal_url: (() => { try { return page.url() } catch { return url } })() })
          } catch (error) {
            const reason = safeFailureCode(error)
            return {
              status: 'human_action_required', blocker_kind: 'authorization_guard',
              blocker_detail: `Saved credential use was blocked by the current server-side authorization guard (${reason}).`,
              filled_fields: filled, pages_visited: pagesVisited, trace,
            }
          }
          const ok = await runHamiltonPageAction(
            page, browserEgress, 'credential',
            () => attemptLogin(page, loginCredential),
          )
          trace.push({ step: 'login_result', detail: { ok } })
          if (ok) { loggedIn = true; continue }
          // Login fill failed (couldn't find/submit form) — fall through to the
          // normal hard-stop so the user is told login is required.
          return {
            status: 'human_action_required', blocker_kind: 'login',
            blocker_detail: 'Saved login could not be completed automatically',
            checkpoint: buildHumanGateCheckpoint({
              pageUrl: page.url(), startUrl: url, pagesVisited, filledCount: filled.length,
              answerSnapshotHash: resolvedAnswerSnapshot.hash,
            }),
            filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn,
          }
        }
        trace.push({ step: 'gate', detail: gate })
        return {
          status: 'human_action_required', blocker_kind: gate.kind,
          blocker_detail: `The portal requires a human ${gate.kind} action before Hamilton can continue.`,
          checkpoint: buildHumanGateCheckpoint({
            pageUrl: page.url(), startUrl: url, pagesVisited, filledCount: filled.length,
            answerSnapshotHash: resolvedAnswerSnapshot.hash,
          }),
          filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn,
        }
      }
      const sigGate = await detectAttestationGate(page, { authorizations })
      if (sigGate) {
        trace.push({ step: 'attestation_gate', detail: sigGate })
        return {
          status: 'human_action_required', blocker_kind: sigGate.kind,
          blocker_detail: 'The portal requires review of exact legal, attestation, terms, release, or signature text. Hamilton did not accept it.',
          checkpoint: buildHumanGateCheckpoint({
            pageUrl: page.url(), startUrl: url, pagesVisited, filledCount: filled.length,
            answerSnapshotHash: resolvedAnswerSnapshot.hash,
          }),
          filled_fields: filled, pages_visited: pagesVisited, trace,
        }
      }

      // Same-origin is insufficient for profile/document mutations: a portal
      // redirect can land on an unrelated account, payment, or attacker-
      // controlled tenant path. Every fill/upload/advance/save/submit below is
      // confined to the frozen application-path contract. Root is exact, never
      // a wildcard.
      try {
        assertHamiltonActionPageAllowed(page, browserEgress, 'application')
      } catch {
        return {
          status: 'human_action_required', blocker_kind: 'unknown_portal_state',
          blocker_detail: 'The portal moved to a same-origin path outside the reviewed application scope. Hamilton entered no profile data and performed no document or control action there.',
          checkpoint: buildHumanGateCheckpoint({
            pageUrl: page.url(), startUrl: url, pagesVisited, filledCount: filled.length,
            answerSnapshotHash: resolvedAnswerSnapshot.hash,
          }),
          filled_fields: filled, pages_visited: pagesVisited, trace,
        }
      }

      let reviewedFieldExecution = null
      if (submissionAdapter) {
        reviewedFieldExecution = await runHamiltonPageAction(
          page, browserEgress, 'application',
          () => fillReviewedFieldContract(page, submissionAdapter, valuesByKey, {
            beforeFill: (fieldKeys) => guard('fill_form', {
              portal_url: page.url(),
              field_keys: fieldKeys,
              answer_snapshot_hash: resolvedAnswerSnapshot.hash,
              submission_adapter_id: submissionAdapter.id,
              submission_adapter_version: submissionAdapter.version,
            }),
          }),
        ).catch((error) => ({
          valid: false,
          reason: safeFailureCode(error, 'reviewed_field_contract_failed'),
          issues: ['reviewed_field_contract_failed'],
          filled: [],
        }))
        if (!reviewedFieldExecution.valid) {
          return {
            status: 'human_action_required', blocker_kind: 'unknown_portal_state',
            blocker_detail: `The reviewed portal field contract changed (${reviewedFieldExecution.reason || 'field drift'}). Hamilton stopped before any final submission.`,
            adapter_field_issues: (reviewedFieldExecution.issues || []).map((issue) => sha256Text(issue)),
            filled_fields: filled, pages_visited: pagesVisited, trace,
          }
        }
        filled.push(...reviewedFieldExecution.filled)
      }

      const fields = await detectFields(page)
      const submitButtons = await detectButtons(page, SUBMIT_BUTTON_PATTERNS)
      const nextButtons   = await detectButtons(page, NEXT_BUTTON_PATTERNS)
      const draftButtons  = await detectButtons(page, DRAFT_BUTTON_PATTERNS)
      trace.push({ step: 'inspect', detail: summarisePageState(page, fields, [...submitButtons, ...nextButtons, ...draftButtons]) })

      // Generic matching is draft-assist only. A reviewed auto-submit adapter
      // must execute its exact, fixture-backed field contract above.
      let filledThisPage = reviewedFieldExecution?.filled?.length || 0
      if (!submissionAdapter) {
        const plannedFieldKeys = [...new Set(fields.map((field) => matchFieldKey(field)?.key).filter((key) => (
          key && valuesByKey[key] !== undefined && valuesByKey[key] !== null && String(valuesByKey[key]).trim() !== ''
        )))]
        if (plannedFieldKeys.length > 0) {
          try {
            await guard('fill_form', {
              portal_url: page.url(),
              field_keys: plannedFieldKeys,
              answer_snapshot_hash: resolvedAnswerSnapshot.hash,
            })
          } catch (error) {
            const reason = safeFailureCode(error)
            return {
              status: 'human_action_required', blocker_kind: 'authorization_guard',
              blocker_detail: `Form filling was blocked by the current server-side authorization guard (${reason}).`,
              filled_fields: filled, pages_visited: pagesVisited, trace,
            }
          }
        }
        for (const f of fields) {
          const rule = matchFieldKey(f)
          if (!rule) continue
          const v = valuesByKey[rule.key]
          if (v === undefined || v === null || String(v).trim() === '') continue
          if (!authorizations.complete_forms && rule.key !== 'email' && rule.key !== 'first_name' && rule.key !== 'last_name') continue
          if (rule.multiline && !authorizations.generate_narratives && !valuesByKey.essay && !valuesByKey.goals) continue
          const ok = await runHamiltonPageAction(
            page, browserEgress, 'application',
            () => fillFieldByFid(page, f.fid, v),
          )
          if (ok) {
            filled.push({ key: rule.key, fid: f.fid, outcome: 'filled_from_frozen_snapshot' })
            filledThisPage += 1
          }
        }
      }
      trace.push({ step: 'fill', detail: { filledThisPage } })

      // Authorized document uploads.
      if (authorizations.upload_documents && Array.isArray(documents) && documents.length > 0) {
        const fileInputs = fields.filter((f) => f.type === 'file')
        if (submissionAdapter && fileInputs.length > 0) {
          return {
            status: 'human_action_required', blocker_kind: 'manual_upload',
            blocker_detail: 'This reviewed portal page requires a document upload. Hamilton paused because no exact malware-checked document field contract is available.',
            filled_fields: filled, pages_visited: pagesVisited, trace,
          }
        }
        for (const inp of fileInputs) {
          const matching = documents.filter((d) => {
            const text = `${inp.name} ${inp.label} ${inp.id} ${inp.placeholder}`.toLowerCase()
            const kind = String(d.kind || '').trim().toLowerCase()
            return kind && text.includes(kind)
          })
          const wanted = matching.length === 1 ? matching[0] : null
          if (!wanted?.path || wanted?.security_status !== 'malware_checked_clean') {
            return {
              status: 'human_action_required', blocker_kind: 'manual_upload',
              blocker_detail: 'Hamilton could not bind this upload control to exactly one authorized, malware-checked document. Upload it manually.',
              filled_fields: filled, pages_visited: pagesVisited, trace,
            }
          }
          if (!wanted?.document_id) {
            return {
              status: 'human_action_required', blocker_kind: 'manual_upload',
              blocker_detail: 'An upload path was supplied without an exact authorized document id.',
              filled_fields: filled, pages_visited: pagesVisited, trace,
            }
          }
          try {
            await guard('upload_document', {
              portal_url: page.url(), document_id: wanted.document_id, kind: wanted.kind || null,
            })
          } catch (error) {
            const reason = safeFailureCode(error)
            return {
              status: 'human_action_required', blocker_kind: 'authorization_guard',
              blocker_detail: `Document upload was blocked by the current server-side authorization guard (${reason}).`,
              filled_fields: filled, pages_visited: pagesVisited, trace,
            }
          }
          const ok = await runHamiltonPageAction(
            page, browserEgress, 'application',
            () => fillFieldByFid(page, inp.fid, wanted.path),
          )
          if (ok) trace.push({ step: 'upload', detail: { kind: wanted.kind, document_id: wanted.document_id, fid: inp.fid } })
        }
      }

      // Decide what to click next. Submit controls pass the truthfulness gate
      // first (actionableSubmitButtons): Hamilton only treats a submit-looking
      // control as an application submit when she actually filled application
      // fields on this run, or the control sits inside a real form with
      // fillable fields.
      const submitCandidates = actionableSubmitButtons(submitButtons, {
        anyFieldFilled: filled.length > 0,
        recognizedFieldCount: fields.length,
      })
      const reviewedSubmitControl = submissionAdapter
        ? await inspectReviewedSubmitControl(page, submissionAdapter)
        : null
      const canSubmit = submissionAdapter ? reviewedSubmitControl?.matched === true : submitCandidates.length > 0
      const canNext   = nextButtons.length > 0
      const canDraft  = draftButtons.length > 0

      if (submissionAdapter && !canSubmit && submitButtons.length > 0) {
        return {
          status: 'human_action_required',
          blocker_kind: 'final_review_submit',
          blocker_detail: `The reviewed portal adapter no longer matches the exact final control (${reviewedSubmitControl?.reason || 'unknown drift'}). Hamilton stopped before clicking.`,
          filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn,
        }
      }

      if (!canSubmit && !canNext && submitButtons.length > 0) {
        // The page has submit-LOOKING controls but no application form Hamilton
        // worked (nothing filled; controls are page chrome / nav links). Before
        // degrading to the manual packet pathway, triage: a LISTING of real
        // awards (bold.org category, scholarships.com) must be decomposed into
        // per-award candidates, not treated as one dead informational page.
        if (filled.length === 0) {
          const listing = await triageDeadEnd(page, fields.length)
          if (listing) {
            trace.push({ step: 'listing_page', detail: { from: 'no_application_form', signals: listing.triage.signals } })
            return {
              status: 'blocked', blocker_kind: 'listing_page',
              blocker_detail: 'This page lists multiple award opportunities rather than a single application form. Hamilton will decompose it into per-award candidates, match each to the profile, and apply for the ones the match engine accepts.',
              listing_snapshot: listing.listing_snapshot, triage: listing.triage,
              filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn,
            }
          }
        }
        trace.push({
          step: 'no_application_form',
          detail: { ignored_submit_like_controls: submitButtons.map((b) => b.text).slice(0, 5) },
        })
        return {
          status: 'blocked',
          blocker_kind: 'no_application_form',
          blocker_detail: 'This page has no application form to fill — the only submit-like controls are page chrome or navigation links (informational page). Hamilton degrades to the manual funder-contact packet pathway.',
          filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn,
        }
      }

      if (canSubmit && finalAllowSubmit) {
        const filledFids = new Set(filled.map((item) => item.fid))
        const unresolvedRequired = fields.filter((field) => {
          if (!field.required) return false
          if (submissionAdapter && !field.reviewedAnswerKey) return true
          if (filledFids.has(field.fid)) return false
          if ((field.type === 'checkbox' || field.type === 'radio') && field.checked === true) return false
          return field.value === null || field.value === undefined || String(field.value).trim() === ''
        })
        if (unresolvedRequired.length > 0) {
          const unsupported = unresolvedRequired.filter((field) => !matchFieldKey(field))
          return {
            status: 'human_action_required',
            blocker_kind: unsupported.length > 0 ? 'unknown_portal_state' : 'missing_information',
            blocker_detail: unsupported.length > 0
              ? 'The portal has required fields Hamilton cannot safely map. Review the current questions before submission.'
              : 'Required portal fields are still unanswered. Review the missing information before submission.',
            unresolved_required_fields: unresolvedRequired.map((field) => ({
              fid: field.fid, key: matchFieldKey(field)?.key || null,
              label_sha256: sha256Text(field.label || field.name || field.id || ''),
            })),
            filled_fields: filled, pages_visited: pagesVisited, trace,
          }
        }
        if (submissionAdapter) {
          const finalFieldCheck = await verifyReviewedFieldExecution(
            page, submissionAdapter, valuesByKey, reviewedFieldExecution,
          )
          if (!finalFieldCheck.valid) {
            return {
              status: 'human_action_required', blocker_kind: 'unknown_portal_state',
              blocker_detail: 'The reviewed field schema changed before final submission. Hamilton stopped before the click.',
              adapter_field_issues: (finalFieldCheck.issues || []).map((issue) => sha256Text(issue)),
              filled_fields: filled, pages_visited: pagesVisited, trace,
            }
          }
        }
        const submitText = submissionAdapter
          ? `adapter:${submissionAdapter.id}@${submissionAdapter.version}`
          : String(submitCandidates[0].text || '').trim()
        let submitHost = ''
        try { submitHost = new URL(page.url()).hostname.toLowerCase() } catch { /* fail below when host is unknown */ }
        if ((submitHost === 'grants.gov' || submitHost.endsWith('.grants.gov')) && !/^sign\s+and\s+submit\b/i.test(submitText)) {
          return {
            status: 'human_action_required', blocker_kind: 'role_aor',
            blocker_detail: 'Grants.gov is only ready for submission. Complete and Notify AOR does not submit; an authorized Standard/Expanded AOR must review Sign and Submit.',
            filled_fields: filled, pages_visited: pagesVisited, trace,
          }
        }
        // Snapshot only redaction-safe receipt signals before the click. A
        // draft Application ID/reference already present here can never be
        // promoted as a post-submit receipt.
        const preClickReceipt = await captureConfirmation(page, null, {
          submissionAdapter, expectedApplicationReference,
        })
        let submitFence = null
        try {
          // The server callback rechecks live versioned consent + profile
          // toggles and atomically moves the fenced attempt to
          // submission_in_flight immediately before this one click.
          submitFence = await guard('final_submit', {
            portal_url: page.url(), button_label_sha256: sha256Text(submitText),
            answer_snapshot_hash: resolvedAnswerSnapshot.hash,
            submission_adapter_id: submissionAdapter?.id || null,
            submission_adapter_version: submissionAdapter?.version || null,
            fixture_contract_sha256: submissionAdapter?.fixture_contract_sha256 || null,
          })
        } catch (error) {
          const reason = safeFailureCode(error)
          return {
            status: 'human_action_required', blocker_kind: 'authorization_guard',
            blocker_detail: `Final submission was blocked by the current server-side authorization guard (${reason}).`,
            filled_fields: filled, pages_visited: pagesVisited, trace,
          }
        }
        // Submit exactly once. No retry path exists after this point until a
        // read-only portal reconciliation proves absence of receipt.
        trace.push({ step: 'submit_attempt', detail: { button_text_sha256: sha256Text(submitText), adapter_id: submissionAdapter?.id || null } })
        const beforeUrl = (() => { try { return page.url() } catch { return null } })()
        const adapterClick = submissionAdapter
          ? await runHamiltonPageAction(page, browserEgress, 'application', () => clickReviewedSubmitControl(page, submissionAdapter, {
              validateBeforeCommit: () => verifyReviewedFieldExecution(
                page, submissionAdapter, valuesByKey, reviewedFieldExecution,
              ),
              beforeClick: () => guard('final_submit_commit', {
                portal_url: page.url(),
                answer_snapshot_hash: resolvedAnswerSnapshot.hash,
                submission_adapter_id: submissionAdapter.id,
                submission_adapter_version: submissionAdapter.version,
                fixture_contract_sha256: submissionAdapter.fixture_contract_sha256,
              }),
              validateAfterCommit: () => verifyReviewedFieldExecution(
                page, submissionAdapter, valuesByKey, reviewedFieldExecution,
              ),
            }))
          : null
        const clicked = submissionAdapter
          ? adapterClick?.clicked === true
          : await runHamiltonPageAction(
            page, browserEgress, 'application',
            () => clickButtonByBid(page, submitCandidates[0].bid),
          )
        if (adapterClick?.commit_result) submitFence = adapterClick.commit_result
        if (!clicked) {
          if (submissionAdapter && adapterClick?.committed !== true) {
            return {
              status: 'human_action_required', blocker_kind: 'final_review_submit',
              blocker_detail: 'The exact reviewed submit control or final authorization changed before dispatch. Hamilton did not click and left the attempt ready for review.',
              submit_clicked: false, filled_fields: filled, pages_visited: pagesVisited, trace,
            }
          }
          return {
            status: 'reconciliation_required', blocker_kind: 'submit_click_failed',
            blocker_detail: 'The submission dispatch was committed, but the exact click outcome is unknown. Reconcile portal state before any retry.',
            submit_clicked: false, filled_fields: filled, pages_visited: pagesVisited, trace,
          }
        }
        // Wait for navigation/state-change. A submit usually navigates to a
        // confirmation page (classic form POST) but may update in place (SPA).
        // `domcontentloaded` alone can resolve against the *pre-submit* document
        // before the navigation commits, racing detectValidationErrors and
        // captureConfirmation into stale HTML and dropping the confirmation
        // reference. Follow it with `networkidle` so the in-flight POST and the
        // confirmation render actually settle before we read the page.
        await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT_MS }).catch(() => null)
        await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS }).catch(() => null)
        const errors = await detectValidationErrors(page)
        if (errors.length > 0) {
          trace.push({ step: 'submit_validation_failed', detail: { errors: errors.slice(0, 5) } })
          return {
            status: 'reconciliation_required', blocker_kind: 'post_submit_validation',
            blocker_detail: `The portal reported ${errors.length} validation issue(s) after the submit action. Reconcile before retrying; no answer text was retained.`,
            submit_clicked: true, filled_fields: filled, pages_visited: pagesVisited, trace,
          }
        }
        const conf = await captureConfirmation(page, screenshotsDir, {
          afterTimestamp: submitFence?.submit_dispatched_at || null,
          submissionAdapter,
          expectedApplicationReference,
        })
        const evidence = submissionAdapter
          ? (assessAdapterPostClickObservation(preClickReceipt, conf).received
              ? { ok: true, confirmation_evidence: 'reviewed_adapter_receipt' }
              : { ok: false, confirmation_evidence: 'none' })
          : assessSubmissionEvidence(conf, preClickReceipt)
        if (!evidence.ok) {
          trace.push({ step: 'submit_unconfirmed', detail: { from: beforeUrl, to: conf.url } })
          return {
            status: 'reconciliation_required',
            blocker_kind: 'submit_outcome_ambiguous',
            blocker_detail: 'Hamilton clicked the portal submit action, but no typed portal receipt or tracking identifier was captured. GrantFlow will not click again or count this as submitted until portal status is reconciled.',
            submit_clicked: true,
            confirmation_received_acknowledgement: conf.received_acknowledgement,
            confirmation_url: conf.url,
            captured_at: conf.captured_at,
            pre_click_page_fingerprint: preClickReceipt.page_fingerprint,
            post_click_page_fingerprint: conf.page_fingerprint,
            filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn,
          }
        }
        try {
          await guard('persist_proof', { portal_url: conf.url, evidence_type: 'portal_confirmation_reference' })
        } catch (error) {
          const reason = safeFailureCode(error, 'proof_persistence_guard_refused')
          return {
            status: 'reconciliation_required', blocker_kind: 'proof_persistence_guard',
            blocker_detail: `The portal may have received the application, but the proof-persistence guard refused the transition (${reason}). Reconcile before retrying.`,
            submit_clicked: true, confirmation_url: conf.url, captured_at: conf.captured_at,
            filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn,
          }
        }
        trace.push({ step: 'external_receipt_candidate', detail: { from: beforeUrl, to: conf.url, confirmation_evidence: evidence.confirmation_evidence, received_acknowledgement: conf.received_acknowledgement } })
        return {
          status: 'external_receipt_candidate',
          submit_clicked: true,
          confirmation_evidence: evidence.confirmation_evidence,
          confirmation_reference: conf.reference,
          confirmation_reference_kind: conf.reference_kind,
          confirmation_extraction_rule: conf.extraction_rule,
          confirmation_captured_at: conf.captured_at,
          confirmation_received_acknowledgement: conf.received_acknowledgement,
          confirmation_url: conf.url,
          pre_click_reference: preClickReceipt.reference,
          pre_click_page_fingerprint: preClickReceipt.page_fingerprint,
          post_click_page_fingerprint: conf.page_fingerprint,
          filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn,
        }
      }

      if (canSubmit && !finalAllowSubmit) {
        // We are on the final page without a reviewed auto-submit path. A
        // generic Save click is not proof that the portal durably preserved
        // the answers, so never label this portal_draft_saved. Record whether
        // a save was attempted and hand final control to the human.
        let draftSaveAttempted = false
        if (canDraft && authorizations.save_drafts) {
          try { await guard('save_draft', { portal_url: page.url() }) } catch (error) {
            const reason = safeFailureCode(error)
            return {
              status: 'human_action_required', blocker_kind: 'authorization_guard',
              blocker_detail: `Draft save was blocked by the current server-side authorization guard (${reason}).`,
              filled_fields: filled, pages_visited: pagesVisited, trace,
            }
          }
          draftSaveAttempted = await runHamiltonPageAction(
            page, browserEgress, 'application',
            () => clickButtonByBid(page, draftButtons[0].bid),
          )
          await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT_MS }).catch(() => null)
        }
        trace.push({ step: 'human_final_submit', detail: { draft_save_attempted: draftSaveAttempted, draft_save_verified: false } })
        return {
          status: 'human_action_required',
          blocker_kind: 'final_review_submit',
          blocker_detail: draftSaveAttempted
            ? 'Hamilton reached the final step and attempted Save, but this portal has no reviewed draft-verification adapter. Open the portal, verify the answers persisted, review the exact final page, and submit yourself.'
            : 'Hamilton reached the final step, but this portal has no reviewed final-submit adapter or verifiable draft checkpoint. Open the portal, review/refill from the frozen application snapshot, and submit yourself.',
          checkpoint: buildHumanGateCheckpoint({
            pageUrl: page.url(), startUrl: url, pagesVisited, filledCount: filled.length,
            answerSnapshotHash: resolvedAnswerSnapshot.hash,
          }),
          draft_save_attempted: draftSaveAttempted,
          draft_save_verified: false,
          filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn,
        }
      }

      if (canNext) {
        try { await guard('advance_page', { portal_url: page.url() }) } catch (error) {
          const reason = safeFailureCode(error)
          return {
            status: 'human_action_required', blocker_kind: 'authorization_guard',
            blocker_detail: `Portal advance was blocked by the current server-side authorization guard (${reason}).`,
            filled_fields: filled, pages_visited: pagesVisited, trace,
          }
        }
        const clicked = await runHamiltonPageAction(
          page, browserEgress, 'application',
          () => clickButtonByBid(page, nextButtons[0].bid),
        )
        if (!clicked) {
          return { status: 'failed', blocker_kind: 'click_failed', blocker_detail: 'Next button could not be clicked', filled_fields: filled, pages_visited: pagesVisited, trace }
        }
        await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT_MS }).catch(() => null)
        const errors = await detectValidationErrors(page)
        if (errors.length > 0) {
          trace.push({ step: 'validation_after_next', detail: { errors: errors.slice(0, 5) } })
          return { status: 'blocked', blocker_kind: 'validation', blocker_detail: `The portal reported ${errors.length} validation issue(s). Review them in the portal; GrantFlow did not retain their text.`, filled_fields: filled, pages_visited: pagesVisited, trace }
        }
        continue
      }

      // No button to advance. If save_drafts authorized and a draft
      // button exists, save it.
      if (canDraft && authorizations.save_drafts) {
        try { await guard('save_draft', { portal_url: page.url() }) } catch (error) {
          const reason = safeFailureCode(error)
          return {
            status: 'human_action_required', blocker_kind: 'authorization_guard',
            blocker_detail: `Draft save was blocked by the current server-side authorization guard (${reason}).`,
            filled_fields: filled, pages_visited: pagesVisited, trace,
          }
        }
        await runHamiltonPageAction(
          page, browserEgress, 'application',
          () => clickButtonByBid(page, draftButtons[0].bid),
        )
        trace.push({ step: 'completed_draft', detail: { reason: 'no_next_button' } })
        return { status: 'completed_draft', filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn }
      }

      // Nothing to advance. Before reporting a hard no_progress, triage: the
      // NGWeb /Scholarships/Search catalog and other award LISTINGS dead-end
      // here (a search box + filter, no advance button, hundreds of award rows).
      // A LISTING decomposes; a genuine no-application-surface page terminates.
      if (filled.length === 0) {
        const listing = await triageDeadEnd(page, fields.length)
        if (listing) {
          trace.push({ step: 'listing_page', detail: { from: 'no_progress', signals: listing.triage.signals } })
          return {
            status: 'blocked', blocker_kind: 'listing_page',
            blocker_detail: 'This page lists multiple award opportunities rather than a single application form. Hamilton will decompose it into per-award candidates, match each to the profile, and apply for the ones the match engine accepts.',
            listing_snapshot: listing.listing_snapshot, triage: listing.triage,
            filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn,
          }
        }
      }
      trace.push({ step: 'no_progress', detail: { reason: 'no advance button found' } })
      return { status: 'blocked', blocker_kind: 'no_progress', blocker_detail: 'Hamilton could not find a Next/Submit button to continue', filled_fields: filled, pages_visited: pagesVisited, trace }
    }

    return { status: 'blocked', blocker_kind: 'too_many_pages', blocker_detail: `Hit ${MAX_PAGES} page cap`, filled_fields: filled, pages_visited: pagesVisited, trace }
  } catch (err) {
    const raw = err?.message || String(err)
    // DNS / connection / navigation-timeout failures are a distinct,
    // user-explainable blocker (dead link or site down). Without this branch
    // they fell into the generic engine_error bucket and users saw raw
    // Playwright text ("Hamilton could not classify this blocker: page.goto:
    // net::ERR_NAME_NOT_RESOLVED …").
    if (/net::ERR_[A-Z_]+|\b(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH)\b|getaddrinfo|Timeout \d+ms exceeded/i.test(raw)) {
      let host = ''
      try { host = new URL(url).hostname } catch { /* non-parseable url — keep generic wording */ }
      return {
        status: 'failed',
        blocker_kind: 'portal_unreachable',
        blocker_detail: `Hamilton could not reach ${host || "the funder's website"} — the site may be down or the saved portal link may be outdated.`,
        error_fingerprint: sha256Text(raw),
        filled_fields: filled,
        pages_visited: 0,
        trace,
      }
    }
    return {
      status: 'failed',
      blocker_kind: 'engine_error',
      blocker_detail: 'Hamilton encountered a technical portal error and stopped without retaining raw page or input text.',
      error_fingerprint: sha256Text(raw),
      filled_fields: filled,
      pages_visited: 0,
      trace,
    }
  } finally {
    // Persist the authenticated session so the NEXT run reuses it instead of
    // re-logging-in. Portal logins must survive across runs AND container
    // restarts; the orchestrator encrypts this storageState into the DB. Only
    // capture when a login actually succeeded, and never let a capture failure
    // break the run (best-effort). Runs on every exit path via finally.
    try {
      if (loggedIn && sessionSink && context) {
        sessionSink.storageState = await context.storageState()
      }
    } catch { /* capture is best-effort; ignore */ }
    try { await context.close() } catch { /* ignore */ }
    try { await browser.close() } catch { /* ignore */ }
  }
}

export const _internal = {
  FIELD_RULES, STANDING_ATTESTATION_PATTERNS, HARD_ATTESTATION_PATTERNS,
  SUBMIT_BUTTON_PATTERNS, NEXT_BUTTON_PATTERNS, DRAFT_BUTTON_PATTERNS,
  matchFieldKey, readProfileValues, applyNarrativeAnswers,
  detectGate, detectBotWall, attemptLogin,
  extractConfirmationReference,
  extractTypedConfirmationReference,
  extractConfirmationReferenceFromUrl,
  detectReceiptAcknowledgement,
  captureConfirmation,
  actionableSubmitButtons,
  assessSubmissionEvidence,
  buildHumanGateCheckpoint,
  safePortalUrl,
  sanitizeTraceValue,
  createRedactionSafeTrace,
  safeFailureCode,
  exactAdapterApplicationReference,
}
