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
 *   7. After submission, capture confirmation reference + screenshot.
 *
 * Hamilton NEVER:
 *   - solves CAPTCHA or signs anything.
 *   - completes a 2FA challenge. The user may clear 2FA themselves and save
 *     the resulting trusted browser session, but Hamilton never derives, types,
 *     intercepts, or replays a live MFA code.
 *   - clicks a legal-attestation checkbox unless `use_standing_attestation`
 *     is authorized AND the checkbox is in the recognised attestation
 *     allow-list (financial-aid eligibility self-certification, etc.).
 *   - bypasses an anti-bot challenge.
 *
 * Profile is provided pre-loaded; no database read during the run.
 */

import fs from 'node:fs'
import { launchPortalBrowser, REALISTIC_PORTAL_UA } from './browserLaunch.js'
import path from 'node:path'
import { registrableDomain } from './hamiltonPortalCredentialService.js'
import { triagePage, PAGE_SURFACES } from './listingPageTriage.js'
import { resolveConfirmationCaptureDir } from './hamiltonConfirmationArtifacts.js'

const NAV_TIMEOUT_MS = Number(process.env.HAMILTON_AUTOPILOT_NAV_TIMEOUT_MS) || 25_000
const STEP_TIMEOUT_MS = Number(process.env.HAMILTON_AUTOPILOT_STEP_TIMEOUT_MS) || 8_000
const MAX_PAGES = Number(process.env.HAMILTON_AUTOPILOT_MAX_PAGES) || 12

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

// Attestation labels Hamilton CAN auto-check when use_standing_attestation
// is authorized. Anything outside this list is a hard blocker.
const STANDING_ATTESTATION_PATTERNS = [
  /information.*(true|accurate|correct).*best\s*of.*knowledge/i,
  /authorize.*(verify|release|confirm).*information/i,
  /agree.*terms.*conditions/i,
  /understand.*may\s*be\s*disqualif/i,
]

// Hard-blocker labels Hamilton NEVER auto-checks.
const HARD_ATTESTATION_PATTERNS = [
  /electronic\s*signature/i,
  /sign\s*(here|below|name)/i,
  /penalty\s*of\s*perjury/i,
  /under\s*oath/i,
  /digital\s*signature/i,
]

const SUBMIT_BUTTON_PATTERNS = [/^submit/i, /finalize/i, /apply\s*now/i, /complete\s*application/i, /send\s*application/i]
const NEXT_BUTTON_PATTERNS   = [/^next/i, /continue/i, /proceed/i, /save\s*&\s*continue/i]
const DRAFT_BUTTON_PATTERNS  = [/save\s*draft/i, /save\s*&\s*exit/i, /save\s*for\s*later/i]

// ── Profile reader (mirrors mapping in packet generator) ─────────────

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
 * Org profiles are first-class fill sources (owner addendum 2026-08-03): a
 * ministry/nonprofit answering a portal's "tell us about your organization /
 * describe" box should get its OWN narrative — mission + programs — not a
 * blank because it has no student essay. Composed only when present; the
 * personal-essay paths below still win for individual profiles.
 */
function readOrgNarrative(profile) {
  const mission = pick(profile, [
    'narrative.mission_statement', 'organization_details.mission_statement', 'mission_statement',
  ])
  const programs = pick(profile, [
    'narrative.programs_description', 'organization_details.programs_description',
  ])
  const joined = [mission, programs].filter(Boolean).join('\n\n')
  return joined || undefined
}

function readProfileValues(profile) {
  const apps = pick(profile, ['university_applications.applications']) || []
  const firstApp = Array.isArray(apps) && apps.length > 0 ? apps[0] : {}
  return {
    first_name:  pick(profile, ['basic_information.first_name', 'first_name']),
    last_name:   pick(profile, ['basic_information.last_name', 'last_name']),
    full_name:   [pick(profile, ['basic_information.first_name','first_name']), pick(profile, ['basic_information.last_name','last_name'])].filter(Boolean).join(' ') || undefined,
    email:       pick(profile, ['basic_information.email', 'email']),
    phone:       pick(profile, ['basic_information.phone', 'phone']),
    address1:    pick(profile, ['basic_information.address1', 'basic_information.address']),
    address2:    pick(profile, ['basic_information.address2']),
    city:        pick(profile, ['basic_information.city']),
    state:       pick(profile, ['basic_information.state']),
    zip:         pick(profile, ['basic_information.zip']),
    country:     pick(profile, ['basic_information.country']) || 'United States',
    school:      firstApp.name      || pick(profile, ['student_info.school_name']),
    major:       firstApp.major     || pick(profile, ['student_info.major']),
    degree_level:firstApp.degree_level || pick(profile, ['student_info.degree_level']),
    student_id:  firstApp.student_id || pick(profile, ['student_info.student_id']),
    gpa:         pick(profile, ['student_info.gpa', 'gpa']),
    act_score:   pick(profile, ['student_info.act_score', 'act_score']),
    sat_score:   pick(profile, ['student_info.sat_score', 'sat_score']),
    expected_graduation: firstApp.expected_graduation || pick(profile, ['student_info.expected_graduation']),
    household_income: pick(profile, ['financial_information.household_income', 'household.income', 'household_income']),
    household_size:   pick(profile, ['financial_information.household_size', 'household.size', 'household_size']),
    fafsa_efc:        pick(profile, ['financial_information.fafsa_efc', 'financial_information.sai']),
    essay:            pick(profile, ['essays.primary', 'essays.personal_statement', 'personal_statement'])
                        ?? readOrgNarrative(profile),
    goals:            pick(profile, ['essays.goals', 'goals', 'career_goals']),
  }
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

async function detectGate(page) {
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
      return { kind: 'signature', detail: `Wet/digital signature attestation present: "${(it.label || it.name).slice(0, 120)}"` }
    }
    if (STANDING_ATTESTATION_PATTERNS.some((rx) => rx.test(text))) {
      if (!authorizations.use_standing_attestation) {
        return { kind: 'attestation', detail: `Legal attestation present (no standing authorization): "${(it.label || it.name).slice(0, 120)}"` }
      }
      // Authorized — Hamilton may tick it later in fill loop.
    }
  }
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

// Confirmation-label vocabulary. Conservative additions (2026-08-03): common
// real labels a portal prints beside a submission id — Ref/Reference,
// Application ID, Submission/Receipt/Tracking — WITHOUT loosening the plausible-
// candidate discipline that already rejected "Application designed…". The
// captured candidate STILL has to pass isPlausibleConfirmationReference, so a
// broader label can never manufacture a reference from prose.
const CONFIRMATION_LABELS = 'confirmation|reference|ref|application|submission|receipt|tracking'

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

// A submission id printed in the POST-submit URL (?confirmationId=…,
// /confirmation/<id>). Treated as explicit (a query key / path keyword named the
// value, so a digitless all-caps id is fine) but still length/charset/word-guard
// checked, so a `?ref=home` (too short) or a prose word never passes.
const CONFIRMATION_URL_KEYS = new Set([
  'confirmationid', 'confirmation', 'confirmationnumber', 'confirmationno',
  'submissionid', 'submission', 'applicationid', 'appid', 'referenceid',
  'reference', 'refid', 'trackingid', 'tracking', 'receiptid', 'receipt', 'conf', 'ref',
])
const CONFIRMATION_URL_PATH_KEYWORDS =
  /^(confirmation|confirmations|confirm|submission|submissions|submitted|receipt|receipts|reference|application|applications)$/i

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
function assessSubmissionEvidence(conf) {
  if (conf?.reference) return { ok: true, confirmation_evidence: 'portal_reference' }
  if (conf?.screenshot_path) return { ok: true, confirmation_evidence: 'screenshot_only' }
  return { ok: false, confirmation_evidence: 'none' }
}

async function captureConfirmation(page, screenshotsDir) {
  const url = (() => { try { return page.url() } catch { return null } })()
  const bodyText = await page.locator('body').innerText({ timeout: 2500 }).catch(() => '')
  const html = await page.content().catch(() => '')
  // Extract a confirmation reference if any looks like one. The label match is
  // case-insensitive, but we only accept explicit labelled codes or generic
  // references with digits (or a submission id printed in the post-submit URL).
  // That avoids old false positives like "Application designed..." while still
  // accepting real all-letter IDs when the page says "Confirmation #:",
  // "Reference code:", or the URL carries ?confirmationId=…. A saved page + a
  // screenshot are captured EVEN WHEN no reference matches, so proof survives a
  // portal that prints no reference number.
  const reference = extractConfirmationReference(bodyText)
    || extractConfirmationReference(html)
    || extractConfirmationReferenceFromUrl(url)
  const receivedAcknowledgement = detectReceiptAcknowledgement(bodyText) || detectReceiptAcknowledgement(html)
  const stamp = Date.now()
  let screenshotPath = null
  let pageHtmlPath = null
  try {
    if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true })
    screenshotPath = path.join(screenshotsDir, `confirmation_${stamp}.png`)
    await page.screenshot({ path: screenshotPath, fullPage: true })
  } catch { screenshotPath = null }
  // Save the confirmation page itself (durable, searchable text/HTML proof).
  // The orchestrator registers both the screenshot and this page as retrievable
  // documents; capturing the page is what preserves proof when the portal shows
  // no reference number.
  try {
    if (html) {
      if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true })
      pageHtmlPath = path.join(screenshotsDir, `confirmation_${stamp}.html`)
      fs.writeFileSync(pageHtmlPath, html, 'utf8')
    }
  } catch { pageHtmlPath = null }
  return {
    url,
    reference,
    screenshot_path: screenshotPath,
    page_html_path: pageHtmlPath,
    page_text: bodyText ? String(bodyText).slice(0, 4000) : '',
    received_acknowledgement: receivedAcknowledgement,
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
} = {}) {
  if (!url) throw new Error('url required')
  if (!profile) throw new Error('profile required')
  if (!authorizations) throw new Error('authorizations required')
  const finalAllowSubmit = allowAutoSubmit === null ? Boolean(authorizations.submit_applications) : Boolean(allowAutoSubmit)

  const trace = []
  const filled = []
  let loggedIn = false
  let loginAttempted = false

  let chromium
  try {
    ({ chromium } = await import('playwright'))
  } catch (err) {
    return { status: 'failed', blocker_kind: 'no_browser', blocker_detail: `Playwright unavailable: ${err?.message || err}`, filled_fields: filled, pages_visited: 0, trace }
  }
  const exe = chromium.executablePath?.()
  if (!exe || !fs.existsSync(exe)) {
    return { status: 'failed', blocker_kind: 'no_browser', blocker_detail: 'Playwright chromium binary not installed', filled_fields: filled, pages_visited: 0, trace }
  }

  const { browser } = await launchPortalBrowser(chromium, { headless })
  // Prefer an in-memory storageState OBJECT (the durable, DB-backed session a
  // user imported after clearing 2FA themselves) — it survives Railway's
  // ephemeral filesystem, unlike an on-disk path. Fall back to a path if given.
  // UA matches the capture-time fingerprint (REALISTIC_PORTAL_UA) so a WAF that
  // bound the session cookies to it accepts the replay.
  const contextOptions = { userAgent: REALISTIC_PORTAL_UA }
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
  try {
    context = await browser.newContext(contextOptions)
    page = await context.newPage()
  } catch (setupErr) {
    await browser.close().catch(() => {})
    throw setupErr
  }
  const valuesByKey = applyNarrativeAnswers(readProfileValues(profile), narrativeAnswers)
  // Durable capture dir (UPLOADS_DIR-based in prod, NEVER ephemeral tmp) so a
  // confirmation screenshot/page survives Railway restarts; the orchestrator
  // also passes an explicit durable dir. Direct callers/tests fall back to tmp.
  const screenshotsRoot = screenshotsDir || resolveConfirmationCaptureDir()

  try {
    trace.push({ step: 'navigate', detail: { url } })
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })

    let pagesVisited = 0
    while (pagesVisited < MAX_PAGES) {
      pagesVisited += 1
      trace.push({ step: 'page', detail: { index: pagesVisited, url: (() => { try { return page.url() } catch { return null } })() } })

      const gate = await detectGate(page)
      if (gate) {
        // Saved-login path: when Hamilton hits a login gate and the user saved a
        // login for this portal, type it into the portal's own login form and
        // continue — instead of hard-stopping. Tried at most once.
        if (gate.kind === 'login' && loginCredential && !loginAttempted) {
          loginAttempted = true
          trace.push({ step: 'login_attempt', detail: { username: '***' } })
          const ok = await attemptLogin(page, loginCredential)
          trace.push({ step: 'login_result', detail: { ok } })
          if (ok) { loggedIn = true; continue }
          // Login fill failed (couldn't find/submit form) — fall through to the
          // normal hard-stop so the user is told login is required.
          return { status: 'blocked', blocker_kind: 'login', blocker_detail: 'Saved login could not be completed automatically', filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn }
        }
        trace.push({ step: 'gate', detail: gate })
        return { status: 'blocked', blocker_kind: gate.kind, blocker_detail: gate.detail, filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn }
      }
      const sigGate = await detectAttestationGate(page, { authorizations })
      if (sigGate) {
        trace.push({ step: 'attestation_gate', detail: sigGate })
        return { status: 'blocked', blocker_kind: sigGate.kind, blocker_detail: sigGate.detail, filled_fields: filled, pages_visited: pagesVisited, trace }
      }

      const fields = await detectFields(page)
      const submitButtons = await detectButtons(page, SUBMIT_BUTTON_PATTERNS)
      const nextButtons   = await detectButtons(page, NEXT_BUTTON_PATTERNS)
      const draftButtons  = await detectButtons(page, DRAFT_BUTTON_PATTERNS)
      trace.push({ step: 'inspect', detail: summarisePageState(page, fields, [...submitButtons, ...nextButtons, ...draftButtons]) })

      // Map and fill recognised fields.
      let filledThisPage = 0
      for (const f of fields) {
        const rule = matchFieldKey(f)
        if (!rule) continue
        const v = valuesByKey[rule.key]
        if (v === undefined || v === null || String(v).trim() === '') continue
        if (!authorizations.complete_forms && rule.key !== 'email' && rule.key !== 'first_name' && rule.key !== 'last_name') {
          // Without complete_forms authorization Hamilton only fills basic
          // identity fields needed to land on the right page.
          continue
        }
        if (rule.multiline && !authorizations.generate_narratives && !valuesByKey.essay && !valuesByKey.goals) {
          continue
        }
        const ok = await fillFieldByFid(page, f.fid, v)
        if (ok) {
          filled.push({ key: rule.key, fid: f.fid, value: String(v).slice(0, 60) })
          filledThisPage += 1
        }
      }
      trace.push({ step: 'fill', detail: { filledThisPage } })

      // Authorized standing attestations.
      if (authorizations.use_standing_attestation) {
        const checkboxes = await page.$$eval('input[type="checkbox"]', (els, opts) => {
          const list = []
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
            const text = `${name} ${labelText || ''}`
            const tickable = opts.standing.some((r) => new RegExp(r.s, r.f).test(text))
            const blocked = opts.hard.some((r) => new RegExp(r.s, r.f).test(text))
            if (tickable && !blocked && !el.checked) {
              el.checked = true
              el.dispatchEvent(new Event('change', { bubbles: true }))
              list.push(text.slice(0, 120))
            }
          }
          return list
        }, {
          standing: STANDING_ATTESTATION_PATTERNS.map((r) => ({ s: r.source, f: r.flags })),
          hard:     HARD_ATTESTATION_PATTERNS.map((r) => ({ s: r.source, f: r.flags })),
        }).catch(() => [])
        if (checkboxes.length > 0) trace.push({ step: 'attestation_checked', detail: { items: checkboxes } })
      }

      // Authorized document uploads.
      if (authorizations.upload_documents && Array.isArray(documents) && documents.length > 0) {
        const fileInputs = fields.filter((f) => f.type === 'file')
        for (const inp of fileInputs) {
          const wanted = documents.find((d) => {
            const text = `${inp.name} ${inp.label} ${inp.id} ${inp.placeholder}`.toLowerCase()
            return text.includes((d.kind || '').toLowerCase())
          }) || documents[0]
          if (!wanted?.path) continue
          const ok = await fillFieldByFid(page, inp.fid, wanted.path)
          if (ok) trace.push({ step: 'upload', detail: { kind: wanted.kind, fid: inp.fid } })
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
      const canSubmit = submitCandidates.length > 0
      const canNext   = nextButtons.length > 0
      const canDraft  = draftButtons.length > 0

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
        // Submit the application.
        trace.push({ step: 'submit_attempt', detail: { button: submitCandidates[0].text } })
        const beforeUrl = (() => { try { return page.url() } catch { return null } })()
        const clicked = await clickButtonByBid(page, submitCandidates[0].bid)
        if (!clicked) {
          return { status: 'failed', blocker_kind: 'click_failed', blocker_detail: 'Submit button could not be clicked', filled_fields: filled, pages_visited: pagesVisited, trace }
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
          return { status: 'blocked', blocker_kind: 'validation', blocker_detail: errors.slice(0, 5).join(' | '), filled_fields: filled, pages_visited: pagesVisited, trace }
        }
        const conf = await captureConfirmation(page, screenshotsRoot)
        const evidence = assessSubmissionEvidence(conf)
        if (!evidence.ok) {
          // Submit was clicked but NO evidence could be captured (no
          // reference, no screenshot). Refuse to claim a submission — hand
          // the run to a human to verify receipt on the portal.
          trace.push({ step: 'submit_unconfirmed', detail: { from: beforeUrl, to: conf.url } })
          return {
            status: 'blocked',
            blocker_kind: 'submit_unconfirmed',
            blocker_detail: 'Hamilton completed the portal\'s submit step, but could not capture any confirmation evidence (no reference number and no final-page screenshot). Verify receipt on the portal before treating this application as submitted.',
            submit_clicked: true,
            filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn,
          }
        }
        trace.push({ step: 'submitted', detail: { from: beforeUrl, to: conf.url, confirmation: conf.reference, confirmation_evidence: evidence.confirmation_evidence, received_acknowledgement: conf.received_acknowledgement } })
        return {
          status: 'submitted',
          submit_clicked: true,
          confirmation_evidence: evidence.confirmation_evidence,
          confirmation_reference: conf.reference,
          confirmation_screenshot_path: conf.screenshot_path,
          confirmation_page_html_path: conf.page_html_path,
          confirmation_page_text: conf.page_text,
          confirmation_received_acknowledgement: conf.received_acknowledgement,
          confirmation_url: conf.url,
          filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn,
        }
      }

      if (canSubmit && !finalAllowSubmit) {
        // We're on the final page but the user didn't authorize submit;
        // save a draft if possible and stop with a clean status.
        if (canDraft && authorizations.save_drafts) {
          await clickButtonByBid(page, draftButtons[0].bid)
          await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT_MS }).catch(() => null)
        }
        trace.push({ step: 'completed_draft', detail: { reason: 'submit_not_authorized' } })
        return { status: 'completed_draft', filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn }
      }

      if (canNext) {
        const clicked = await clickButtonByBid(page, nextButtons[0].bid)
        if (!clicked) {
          return { status: 'failed', blocker_kind: 'click_failed', blocker_detail: 'Next button could not be clicked', filled_fields: filled, pages_visited: pagesVisited, trace }
        }
        await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT_MS }).catch(() => null)
        const errors = await detectValidationErrors(page)
        if (errors.length > 0) {
          trace.push({ step: 'validation_after_next', detail: { errors: errors.slice(0, 5) } })
          return { status: 'blocked', blocker_kind: 'validation', blocker_detail: errors.slice(0, 5).join(' | '), filled_fields: filled, pages_visited: pagesVisited, trace }
        }
        continue
      }

      // No button to advance. If save_drafts authorized and a draft
      // button exists, save it.
      if (canDraft && authorizations.save_drafts) {
        await clickButtonByBid(page, draftButtons[0].bid)
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
        blocker_raw: raw.split('\n')[0].slice(0, 300),
        filled_fields: filled,
        pages_visited: 0,
        trace,
      }
    }
    return { status: 'failed', blocker_kind: 'engine_error', blocker_detail: raw, filled_fields: filled, pages_visited: 0, trace }
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
  detectGate, attemptLogin,
  extractConfirmationReference,
  extractConfirmationReferenceFromUrl,
  detectReceiptAcknowledgement,
  captureConfirmation,
  actionableSubmitButtons,
  assessSubmissionEvidence,
}
