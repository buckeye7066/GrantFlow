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
 * 2FA (owner order 2026-08-21: "The goal with the mailbox and phone number is
 * so hamilton can do 2fa's"):
 *   Hamilton completes a one-time-code challenge on an account registered to
 *   HIS OWN identity, by reading the code from HIS OWN mailbox/SMS inbox
 *   (`HAMILTON_IDENTITY` — Hamilton@axiombiolabs.org / 423-504-7778) and typing
 *   it into the portal. This is the whole reason that mailbox and number exist.
 *
 *   The bar is deliberately narrow and it is NOT "2FA is now automated":
 *     - Only under FULL automation consent. Without it, the old `needs_user`
 *       handoff is unchanged.
 *     - The code must come from Hamilton's own inbox. Hamilton never derives,
 *       guesses, or brute-forces a code, and never reads a HUMAN's mailbox — if
 *       the portal account was registered under the applicant's own email or
 *       phone, the code lands somewhere Hamilton cannot read and the run takes
 *       the SAME handoff it always did. That is a correct refusal, not a bug.
 *     - Tried at most ONCE per run, mirroring the saved-login path below: a
 *       retry loop against an OTP wall is indistinguishable from an attack and
 *       is how an account gets locked.
 *
 * Hamilton NEVER:
 *   - solves CAPTCHA or signs anything.
 *   - reads any mailbox but his own, or replays a code he did not receive.
 *   - clicks a legal-attestation checkbox unless `use_standing_attestation`
 *     is authorized AND the checkbox is in the recognised attestation
 *     allow-list (financial-aid eligibility self-certification, etc.).
 *   - bypasses an anti-bot challenge.
 *
 * Profile is provided pre-loaded; no database read during the run.
 */

import fs from 'node:fs'
import crypto from 'node:crypto'
import { launchPortalBrowser, REALISTIC_PORTAL_UA } from './browserLaunch.js'
import {
  controlledBetaBrowserContextOptions,
  controlledBetaBrowserRefusal,
  installControlledBetaBrowserEgressGuard,
  isHamiltonBrowserTargetAllowed,
} from './controlledBetaBrowserPolicy.js'
import path from 'node:path'
import { registrableDomain } from './hamiltonPortalCredentialService.js'
import { triagePage, PAGE_SURFACES } from './listingPageTriage.js'
import { resolveConfirmationCaptureDir } from './hamiltonConfirmationArtifacts.js'
import { resolveUploadsDir } from '../../utils/uploadsDir.js'
import { startLiveScreencast, reportLiveStep, isLiveViewEnabled } from './hamiltonLiveView.js'
import { isAnswerableUnknownField, fieldLabelOf } from './hamiltonFieldAnswerer.js'

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
  // Word-boundaried so "unit" no longer matches inside "community": a
  // "community involvement" field was mis-recognized as an address line (2026-08-22).
  { key: 'address2',        patterns: [new RegExp(`address${_S_}(2|line${_S_}2)`, 'i'), /\bapt\b|\bapartment\b|\bsuite\b|\bste\b|\bunit\b/i] },
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
  // Identity-proofing fields. These map to the ENCRYPTED identity vault, not the
  // profile, and are filled ONLY under full automation when a value is on file
  // (see identityValues below). SSN/ITIN, DOB, government-ID, and the FSA-ID /
  // SSO / Login.gov / ID.me credential fields a proofing wall asks for.
  { key: 'id_ssn',              patterns: [/\bssn\b/i, new RegExp(`social${_S_}security`, 'i'), new RegExp(`social${_S_}security${_S_}number`, 'i')] },
  { key: 'id_itin',             patterns: [/\bitin\b/i, new RegExp(`individual${_S_}taxpayer`, 'i')] },
  { key: 'id_date_of_birth',    patterns: [new RegExp(`date${_S_}of${_S_}birth`, 'i'), /\bdob\b/i, new RegExp(`birth${_S_}date`, 'i'), /^birthdate$/i] },
  { key: 'id_government_id_number', patterns: [new RegExp(`driver'?s?${_S_}licen[sc]e`, 'i'), new RegExp(`government${_S_}id`, 'i'), new RegExp(`state${_S_}id${_S_}number`, 'i')] },
  { key: 'id_passport_number',  patterns: [/passport/i] },
  { key: 'id_fsa_id_username',  patterns: [new RegExp(`fsa${_S_}id${_S_}(username|user${_S_}name)`, 'i'), new RegExp(`fsa${_S_}id\\b`, 'i')] },
  { key: 'id_fsa_id_password',  patterns: [new RegExp(`fsa${_S_}id${_S_}password`, 'i')] },
  { key: 'id_sso_username',     patterns: [new RegExp(`sso${_S_}(username|user${_S_}name|id)`, 'i')] },
  { key: 'id_sso_password',     patterns: [new RegExp(`sso${_S_}password`, 'i')] },
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

// Typed e-signature fields: a text input whose label/name/placeholder asks the
// applicant to type their name AS a signature. Distinct from a plain "Full
// name" identity field (FIELD_RULES.full_name) — that one is always filled;
// this one is a legal act and is filled ONLY under full-automation consent.
const SIGNATURE_FIELD_PATTERNS = [
  /\bsignature\b/i,
  /\bsign(?:ed)?\s*(?:(?:your|full|legal)\s*)*name\b/i,
  /type\s*(?:(?:your|full|legal)\s*)*name\s*(?:to|as|for)\s*(?:e-?)?sign/i,
  /electronic(?:ally)?\s*sign/i,
  /e-?sign(?:ature)?\b/i,
]

/**
 * Is this visible field a typed-signature input? Text-like inputs only — a
 * checkbox signature is the HARD_ATTESTATION path, a file input is an upload.
 */
function isTypedSignatureField(field) {
  if (!field) return false
  if (field.tag === 'select') return false
  if (field.tag === 'input' && !['', 'text', 'search'].includes(String(field.type || '').toLowerCase())) return false
  const text = [field.name, field.id, field.placeholder, field.ariaLabel, field.label].filter(Boolean).join(' ')
  return SIGNATURE_FIELD_PATTERNS.some((rx) => rx.test(text))
}

/**
 * The consent that lets Hamilton perform the applicant's electronic signature.
 *
 * Owner goal 2026-08-21 (reaffirmed): under FULL AUTOMATION Hamilton finishes
 * every portal end to end. An e-signature on the applicant's own application,
 * executed under the applicant's standing consent, is the applicant's act —
 * but ONLY when all three hold, and each is read from the one authority that
 * owns it rather than re-derived here:
 *   - `fullAutomation`  — resolveSubmissionDecision's verdict, passed in by the
 *                         orchestrator (the same flag that gates 2FA clearing);
 *   - `use_standing_attestation` + `submit_applications` — granted types;
 *   - a real applicant name on the profile to sign WITH (never invented).
 * With any of them absent the signature stays a hard blocker, exactly as before.
 */
function signatureConsentFor({ fullAutomation, authorizations, signerName }) {
  if (!fullAutomation) return null
  if (!authorizations?.use_standing_attestation || !authorizations?.submit_applications) return null
  const name = String(signerName || '').trim()
  if (!name) return null
  return { name }
}

const SUBMIT_BUTTON_PATTERNS = [/^submit/i, /finalize/i, /apply\s*now/i, /complete\s*application/i, /send\s*application/i]
const NEXT_BUTTON_PATTERNS   = [/^next/i, /continue/i, /proceed/i, /save\s*&\s*continue/i]
const DRAFT_BUTTON_PATTERNS  = [/save\s*draft/i, /save\s*&\s*exit/i, /save\s*for\s*later/i]
// LANDING PAGE → APPLICATION FORM. A "portal" URL often points at a program
// description / landing page whose only control is an "Apply" / "Start
// Application" link that NAVIGATES to the real form. That control is filtered
// out of the submit candidates (no fields to fill on a landing page), so without
// following it Hamilton dead-ends as no_application_form one click from the
// application — the single biggest "waiting for review" bucket on a real profile
// (86 of 200, 2026-08-22). These patterns are for NAVIGATION only, followed just
// when no fillable form and no next-control were found, so they never intercept
// a real submit.
const APPLY_NAV_PATTERNS = [
  /^apply(?:\s|$)/i, /apply\s*now/i, /apply\s*online/i, /apply\s*here/i, /apply\s*today/i,
  /start\s*(?:your\s*|an?\s*)?application/i, /begin\s*(?:your\s*|an?\s*)?application/i,
  /start\s*(?:your\s*)?app\b/i, /go\s*to\s*(?:the\s*)?application/i, /open\s*application/i,
  /application\s*form/i,
]
const MAX_APPLY_NAV_CLICKS = 3

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
          const formContext = form
            ? `${form.getAttribute('id') || ''} ${form.getAttribute('name') || ''} ${form.getAttribute('aria-label') || ''} ${form.innerText || form.textContent || ''}`
            : ''
          const isPageFeedback = /\b(?:was this page helpful|rate this page|feedback (?:about|on) this page|did you find what you needed|how (?:helpful|useful) was this page)\b/i.test(formContext)
          el.setAttribute('data-hamilton-btn', `b${out.length}`)
          out.push({ bid: `b${out.length}`, text, inForm: !!form, formFieldCount, isPageFeedback })
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
  // A separate "Was this page helpful?" footer form is never an application
  // boundary. Previously the any-field-filled fast path admitted every Submit
  // control, so a feedback survey could win over the real application form and
  // surface its required Yes/No radio as an application validation blocker.
  const list = Array.isArray(submitButtons)
    ? submitButtons.filter((button) => button && button.isPageFeedback !== true)
    : []
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
    // Real portals routinely put the submit button below the fold and cover it
    // with a sticky footer / cookie banner / consent overlay, so a plain
    // actionability-checked click throws "element intercepts pointer events" and
    // the whole submission fails ("Submit button could not be clicked" killed
    // HOPE / Aspire / GAMS / TSAA for a real applicant, 2026-08-21). Try, in
    // order: scroll it into view, a normal click, a FORCED click (bypasses the
    // pointer-intercept check), then a direct DOM click. A forced/DOM click
    // still cannot fire a genuinely DISABLED button, so this never submits a
    // form the portal itself considers invalid — it only defeats an overlay
    // sitting on top of the right control.
    await h.scrollIntoViewIfNeeded?.({ timeout: STEP_TIMEOUT_MS }).catch(() => {})
    let clicked = false
    try { await h.click({ timeout: STEP_TIMEOUT_MS }); clicked = true } catch { /* overlay/visibility — fall through */ }
    if (!clicked) {
      try { await h.click({ timeout: STEP_TIMEOUT_MS, force: true }); clicked = true } catch { /* fall through */ }
    }
    if (!clicked) {
      try { await h.evaluate((el) => el.click()); clicked = true } catch { /* give up below */ }
    }
    if (!clicked) return false
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

async function detectAttestationGate(page, { authorizations, signatureConsent = null }) {
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
      // Under full-automation consent an e-signature checkbox is ticked in
      // the fill loop (traced as `signature_attested`), not reported as a gate.
      if (signatureConsent) continue
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

// Page chrome that is NOT part of the application: a "Was this page helpful?"
// survey, a "Report suspected fraud" widget, a newsletter/cookie box. On many
// government portals these live in the SAME <form> as the real submit control,
// so a required Yes/No feedback radio fails checkValidity() and — before this —
// hard-blocked the actual application ("Was this page helpful? field is
// required" killed a real TANF submission, a real applicant's run 2026-08-21). Mirrors
// the isPageFeedback filter that already keeps such widgets from being treated
// as the application's SUBMIT button.
const FEEDBACK_VALIDATION_IGNORE_RX = /was this (page |content )?helpful|page helpful|how helpful|rate (this )?(page|content)|site feedback|leave feedback|feedback about this|report (suspected )?(fraud|abuse)|newsletter|subscribe|cookie/i

async function detectNativeValidationErrors(page, buttonId) {
  if (!buttonId) return []
  return await page.$eval(`[data-hamilton-btn="${buttonId}"]`, (button, feedbackSrc) => {
    const form = button.form || button.closest('form')
    if (!form) return []
    const feedbackRx = new RegExp(feedbackSrc, 'i')
    const isFeedbackField = (field) => {
      const label = field.labels?.[0]?.textContent || field.getAttribute?.('aria-label') || ''
      const name = field.getAttribute?.('name') || ''
      const id = field.getAttribute?.('id') || ''
      const legend = field.closest?.('fieldset')?.querySelector?.('legend')?.textContent || ''
      return feedbackRx.test(label) || feedbackRx.test(name) || feedbackRx.test(id) || feedbackRx.test(legend)
    }
    return Array.from(form.elements || [])
      .filter((field) => typeof field.checkValidity === 'function' && !field.checkValidity())
      // A page-feedback / fraud-report / newsletter widget is not the
      // application and must never block its submission.
      .filter((field) => !isFeedbackField(field))
      .slice(0, 10)
      .map((field) => {
        const label = field.labels?.[0]?.textContent || field.getAttribute('aria-label')
          || field.getAttribute('name') || field.getAttribute('id') || 'required field'
        const message = field.validationMessage || 'invalid value'
        return `${String(label).trim()}: ${String(message).trim()}`.slice(0, 300)
      })
  }, FEEDBACK_VALIDATION_IGNORE_RX.source).catch(() => [])
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
 * Raw listing text and links are ephemeral browser input and may contain names,
 * balances, or bearer-like URLs. Persist only a value-free shape after the
 * decomposition step consumes the raw snapshot in memory.
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
  const digest = (value) => crypto.createHash('sha256').update(value).digest('hex')
  return Object.freeze({
    portal_origin: portalOrigin,
    field_count: Math.max(0, Number(snapshot?.fieldCount) || 0),
    link_count: links.length,
    text_length: text.length,
    text_sha256: text ? digest(text) : null,
    title_sha256: title ? digest(title) : null,
    content_retained: false,
  })
}

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

// Additional post-submit acknowledgement phrasings real portals use, as a regex
// LITERAL (avoids the string-array backslash doubling). OR'd with the primary
// set; kept to clearly-post-submission phrasings so it never matches a pre-submit
// form page.
const RECEIPT_ACK_EXTRA_RX = /\byou(?:'ve| have)? (?:successfully )?(?:applied|submitted your application)\b|\b(?:confirmation|submission|application|reference)\s*(?:number|code|id)\s*[:#]|\ba confirmation (?:email|message)?\s*(?:has been|was)?\s*(?:sent|emailed)\b|\byour application is (?:now )?(?:complete|submitted|in review|under review)\b|\bapplication (?:complete|completed)\b/i

function detectReceiptAcknowledgement(text) {
  const t = String(text || '')
  return RECEIPT_ACK_RX.test(t) || RECEIPT_ACK_EXTRA_RX.test(t)
}

// A distinct post-submit URL landing on a confirmation/receipt/thank-you page is
// independent corroboration a submit landed — used ONLY to strengthen a genuine
// acknowledgement, never to manufacture one.
const CONFIRMATION_LANDING_RX = /(confirmation|submitted|receipt|thank[-_]?you|success|complete|received)/i
function urlLandedOnConfirmation(url) {
  try {
    const u = new URL(String(url))
    return CONFIRMATION_LANDING_RX.test(u.pathname) || CONFIRMATION_LANDING_RX.test(u.search)
  } catch { return false }
}

function normalizedReference(value) {
  return String(value || '').trim().toUpperCase()
}

/**
 * Truthfulness of a submit click (owner addendum 2026-08-03): "clicked
 * submit" and "portal confirmed receipt" are different facts. A run may only
 * claim status=submitted only when the portal emits a genuinely new reference
 * or a newly-appearing explicit receipt acknowledgement. A URL change,
 * screenshot, or saved page alone corroborates that a click occurred but
 * remains attempt evidence, never receipt proof. Pure function — unit-tested
 * directly.
 */
function assessSubmissionEvidence(conf, before = {}) {
  const afterReference = normalizedReference(conf?.reference)
  const beforeReference = normalizedReference(before?.reference)
  const referenceChanged = Boolean(afterReference && afterReference !== beforeReference)
  if (referenceChanged) {
    return { ok: true, confirmation_evidence: 'portal_reference' }
  }
  // Acknowledgement is proof when a genuine receipt phrase is on the post-submit
  // page AND that is either NEW since before the click, OR the portal redirected
  // to a distinct confirmation/receipt page. The ack TEXT is load-bearing — a
  // bare URL change or a screenshot alone still never counts (honesty floor).
  const ackPresent = conf?.received_acknowledgement === true
  const ackNew = ackPresent && before?.received_acknowledgement !== true
  const movedToConfirmation = Boolean(
    before?.url && conf?.url && before.url !== conf.url && urlLandedOnConfirmation(conf.url),
  )
  if (ackPresent && (ackNew || movedToConfirmation)) {
    return { ok: true, confirmation_evidence: 'portal_acknowledgement' }
  }
  const attemptCaptured = Boolean(
    conf?.screenshot_path
    || conf?.page_html_path
    || conf?.reference
    || conf?.received_acknowledgement
    || (before?.url && conf?.url && before.url !== conf.url),
  )
  return {
    ok: false,
    confirmation_evidence: attemptCaptured ? 'attempt_evidence' : 'none',
  }
}

function configuredUploadRoots() {
  const explicit = String(process.env.UPLOADS_DIR || '').trim()
  if (process.env.NODE_ENV === 'production' && !explicit) return []
  const { uploadsDir, legacyUploadsDir } = resolveUploadsDir({
    baseDir: path.resolve(process.cwd(), 'backend'),
  })
  return [...new Set([uploadsDir, legacyUploadsDir].filter(Boolean).map((root) => path.resolve(root)))]
}

function pathInsideRoot(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

function resolveSafeUploadDocument(document) {
  if (!document?.path) return null
  try {
    const requested = path.resolve(String(document.path))
    const statBefore = fs.lstatSync(requested)
    if (!statBefore.isFile() || statBefore.isSymbolicLink()) return null
    const real = fs.realpathSync(requested)
    const roots = configuredUploadRoots().map((root) => {
      try { return fs.realpathSync(root) } catch { return root }
    })
    if (!roots.some((root) => pathInsideRoot(real, root))) return null
    const stat = fs.statSync(real)
    if (!stat.isFile() || stat.size > 25 * 1024 * 1024) return null
    const extension = path.extname(real).toLowerCase()
    if (!new Set(['.pdf', '.doc', '.docx', '.txt', '.rtf', '.odt', '.jpg', '.jpeg', '.png']).has(extension)) return null
    return { ...document, path: real }
  } catch {
    return null
  }
}

let confirmationCaptureSequence = 0

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
  // screenshot are captured EVEN WHEN no reference matches, so the click attempt
  // remains reviewable without being mislabeled as confirmation proof.
  const reference = extractConfirmationReference(bodyText)
    || extractConfirmationReference(html)
    || extractConfirmationReferenceFromUrl(url)
  const receivedAcknowledgement = detectReceiptAcknowledgement(bodyText) || detectReceiptAcknowledgement(html)
  const stamp = `${Date.now()}_${confirmationCaptureSequence += 1}`
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

function mergeSubmitCapture(previous, next) {
  if (!previous) return next || null
  if (!next) return previous
  return {
    url: next.url || previous.url || null,
    reference: next.reference || previous.reference || null,
    screenshot_path: next.screenshot_path || previous.screenshot_path || null,
    page_html_path: next.page_html_path || previous.page_html_path || null,
    page_text: next.page_text || previous.page_text || '',
    received_acknowledgement: Boolean(
      next.received_acknowledgement || previous.received_acknowledgement,
    ),
  }
}

function submitCaptureResult(conf, before = {}, evidence = assessSubmissionEvidence(conf, before)) {
  const capture = conf || {}
  return {
    submit_clicked: true,
    confirmation_evidence: evidence.confirmation_evidence,
    submission_evidence_classification: evidence.ok ? 'confirmation_proof' : 'attempt_evidence',
    confirmation_reference: capture.reference || null,
    confirmation_reference_is_new: Boolean(
      normalizedReference(capture.reference)
      && normalizedReference(capture.reference) !== normalizedReference(before?.reference),
    ),
    confirmation_screenshot_path: capture.screenshot_path || null,
    confirmation_page_html_path: capture.page_html_path || null,
    confirmation_page_text: capture.page_text || '',
    confirmation_received_acknowledgement: capture.received_acknowledgement === true,
    confirmation_received_acknowledgement_is_new: Boolean(
      capture.received_acknowledgement === true
      && before?.received_acknowledgement !== true,
    ),
    confirmation_url: capture.url || null,
    confirmation_url_changed: Boolean(
      before?.url && capture.url && before.url !== capture.url,
    ),
  }
}

function submitCaptureHistoryResult(captures, before = {}) {
  const history = Array.isArray(captures) ? captures.filter(Boolean) : []
  const merged = history.reduce((current, capture) => mergeSubmitCapture(current, capture), null)
  return {
    ...submitCaptureResult(merged, before),
    submission_attempt_captures: history.map((capture) => ({
      url: capture.url || null,
      reference: capture.reference || null,
      screenshot_path: capture.screenshot_path || null,
      page_html_path: capture.page_html_path || null,
      page_text: capture.page_text || '',
      received_acknowledgement: capture.received_acknowledgement === true,
    })),
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
const IDENTITY_FIELD_TO_KIND = Object.freeze({
  id_ssn: 'ssn', id_itin: 'itin', id_date_of_birth: 'date_of_birth',
  id_government_id_number: 'government_id_number', id_passport_number: 'passport_number',
  id_fsa_id_username: 'fsa_id_username', id_fsa_id_password: 'fsa_id_password',
  id_sso_username: 'sso_username', id_sso_password: 'sso_password',
})

export async function runAutopilot({
  url,
  profile,
  authorizations,
  documents = [],
  storageState = null,
  allowAutoSubmit = null,
  loginCredential = null,
  headless = true,
  screenshotsDir = null,
  sessionSink = null,
  signal = null,
  beforeSubmit = null,
  // MBA-level long-form answers drafted by hamiltonFullProposalGenerator
  // (buildPortalNarrativeAnswers). Only the narrative keys below may be
  // overridden — short factual fields (name, address, …) always come from
  // the profile verbatim. Falls back to the profile's raw essays when absent.
  narrativeAnswers = null,
  // One-time-code solver, injected by the orchestrator. Signature:
  //   (page) => Promise<{ verified: boolean, reason?: string }>
  //
  // A CALLBACK rather than a `db` handle on purpose: this engine's contract
  // (see the header) is that the profile arrives pre-loaded and nothing reads
  // the database mid-run. The orchestrator owns the db and the Graph token
  // provider and closes over both, so the engine only ever sees a page and a
  // verdict. Absent (the default) = the previous behaviour exactly: a 2FA gate
  // is a hard blocker.
  attemptVerification = null,
  // One-time CAPTCHA solver, injected by the orchestrator only under full
  // automation with an owner-configured solver key. Signature mirrors
  // attemptVerification: (page) => Promise<{ solved: boolean, reason?: string }>.
  // Absent (the default) = a CAPTCHA is a hard blocker, exactly as before.
  solveCaptcha = null,
  // Decrypted identity-vault values for this profile, keyed by vault kind
  // (ssn, date_of_birth, government_id_number, fsa_id_*, sso_*). Loaded by the
  // ORCHESTRATOR under full automation and passed in (the engine never reads the
  // db mid-run — same contract as narrativeAnswers). Absent/empty = an identity
  // field is a blocker, exactly as before. NEVER logged or traced.
  identityValues = null,
  // LLM field-understanding layer: an injected (field) => Promise<{value,
  // free_text, grounded_in} | null> that answers a portal field Hamilton's fixed
  // vocabulary does NOT recognize, grounded strictly in the profile (never
  // fabricates; returns null when the profile can't answer it → the field stays
  // blank and becomes a user ask). Injected by the orchestrator only under
  // generate_narratives consent, closing over the profile/funder + LLM (the
  // engine's no-db-mid-run contract holds — same pattern as solveCaptcha).
  answerUnknownField = null,
  // The autopilot run id. When set (and live view is enabled), this run's
  // browser is screencast to the in-memory live store under this id and the
  // engine reports its current step there, so the watch window can show a live
  // video + play-by-play. Absent (direct callers / tests) = no live view, and
  // every reportLiveStep/screencast call is a guarded no-op.
  runId = null,
  // TEST-ONLY page injection. Engine-internal (underscore); the orchestrator's
  // runAutopilot call never sets it and no request can reach it. When provided,
  // the real engine logic runs against this page instead of launching Chromium,
  // so an in-process e2e can drive the whole autonomous gauntlet against a real
  // (jsdom-backed) DOM. Absent (production) = a browser is launched, unchanged.
  _testPage = null,
  // Full-automation consent (resolveSubmissionDecision's verdict, forwarded by
  // the orchestrator). Unlocks the applicant's electronic signature — typed
  // name fields and e-sign checkboxes — see signatureConsentFor. Absent (the
  // default) = a signature is a hard blocker, exactly as before.
  fullAutomation = false,
} = {}) {
  if (!url) throw new Error('url required')
  if (!profile) throw new Error('profile required')
  if (!authorizations) throw new Error('authorizations required')
  const finalAllowSubmit = Boolean(authorizations.submit_applications)
    && (allowAutoSubmit === null ? true : Boolean(allowAutoSubmit))

  const trace = []
  const filled = []
  let loggedIn = false
  let loginAttempted = false
  let twoFactorAttempted = false
  if (signal?.aborted) {
    return { status: 'cancelled', blocker_kind: 'cancelled', blocker_detail: 'Hamilton task was cancelled before browser launch.', filled_fields: filled, pages_visited: 0, trace }
  }

  if (!isHamiltonBrowserTargetAllowed(url)) {
    const refusal = controlledBetaBrowserRefusal()
    return {
      status: 'blocked',
      blocker_kind: refusal.code,
      blocker_detail: refusal.message,
      requires_human_handoff: true,
      filled_fields: filled,
      pages_visited: 0,
      trace,
    }
  }

  let browser
  let context
  let page
  if (_testPage) {
    // In-process e2e: use the injected page directly, no browser launch.
    page = _testPage
    browser = _testPage._browser || { close: async () => {} }
    context = _testPage._context || { close: async () => {}, storageState: async () => ({}) }
  } else {
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

    ;({ browser } = await launchPortalBrowser(chromium, { headless, targetUrl: url }))
    // Only an in-memory storageState OBJECT from the profile-owned encrypted
    // session store is accepted. Request-supplied filesystem paths are never
    // passed to Playwright.
    // UA matches the capture-time fingerprint (REALISTIC_PORTAL_UA) so a WAF that
    // bound the session cookies to it accepts the replay.
    const contextOptions = controlledBetaBrowserContextOptions({ userAgent: REALISTIC_PORTAL_UA })
    if (storageState && typeof storageState === 'object') {
      contextOptions.storageState = storageState
    }
    // Guard the setup path: if newContext/newPage throws (e.g. /dev/shm memory
    // pressure), the already-launched Chromium must not leak — the main
    // try/finally below only covers code after both exist.
    try {
      context = await browser.newContext(contextOptions)
      await installControlledBetaBrowserEgressGuard(context)
      page = await context.newPage()
    } catch (setupErr) {
      await browser.close().catch(() => {})
      throw setupErr
    }
  }
  const valuesByKey = applyNarrativeAnswers(readProfileValues(profile), narrativeAnswers)
  const signatureConsent = signatureConsentFor({
    fullAutomation, authorizations, signerName: valuesByKey.full_name,
  })
  // Merge decrypted identity values in under their id_* field keys, ONLY under
  // full automation. Kept OUT of valuesByKey's log/trace surface: filled fields
  // record the KEY and a 60-char value slice, so an SSN would leak into the
  // trace — identity fills are therefore recorded WITHOUT their value below.
  const identityByFieldKey = {}
  if (fullAutomation && identityValues && typeof identityValues === 'object') {
    const KIND_TO_FIELD = {
      ssn: 'id_ssn', itin: 'id_itin', date_of_birth: 'id_date_of_birth',
      government_id_number: 'id_government_id_number', passport_number: 'id_passport_number',
      fsa_id_username: 'id_fsa_id_username', fsa_id_password: 'id_fsa_id_password',
      sso_username: 'id_sso_username', sso_password: 'id_sso_password',
    }
    for (const [kind, fieldKey] of Object.entries(KIND_TO_FIELD)) {
      const v = identityValues[kind]
      if (v !== undefined && v !== null && String(v) !== '') identityByFieldKey[fieldKey] = String(v)
    }
  }
  const isIdentityFieldKey = (k) => typeof k === 'string' && k.startsWith('id_')
  // Durable capture dir (UPLOADS_DIR-based in prod, NEVER ephemeral tmp) so a
  // confirmation screenshot/page survives Railway restarts; the orchestrator
  // also passes an explicit durable dir. Direct callers/tests fall back to tmp.
  const screenshotsRoot = screenshotsDir || resolveConfirmationCaptureDir()
  let pagesVisited = 0
  let captchaAttempted = false
  // Landing-page → application-form navigation state (bounded, never re-clicks
  // the same control) — see APPLY_NAV_PATTERNS.
  let applyNavClicks = 0
  const clickedApplyNav = new Set()
  const missingIdentityKinds = new Set()
  // Required portal-specific questions Hamilton could not answer from the
  // profile (owner doctrine 2026-08-22, condition 2). Collected here; the
  // orchestrator routes each to its profile home or has a global field made.
  const unansweredRequiredFields = []
  let submissionAttemptStarted = false
  let submitClicked = false
  let beforeSubmitCapture = {}
  let submitCapture = null
  const submitCaptureHistory = []
  let submitCaptureInFlight = null
  const retainSubmitCapture = async () => {
    if (!submitClicked || !page) return submitCapture
    if (submitCaptureInFlight) return submitCaptureInFlight
    submitCaptureInFlight = (async () => {
      try {
        const captured = await captureConfirmation(page, screenshotsRoot)
        submitCaptureHistory.push(captured)
        submitCapture = mergeSubmitCapture(
          submitCapture,
          captured,
        )
      } catch {
        // The click is still a recorded attempt even if the portal/browser died
        // before a fresh screenshot or page snapshot could be captured.
      }
      return submitCapture
    })()
    try {
      return await submitCaptureInFlight
    } finally {
      submitCaptureInFlight = null
    }
  }
  const retainedSubmitFields = () => {
    if (!submissionAttemptStarted) return {}
    if (!submitClicked) return { submission_attempt_started: true }
    return {
      submission_attempt_started: true,
      ...submitCaptureHistoryResult(submitCaptureHistory, beforeSubmitCapture),
    }
  }
  const abortBrowser = () => {
    // Before a submit click, close immediately. After a click, leave the page
    // alive long enough for the catch/cancel path to retain attempt evidence.
    if (!submitClicked) void browser.close().catch(() => {})
  }
  signal?.addEventListener('abort', abortBrowser, { once: true })

  // Live view: stream a low-fps screencast of this run's browser and report its
  // steps to the in-memory live store. Pure side channel — startLiveScreencast
  // never throws, and a failure leaves the run untouched. Only the real headless
  // Chromium path (the injected test page has no CDP session). Declared here so
  // the finally below can always stop it.
  let liveViewHandle = { stop: async () => {} }
  if (runId && !_testPage && isLiveViewEnabled()) {
    liveViewHandle = await startLiveScreencast(page, runId).catch(() => ({ stop: async () => {} }))
  }

  try {
    reportLiveStep(runId, 'Opening the portal', {
      detail: { host: (() => { try { return new URL(url).host } catch { return null } })() },
    })
    trace.push({ step: 'navigate', detail: { url } })
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })

    while (pagesVisited < MAX_PAGES) {
      if (signal?.aborted) {
        return { status: 'cancelled', blocker_kind: 'cancelled', blocker_detail: 'Hamilton task was cancelled.', filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn }
      }
      pagesVisited += 1
      reportLiveStep(runId, 'Reading the application page', { detail: { page: pagesVisited } })
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
        // One-time-code wall: read the code from HAMILTON'S OWN inbox and type
        // it. Mirrors the saved-login path above deliberately — attempted at
        // most ONCE, and a failure falls through to the SAME hard stop that has
        // always been here, so the handoff is preserved rather than replaced.
        //
        // Once only is not caution for its own sake: repeated OTP submissions
        // are what portals treat as an attack, and the cost of being wrong is a
        // locked account on a real applicant's portal.
        // CAPTCHA wall: forward the challenge to the owner-configured solver
        // service and inject the token. Mirrors the 2FA path deliberately —
        // once per gate, and any failure falls through to the SAME hard stop
        // that has always been here (saved-session reuse, then human hand-off),
        // so the default without a solver key is unchanged. Hamilton never
        // hand-forges a challenge; the token comes from the paid service the
        // owner opted into.
        // A CAPTCHA wall — OR a full-page bot-protection interstitial that is
        // actually a SOLVABLE challenge (Cloudflare Turnstile / managed
        // challenge carrying a sitekey). CapSolver solves Turnstile proxyless,
        // so a bot_protected page should get a solver attempt BEFORE dead-ending
        // at the co-browse hand-off — the solver's own detector looks for a
        // Turnstile/reCAPTCHA/hCaptcha sitekey and returns no_sitekey_on_page for
        // a pure managed challenge with no widget, which then falls through to
        // the unchanged bot_protected hard stop below. This removes the block for
        // the solvable subset without ever claiming to pass an unsolvable wall.
        if ((gate.kind === 'captcha' || gate.kind === 'bot_protected') && solveCaptcha && !captchaAttempted) {
          captchaAttempted = true
          trace.push({ step: 'captcha_attempt', detail: gate.kind === 'bot_protected' ? { source: 'bot_wall' } : undefined })
          reportLiveStep(runId, gate.kind === 'bot_protected' ? 'Clearing the site security check' : 'Solving the CAPTCHA')
          let verdict = { solved: false, reason: 'solver_unavailable' }
          try {
            verdict = (await solveCaptcha(page)) || verdict
          } catch (err) {
            verdict = { solved: false, reason: String(err?.message || err).slice(0, 80) }
          }
          trace.push({ step: 'captcha_result', detail: { solved: Boolean(verdict.solved), vendor: verdict.vendor || null, reason: verdict.reason || null } })
          if (verdict.solved) {
            // Token injected; re-inspect the page rather than treating the
            // challenge as a live gate.
            continue
          }
        }
        if (gate.kind === '2fa' && attemptVerification && !twoFactorAttempted) {
          twoFactorAttempted = true
          trace.push({ step: 'two_factor_attempt' })
          let verdict = { verified: false, reason: 'verification_unavailable' }
          try {
            verdict = (await attemptVerification(page)) || verdict
          } catch (err) {
            // Never let the solver take the run down: an unreadable mailbox is
            // a reason to hand off, not to crash a run that has already filled
            // fields worth preserving.
            verdict = { verified: false, reason: `verification_error:${err?.message || err}` }
          }
          // The code itself is NEVER traced. `trace` is persisted on the run row
          // and rendered in the task drawer, and a live MFA code written into
          // durable storage outlives its usefulness by months.
          trace.push({
            step: 'two_factor_result',
            detail: { verified: Boolean(verdict.verified), reason: verdict.reason || null },
          })
          if (verdict.verified) {
            loggedIn = true
            continue
          }
        }
        trace.push({ step: 'gate', detail: gate })
        return { status: 'blocked', blocker_kind: gate.kind, blocker_detail: gate.detail, filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn }
      }
      const sigGate = await detectAttestationGate(page, { authorizations, signatureConsent })
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
        if (!rule) {
          // Field outside the fixed vocabulary (a portal-specific question).
          // Answer it from the profile via the injected LLM layer — grounded,
          // never fabricated; a null answer leaves the field blank so it becomes
          // a genuine user ask instead of a made-up value. Only text-like fields,
          // only when narrative generation is authorized, only if not pre-filled.
          let unknownFilled = false
          if (answerUnknownField && authorizations.generate_narratives
              && isAnswerableUnknownField(f) && !f.value) {
            let answered = null
            try { answered = await answerUnknownField(f) } catch { answered = null }
            if (answered?.value) {
              const okA = await fillFieldByFid(page, f.fid, answered.value)
              if (okA) {
                filled.push({ key: `q:${fieldLabelOf(f).slice(0, 40)}`, fid: f.fid, source: 'llm_field_answer', value: String(answered.value).slice(0, 60) })
                filledThisPage += 1
                unknownFilled = true
                trace.push({ step: 'llm_field_answer', detail: { label: fieldLabelOf(f).slice(0, 60), free_text: Boolean(answered.free_text), grounded_in: answered.grounded_in || [] } })
              }
            }
          }
          // A REQUIRED portal-specific question Hamilton could not answer from
          // the profile — and has no fixed rule for — is exactly what the owner
          // wants ASKED (never fabricated). Collect it so the orchestrator can
          // route it to the right profile section, or have Anya create a global
          // field for it, and surface a specific request. Deduped by label.
          if (f.required && !unknownFilled && !f.value) {
            const label = fieldLabelOf(f).slice(0, 120)
            if (label && !unansweredRequiredFields.some((u) => u.label === label)) {
              unansweredRequiredFields.push({ label, fid: f.fid, type: String(f.type || f.tag || 'text') })
            }
          }
          continue
        }
        // An identity-proofing field is filled from the ENCRYPTED vault, only
        // when a value is on file — never from the profile, never invented.
        const identityField = isIdentityFieldKey(rule.key)
        const v = identityField ? identityByFieldKey[rule.key] : valuesByKey[rule.key]
        if (v === undefined || v === null || String(v).trim() === '') {
          // A REQUIRED identity field we cannot fill (nothing on file) is what
          // the owner wants Hamilton to ASK for by name — record the vault kind
          // so the run surfaces a specific request instead of silently stalling.
          if (identityField && fullAutomation && f.required && IDENTITY_FIELD_TO_KIND[rule.key]) {
            missingIdentityKinds.add(IDENTITY_FIELD_TO_KIND[rule.key])
          }
          continue
        }
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
          // NEVER record an identity value in the trace/filled list — it is
          // persisted on the run row. Record the key and that it came from the
          // vault; the value is deliberately omitted.
          filled.push(identityField
            ? { key: rule.key, fid: f.fid, source: 'identity_vault' }
            : { key: rule.key, fid: f.fid, value: String(v).slice(0, 60) })
          filledThisPage += 1
        }
      }
      trace.push({ step: 'fill', detail: { filledThisPage } })
      reportLiveStep(runId, 'Filling the application', { detail: { fields_filled: filledThisPage } })

      // A required identity value is missing from the vault: stop and hand back a
      // NAMED request (owner directive 2026-08-21 — Hamilton asks the profile's
      // user for what he needs rather than fabricating or dead-ending). The kinds
      // are surfaced; no value is ever in the trace.
      if (missingIdentityKinds.size > 0) {
        const kinds = [...missingIdentityKinds]
        trace.push({ step: 'identity_needed', detail: { kinds } })
        return {
          status: 'blocked',
          blocker_kind: 'identity_proof',
          blocker_detail: `Hamilton needs identity detail(s) not on file: ${kinds.join(', ')}.`,
          missing_identity_kinds: kinds,
          filled_fields: filled,
          pages_visited: pagesVisited,
          trace,
          logged_in: loggedIn,
        }
      }

      // The applicant's typed electronic signature, under full-automation
      // consent only. The value is the applicant's own name from the profile
      // (never Hamilton's, never invented) and every signature is traced so
      // the run record shows exactly what was signed where.
      if (signatureConsent) {
        for (const f of fields) {
          if (!isTypedSignatureField(f)) continue
          if (f.value && String(f.value).trim()) continue
          const ok = await fillFieldByFid(page, f.fid, signatureConsent.name)
          if (ok) {
            filled.push({ key: 'signature', fid: f.fid, value: signatureConsent.name.slice(0, 60) })
            trace.push({ step: 'signature_typed', detail: { fid: f.fid, label: (f.label || f.name || f.placeholder || '').slice(0, 120), name: signatureConsent.name } })
          }
        }
      }

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
              list.push({ kind: 'standing', text: text.slice(0, 120) })
            } else if (blocked && opts.signature && !el.checked) {
              // An e-signature checkbox, under full-automation consent.
              el.checked = true
              el.dispatchEvent(new Event('change', { bubbles: true }))
              list.push({ kind: 'signature', text: text.slice(0, 120) })
            }
          }
          return list
        }, {
          standing: STANDING_ATTESTATION_PATTERNS.map((r) => ({ s: r.source, f: r.flags })),
          hard:     HARD_ATTESTATION_PATTERNS.map((r) => ({ s: r.source, f: r.flags })),
          signature: Boolean(signatureConsent),
        }).catch(() => [])
        const standingTicked = checkboxes.filter((c) => c.kind === 'standing').map((c) => c.text)
        const signatureTicked = checkboxes.filter((c) => c.kind === 'signature').map((c) => c.text)
        if (standingTicked.length > 0) trace.push({ step: 'attestation_checked', detail: { items: standingTicked } })
        if (signatureTicked.length > 0) trace.push({ step: 'signature_attested', detail: { items: signatureTicked, name: signatureConsent.name } })
      }

      // Authorized document uploads.
      if (authorizations.upload_documents && Array.isArray(documents) && documents.length > 0) {
        if (signal?.aborted) {
          return { status: 'cancelled', blocker_kind: 'cancelled', blocker_detail: 'Hamilton task was cancelled before document upload.', filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn }
        }
        const fileInputs = fields.filter((f) => f.type === 'file')
        for (const inp of fileInputs) {
          const wanted = documents.map(resolveSafeUploadDocument).filter(Boolean).find((d) => {
            const text = `${inp.name} ${inp.label} ${inp.id} ${inp.placeholder}`.toLowerCase()
            return text.includes((d.kind || '').toLowerCase())
          })
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
        // Before giving up: this may be a LANDING page whose "Apply" / "Start
        // Application" control NAVIGATES to the real form. Follow it (bounded,
        // never the same control twice) and re-inspect — the form it leads to
        // carries the fields Hamilton fills. Only reached when nothing was
        // fillable here, so it can never intercept a real submit.
        const applyNav = await detectButtons(page, APPLY_NAV_PATTERNS)
        const nextApply = applyNav.find(
          (b) => !clickedApplyNav.has(String(b.text || '').trim().toLowerCase()),
        )
        if (nextApply && applyNavClicks < MAX_APPLY_NAV_CLICKS) {
          applyNavClicks += 1
          clickedApplyNav.add(String(nextApply.text || '').trim().toLowerCase())
          trace.push({ step: 'follow_apply_link', detail: { text: String(nextApply.text || '').slice(0, 40) } })
          reportLiveStep(runId, 'Opening the application form')
          const followed = await clickButtonByBid(page, nextApply.bid)
          if (followed) {
            await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT_MS }).catch(() => null)
            await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => null)
            continue // re-inspect the page the apply link led to
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
        const nativeErrors = await detectNativeValidationErrors(page, submitCandidates[0].bid)
        if (nativeErrors.length > 0) {
          trace.push({ step: 'submit_native_validation_failed', detail: { errors: nativeErrors.slice(0, 5) } })
          return { status: 'blocked', blocker_kind: 'validation', blocker_detail: nativeErrors.slice(0, 5).join(' | '), filled_fields: filled, unanswered_required_fields: unansweredRequiredFields, pages_visited: pagesVisited, trace }
        }
        const boundary = typeof beforeSubmit === 'function'
          ? await beforeSubmit()
          : { allow: false, reason: 'missing_submit_boundary_check' }
        if (signal?.aborted || boundary?.cancelled) {
          return { status: 'cancelled', blocker_kind: 'cancelled', blocker_detail: 'Hamilton task was cancelled before submission.', filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn }
        }
        if (boundary?.allow !== true) {
          trace.push({ step: 'completed_draft', detail: { reason: boundary?.reason || 'submit_authority_revoked' } })
          return { status: 'completed_draft', submit_withheld_reason: boundary?.reason || 'submit_authority_revoked', filled_fields: filled, unanswered_required_fields: unansweredRequiredFields, pages_visited: pagesVisited, trace, logged_in: loggedIn }
        }
        submissionAttemptStarted = true
        // Submit the application.
        trace.push({ step: 'submit_attempt', detail: { button: submitCandidates[0].text } })
        const beforeUrl = (() => { try { return page.url() } catch { return null } })()
        const beforeText = await page.locator('body').innerText({ timeout: 2500 }).catch(() => '')
        const beforeHtml = await page.content().catch(() => '')
        const beforeConfirmation = {
          url: beforeUrl,
          reference: extractConfirmationReference(beforeText)
            || extractConfirmationReference(beforeHtml)
            || extractConfirmationReferenceFromUrl(beforeUrl),
          received_acknowledgement: detectReceiptAcknowledgement(beforeText)
            || detectReceiptAcknowledgement(beforeHtml),
        }
        beforeSubmitCapture = beforeConfirmation
        reportLiveStep(runId, 'Submitting the application')
        const clicked = await clickButtonByBid(page, submitCandidates[0].bid)
        if (!clicked) {
          return {
            status: 'failed', blocker_kind: 'click_failed',
            blocker_detail: 'Submit button could not be clicked after the durable submission boundary was acquired.',
            ...retainedSubmitFields(),
            filled_fields: filled, pages_visited: pagesVisited, trace,
          }
        }
        submitClicked = true
        // Capture immediately. If navigation, cancellation, or a browser error
        // happens next, the run still retains an honest submit-attempt record.
        await retainSubmitCapture()
        if (signal?.aborted) {
          return {
            status: 'cancelled',
            blocker_kind: 'cancelled',
            blocker_detail: 'Hamilton task was cancelled after the portal submit control was clicked. Retained captures are attempt evidence unless a genuinely new portal reference or receipt acknowledgement was observed.',
            ...retainedSubmitFields(),
            filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn,
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
        await retainSubmitCapture()
        if (signal?.aborted) {
          return {
            status: 'cancelled',
            blocker_kind: 'cancelled',
            blocker_detail: 'Hamilton task was cancelled after the portal submit control was clicked. Retained captures are attempt evidence unless a genuinely new portal reference or receipt acknowledgement was observed.',
            ...retainedSubmitFields(),
            filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn,
          }
        }
        const errors = await detectValidationErrors(page)
        if (errors.length > 0) {
          trace.push({ step: 'submit_validation_failed', detail: { errors: errors.slice(0, 5) } })
          return {
            status: 'blocked', blocker_kind: 'validation', unanswered_required_fields: unansweredRequiredFields,
            blocker_detail: errors.slice(0, 5).join(' | '),
            ...retainedSubmitFields(),
            filled_fields: filled, pages_visited: pagesVisited, trace,
          }
        }
        const conf = submitCapture
        const evidence = assessSubmissionEvidence(conf, beforeConfirmation)
        if (!evidence.ok) {
          // Submit was clicked but NO evidence could be captured (no
          // reference, no screenshot). Refuse to claim a submission — hand
          // the run to a human to verify receipt on the portal.
          trace.push({ step: 'submit_unconfirmed', detail: { from: beforeUrl, to: conf.url } })
          return {
            status: 'blocked',
            blocker_kind: 'submit_unconfirmed',
            blocker_detail: 'Hamilton clicked the portal submit control, but the portal produced neither a genuinely new portal reference nor a newly appearing receipt acknowledgement. URL changes, screenshots, and saved pages were retained as attempt evidence only. Verify receipt on the portal before treating this application as submitted.',
            ...retainedSubmitFields(),
            filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn,
          }
        }
        trace.push({ step: 'submitted', detail: { from: beforeUrl, to: conf.url, confirmation: conf.reference, confirmation_evidence: evidence.confirmation_evidence, received_acknowledgement: conf.received_acknowledgement } })
        return {
          status: 'submitted',
          ...retainedSubmitFields(),
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
        return { status: 'completed_draft', filled_fields: filled, unanswered_required_fields: unansweredRequiredFields, pages_visited: pagesVisited, trace, logged_in: loggedIn }
      }

      if (canNext) {
        if (signal?.aborted) {
          return { status: 'cancelled', blocker_kind: 'cancelled', blocker_detail: 'Hamilton task was cancelled before continuing.', filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn }
        }
        const clicked = await clickButtonByBid(page, nextButtons[0].bid)
        if (!clicked) {
          return { status: 'failed', blocker_kind: 'click_failed', blocker_detail: 'Next button could not be clicked', filled_fields: filled, pages_visited: pagesVisited, trace }
        }
        await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT_MS }).catch(() => null)
        const errors = await detectValidationErrors(page)
        if (errors.length > 0) {
          trace.push({ step: 'validation_after_next', detail: { errors: errors.slice(0, 5) } })
          return { status: 'blocked', blocker_kind: 'validation', blocker_detail: errors.slice(0, 5).join(' | '), filled_fields: filled, unanswered_required_fields: unansweredRequiredFields, pages_visited: pagesVisited, trace }
        }
        continue
      }

      // No button to advance. If save_drafts authorized and a draft
      // button exists, save it.
      if (canDraft && authorizations.save_drafts) {
        await clickButtonByBid(page, draftButtons[0].bid)
        trace.push({ step: 'completed_draft', detail: { reason: 'no_next_button' } })
        return { status: 'completed_draft', filled_fields: filled, unanswered_required_fields: unansweredRequiredFields, pages_visited: pagesVisited, trace, logged_in: loggedIn }
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
    if (submitClicked) await retainSubmitCapture()
    if (signal?.aborted) {
      return {
        status: 'cancelled', blocker_kind: 'cancelled',
        blocker_detail: submitClicked
          ? 'Hamilton task was cancelled after the portal submit control was clicked. Retained captures are attempt evidence unless a genuinely new portal reference or receipt acknowledgement was observed.'
          : 'Hamilton task was cancelled.',
        ...retainedSubmitFields(),
        filled_fields: filled, pages_visited: pagesVisited, trace,
      }
    }
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
        ...retainedSubmitFields(),
        filled_fields: filled,
        pages_visited: pagesVisited,
        trace,
      }
    }
    return {
      status: 'failed', blocker_kind: 'engine_error', blocker_detail: raw,
      ...retainedSubmitFields(),
      filled_fields: filled, pages_visited: pagesVisited, trace,
    }
  } finally {
    signal?.removeEventListener('abort', abortBrowser)
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
    try { await liveViewHandle.stop() } catch { /* ignore */ }
    try { await context.close() } catch { /* ignore */ }
    try { await browser.close() } catch { /* ignore */ }
  }
}

export const _internal = {
  FIELD_RULES, STANDING_ATTESTATION_PATTERNS, HARD_ATTESTATION_PATTERNS,
  SIGNATURE_FIELD_PATTERNS, isTypedSignatureField, signatureConsentFor, detectAttestationGate,
  SUBMIT_BUTTON_PATTERNS, NEXT_BUTTON_PATTERNS, DRAFT_BUTTON_PATTERNS,
  matchFieldKey, readProfileValues, applyNarrativeAnswers,
  clickButtonByBid, FEEDBACK_VALIDATION_IGNORE_RX,
  detectGate, detectBotWall, attemptLogin,
  extractConfirmationReference,
  extractConfirmationReferenceFromUrl,
  detectReceiptAcknowledgement,
  normalizedReference,
  captureConfirmation,
  mergeSubmitCapture,
  submitCaptureResult,
  submitCaptureHistoryResult,
  actionableSubmitButtons,
  assessSubmissionEvidence,
  detectNativeValidationErrors,
  resolveSafeUploadDocument,
}
