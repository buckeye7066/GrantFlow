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
  isControlledBetaSyntheticBrowserUrl,
  isHamiltonBrowserTargetAllowed,
  isPrivateResolutionVerdict,
  normalizeBrowserTargetUrl,
  resolvePublicBrowserTarget,
} from './controlledBetaBrowserPolicy.js'
import path from 'node:path'
import { registrableDomain } from './hamiltonPortalCredentialService.js'
import { triagePage, PAGE_SURFACES } from './listingPageTriage.js'
import { detectSpaApplySurface, spaApplyBlockerDetail } from './spaApplySurface.js'
import { resolveConfirmationCaptureDir } from './hamiltonConfirmationArtifacts.js'
import { resolveUploadsDir } from '../../utils/uploadsDir.js'
import { startLiveScreencast, reportLiveStep, isLiveViewEnabled } from './hamiltonLiveView.js'
import { isAnswerableUnknownField, fieldLabelOf } from './hamiltonFieldAnswerer.js'
import { STATE_REGISTRY } from '../shared/data/stateRegistry.js'
import { US_STATE_CODES, US_TERRITORY_CODES } from '../../../shared/usStateCodes.js'

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
  // "I have read and agree to the 2026 U.S. Bank Student Scholarship
  // Sweepstakes Official Rules" — reading + agreeing to the funder's rules,
  // terms, privacy policy or guidelines is the consent the full-automation
  // grant already carries (07f6c0d8). Left unticked it failed the submit.
  /\b(read|reviewed)\b.*\b(agree|accept|consent)\b/i,
  /\b(agree|accept|consent)\b.*\b(official\s*rules|rules|terms|privacy|policy|policies|guidelines|requirements)\b/i,
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
// A "Submit" that submits a FILTER, a search box or a feedback form is not an
// application submit. bja.ojp.gov/funding/opportunities carries "Submit all
// selections" on its facet filter; a student's task reached the irreversible
// boundary on it (prod, 2026-08-22).
export const SUBMIT_BUTTON_EXCLUDE_RX = /submit\s+(all\s+)?(selections?|search|query|filters?|feedback|comments?|a\s+(question|request|ticket))\b|\bsearch\b/i
const NEXT_BUTTON_PATTERNS   = [/^next/i, /continue/i, /proceed/i, /save\s*&\s*continue/i]
// A "Continue Working" control is a SESSION-TIMEOUT dismissal, not a form
// advance. NGWeb Scholarship Manager's public landing carries exactly one
// button — `ngSessionTimeoutButton` "Continue Working" (onclick: reload) — and
// the engine clicked it as "Next" twice, then ended `next_without_fields`
// on a page whose real way forward was the "Students" sign-in link (live,
// mtsu.scholarships.ngwebsolutions.com, 2026-09-06). Exported via _internal.
export const NEXT_BUTTON_EXCLUDE_RX = /continue\s+working|stay\s+(?:signed|logged)\s+in|keep\s+(?:me\s+)?(?:signed|logged)\s+in|continue\s+(?:shopping|reading|browsing|watching)|extend\s+(?:my\s+)?session|session\s+(?:timeout|expir)/i
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
// An ADMISSIONS application is not a scholarship application. Live 2026-09-05:
// from mtsu.edu/scholarships the engine followed "Apply to MTSU" into the
// Slate admissions portal (apply.mtsu.edu/portal/app_management) for a
// student already committed to MTSU, and parked at its single sign-on wall.
// A student who is provably enrolled or committed post-secondary never needs
// an admissions application; these links are skipped for them, recorded in
// the trace, and everything else (a scholarship "Apply", a general
// application) is followed exactly as before.
const ADMISSIONS_LINK_TEXT_RX = /\b(?:apply (?:to|for admission)|admissions?|undergraduate application|freshman application|transfer application|graduate application|common app|apply as a (?:freshman|transfer))\b/i
const ADMISSIONS_LINK_HREF_RX = /^https?:\/\/(?:apply|admissions?|go|connect)\.[a-z0-9.-]+\.edu(?:\/|$)|\/applynow(?:\/|$)|\/admissions?(?:\/|$)|\/portal\/app_management|\/manage\/login/i

export function isAdmissionsApplicationLink({ text = '', href = '' } = {}) {
  const t = String(text || '')
  const h = String(href || '')
  if (ADMISSIONS_LINK_TEXT_RX.test(t)) return true
  if (/\.edu(?:\/|$)/i.test(h) && ADMISSIONS_LINK_HREF_RX.test(h)) return true
  return false
}

/** Committed / enrolled post-secondary — from structured fields only. */
export function applicantProvablyEnrolled(profile) {
  if (!profile || typeof profile !== 'object') return false
  const apps = pick(profile, ['university_applications.applications'])
  if (Array.isArray(apps) && apps.some((app) => ['committed', 'enrolled', 'attending'].includes(String(app?.status || '').toLowerCase()))) return true
  const institution = pick(profile, ['education.current_institution', 'education_information.current_institution', 'student_info.school_name'])
  if (typeof institution === 'string' && institution.trim() && !/^(?:none|n\/a|unknown|-)$/i.test(institution.trim())) return true
  const level = String(pick(profile, ['education.highest_level']) || '')
  return /associate|bachelor|master|doctor|graduate/i.test(level)
}

const APPLY_NAV_PATTERNS = [
  /^apply(?:\s|$)/i, /apply\s*now/i, /apply\s*online/i, /apply\s*here/i, /apply\s*today/i,
  /start\s*(?:your\s*|an?\s*)?application/i, /begin\s*(?:your\s*|an?\s*)?application/i,
  /start\s*(?:your\s*)?app\b/i, /go\s*to\s*(?:the\s*)?application/i, /open\s*application/i,
  /application\s*form/i,
  // 2026-08-30: real funder sites (NAMI / Seattle CDBG / Alaska Housing class)
  // reach the form through ordinary navigation copy, not a button labelled
  // "Apply". Navigation-only patterns — this list is consulted ONLY on a page
  // with no fillable form, so widening it cannot intercept a submit.
  /how\s*to\s*apply/i, /application\s*portal/i, /online\s*application/i,
  /submit\s*(?:an\s*|your\s*)?application/i, /apply\s*for\s*(?:funding|assistance|this)/i,
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

/**
 * A profile address often arrives as ONE blob ("3940 Eveningside Dr. NE\n
 * Cleveland, TN 37312") with city/state/zip empty. Filled verbatim into
 * "Address line 1" while "City" stayed blank, the U.S. Bank form failed its
 * native validation on City (prod, 2026-08-22). This splits the blob into its
 * parts when — and only when — the tail has the unambiguous "City, ST 12345"
 * shape; anything else is left exactly as stored.
 */
export function parseAddressBlob(raw) {
  const text = String(raw ?? '').replace(/\r/g, '').trim()
  if (!text) return null
  const m = text.match(/^([\s\S]*?)[,\n]\s*([A-Za-z][A-Za-z .'-]{1,60}?),?\s+([A-Za-z]{2})\.?\s+(\d{5})(?:-\d{4})?\s*$/)
  if (!m) return null
  const state = m[3].toUpperCase()
  if (!US_STATE_CODES.includes(state) && !US_TERRITORY_CODES.includes(state)) return null
  const street = m[1].replace(/\s*\n\s*/g, ', ').replace(/,\s*$/, '').trim()
  return { street: street || undefined, city: m[2].trim(), state, zip: m[4] }
}

const STATE_NAME_BY_CODE = Object.freeze(Object.fromEntries(
  Object.entries(STATE_REGISTRY).map(([code, entry]) => [code.toUpperCase(), entry?.name]).filter(([, name]) => name),
))
const STATE_CODE_BY_NAME = Object.freeze(Object.fromEntries(
  Object.entries(STATE_NAME_BY_CODE).map(([code, name]) => [String(name).toLowerCase(), code]),
))

/**
 * A state <select> lists either "Tennessee" or "TN"; the profile stores one of
 * them. Try what the profile says first, then the other spelling. Never a
 * guess: an unrecognised value yields only itself.
 */
export function stateValueAlternates(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return []
  const out = [raw]
  const upper = raw.toUpperCase()
  if (STATE_NAME_BY_CODE[upper]) out.push(STATE_NAME_BY_CODE[upper])
  const code = STATE_CODE_BY_NAME[raw.toLowerCase()]
  if (code) out.push(code)
  return [...new Set(out)]
}

function readProfileValues(profile) {
  const apps = pick(profile, ['university_applications.applications']) || []
  const committed = Array.isArray(apps)
    ? apps.find((app) => ['committed', 'enrolled', 'attending'].includes(String(app?.status || '').toLowerCase()))
    : null
  const firstApp = committed || (Array.isArray(apps) && apps.length > 0 ? apps[0] : {})
  const storedAddress1 = pick(profile, [
    'basic_information.address1', 'basic_information.address',
    'contact_information.address1', 'contact_information.address',
    'address1', 'address',
  ])
  const storedCity = pick(profile, ['basic_information.city', 'contact_information.city', 'city', 'signals.location.city'])
  const storedState = pick(profile, ['basic_information.state', 'contact_information.state', 'state', 'signals.location.state'])
  const storedZip = pick(profile, [
    'basic_information.zip', 'basic_information.postal_code',
    'contact_information.zip', 'postal_code', 'zip', 'signals.location.zip',
  ])
  const parsedAddress = (!storedCity || !storedState || !storedZip) ? parseAddressBlob(storedAddress1) : null
  return {
    first_name: pick(profile, [
      'basic_information.first_name', 'personal_information.first_name', 'first_name',
    ]),
    last_name: pick(profile, [
      'basic_information.last_name', 'personal_information.last_name', 'last_name',
    ]),
    full_name: [
      pick(profile, ['basic_information.first_name', 'personal_information.first_name', 'first_name']),
      pick(profile, ['basic_information.last_name', 'personal_information.last_name', 'last_name']),
    ].filter(Boolean).join(' ') || pick(profile, ['basic_information.full_name', 'display_name']),
    email: pick(profile, ['basic_information.email', 'contact_information.email', 'email']),
    phone: pick(profile, ['basic_information.phone', 'contact_information.phone', 'phone']),
    address1: parsedAddress?.street || storedAddress1,
    address2: pick(profile, ['basic_information.address2', 'contact_information.address2', 'address2']),
    city: storedCity || parsedAddress?.city,
    state: storedState || parsedAddress?.state,
    zip: storedZip || parsedAddress?.zip,
    country: pick(profile, ['basic_information.country', 'contact_information.country', 'country']) || 'United States',
    school: firstApp.name || pick(profile, [
      'education.current_institution', 'education.school_name',
      'education_information.current_institution', 'student_info.school_name',
    ]),
    major: firstApp.major || pick(profile, [
      'education.intended_major', 'education.major',
      'education_information.intended_major', 'student_info.major',
    ]),
    degree_level: firstApp.degree_level || pick(profile, [
      'education.degree_level', 'education_information.degree_level', 'student_info.degree_level',
    ]),
    student_id: firstApp.student_id || pick(profile, ['education.student_id', 'student_info.student_id']),
    gpa: pick(profile, ['education.gpa', 'education_information.gpa', 'student_info.gpa', 'gpa']),
    act_score: pick(profile, ['education.act_score', 'education_information.act_score', 'student_info.act_score', 'act_score']),
    sat_score: pick(profile, ['education.sat_score', 'education_information.sat_score', 'student_info.sat_score', 'sat_score']),
    expected_graduation: firstApp.expected_graduation || pick(profile, [
      'education.expected_graduation', 'education_information.expected_graduation',
      'student_info.expected_graduation',
    ]),
    household_income: pick(profile, [
      'financial_information.household_income', 'financial_information.annual_income',
      'household.income', 'household_income',
    ]),
    household_size: pick(profile, [
      'financial_information.household_size', 'family.household_size',
      'family_life.household_size', 'household.size', 'household_size',
    ]),
    fafsa_efc: pick(profile, [
      'financial_information.fafsa_efc', 'financial_information.sai',
      'education.fafsa_efc', 'education.sai',
    ]),
    essay: pick(profile, [
      'essays.primary', 'essays.personal_statement',
      'narrative.personal_statement', 'narrative.statement_of_need',
      'personal_statement',
    ]) ?? readOrgNarrative(profile),
    goals: pick(profile, [
      'essays.goals', 'narrative.goals', 'education.career_goals',
      'goals', 'career_goals',
    ]),
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
        // The portal's OWN stated character limit. Until this was read, the
        // answerer truncated every field at a hard-coded 300 / 4000, so a
        // funder allowing a 10,000-character narrative silently received 4,000
        // and any non-essay field was chopped at 300. `el.maxLength` is -1 when
        // the attribute is absent; normalise that to null so "the portal said
        // nothing" is distinguishable from "the portal said zero".
        maxLength: (() => {
          const attr = el.getAttribute('maxlength')
          const n = attr === null ? Number(el.maxLength) : Number(attr)
          return Number.isFinite(n) && n > 0 ? n : null
        })(),
        value: el.value ?? null,
        options: tag === 'select'
          ? Array.from(el.options || []).slice(0, 60).map((o) => String(o.textContent || o.label || o.value || '').trim().slice(0, 80))
          : undefined,
      })
      idx += 1
    }
    return out
  })
}

function matchFieldKey(field) {
  const parts = [field.name, field.id, field.placeholder, field.ariaLabel, field.label]
    .filter(Boolean).map((c) => String(c).toLowerCase().trim()).filter(Boolean)
  if (parts.length === 0) return null
  // Each candidate is tested ON ITS OWN as well as the joined string. An
  // anchored rule (/^city$/, /^state$/, /^name$/) can never match the joined
  // "city city city" of a field whose name, id and label all read "City" —
  // which is exactly why a live form's City stayed blank while the profile
  // held the value (prod, 2026-08-22). The joined form still serves the
  // multi-word rules ("date of birth" split across name + label).
  const joined = parts.join(' ')
  for (const rule of FIELD_RULES) {
    if (rule.patterns.some((rx) => parts.some((c) => rx.test(c)) || rx.test(joined))) return rule
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
          // A newsletter / "stay in touch" / contact-us / site-search form is
          // not an application, however well its Submit button matches. Prod
          // 2026-08-31: seven tasks reached the irreversible boundary on
          // exactly these (first name + last name + email + Submit on a
          // homepage) and then sat in submission_verification_required for a
          // human to "check the portal" — for a mailing-list sign-up.
          const formAttrs = form
            ? `${form.getAttribute('id') || ''} ${form.getAttribute('name') || ''} ${form.getAttribute('class') || ''} ${form.getAttribute('aria-label') || ''} ${form.getAttribute('action') || ''}`
            : ''
          const isContactForm = !!form && (
            /\b(newsletter|subscribe|subscription|mailing[-_ ]?list|mailchimp|mc-embedded|mc4wp|klaviyo|hubspot|stay[-_ ](informed|connected|updated|in[-_ ]touch)|contact[-_ ]?(us|form)|get[-_ ]in[-_ ]touch|site[-_ ]?search|searchform|search[-_ ]form)\b/i.test(formAttrs)
            || /\b(?:sign up for (?:our )?(?:updates|news|newsletter|emails?)|subscribe to (?:our )?(?:newsletter|updates|emails?)|join our (?:mailing|email) list|stay (?:informed|connected|up to date|in the loop)|get (?:the latest|updates|news) (?:from|about|in your inbox)|contact us|send us a message|we'd love to hear from you|search this site|search the site)\b/i.test(formContext.slice(0, 1200))
          )
          // A STABLE id per element. detectButtons runs once per pattern set
          // (submit / next / draft) and used to renumber from b0 each time, so
          // a button matching BOTH submit and next ("Submit and continue") was
          // re-stamped by the later call and the submit click looked up an id
          // that no longer existed — "Submit button could not be clicked" on a
          // form whose button was right there (prod, 2026-08-03 and 2026-08-22).
          let bid = el.getAttribute('data-hamilton-btn')
          if (!bid) {
            window.__hamiltonBtnSeq = (window.__hamiltonBtnSeq || 0) + 1
            bid = `b${window.__hamiltonBtnSeq}`
            el.setAttribute('data-hamilton-btn', bid)
          }
          out.push({ bid, text, inForm: !!form, formFieldCount, isPageFeedback, isContactForm })
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

/**
 * Click the SUBMIT control with a verdict the irreversible boundary can trust.
 *
 * Returns { clicked, dispatched }:
 *   - clicked:    the click ran and the post-click settle completed.
 *   - dispatched: whether a click event may have REACHED the page. false means
 *     provably not — the handle was gone, or every attempt failed during
 *     Playwright's pre-dispatch actionability phase (a TimeoutError there
 *     fires no event). Only a failure AFTER dispatch could have submitted,
 *     and those set dispatched=true so the caller stays conservative.
 *
 * WHY (2026-08-30): "Submit button could not be clicked" (TSAC / HOPE / GAMS /
 * Aspire) ended runs in submission_verification_required — "a submission may
 * have gone through" — for clicks that provably never fired: SPA re-renders
 * drop the data-hamilton-btn attribute between detect and click, so page.$
 * returned null and NOTHING was ever clicked, yet the task was quarantined as
 * an uncertain submission a human had to reconcile. The fallback re-detects
 * the control by its own text before giving up.
 */
async function clickSubmitControl(page, candidate, patterns) {
  const first = await clickButtonByBidVerdict(page, candidate.bid)
  if (first.clicked || first.dispatched) return first
  // The stamped attribute vanished (SPA re-render) or the click never got past
  // actionability. Re-detect submit-looking controls and retry the one whose
  // text matches the candidate we already vetted. Never widens the choice:
  // only an exact-text match of the ALREADY-CHOSEN control is retried.
  try {
    const again = await detectButtons(page, patterns)
    const wantText = String(candidate.text || '').trim().toLowerCase()
    const match = again.find((b) => String(b.text || '').trim().toLowerCase() === wantText)
    if (match) return await clickButtonByBidVerdict(page, match.bid)
  } catch { /* fall through to the honest failure */ }
  return { clicked: false, dispatched: false }
}

async function clickButtonByBidVerdict(page, bid) {
  const sel = `[data-hamilton-btn="${bid}"]`
  const h = await page.$(sel).catch(() => null)
  if (!h) return { clicked: false, dispatched: false }
  try {
    const navWait = page.waitForNavigation({ timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' }).catch(() => null)
    await h.scrollIntoViewIfNeeded?.({ timeout: STEP_TIMEOUT_MS }).catch(() => {})
    let clicked = false
    let mayHaveDispatched = false
    const attempt = async (fn) => {
      try { await fn(); clicked = true } catch (err) {
        // A TimeoutError fires during Playwright's PRE-dispatch actionability
        // wait — no event reached the page. Any other error (context destroyed
        // by a navigation the click itself caused, target closed) may have
        // fired the event, so the boundary must stay conservative.
        if (!/Timeout|timeout/.test(String(err?.message || err))) mayHaveDispatched = true
      }
    }
    await attempt(() => h.click({ timeout: STEP_TIMEOUT_MS }))
    if (!clicked) await attempt(() => h.click({ timeout: STEP_TIMEOUT_MS, force: true }))
    if (!clicked) await attempt(() => h.evaluate((el) => el.click()))
    if (!clicked) return { clicked: false, dispatched: mayHaveDispatched }
    await Promise.race([
      navWait,
      new Promise((r) => setTimeout(r, 1500)),
    ])
    await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT_MS }).catch(() => null)
    return { clicked: true, dispatched: true }
  } catch {
    // The click may have fired before the failure (e.g. the navigation it
    // caused destroyed the context) — conservative.
    return { clicked: false, dispatched: true }
  }
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
// Visible text an identity provider prints when a sign-in fails. Captured
// (sanitised, capped) into the login verdict so the run's trace and the
// task's blocker say WHAT the provider said, never just "could not be
// completed" — the verbatim class of 2026-09-06, three rounds of
// `login_result:false` with no reason on any of them.
const LOGIN_FAILURE_TEXT_RX = /(?:we couldn'?t find an account|that microsoft account doesn'?t exist|your account or password is incorrect|incorrect (?:user ?name|password)|invalid (?:user ?name|password|credentials|login)|enter a valid email|this username may be incorrect|account (?:has been )?locked|too many (?:attempts|sign-in)|sign-in (?:was )?blocked|access denied|unauthori[sz]ed)[^.\n]{0,120}/i

async function readLoginFailureText(page) {
  const { bodyText } = await readBotWallSignals(page)
  const m = LOGIN_FAILURE_TEXT_RX.exec(bodyText || '')
  return m ? m[0].replace(/\s+/g, ' ').trim().slice(0, 200) : null
}

// What the page shows when no known failure sentence matched — the first
// visible words, so a verdict is never "the provider did not accept the
// password" with nothing to check it against (prod 2026-09-06 round 4:
// password_rejected, said:null, and no way to tell a wrong password from a
// step the engine did not recognise).
async function readVisibleTextSnippet(page) {
  const { bodyText } = await readBotWallSignals(page)
  const t = String(bodyText || '').replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, 240) : null
}

// Multi-factor prompts that carry NO otp-named input (Microsoft push
// approval, number matching, Duo push).
const MFA_PROMPT_TEXT_RX = /approve (?:the )?sign[- ]?in request|open your authenticator app|enter the number shown|we(?:'| ha)ve sent a (?:notification|text|code)|verify your identity|two[- ]step verification|multi[- ]?factor authentication|enter (?:the|your) (?:verification )?code|duo push|check your phone/i

// After a sign-in submit, an identity provider's single-page app swaps steps
// with an animation and follow-up requests: the lightbox goes BLANK, then the
// next step (password, MFA prompt, "Stay signed in?", the SAML hop) paints.
// `networkidle` resolves in that blank moment (prod screenshot 2026-09-06
// 18:42Z: an empty MTSU-branded Microsoft lightbox), so a DOM read there
// still saw the password box and called it a rejected password. Wait for the
// page to SETTLE: the password box gone, a failure sentence, an MFA prompt,
// or a navigation off the sign-in URL — bounded.
async function waitForSignInSettle(page, { timeoutMs = 12000, startUrl = null } = {}) {
  const t0 = Date.now()
  let last = 'timeout'
  while (Date.now() - t0 < timeoutMs) {
    const url = (() => { try { return page.url() } catch { return null } })()
    if (startUrl && url && url !== startUrl) { last = 'navigated'; break }
    const pass = await visiblePasswordField(page)
    if (!pass) { last = 'password_gone'; break }
    const said = await readLoginFailureText(page)
    if (said) { last = 'failure_text'; break }
    const { bodyText } = await readBotWallSignals(page)
    if (MFA_PROMPT_TEXT_RX.test(bodyText || '')) { last = 'mfa_prompt'; break }
    if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(400).catch(() => {})
    else await new Promise((r) => setTimeout(r, 400))
  }
  return last
}

// A password box that is in the DOM but NOT shown is not a password step.
// Microsoft keeps its hidden inputs across steps; reading the DOM alone
// turned every post-password page (MFA prompt, "Stay signed in?") into
// "still a password box" → password_rejected.
async function visiblePasswordField(page) {
  const f = await page.$('input[type="password"]:not([disabled])').catch(() => null)
  if (!f) return null
  if (typeof f.isVisible === 'function') {
    const visible = await f.isVisible().catch(() => true)
    if (!visible) return null
  }
  return f
}

/**
 * Boolean contract kept for every existing caller and test: true only when
 * the page no longer shows a sign-in surface. See attemptLoginDetailed for
 * the reason a false carries.
 */
async function attemptLogin(page, credential) {
  const verdict = await attemptLoginDetailed(page, credential)
  return verdict.ok === true
}

/**
 * Type a saved credential into the page's login form and report a VERDICT:
 *   { ok, reason, url, said }
 * reason ∈ origin_refused | no_login_form | username_not_accepted |
 *          password_rejected | still_login_surface | exception
 * `said` is the provider's own visible failure text when it printed one.
 */
async function attemptLoginDetailed(page, credential) {
  const urlNow = () => { try { return page.url() } catch { return null } }
  try {
    const username = credential?.username
    const password = credential?.password
    if (!username || !password) return { ok: false, reason: 'no_credential', url: urlNow(), said: null }
    // Origin safety: only type a saved credential into a page whose host shares
    // the credential's registrable domain (eTLD+1). Defeats a portal that
    // redirects mid-flow to an attacker origin before the login form. Re-checked
    // here against the LIVE page.url() right before any field is touched.
    const allowedDomain = registrableDomain(credential?.portal_host)
    let currentDomain = null
    let currentHost = null
    try { currentHost = new URL(page.url()).hostname.toLowerCase(); currentDomain = registrableDomain(currentHost) } catch { return false }
    // A credential may name the identity-provider hosts its portal signs in
    // through (`allowed_hosts`, from the institution registry) — the school
    // SSO pair is typed on nextgensso.com / login.microsoftonline.com, never on
    // the portal host itself. Anything outside that list is still refused.
    const allowedHosts = Array.isArray(credential?.allowed_hosts) ? credential.allowed_hosts.map((h) => String(h || '').toLowerCase()).filter(Boolean) : []
    const hostAllowed = allowedHosts.some((h) => currentHost === h || currentHost.endsWith(`.${h}`))
    if (!hostAllowed && (!allowedDomain || currentDomain !== allowedDomain)) {
      return { ok: false, reason: 'origin_refused', url: urlNow(), said: null }
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
    const findUserField = async () => {
      for (const sel of userSelectors) {
        const f = await page.$(sel).catch(() => null)
        if (f) return f
      }
      return null
    }
    let userField = await findUserField()
    let passField = await page.$('input[type="password"]:not([disabled])').catch(() => null)
    // A JS-rendered sign-in (Microsoft, Okta) may not have painted its inputs
    // at the instant the SSO hop lands. Give the form a moment to appear
    // before deciding there is none.
    if (!userField && !passField && typeof page.waitForSelector === 'function') {
      await page.waitForSelector(`${userSelectors.join(', ')}, input[type="password"]:not([disabled])`, { timeout: 8000, state: 'visible' }).catch(() => null)
      userField = await findUserField()
      passField = await page.$('input[type="password"]:not([disabled])').catch(() => null)
    }
    // Microsoft renders the password box in the DOM on the USERNAME step,
    // hidden (live login.microsoftonline.com, 2026-09-06): filling it there
    // times out and the run reads "still a password box" as a failed login.
    // A hidden password box is the username-first shape.
    if (passField && typeof passField.isVisible === 'function') {
      const visible = await passField.isVisible().catch(() => true)
      if (!visible) passField = null
    }
    if (!userField) {
      const said = await readLoginFailureText(page)
      return { ok: false, reason: 'no_login_form', url: urlNow(), said, text: said ? null : await readVisibleTextSnippet(page) }
    }
    // USERNAME-FIRST identity providers (Microsoft, Okta, Google) show the
    // password only after the username is submitted. Type it, advance, then
    // wait for the password box to appear.
    if (!passField) {
      await userField.fill(String(username), { timeout: 5000 }).catch(() => {})
      let advanced = false
      for (const sel of ['#idSIButton9', 'input[type="submit"]:not([disabled])', 'button[type="submit"]:not([disabled])', 'button:has-text("Next")', 'button:has-text("Continue")']) {
        const b = await page.$(sel).catch(() => null)
        if (b) { await b.click({ timeout: 5000 }).catch(() => {}); advanced = true; break }
      }
      if (!advanced) await userField.press('Enter').catch(() => {})
      try {
        if (typeof page.waitForSelector === 'function') {
          passField = await page.waitForSelector('input[type="password"]:not([disabled])', { timeout: 10000, state: 'visible' }).catch(() => null)
        }
      } catch { passField = null }
      if (!passField) {
        // Poll for a VISIBLE box: the username step's hidden input can satisfy
        // a selector wait without ever being shown.
        const t0 = Date.now()
        while (!passField && Date.now() - t0 < 10000) {
          passField = await visiblePasswordField(page)
          if (passField) break
          if (await readLoginFailureText(page)) break
          if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(400).catch(() => {})
          else await new Promise((r) => setTimeout(r, 400))
        }
      }
      if (!passField) passField = await page.$('input[type="password"]:not([disabled])').catch(() => null)
      if (passField && typeof passField.isVisible === 'function' && !(await passField.isVisible().catch(() => true))) passField = null
      if (!passField) {
        const said = await readLoginFailureText(page)
        return { ok: false, reason: 'username_not_accepted', url: urlNow(), said, text: said ? null : await readVisibleTextSnippet(page) }
      }
    } else {
      await userField.fill(String(username), { timeout: 5000 }).catch(() => {})
    }
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
    const settled = await waitForSignInSettle(page, { startUrl: (() => { try { return page.url() } catch { return null } })() })
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
    // Microsoft's "Stay signed in?" interstitial: answer Yes so the SAML hop
    // completes and the session cookie persists for the run.
    const kmsi = await page.$('#idSIButton9, input[type="submit"][value="Yes"], button:has-text("Yes")').catch(() => null)
    if (kmsi) {
      const { bodyText } = await readBotWallSignals(page)
      if (/stay signed in|keep me signed in|remember me/i.test(bodyText)) {
        await kmsi.click({ timeout: 5000 }).catch(() => {})
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
      }
    }
    const stillPassword = await visiblePasswordField(page)
    if (stillPassword) {
      const said = await readLoginFailureText(page)
      return { ok: false, reason: 'password_rejected', url: urlNow(), said, text: said ? null : await readVisibleTextSnippet(page), settled }
    }
    // Still on a sign-in surface (a username-first IdP bounced back to its
    // first step, a rejected password re-rendering the form) is NOT a login.
    // A multi-factor prompt is: the credential was accepted, and the loop's
    // next gate read routes the prompt through the 2FA path.
    const afterGate = await detectGate(page).catch(() => null)
    if (afterGate?.kind === 'login') {
      const said = await readLoginFailureText(page)
      return { ok: false, reason: 'still_login_surface', url: urlNow(), said, text: said ? null : await readVisibleTextSnippet(page) }
    }
    return { ok: true, reason: null, url: urlNow(), said: null, settled }
  } catch (err) {
    return { ok: false, reason: 'exception', url: urlNow(), said: String(err?.message || err).split('\n')[0].slice(0, 160) }
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

// SSO / identity-provider hosts and paths. A school portal's sign-in is usually
// a SAML hop into a shared IdP (nextgensso.com → login.microsoftonline.com for
// MTSU's PipelineMT), and those pages ask for the USERNAME FIRST with no
// password field on the page — so the password-only login heuristic below read
// them as "no application form". Vendor-agnostic on purpose: a new IdP still
// classifies as a login gate instead of dead-ending. Exported via _internal.
export const SSO_IDP_HOST_RX = /(?:^|\.)(?:login\.microsoftonline\.com|login\.microsoft\.com|login\.live\.com|accounts\.google\.com|okta\.com|oktapreview\.com|nextgensso\.com|pingone\.com|pingidentity\.com|auth0\.com|onelogin\.com|duosecurity\.com)$|^(?:sso|login|signin|idp|cas|shibboleth|auth|adfs|fs)\./i
export const SSO_ENTRY_PATH_RX = /startsso|\/saml2?\b|\/sso\b|\/oauth2\/authorize|\/adfs\/ls|\/login\b|\/signin\b|\/sign-in\b|\/cas\b|shibboleth|\/idp\//i
// Anchor TEXT that names a sign-in entry on a landing page ("Students",
// "Student Login", "Sign in", "Applicant Portal"). Staff/admin/reviewer
// entries are refused explicitly — NGWeb's landing carries a second SSO link
// for the ADMIN portal beside the student one.
const SSO_ENTRY_TEXT_RX = /^(?:students?(?:\s+(?:portal|sign[\s-]?in|log[\s-]?in|login|access|enter))?|applicants?(?:\s+(?:portal|sign[\s-]?in|log[\s-]?in|login))?|sign[\s-]?in|log[\s-]?in|login|my\s+account|access\s+(?:your|the|my)\s+(?:account|portal|application)|student\s+portal|applicant\s+portal|current\s+students?)$/i
const SSO_ENTRY_REFUSE_RX = /admin|staff|faculty|employee|reviewer|committee|donor|alumni|parent|counselor|advisor|recommender|register|create\s+(?:an?\s+)?account|sign\s*up|forgot/i
// Username-first inputs an IdP page shows before any password.
const IDP_USERNAME_SELECTOR = 'input[type="email"]:not([disabled]), input[name="loginfmt"], input[autocomplete="username"]:not([disabled]), input[name*="user" i]:not([disabled]):not([type="hidden"]), input[id*="user" i]:not([disabled]):not([type="hidden"]), input[name="identifier"]'

function hostOfUrl(url) {
  try { return new URL(String(url)).hostname.toLowerCase() } catch { return '' }
}

/** Is this page an identity-provider sign-in surface (username-first, no password yet)? */
async function detectIdpLoginSurface(page, url) {
  const host = hostOfUrl(url)
  let path = ''
  try { path = new URL(String(url)).pathname + new URL(String(url)).search } catch { path = '' }
  const onIdp = SSO_IDP_HOST_RX.test(host) || SSO_ENTRY_PATH_RX.test(path)
  if (!onIdp) return false
  const userField = await page.$(IDP_USERNAME_SELECTOR).catch(() => null)
  return Boolean(userField)
}

/** Sign-in entry links on a landing page, best first. Exported via _internal. */
async function detectSsoEntryLinks(page) {
  try {
    const links = await page.$$eval('a[href], button[onclick], a[role="button"]', (els, { textRx, refuseRx, pathRx, hostRx }) => {
      const T = new RegExp(textRx.source, textRx.flags)
      const R = new RegExp(refuseRx.source, refuseRx.flags)
      const P = new RegExp(pathRx.source, pathRx.flags)
      const H = new RegExp(hostRx.source, hostRx.flags)
      const out = []
      const seen = new Set()
      for (const el of els) {
        const href = el.href || el.getAttribute('href') || ''
        if (!/^https?:/i.test(href)) continue
        const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ')
        const id = `${el.id || ''} ${el.className || ''}`
        if (R.test(text) || R.test(href) || R.test(id)) continue
        let host = ''
        let path = ''
        try { const u = new URL(href); host = u.hostname.toLowerCase(); path = u.pathname + u.search } catch { continue }
        const textHit = T.test(text)
        const hrefHit = P.test(path) || H.test(host)
        if (!textHit && !hrefHit) continue
        const key = href.split('#')[0]
        if (seen.has(key)) continue
        seen.add(key)
        const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 1, height: 1 }
        const hidden = !(r.width > 0 && r.height > 0)
        out.push({ href, text: text.slice(0, 80), hidden, score: (hrefHit ? 2 : 0) + (textHit ? 2 : 0) + (/student/i.test(text) ? 1 : 0) + (hidden ? 0 : 1) })
      }
      return out.sort((a, b) => b.score - a.score).slice(0, 6)
    }, {
      textRx: { source: SSO_ENTRY_TEXT_RX.source, flags: SSO_ENTRY_TEXT_RX.flags },
      refuseRx: { source: SSO_ENTRY_REFUSE_RX.source, flags: SSO_ENTRY_REFUSE_RX.flags },
      pathRx: { source: SSO_ENTRY_PATH_RX.source, flags: SSO_ENTRY_PATH_RX.flags },
      hostRx: { source: SSO_IDP_HOST_RX.source, flags: SSO_IDP_HOST_RX.flags },
    })
    return Array.isArray(links) ? links : []
  } catch {
    return []
  }
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
  let hasPassword = await page.$('input[type="password"]:not([disabled])').catch(() => null)
  // A password input that is in the DOM but not SHOWN is not a wall: Microsoft
  // keeps its hidden inputs across steps, so the MFA / "Stay signed in?" pages
  // after a successful password otherwise read as "login required" again.
  if (hasPassword && typeof hasPassword.isVisible === 'function') {
    const visible = await hasPassword.isVisible().catch(() => true)
    if (!visible) hasPassword = null
  }
  if (hasPassword) {
    const onLoginUrl = /\/(login|signin|sso|cas|shibboleth)/i.test(url)
    // A password box is not always a login WALL. A credit union's homepage
    // carries an online-banking sign-in widget beside the scholarship
    // announcement (www.tvfcu.com, prod 2026-08-31: five "retried this login"
    // hand-offs on a page nobody needs to log in to). When the password lives
    // in a small side widget on an otherwise content-rich page, it is
    // incidental — Hamilton reads past it and works the page as usual.
    if (!onLoginUrl && await isIncidentalLoginWidget(page)) {
      // fall through to the remaining checks
    } else {
      return { kind: 'login', detail: onLoginUrl ? `Login required at ${url}` : 'Password input visible — login required' }
    }
  }
  // 2FA / OTP heuristics. Microsoft's code box is `name="otc"`; a push /
  // number-matching prompt has NO input at all and is read from its text.
  const hasOtp = await page.$('input[autocomplete*="one-time-code"], input[name*="otp"], input[name*="2fa"], input[name="otc"], #idTxtBx_SAOTCC_OTC, input[name*="verificationcode" i], input[name*="passcode" i]').catch(() => null)
  if (hasOtp) return { kind: '2fa', detail: 'One-time code input visible' }
  if (SSO_IDP_HOST_RX.test(hostOfUrl(url))) {
    const { bodyText } = await readBotWallSignals(page)
    if (MFA_PROMPT_TEXT_RX.test(bodyText)) {
      return { kind: '2fa', detail: `Multi-factor verification requested at ${url}` }
    }
  }
  // An identity-provider sign-in page asks for the USERNAME first and shows no
  // password until the next step — still a login wall, not "no form".
  if (!hasPassword && await detectIdpLoginSurface(page, url)) {
    return { kind: 'login', detail: `Sign-in required at ${url}`, idp: true }
  }
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
  if (hasCaptcha) {
    // An INVISIBLE reCAPTCHA (v3 score badge, or v2-invisible bound to the
    // submit button) challenges nobody at page-open: the token is minted when
    // the form is submitted. Treating the badge as a wall parked real pages
    // behind "Hamilton hit a CAPTCHA" (Gravity Forms v3 on mtsu.edu /
    // alsacramento.org, prod 2026-08-31) and sent the solver a V2 task for a
    // V3 key (ERROR_INVALID_TASK_DATA). Report the SHAPE so the run loop can
    // defer solving to the submit boundary instead of stopping here.
    const shape = await readCaptchaShape(page)
    return {
      kind: 'captcha',
      detail: shape.invisible ? 'Invisible reCAPTCHA present (solved at submit time)' : 'CAPTCHA / human-verification challenge present',
      invisible: shape.invisible,
      visible_widget: shape.visibleWidget,
    }
  }
  // Payment.
  const payment = await detectPaymentGate(page, url)
  if (payment) return payment
  return null
}

/**
 * Is the page's password input an incidental widget (online-banking box,
 * member-login sidebar) rather than the login wall of THIS page? True only
 * when the password sits in a SMALL form (<= 3 fillable inputs) and the page
 * is clearly something else: it carries other visible inputs outside that
 * form, or it is a long content page. A page that is nothing but a login form
 * (few inputs, short text) is still a login gate. Exported via _internal.
 */
async function isIncidentalLoginWidget(page) {
  if (!page || typeof page.evaluate !== 'function') return false
  try {
    const res = await page.evaluate(() => {
      function visible(el) {
        if (!el) return false
        const r = el.getBoundingClientRect()
        const cs = window.getComputedStyle(el)
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'
      }
      const pass = Array.from(document.querySelectorAll('input[type="password"]:not([disabled])')).find(visible)
      if (!pass) return { incidental: true, reason: 'no_visible_password' }
      const form = pass.closest('form')
      const fillable = (root) => Array.from(root.querySelectorAll('input, textarea, select')).filter((el) => {
        const t = (el.getAttribute('type') || '').toLowerCase()
        if (el.tagName.toLowerCase() === 'input' && ['hidden', 'submit', 'button', 'image', 'checkbox', 'radio'].includes(t)) return false
        return visible(el)
      })
      const formInputs = form ? fillable(form) : [pass]
      const allInputs = fillable(document)
      const outside = allInputs.filter((el) => !form || !form.contains(el))
      const bodyLen = (document.body?.innerText || '').trim().length
      const title = `${document.title || ''} ${document.querySelector('h1')?.textContent || ''}`
      const titleIsLogin = /\b(log ?in|sign ?in|member(s)? area|account access|authenticate)\b/i.test(title)
      const smallForm = formInputs.length <= 3
      const formText = form ? (form.innerText || '').slice(0, 600) : ''
      const widgetish = /\b(online banking|internet banking|member login|account login|customer login|login to (your )?account|sign in to (your )?account|mobile banking|e-?banking|user id)\b/i.test(formText)
      const incidental = smallForm && !titleIsLogin && (outside.length >= 1 || bodyLen > 3000 || widgetish)
      return { incidental, formInputs: formInputs.length, outside: outside.length, bodyLen, titleIsLogin, widgetish }
    })
    return Boolean(res?.incidental)
  } catch {
    return false
  }
}

/**
 * Shape of the CAPTCHA on the page: is a VISIBLE challenge widget rendered
 * (checkbox reCAPTCHA / hCaptcha / Turnstile box), or only an invisible
 * reCAPTCHA (v3 badge, `render=` script, `size=invisible` anchor, v2 with
 * data-size="invisible")? Exported via _internal.
 */
async function readCaptchaShape(page) {
  if (!page || typeof page.evaluate !== 'function') return { invisible: false, visibleWidget: true }
  try {
    const res = await page.evaluate(() => {
      function visible(el) {
        if (!el) return false
        const r = el.getBoundingClientRect()
        const cs = window.getComputedStyle(el)
        return r.width > 20 && r.height > 20 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'
      }
      const frames = Array.from(document.querySelectorAll('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], iframe[src*="challenges.cloudflare.com"], iframe[src*="arkoselabs"], iframe[src*="funcaptcha"], iframe[src*="captcha" i]'))
      const widgetBoxes = Array.from(document.querySelectorAll('div.g-recaptcha, div.h-captcha, div.cf-turnstile, [data-sitekey]'))
      const v3Script = Array.from(document.querySelectorAll('script[src*="recaptcha"]')).some((sc) => /[?&]render=[\w-]{20,}/.test(sc.getAttribute('src') || ''))
      const badge = document.querySelector('.grecaptcha-badge')
      const invisibleAnchor = frames.some((f) => /size=invisible/.test(f.getAttribute('src') || ''))
      const invisibleBox = widgetBoxes.some((b) => (b.getAttribute('data-size') || '').toLowerCase() === 'invisible')
      const visibleWidget = frames.some((f) => !/size=invisible/.test(f.getAttribute('src') || '') && visible(f))
        || widgetBoxes.some((b) => (b.getAttribute('data-size') || '').toLowerCase() !== 'invisible' && visible(b) && !(b.closest && b.closest('.grecaptcha-badge')))
      const invisible = !visibleWidget && (v3Script || Boolean(badge) || invisibleAnchor || invisibleBox)
      return { invisible, visibleWidget }
    })
    return { invisible: Boolean(res?.invisible), visibleWidget: Boolean(res?.visibleWidget) }
  } catch {
    return { invisible: false, visibleWidget: true }
  }
}

/**
 * Payment gate — only when the page is actually asking THIS applicant to pay:
 * a card-number input, or a hosted payment frame on a page that talks about a
 * fee/checkout. A bare Stripe iframe (a "Donate" widget on a scholarship
 * listing — bold.org, prod 2026-08-31) is not a payment step in the
 * application. The detail names the URL and the amount when it is visible, so
 * the stop is actionable instead of a bare "Payment widget visible".
 */
async function detectPaymentGate(page, url = '') {
  const cardInput = await page.$('input[autocomplete="cc-number"]:not([disabled]), input[name*="card_number" i]:not([disabled]), input[name*="cardnumber" i]:not([disabled]), input[id*="card-number" i]:not([disabled]), input[id*="cardnumber" i]:not([disabled])').catch(() => null)
  const hostedFrame = cardInput ? null : await page.$('iframe[src*="stripe.com"], iframe[src*="braintree"], iframe[src*="paypal.com/smart"], iframe[src*="checkout.square"]').catch(() => null)
  if (!cardInput && !hostedFrame) return null
  let text = ''
  try { text = String(await page.$eval('body', (el) => (el && (el.innerText || el.textContent)) || '')) } catch { text = '' }
  const feeRx = /\b(application fee|processing fee|registration fee|entry fee|nonrefundable fee|non-refundable fee|pay(?:ment)? (?:of|due|required|now)|checkout|order total|amount due|total due|billing (?:details|information))\b/i
  const feeMention = feeRx.test(text)
  if (!cardInput && !feeMention) return null
  let amount = null
  const feeIdx = text.search(feeRx)
  const window = feeIdx >= 0 ? text.slice(Math.max(0, feeIdx - 160), feeIdx + 240) : text
  const m = window.match(/\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/)
  if (m) amount = `$${m[1]}`
  const where = url ? ` at ${url}` : ''
  return {
    kind: 'payment',
    detail: amount
      ? `Payment step${where}: the portal asks for a payment of ${amount} (${cardInput ? 'card number field' : 'hosted checkout'} shown). Hamilton never pays; open the link, complete the payment, and Hamilton will continue on the next run.`
      : `Payment step${where}: the portal shows a ${cardInput ? 'card number field' : 'hosted checkout'} and mentions a fee. Hamilton never pays; open the link, complete the payment, and Hamilton will continue on the next run.`,
    amount,
  }
}

// Playwright throws these when the page navigates (or a frame detaches)
// between our query and its evaluation — a race, not a portal fact. Prod
// 2026-08-31: "page.$$eval: Execution context was destroyed, most likely
// because of a navigation" failed a whole task on hud.gov. Wait for the new
// document and ask again, twice at most.
const CONTEXT_LOSS_RX = /Execution context was destroyed|Cannot find context with specified id|Frame was detached|Target closed|Target page, context or browser has been closed|Navigation interrupted|frame got detached/i
async function retryOnContextLoss(page, fn, { attempts = 3, settleMs = 600 } = {}) {
  let lastErr = null
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!CONTEXT_LOSS_RX.test(String(err?.message || err))) throw err
      let closed = false
      try { closed = typeof page?.isClosed === 'function' ? page.isClosed() : false } catch { closed = false }
      if (closed) throw err
      await page.waitForLoadState?.('domcontentloaded', { timeout: NAV_TIMEOUT_MS }).catch(() => null)
      await new Promise((r) => setTimeout(r, settleMs))
    }
  }
  throw lastErr
}

// A navigation target that is a FILE (PDF/DOC application form) makes
// Chromium start a download instead of rendering a page; Playwright reports
// it as "page.goto: Download is starting". That is not an engine failure —
// it is a document pathway, and the orchestrator handles it as one.
const DOWNLOAD_STARTING_RX = /Download is starting/i
const DOCUMENT_URL_RX = /\.(pdf|docx?|xlsx?|rtf|odt)(\?|#|$)/i
class DocumentDownloadTarget extends Error {
  constructor(url) { super(`document_download:${url}`); this.code = 'document_download'; this.documentUrl = url }
}

/**
 * Open the portal with one honest recovery: a slow site that misses the
 * domcontentloaded deadline gets a second, longer attempt that only waits for
 * the response to COMMIT (jjpaf.org took >25s in prod 2026-08-31 and was
 * recorded as "could not reach"). A file target raises DocumentDownloadTarget.
 * Connection resets / DNS failures still surface as-is (portal_unreachable).
 */
async function navigateWithRecovery(page, url, { navTimeoutMs = NAV_TIMEOUT_MS, trace = null } = {}) {
  if (DOCUMENT_URL_RX.test(String(url || ''))) throw new DocumentDownloadTarget(url)
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs })
    return { attempts: 1 }
  } catch (err) {
    const msg = String(err?.message || err)
    if (DOWNLOAD_STARTING_RX.test(msg)) throw new DocumentDownloadTarget(url)
    if (!/Timeout \d+ms exceeded/i.test(msg)) throw err
    trace?.push({ step: 'navigate_retry', detail: { reason: 'timeout', wait_until: 'commit', timeout_ms: navTimeoutMs * 2 } })
    try {
      await page.goto(url, { waitUntil: 'commit', timeout: navTimeoutMs * 2 })
    } catch (err2) {
      if (DOWNLOAD_STARTING_RX.test(String(err2?.message || err2))) throw new DocumentDownloadTarget(url)
      throw err2
    }
    await page.waitForLoadState('domcontentloaded', { timeout: navTimeoutMs }).catch(() => null)
    return { attempts: 2 }
  }
}

/**
 * Landing pages link to the real application with an ANCHOR, not a button —
 * "Apply", "Application", "Apply Now" in the nav or body — and often to a
 * different host (the funder's portal vendor). detectButtons only sees
 * button-like controls, so these pages dead-ended as no_application_form
 * (thegatesscholarship.org, tnachieves.org/tn-promise, prod 2026-08-31).
 * Returns visible http(s) links whose text or href looks like an apply link,
 * most specific first. Exported via _internal.
 */
async function detectApplyLinks(page) {
  try {
    const links = await page.$$eval('a[href]', (els, { rxList }) => {
      const out = []
      const seen = new Set()
      for (const el of els) {
        const href = el.href || ''
        if (!/^https?:/i.test(href)) continue
        const r = el.getBoundingClientRect()
        // Collapsed navigation (hamburger menus, mega-menus) hides the very
        // "Apply" link a landing page routes through — thegatesscholarship.org
        // and tnachieves.org/tn-promise both showed zero visible apply anchors
        // in a headless viewport (live, 2026-08-31). A hidden anchor is still a
        // real destination; it simply ranks below a visible one.
        const hidden = !(r.width > 0 && r.height > 0)
        const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ')
        const textHit = rxList.some((r2) => new RegExp(r2.source, r2.flags).test(text))
        // "Learn More & Apply" (tnachieves.org/tn-promise → collegefortn.org/tnpromise,
        // live 2026-08-31): the word is there, the phrase patterns are not.
        const weakTextHit = !textHit && /\bapply\b/i.test(text) && text.length <= 60
        const hrefHit = /\/(apply|application|applications|apply-now|applynow|start-application|scholarship-application|grant-application)(\/|\?|#|$|\.)/i.test(href)
          || /[?&](page|view|action)=apply/i.test(href)
        if (!textHit && !weakTextHit && !hrefHit) continue
        if (/\b(how to apply|apply(ing)? for (financial )?aid|before you apply|applied|application (status|deadline|process|tips|timeline|requirements|faq|guide))\b/i.test(text) && !hrefHit) continue
        const key = href.split('#')[0]
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ href, text: text.slice(0, 80), hidden, score: (textHit ? 2 : 0) + (weakTextHit ? 1 : 0) + (hrefHit ? 1 : 0) + (hidden ? 0 : 1) })
      }
      return out.sort((a, b) => b.score - a.score).slice(0, 8)
    }, { rxList: APPLY_NAV_PATTERNS.map((p) => ({ source: p.source, flags: p.flags })) })
    return Array.isArray(links) ? links : []
  } catch {
    return []
  }
}

// Field keys a mailing-list / contact form asks for. A form whose filled keys
// all fall in here, with no application-shaped field anywhere in it, is a
// CONTACT form regardless of what its button says.
const CONTACT_FORM_KEYS = new Set([
  'first_name', 'last_name', 'full_name', 'name', 'email', 'phone', 'zip', 'zip_code', 'postal_code',
  'city', 'state', 'country', 'school', 'organization', 'org_name', 'organization_name', 'message', 'comments',
])
const APPLICATION_FIELD_SIGNAL_RX = /\b(essay|personal statement|statement of|gpa|grade point|graduat|date of birth|birth ?date|\bdob\b|major|degree|income|household|award|scholarship|applicant|upload|resume|résumé|transcript|reference|recommend|amount requested|budget|project (title|description|summary)|financial need|ssn|social security|student id|enrollment|semester|term|academic|citizenship|ethnicity|gender|veteran|disability|employer|occupation|address line|street)\b/i
/**
 * Is the form Hamilton is about to submit a contact / newsletter form rather
 * than an application? Pure. Exported via _internal.
 */
const APPLICATION_CONTEXT_RX = /\b(appl(?:y|ication|icant)|scholarship|fellowship|grant|award|nominat|enrol|registration|request (?:for )?(?:funding|assistance|aid))/i
const CONTACT_BUTTON_RX = /^(submit|subscribe|sign ?up|send|go|search|join|get updates|stay informed|keep me (?:posted|informed))$/i
function isContactOrNewsletterForm({ submitButton = null, fields = [], filled = [], pageTitle = '' } = {}) {
  const formFieldCount = Number(submitButton?.formFieldCount) || 0
  const list = Array.isArray(fields) ? fields : []
  const labels = list.map((f) => `${f?.label || ''} ${f?.name || ''} ${f?.id || ''} ${f?.placeholder || ''}`).join(' | ')
  const hasApplicationSignal = APPLICATION_FIELD_SIGNAL_RX.test(labels)
  // The page or the button SAYS this is an application → it is one. A
  // three-field "Submit application" form on a page titled "Application" is a
  // real (short) application, never a newsletter.
  if (APPLICATION_CONTEXT_RX.test(String(submitButton?.text || ''))) return false
  if (APPLICATION_CONTEXT_RX.test(String(pageTitle || ''))) return false
  if (hasApplicationSignal) return false
  // Structural evidence on the form itself (newsletter / contact-us / search
  // ids, classes, actions, or copy) is sufficient.
  if (submitButton?.isContactForm === true) return true
  // Otherwise only the narrowest shape: a tiny form (<= 3 fields, no long-form
  // or choice fields) whose filled keys are all contact identity and whose
  // button is a bare Submit/Subscribe/Send.
  const filledKeys = (Array.isArray(filled) ? filled : []).map((f) => String(f?.key || '').toLowerCase())
  const onlyContactKeys = filledKeys.length > 0 && filledKeys.every((k) => CONTACT_FORM_KEYS.has(k))
  const hasLongOrChoice = list.some((f) => f?.tag === 'textarea' || f?.tag === 'select' || f?.type === 'file' || f?.type === 'radio')
  const bareButton = CONTACT_BUTTON_RX.test(String(submitButton?.text || '').trim())
  if (onlyContactKeys && !hasLongOrChoice && bareButton && formFieldCount > 0 && formFieldCount <= 3) return true
  return false
}

export function computeAgeYears(dobStr, now = new Date()) {
  if (!dobStr) return null
  const dob = new Date(dobStr)
  if (Number.isNaN(dob.getTime())) return null
  let age = now.getFullYear() - dob.getFullYear()
  const m = now.getMonth() - dob.getMonth()
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age -= 1
  return age >= 0 && age < 130 ? age : null
}

// Verdict for a REQUIRED eligibility checkbox that affirms an AGE fact about the
// applicant (owner 2026-08-22, live-diagnosed on the U.S. Bank form: "I am 18
// years old or older" vs "I am 17 years old…"). Returns true = tick (provably
// satisfied by the applicant's real age), false = leave unticked (provably NOT),
// null = not an age affirmation / ambiguous (leave to the attestation logic or
// the human). Never fabricates — the age comes from the vault/profile DOB.
export function ageAffirmationVerdict(text, ageYears) {
  if (ageYears === null) return null
  const t = String(text || '').toLowerCase()
  let m = t.match(/\b(\d{1,2})\s*(?:\+|years?\s*(?:old|of age)?\s*(?:or\s*(?:older|above|more)|and\s*(?:older|above)))/)
       || t.match(/\bat\s*least\s*(\d{1,2})\b/)
       || t.match(/\b(\d{1,2})\s*(?:years?)?\s*or\s*older\b/)
  if (m) return ageYears >= Number(m[1])
  if (/\b(?:age of majority|legal age)\b/.test(t)) return ageYears >= 18
  m = t.match(/\bunder\s*(?:the\s*age\s*of\s*)?(\d{1,2})\b/) || t.match(/\byounger\s*than\s*(\d{1,2})\b/)
  if (m) return ageYears < Number(m[1])
  m = t.match(/\bi\s*am\s*(\d{1,2})\s*years?\s*old\b/)
  if (m) return ageYears === Number(m[1])
  return null
}

/**
 * Facts an eligibility checkbox can be checked against, each read from what
 * the profile DECLARES (never inferred from prose). A fact the profile does
 * not state is `null`, and a null fact can never affirm anything.
 */
export function deriveEligibilityFacts(profile, valuesByKey = {}) {
  const applicantType = String(pick(profile, ['applicant_type', 'primary_type']) || '').toLowerCase()
  const degreeLevel = String(valuesByKey.degree_level || '').toLowerCase()
  const school = String(valuesByKey.school || '').trim()
  const isGraduate = /(?<!under)\b(graduate|master|mba|ph\.?d|doctoral|doctorate|law school|\bjd\b|\bmd\b)\b/i.test(degreeLevel)
    || /graduate_student|postdoc/.test(applicantType)
  const isUndergrad = /\b(bachelor|associate|undergrad|freshman|sophomore|junior|senior|trade|vocational|certificate|community college)\b/i.test(degreeLevel)
    || /college_student|high_school_student/.test(applicantType)
  const isStudent = Boolean(school) || Boolean(degreeLevel) || /student/.test(applicantType)
  const stateCode = String(valuesByKey.state || '').toUpperCase()
  const declaredCountry = String(pick(profile, ['basic_information.country']) || '').toLowerCase()
  const usBased = (US_STATE_CODES.includes(stateCode) || US_TERRITORY_CODES.includes(stateCode))
    || /^(us|usa|u\.s\.a?\.?|united states( of america)?)$/.test(declaredCountry)
    || (declaredCountry === '' && /^\d{5}(-\d{4})?$/.test(String(valuesByKey.zip || '')) ? true : null)
  const immigration = String(pick(profile, [
    'demographics.immigrant_status', 'demographics.immigration_status',
    'basic_information.immigrant_status', 'basic_information.immigration_status',
  ]) || '').toLowerCase()
  const citizen = immigration === 'us_citizen' ? true : (immigration && immigration !== 'unknown' ? false : null)
  const resident = immigration === 'permanent_resident' ? true : (citizen === true ? true : (immigration && immigration !== 'unknown' ? false : null))
  return {
    isStudent,
    isUndergrad: isStudent ? (isGraduate ? false : (isUndergrad || null)) : null,
    isGraduate: isStudent ? isGraduate : null,
    usBased: usBased === true ? true : (usBased === false ? false : null),
    citizen,
    resident,
    known: isStudent || usBased === true || citizen !== null,
  }
}

/**
 * Verdict for an ELIGIBILITY checkbox: true only when the profile's declared
 * facts PROVE the statement; false when they contradict it; null when they
 * say nothing — and a null on a required box becomes a named ask, never a
 * tick. (U.S. Bank 2026-08-22: "I am a college-bound student, accepted or
 * enrolled at an undergraduate, trade or vocational school…", "I am not a
 * graduate student, an international student, or a student attending a
 * college outside the U.S." — both provable for an enrolled MTSU undergrad.)
 */
export function eligibilityAffirmationVerdict(text, facts) {
  if (!facts) return null
  const t = String(text || '').toLowerCase()
  if (!t) return null
  const enrolledUndergrad = /(college-?\s?bound|accepted or enrolled|currently enrolled|enrolled (as|at|in)\b|undergraduate student|trade or vocational|full-?time student|student enrolled)/.test(t)
  const notGraduateOrIntl = /(not a graduate student|not an? (international|foreign) student|outside (of )?the u\.?s|not .*international student)/.test(t)
  const citizenship = /(u\.?s\.? citizen|united states citizen|citizen of the united states)/.test(t)
  const residency = /(legal (u\.?s\.? )?resident|permanent resident|lawful permanent resident|legal resident of the united states)/.test(t)
  if (notGraduateOrIntl) {
    if (facts.isGraduate === true) return false
    if (facts.isStudent && facts.isGraduate === false && facts.usBased === true) return true
    return null
  }
  if (enrolledUndergrad) {
    if (/undergraduate|trade or vocational|college-?\s?bound/.test(t) && facts.isGraduate === true) return false
    if (facts.isStudent && (facts.isUndergrad === true || facts.isGraduate === false)) return true
    return null
  }
  if (citizenship && residency) {
    if (facts.citizen === true || facts.resident === true) return true
    if (facts.citizen === false && facts.resident === false) return false
    return null
  }
  if (citizenship) {
    if (facts.citizen === true) return true
    if (facts.citizen === false) return false
    return null
  }
  if (residency) {
    if (facts.resident === true) return true
    if (facts.resident === false) return false
    return null
  }
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

// Page chrome that is NOT part of the application: a "Was this page helpful?"
// survey, a "Report suspected fraud" widget, a newsletter/cookie box. On many
// government portals these live in the SAME <form> as the real submit control,
// so a required Yes/No feedback radio fails checkValidity() and — before this —
// hard-blocked the actual application ("Was this page helpful? field is
// required" killed a real TANF submission, a real applicant's run 2026-08-21). Mirrors
// the isPageFeedback filter that already keeps such widgets from being treated
// as the application's SUBMIT button.
const FEEDBACK_VALIDATION_IGNORE_RX = /was this (page |content )?helpful|page helpful|how helpful|rate (this )?(page|content)|site feedback|leave feedback|feedback about this|report (suspected )?(fraud|abuse)|newsletter|subscribe|cookie/i

async function detectValidationErrors(page) {
  const raw = await page.$$eval('[role="alert"], .error, .invalid-feedback, .field-error, [aria-invalid="true"]', (els) => {
    const out = []
    for (const el of els) {
      const text = (el.innerText || '').trim()
      if (text && text.length < 400) out.push(text)
    }
    return out
  }).catch(() => [])
  // The same page-chrome rule the submit path applies: a "Was this page
  // helpful?" survey or a "Report fraud" widget is not a validation error of
  // the application. It blocked the acf.gov TANF run after a Next click
  // (prod 2026-08-22) because only the submit path filtered it.
  return raw.filter((text) => !FEEDBACK_VALIDATION_IGNORE_RX.test(text))
}


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
  // A DOM SLUG IS NOT A REFERENCE. The single-lowercase-word guard above did
  // not catch several words joined by hyphens, and the `explicit` path
  // deliberately does not require a digit (a digitless ALL-CAPS id is real).
  // Prod 2026-08-24: across 3,292 runs the ONLY confirmation_reference values
  // in the database were three copies of the scraped element id
  // "children-notification-children-notification" — recorded on one run marked
  // 'submitted' and on TWO marked 'failed', which is itself proof it describes
  // no submission outcome. A confirmation reference on a submitted run is
  // accepted as durable proof, so one bogus value is the difference between
  // "never confirmed" and a surface claiming a submission. A FALSE proof is
  // worse than no proof. ALL-CAPS / mixed-case / digit-bearing ids still pass.
  if (/^[a-z]+(?:-[a-z]+)+$/.test(candidate)) return false
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
  // Live top-level document revalidation (ported from #1520). Called with the
  // page's CURRENT url right before applicant data is disclosed — before the
  // first field fill on a page, before a document upload, and before the
  // submit click. Signature: (liveUrl, { stage }) => Promise<{ allow, reason? }>.
  // The orchestrator answers from the portal policy registry for the LIVE host
  // (a redirect into a host whose terms forbid agent automation must not
  // receive a fill). Absent = only the SSRF floor is re-checked on the live
  // document. CDN subresources are never consulted here — they are governed by
  // the egress guard alone.
  validatePortalUrl = null,
  // MBA-level long-form answers drafted by hamiltonFullProposalGenerator
  // (buildPortalNarrativeAnswers). Only the narrative keys below may be
  // overridden — short factual fields (name, address, …) always come from
  // the profile verbatim. Falls back to the profile's raw essays when absent.
  narrativeAnswers = null,
  // Lazy counterpart of narrativeAnswers: `async () => ({ essay?, goals? })`,
  // called at most once and ONLY when the engine is about to fill a long-form
  // (essay/goals) field. Lets the orchestrator defer the paid proposal draft
  // until a page proves it has somewhere to put it.
  narrativeProvider = null,
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
  let blindNextClicks = 0
  const filled = []
  let loggedIn = false
  let loginAttempted = false
  let twoFactorAttempted = false
  if (signal?.aborted) {
    return { status: 'cancelled', blocker_kind: 'cancelled', blocker_detail: 'Hamilton task was cancelled before browser launch.', filled_fields: filled, pages_visited: 0, trace }
  }

  // A plain-http saved link is upgraded to https for PUBLIC hosts before the
  // target check (the SSRF floor is unchanged — see normalizeBrowserTargetUrl).
  const originalUrl = url
  url = normalizeBrowserTargetUrl(url)
  if (url !== originalUrl) trace.push({ step: 'url_upgraded_to_https', detail: { from: originalUrl, to: url } })
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

    try {
      ;({ browser } = await launchPortalBrowser(chromium, { headless, targetUrl: url }))
    } catch (launchErr) {
      // The launcher's DNS gate refused the target (a public-looking name that
      // resolves to private/loopback/metadata space, or a rebinding attempt).
      // Report it as the same unsafe-target refusal the URL-shape check gives,
      // never as a crashed run.
      if (launchErr?.code === 'unsafe_browser_target') {
        const refusal = controlledBetaBrowserRefusal()
        trace.push({ step: 'unsafe_target_dns', detail: { reason: launchErr.reason || null } })
        return {
          status: 'blocked',
          blocker_kind: refusal.code,
          blocker_detail: `${refusal.message} (${launchErr.reason || 'dns_rejected'})`,
          requires_human_handoff: true,
          filled_fields: filled,
          pages_visited: 0,
          trace,
        }
      }
      throw launchErr
    }
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
  // Live top-level document revalidation (ported from #1520): the page the
  // browser is ON right now, re-checked against the SSRF floor (URL shape +
  // DNS answers, so a redirect chain that lands on a public-looking alias for
  // private space is refused) and against the orchestrator's portal-policy
  // hook. Stages: before_fill / before_upload / before_submit. This is a
  // floor, not a same-origin pin: real portals legitimately hop to vendor
  // application hosts and SSO providers, and those stay allowed.
  const validateLiveDocument = async (stage) => {
    const liveUrl = (() => { try { return page?.url?.() || url } catch { return url } })()
    if (!isControlledBetaSyntheticBrowserUrl(liveUrl) && !_testPage) {
      const verdict = await resolvePublicBrowserTarget(liveUrl)
      if (isPrivateResolutionVerdict(verdict)) {
        return { allow: false, reason: verdict.reason, url: liveUrl, stage }
      }
    }
    if (typeof validatePortalUrl === 'function') {
      let policy = null
      try { policy = await validatePortalUrl(liveUrl, { stage }) } catch (err) {
        policy = { allow: false, reason: `portal_policy_error:${err?.message || err}` }
      }
      if (policy?.allow !== true) {
        return { allow: false, reason: policy?.reason || 'portal_policy_block', url: liveUrl, stage }
      }
    }
    return { allow: true, url: liveUrl, stage }
  }
  const valuesByKey = applyNarrativeAnswers(readProfileValues(profile), narrativeAnswers)
  let narrativeProviderResolved = !narrativeProvider
  const resolveNarrativeOnDemand = async () => {
    if (narrativeProviderResolved) return
    narrativeProviderResolved = true
    let answers = null
    try { answers = await narrativeProvider() } catch { answers = null }
    if (answers && typeof answers === 'object') {
      applyNarrativeAnswers(valuesByKey, answers)
      trace.push({ step: 'narrative_drafted_on_demand', detail: { keys: NARRATIVE_OVERRIDE_KEYS.filter((k) => answers[k]) } })
    }
  }
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
  // Set once the solver actually SOLVES a challenge this run. A solved
  // reCAPTCHA/Turnstile injects its token but leaves the widget DOM in place,
  // so detectGate re-fires on the next inspection — without this the run
  // dead-ended on a captcha it had already cleared (the fleet-wide 130-captcha
  // zero: solver ran, solved:true, then blocked anyway). Live-diagnosed on the
  // U.S. Bank form 2026-08-22.
  let captchaSolved = false
  // An INVISIBLE reCAPTCHA (v3 / v2-invisible) was seen: nothing to solve at
  // page-open; the boundary solve below mints the token when the form goes.
  let captchaInvisible = false
  // Landing-page → application-form navigation state (bounded, never re-clicks
  // the same control) — see APPLY_NAV_PATTERNS.
  let applyNavClicks = 0
  const clickedApplyNav = new Set()
  const enrolledApplicant = applicantProvablyEnrolled(profile)
  const skipAdmissions = (link) => {
    if (!enrolledApplicant || !isAdmissionsApplicationLink(link)) return false
    trace.push({ step: 'admissions_link_skipped', detail: { text: String(link.text || '').slice(0, 40), href: String(link.href || '').slice(0, 120), reason: 'applicant is already enrolled/committed; an admissions application is not a scholarship application' } })
    return true
  }
  // Follow an apply BUTTON ("Apply", "Start application") from a landing page
  // — bounded, never the same control twice. Returns true when it navigated.
  // thegatesscholarship.org's apply control is a BUTTON on a page with no
  // submit-looking control at all, so the no-form branch (which requires one)
  // never reached it and the run ended as no_progress (live, 2026-08-31).
  const tryFollowApplyButton = async () => {
    if (applyNavClicks >= MAX_APPLY_NAV_CLICKS) return false
    const applyNav = await detectButtons(page, APPLY_NAV_PATTERNS)
    const nextApply = applyNav.find(
      (b) => !clickedApplyNav.has(String(b.text || '').trim().toLowerCase()) && !skipAdmissions({ text: b.text, href: '' }),
    )
    if (!nextApply) return false
    applyNavClicks += 1
    clickedApplyNav.add(String(nextApply.text || '').trim().toLowerCase())
    trace.push({ step: 'follow_apply_link', detail: { text: String(nextApply.text || '').slice(0, 40) } })
    reportLiveStep(runId, 'Opening the application form')
    const followed = await clickButtonByBid(page, nextApply.bid)
    if (!followed) return false
    await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT_MS }).catch(() => null)
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => null)
    return true
  }
  // Follow an apply ANCHOR (not a button) from a landing page — bounded by the
  // same MAX_APPLY_NAV_CLICKS budget, never the same href twice, public-HTTPS
  // targets only. Returns true when the page navigated (caller re-inspects).
  const tryFollowApplyAnchor = async () => {
    if (applyNavClicks >= MAX_APPLY_NAV_CLICKS) return false
    const applyLinks = await detectApplyLinks(page)
    trace.push({ step: 'apply_link_scan', detail: { candidates: applyLinks.length, sample: applyLinks.slice(0, 3).map((l) => ({ text: String(l.text || '').slice(0, 30), href: String(l.href || '').slice(0, 100), hidden: Boolean(l.hidden) })) } })
    const currentPage = (() => { try { return page.url().split('#')[0] } catch { return '' } })()
    const nextLink = applyLinks.find((l) => {
      const target = normalizeBrowserTargetUrl(l.href)
      const key = `href:${target.split('#')[0]}`
      return target.split('#')[0] !== currentPage && !clickedApplyNav.has(key) && isHamiltonBrowserTargetAllowed(target) && !skipAdmissions({ text: l.text, href: target })
    })
    if (!nextLink) return false
    const target = normalizeBrowserTargetUrl(nextLink.href)
    applyNavClicks += 1
    clickedApplyNav.add(`href:${target.split('#')[0]}`)
    trace.push({ step: 'follow_apply_link', detail: { text: String(nextLink.text || '').slice(0, 40), href: target.slice(0, 200), via: 'anchor' } })
    reportLiveStep(runId, 'Opening the application form')
    try {
      await navigateWithRecovery(page, target, { navTimeoutMs: NAV_TIMEOUT_MS, trace })
      await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => null)
      return true
    } catch (err) {
      if (err instanceof DocumentDownloadTarget) throw err
      trace.push({ step: 'follow_apply_link_failed', detail: { href: target.slice(0, 200), error: String(err?.message || err).split('\n')[0].slice(0, 160) } })
      return false
    }
  }
  // SIGN-IN ENTRY ON A LANDING PAGE. A school scholarship portal's public
  // landing has NO form: its "Students" button starts the SSO hop. When
  // Hamilton holds a login for this portal and the page shows nothing to
  // fill, follow that entry ONCE before treating the page as form-less.
  let ssoEntryFollowed = false
  const tryFollowSsoEntry = async () => {
    if (ssoEntryFollowed || loggedIn || !loginCredential) return false
    const entries = await detectSsoEntryLinks(page)
    const currentPage = (() => { try { return page.url().split('#')[0] } catch { return '' } })()
    const next = entries.find((l) => {
      const target = normalizeBrowserTargetUrl(l.href)
      return target.split('#')[0] !== currentPage && isHamiltonBrowserTargetAllowed(target)
    })
    ssoEntryFollowed = true
    if (!next) {
      trace.push({ step: 'sso_entry_scan', detail: { candidates: entries.length, followed: false } })
      return false
    }
    const target = normalizeBrowserTargetUrl(next.href)
    trace.push({ step: 'sso_entry_follow', detail: { text: String(next.text || '').slice(0, 40), href: target.slice(0, 200) } })
    reportLiveStep(runId, 'Opening the portal sign-in')
    try {
      await navigateWithRecovery(page, target, { navTimeoutMs: NAV_TIMEOUT_MS, trace })
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null)
      return true
    } catch (err) {
      if (err instanceof DocumentDownloadTarget) throw err
      trace.push({ step: 'sso_entry_follow_failed', detail: { href: target.slice(0, 200), error: String(err?.message || err).split('\n')[0].slice(0, 160) } })
      return false
    }
  }
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
    await navigateWithRecovery(page, url, { navTimeoutMs: NAV_TIMEOUT_MS, trace })

    while (pagesVisited < MAX_PAGES) {
      if (signal?.aborted) {
        return { status: 'cancelled', blocker_kind: 'cancelled', blocker_detail: 'Hamilton task was cancelled.', filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn }
      }
      pagesVisited += 1
      reportLiveStep(runId, 'Reading the application page', { detail: { page: pagesVisited } })
      trace.push({ step: 'page', detail: { index: pagesVisited, url: (() => { try { return page.url() } catch { return null } })() } })

      let gate = await retryOnContextLoss(page, () => detectGate(page))
      // A captcha this run's solver already SOLVED is not a live gate — the
      // token is injected; the lingering widget DOM must not re-block. Proceed
      // to fill/submit (a genuinely unapplied token surfaces later as an honest
      // validation/submit failure, never a fabricated success).
      if (gate && (gate.kind === 'captcha' || gate.kind === 'bot_protected') && captchaSolved) {
        trace.push({ step: 'captcha_cleared', detail: { note: 'solved token injected; ignoring lingering widget' } })
        gate = null
      }
      // An INVISIBLE reCAPTCHA challenges nobody at page-open — the token is
      // minted on submit. Read past it; the submit boundary solves it (v3 task
      // type) right before the click, when the token is actually consumed.
      if (gate && gate.kind === 'captcha' && gate.invisible === true) {
        if (!captchaInvisible) trace.push({ step: 'captcha_invisible_deferred', detail: { note: 'invisible reCAPTCHA; solved at the submit boundary' } })
        captchaInvisible = true
        gate = null
      }
      if (gate) {
        // Saved-login path: when Hamilton hits a login gate and the user saved a
        // login for this portal, type it into the portal's own login form and
        // continue — instead of hard-stopping. Tried at most once.
        if (gate.kind === 'login' && loginCredential && !loginAttempted) {
          loginAttempted = true
          trace.push({ step: 'login_attempt', detail: { username: '***' } })
          const loginVerdict = await attemptLoginDetailed(page, loginCredential)
          const ok = loginVerdict.ok === true
          trace.push({ step: 'login_result', detail: { ok, reason: loginVerdict.reason || null, url: String(loginVerdict.url || '').slice(0, 160), said: loginVerdict.said || null, text: loginVerdict.text || null } })
          if (ok) { loggedIn = true; continue }
          // The credential was accepted but the provider now asks for a second
          // factor: that is the 2FA gate, not a failed login. Re-read the page
          // and let the 2FA path below (mailbox code, then honest hand-off)
          // take it — the hand-off then names the real blocker.
          const afterLogin = await retryOnContextLoss(page, () => detectGate(page)).catch(() => null)
          if (afterLogin?.kind === '2fa') {
            trace.push({ step: 'login_reached_2fa', detail: { url: (() => { try { return page.url() } catch { return null } })() } })
            gate = afterLogin
          } else {
            // Leave a picture of the page the sign-in died on, beside the
            // confirmation captures (durable dir), so the failure can be SEEN
            // — five rounds of prod verdicts on 2026-09-06 were words about a
            // page nobody could look at.
            let loginShot = null
            try {
              if (!fs.existsSync(screenshotsRoot)) fs.mkdirSync(screenshotsRoot, { recursive: true })
              loginShot = path.join(screenshotsRoot, `login_failure_${Date.now()}.png`)
              await page.screenshot({ path: loginShot, fullPage: true, timeout: 8000 })
            } catch { loginShot = null }
            if (loginShot) trace.push({ step: 'login_failure_screenshot', detail: { path: loginShot } })
            // Login fill failed (couldn't find/submit form) — fall through to the
            // normal hard-stop so the user is told login is required.
            const why = loginVerdict.reason === 'origin_refused' ? 'the sign-in page is on a host the saved login is not scoped to'
              : loginVerdict.reason === 'no_login_form' ? 'no sign-in form appeared on the page'
                : loginVerdict.reason === 'username_not_accepted' ? 'the provider did not accept the username'
                  : loginVerdict.reason === 'password_rejected' ? 'the provider did not accept the password'
                    : loginVerdict.reason === 'still_login_surface' ? 'the provider returned to its sign-in page'
                      : (loginVerdict.reason || 'unknown')
            const said = loginVerdict.said
              ? ` The page said: "${loginVerdict.said}".`
              : (loginVerdict.text ? ` The page showed: "${String(loginVerdict.text).slice(0, 160)}".` : '')
            let host = ''
            try { host = new URL(String(loginVerdict.url || '')).hostname } catch { host = '' }
            return {
              status: 'blocked', blocker_kind: 'login',
              blocker_detail: `Saved login could not be completed automatically: ${why}${host ? ` (at ${host})` : ''}.${said}`,
              login_failure: { reason: loginVerdict.reason || null, url: loginVerdict.url || null, said: loginVerdict.said || null, text: loginVerdict.text || null, screenshot_path: loginShot },
              filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn,
            }
          }
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
            // challenge as a live gate. captchaSolved makes the re-inspection
            // ignore the lingering widget instead of re-blocking.
            captchaSolved = true
            continue
          }
          // The detector matched captcha-NAMED markup (a hidden badge, a
          // theme's `.captcha-field` wrapper) but there is no solvable
          // challenge on the page: no vendor widget, no sitekey. That is an
          // INERT decoration, not a wall — cfocoeeregion.com / easttennessee
          // foundation.org parked five tasks on it (prod 2026-08-31). Read
          // past it; a real challenge that appears at submit time is caught by
          // the boundary solve or surfaces as an honest submit bounce.
          if (gate.kind === 'captcha' && verdict.reason === 'no_solvable_challenge') {
            trace.push({ step: 'captcha_inert', detail: { note: 'captcha markup with no solvable challenge; not a gate' } })
            captchaSolved = true
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

      // Revalidate the LIVE top-level document before any applicant data is
      // typed into it. Placed AFTER the gate handling on purpose: an SSO or
      // login hop is handled by the gate logic above (credentials are already
      // pinned to the credential's own domain in attemptLogin); this check
      // only governs where PROFILE data goes.
      const fillBoundary = await validateLiveDocument('before_fill')
      if (!fillBoundary.allow) {
        trace.push({ step: 'portal_policy_block', detail: { stage: 'before_fill', url: fillBoundary.url, reason: fillBoundary.reason } })
        return { status: 'blocked', blocker_kind: 'portal_policy_block', blocker_detail: `Hamilton refused to fill the live portal document (${fillBoundary.url}): ${fillBoundary.reason}`, filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn }
      }

      const fields = await retryOnContextLoss(page, () => detectFields(page))
      const submitButtons = (await retryOnContextLoss(page, () => detectButtons(page, SUBMIT_BUTTON_PATTERNS)))
        .filter((b) => !SUBMIT_BUTTON_EXCLUDE_RX.test(String(b.text || '')))
      const nextButtons   = (await retryOnContextLoss(page, () => detectButtons(page, NEXT_BUTTON_PATTERNS)))
        .filter((b) => !NEXT_BUTTON_EXCLUDE_RX.test(String(b.text || '')))
      const draftButtons  = await retryOnContextLoss(page, () => detectButtons(page, DRAFT_BUTTON_PATTERNS))
      trace.push({ step: 'inspect', detail: summarisePageState(page, fields, [...submitButtons, ...nextButtons, ...draftButtons]) })
      // Nothing to fill and a login in hand: the sign-in entry comes before any
      // "Next"/apply-link hunting (the NGWeb landing, live 2026-09-06).
      if (fields.length === 0 && !loggedIn && loginCredential && !ssoEntryFollowed) {
        if (await tryFollowSsoEntry()) continue
      }

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
        // A long-form field is the one place the paid narrative is worth
        // drafting — draft it now (once), not before the page was opened.
        if (!identityField && NARRATIVE_OVERRIDE_KEYS.includes(rule.key) && !f.value) await resolveNarrativeOnDemand()
        const v = identityField ? identityByFieldKey[rule.key] : valuesByKey[rule.key]
        if (v === undefined || v === null || String(v).trim() === '') {
          // A REQUIRED identity field we cannot fill (nothing on file) is what
          // the owner wants Hamilton to ASK for by name — record the vault kind
          // so the run surfaces a specific request instead of silently stalling.
          if (identityField && fullAutomation && f.required && IDENTITY_FIELD_TO_KIND[rule.key]) {
            missingIdentityKinds.add(IDENTITY_FIELD_TO_KIND[rule.key])
          }
          // A NON-identity rule claim with nothing to fill may be a MIS-CLAIM
          // (the same class as the fill-refused branch below): give the
          // grounded answerer its chance before leaving the field empty.
          if (!identityField && answerUnknownField && authorizations.generate_narratives
              && isAnswerableUnknownField(f) && !f.value) {
            let answered = null
            try { answered = await answerUnknownField(f) } catch { answered = null }
            if (answered?.value) {
              const okA = await fillFieldByFid(page, f.fid, answered.value)
              if (okA) {
                filled.push({ key: `q:${fieldLabelOf(f).slice(0, 40)}`, fid: f.fid, source: 'llm_field_answer', value: String(answered.value).slice(0, 60) })
                filledThisPage += 1
                trace.push({ step: 'llm_field_answer', detail: { label: fieldLabelOf(f).slice(0, 60), free_text: Boolean(answered.free_text), grounded_in: answered.grounded_in || [], misclaimed_rule: rule.key } })
                continue
              }
            }
            if (f.required) {
              const label = fieldLabelOf(f).slice(0, 120)
              if (label && !unansweredRequiredFields.some((u) => u.label === label)) {
                unansweredRequiredFields.push({ label, fid: f.fid, type: String(f.type || f.tag || 'text') })
              }
            }
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
        let ok = await fillFieldByFid(page, f.fid, v)
        if (!ok && rule.key === 'state' && f.tag === 'select') {
          // "TN" vs "Tennessee": the profile's spelling first, then the other.
          for (const alt of stateValueAlternates(v).slice(1)) {
            ok = await fillFieldByFid(page, f.fid, alt)
            if (ok) break
          }
        }
        if (ok) {
          // NEVER record an identity value in the trace/filled list — it is
          // persisted on the run row. Record the key and that it came from the
          // vault; the value is deliberately omitted.
          filled.push(identityField
            ? { key: rule.key, fid: f.fid, source: 'identity_vault' }
            : { key: rule.key, fid: f.fid, value: String(v).slice(0, 60) })
          filledThisPage += 1
        } else if (!identityField && answerUnknownField && authorizations.generate_narratives
            && isAnswerableUnknownField(f) && !f.value) {
          // A RULE-claimed field whose mapped value the portal REFUSED (a
          // <select> without that option) is a MIS-CLAIM, not a fill.
          // Measured 2026-08-23 on the U.S. Bank form: "Where did you hear
          // about our scholarship program?" matched the `major` rule on the
          // word "program", so every run tried selectOption("Forensic
          // Science") and failed silently. Give the grounded answerer the
          // same chance the no-rule branch gets — it may only choose among
          // the portal's own options, and null still means "ask the user".
          let answered = null
          try { answered = await answerUnknownField(f) } catch { answered = null }
          if (answered?.value) {
            const okA = await fillFieldByFid(page, f.fid, answered.value)
            if (okA) {
              filled.push({ key: `q:${fieldLabelOf(f).slice(0, 40)}`, fid: f.fid, source: 'llm_field_answer', value: String(answered.value).slice(0, 60) })
              filledThisPage += 1
              trace.push({ step: 'llm_field_answer', detail: { label: fieldLabelOf(f).slice(0, 60), free_text: Boolean(answered.free_text), grounded_in: answered.grounded_in || [], misclaimed_rule: rule.key } })
            }
          }
          if (!answered?.value && f.required) {
            const label = fieldLabelOf(f).slice(0, 120)
            if (label && !unansweredRequiredFields.some((u) => u.label === label)) {
              unansweredRequiredFields.push({ label, fid: f.fid, type: String(f.type || f.tag || 'text') })
            }
          }
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

      // Eligibility AGE-AFFIRMATION checkboxes: a required box affirming a fact
      // Hamilton can VERIFY from the applicant's real age is ticked when
      // provably true, and left alone when false or ambiguous. Under full
      // automation only. (U.S. Bank form: tick "I am 18 or older", leave "I am
      // 17…" — the difference between filling the form and blocking on submit.)
      if (authorizations.use_standing_attestation) {
        const dobForAge = identityByFieldKey.id_date_of_birth
          || (identityValues && identityValues.date_of_birth)
          || valuesByKey.date_of_birth || valuesByKey.dob || null
        const ageYears = computeAgeYears(dobForAge)
        // Beyond age: enrollment / undergraduate / not-international /
        // citizenship statements are checked against what the profile
        // DECLARES. A statement the facts cannot settle is left unticked and,
        // when required, becomes a named ask (condition 2) — never a tick.
        const eligibilityFacts = deriveEligibilityFacts(profile, valuesByKey)
        if (ageYears !== null || eligibilityFacts.known) {
          const boxes = await page.$$eval('input[type="checkbox"]', (els) => els.map((el) => {
            const id = el.id || ''
            let lab = ''
            if (id) { const l = document.querySelector(`label[for="${CSS.escape(id)}"]`); if (l) lab = l.textContent || '' }
            if (!lab) { const par = el.closest('label'); if (par) lab = par.textContent || '' }
            return {
              id, name: el.getAttribute('name') || '',
              text: `${el.getAttribute('name') || ''} ${(lab || '').trim()}`,
              checked: el.checked,
              required: el.required || el.getAttribute('aria-required') === 'true',
            }
          })).catch(() => [])
          const selFor = (b) => b.id ? `input[id="${String(b.id).replace(/"/g, '\\"')}"]`
            : (b.name ? `input[name="${String(b.name).replace(/"/g, '\\"')}"]` : null)
          const affirmed = []
          const falseAffirmations = []
          const undecided = []
          for (const b of boxes) {
            let verdict = ageAffirmationVerdict(b.text, ageYears)
            if (verdict === null) verdict = eligibilityAffirmationVerdict(b.text, eligibilityFacts)
            if (verdict === null && b.required && !b.checked
                && !STANDING_ATTESTATION_PATTERNS.some((rx) => rx.test(b.text))
                && !HARD_ATTESTATION_PATTERNS.some((rx) => rx.test(b.text))) {
              undecided.push(b)
            }
            if (verdict === true && !b.checked) {
              const sel = selFor(b)
              if (!sel) continue
              const ok = await page.$eval(sel, (el) => {
                if (!el) return false
                el.checked = true
                el.dispatchEvent(new Event('change', { bubbles: true }))
                return true
              }).catch(() => false)
              if (ok) affirmed.push(b.text.slice(0, 100))
            } else if (verdict === false && b.required && !b.checked) {
              falseAffirmations.push(b)
            }
          }
          // A REQUIRED age affirmation the applicant provably does NOT satisfy
          // (the "I am 17…" alternate for an 18-year-old) is correctly left
          // unchecked. When Hamilton HAS made a true age affirmation in the same
          // form, the false alternate's static `required` is a form artifact
          // that must not block a correct submission — relax it. Honest: the
          // applicant made the real affirmation; the false box stays UNCHECKED.
          if (affirmed.length > 0 && falseAffirmations.length > 0) {
            const relaxed = []
            for (const b of falseAffirmations) {
              const sel = selFor(b)
              if (!sel) continue
              const ok = await page.$eval(sel, (el) => {
                if (!el) return false
                el.required = false
                el.removeAttribute('required')
                el.setAttribute('aria-required', 'false')
                return true
              }).catch(() => false)
              if (ok) relaxed.push(b.text.slice(0, 80))
            }
            if (relaxed.length > 0) trace.push({ step: 'eligibility_alternate_relaxed', detail: { items: relaxed } })
          }
          if (affirmed.length > 0) trace.push({ step: 'eligibility_affirmed', detail: { items: affirmed } })
          for (const b of undecided) {
            const label = String(b.text || '').replace(/^\S+\s+/, '').trim().slice(0, 120) || String(b.text || '').slice(0, 120)
            if (label && !unansweredRequiredFields.some((u) => u.label === label)) {
              unansweredRequiredFields.push({ label, fid: null, type: 'checkbox' })
            }
          }
          if (undecided.length > 0) trace.push({ step: 'eligibility_undecided', detail: { items: undecided.map((b) => b.text.slice(0, 100)) } })
        }
      }

      // Authorized document uploads.
      if (authorizations.upload_documents && Array.isArray(documents) && documents.length > 0) {
        if (signal?.aborted) {
          return { status: 'cancelled', blocker_kind: 'cancelled', blocker_detail: 'Hamilton task was cancelled before document upload.', filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn }
        }
        const uploadBoundary = await validateLiveDocument('before_upload')
        if (!uploadBoundary.allow) {
          trace.push({ step: 'portal_policy_block', detail: { stage: 'before_upload', url: uploadBoundary.url, reason: uploadBoundary.reason } })
          return { status: 'blocked', blocker_kind: 'portal_policy_block', blocker_detail: `Hamilton refused to upload documents to the live portal document (${uploadBoundary.url}): ${uploadBoundary.reason}`, filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn }
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
          // A logged-in scholarship-HUB SPA (bold.org / scholarshipowl) whose
          // apply control opens the application behind an in-app "Apply" button —
          // not a native form and not a navigable apply URL. Route it to an
          // honest, distinct blocker (carrying co-browse-with-saved-session
          // guidance) BEFORE the apply-nav follow below, so Hamilton never
          // blind-clicks "Apply" on a no-essay award and triggers an unintended
          // real submission. See spaApplySurface.js for the prod evidence.
          const spaSurface = detectSpaApplySurface({
            url: (() => { try { return page.url() } catch { return null } })(),
            fieldCount: fields.length,
            buttonTexts: submitButtons.map((b) => b.text),
          })
          if (spaSurface.isSpaApply) {
            trace.push({ step: 'spa_apply_surface', detail: { hub: spaSurface.hub } })
            return {
              status: 'blocked', blocker_kind: 'spa_apply_surface',
              blocker_detail: spaApplyBlockerDetail(spaSurface.display),
              filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn,
            }
          }
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
        if (await tryFollowApplyButton()) continue // re-inspect the page the apply control led to
        // No apply BUTTON — look for an apply LINK (anchor), on this host or
        // the funder's portal vendor. Public-HTTPS only (the egress guard and
        // the target policy both still apply); bounded like the button path.
        if (await tryFollowApplyAnchor()) continue // re-inspect the page the apply link led to
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

      // A contact / newsletter form is never an application, whatever its
      // button says. Refuse the click and degrade honestly instead of
      // submitting a mailing-list sign-up and then asking a human to "verify
      // the portal" for it.
      if (canSubmit && isContactOrNewsletterForm({
        submitButton: submitCandidates[0], fields, filled,
        pageTitle: await Promise.resolve(page.title?.()).catch(() => ''),
      })) {
        trace.push({ step: 'contact_form_not_application', detail: { button: submitCandidates[0].text, form_fields: submitCandidates[0].formFieldCount, filled_keys: filled.map((f) => f.key).slice(0, 8) } })
        return {
          status: 'blocked',
          blocker_kind: 'no_application_form',
          blocker_detail: 'The only form on this page is a contact / newsletter sign-up, not an application (Hamilton did not submit it). Hamilton degrades to the manual funder-contact packet pathway.',
          filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn,
        }
      }

      if (canSubmit && finalAllowSubmit) {
        const submitBoundary = await validateLiveDocument('before_submit')
        if (!submitBoundary.allow) {
          trace.push({ step: 'portal_policy_block', detail: { stage: 'before_submit', url: submitBoundary.url, reason: submitBoundary.reason } })
          return { status: 'blocked', blocker_kind: 'portal_policy_block', blocker_detail: `Hamilton refused to submit on the live portal document (${submitBoundary.url}): ${submitBoundary.reason}`, filled_fields: filled, unanswered_required_fields: unansweredRequiredFields, pages_visited: pagesVisited, trace, logged_in: loggedIn }
        }
        const nativeErrors = await detectNativeValidationErrors(page, submitCandidates[0].bid)
        if (nativeErrors.length > 0) {
          trace.push({ step: 'submit_native_validation_failed', detail: { errors: nativeErrors.slice(0, 5) } })
          return { status: 'blocked', blocker_kind: 'validation', blocker_detail: nativeErrors.slice(0, 5).join(' | '), filled_fields: filled, unanswered_required_fields: unansweredRequiredFields, pages_visited: pagesVisited, trace }
        }
        // The orchestrator's irreversible-boundary check receives the LIVE
        // document url so it re-checks executability + portal policy for the
        // host Hamilton is actually about to submit on, not the launch url.
        const boundary = typeof beforeSubmit === 'function'
          ? await beforeSubmit({ url: submitBoundary.url })
          : { allow: false, reason: 'missing_submit_boundary_check' }
        if (signal?.aborted || boundary?.cancelled) {
          return { status: 'cancelled', blocker_kind: 'cancelled', blocker_detail: 'Hamilton task was cancelled before submission.', filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn }
        }
        if (boundary?.allow !== true) {
          trace.push({ step: 'completed_draft', detail: { reason: boundary?.reason || 'submit_authority_revoked' } })
          return { status: 'completed_draft', submit_withheld_reason: boundary?.reason || 'submit_authority_revoked', filled_fields: filled, unanswered_required_fields: unansweredRequiredFields, pages_visited: pagesVisited, trace, logged_in: loggedIn }
        }
        submissionAttemptStarted = true
        // A CAPTCHA token solved at page-open is often DEAD by click time —
        // measured live 2026-08-23 (U.S. Bank): the reCAPTCHA was solved at
        // run start, ~90s of filling followed, and the POST bounced back to a
        // blank form with no visible error (Google tokens expire ~120s and
        // are single-use). Re-solve at the boundary whenever a captcha was
        // present this run, so the token the submit carries is fresh.
        if (solveCaptcha && (captchaAttempted || captchaInvisible)) {
          trace.push({ step: 'captcha_refresh_attempt', detail: captchaInvisible && !captchaAttempted ? { invisible: true } : undefined })
          try {
            const refreshed = await solveCaptcha(page)
            trace.push({ step: 'captcha_refresh_result', detail: { solved: Boolean(refreshed?.solved), vendor: refreshed?.vendor || null } })
          } catch { trace.push({ step: 'captcha_refresh_result', detail: { solved: false } }) }
        }
        // The form's own declared receipt page (Salesforce web-to-lead
        // `retURL` and kin) is the portal telling us what success looks like:
        // landing there IS confirmation evidence, and bouncing back to the
        // origin form BLANK proves the POST was rejected.
        const expectedReceiptUrl = await page.evaluate(
          () => document.querySelector('form input[name="retURL"]')?.value || null,
        ).catch(() => null)
        if (expectedReceiptUrl) trace.push({ step: 'declared_receipt_url', detail: { retURL: String(expectedReceiptUrl).slice(0, 200) } })
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
        const clickVerdict = await clickSubmitControl(page, submitCandidates[0], SUBMIT_BUTTON_PATTERNS)
        if (!clickVerdict.clicked) {
          // dispatched=false is a PROOF: the click never reached the page (the
          // stamped control was gone or every attempt died pre-dispatch), so
          // nothing was submitted and a retry is safe. Only a failure that may
          // have fired the event keeps the conservative uncertain-submission
          // quarantine.
          return {
            status: 'failed', blocker_kind: 'click_failed',
            blocker_detail: clickVerdict.dispatched
              ? 'Submit click failed after it may have reached the page; check the portal before retrying.'
              : 'Submit button could not be clicked (the control was never actually activated — no submission occurred). Safe to retry.',
            provably_not_submitted: clickVerdict.dispatched !== true,
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
        const normUrl = (u) => { try { const p = new URL(String(u)); return `${p.origin}${p.pathname}`.replace(/\/+$/, '').toLowerCase() } catch { return String(u ?? '').split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase() } }
        if (!evidence.ok && expectedReceiptUrl && conf?.url && normUrl(conf.url) === normUrl(expectedReceiptUrl)) {
          // The portal navigated to ITS OWN declared receipt page — that is
          // the strongest confirmation signal a receipt-silent portal offers.
          trace.push({ step: 'submitted', detail: { from: beforeUrl, to: conf.url, confirmation_evidence: 'declared_receipt_url' } })
          return {
            status: 'submitted',
            ...retainedSubmitFields(),
            confirmation_evidence: 'declared_receipt_url',
            filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn,
          }
        }
        if (!evidence.ok && expectedReceiptUrl && conf?.url && beforeUrl && normUrl(conf.url) === normUrl(beforeUrl)) {
          // Landed BACK on the origin form with a declared receipt page never
          // reached. If the form re-rendered BLANK, the POST was provably
          // rejected server-side (nothing was recorded — a success would have
          // redirected to retURL) — so a retry is SAFE, not a double-submit
          // risk. Measured live 2026-08-23: the U.S. Bank form bounces blank
          // when the captcha token has expired, with no visible error.
          const bouncedBlank = await page.evaluate(() => {
            const anchor = document.querySelector('form input[name="retURL"]')
            const form = anchor ? anchor.form : null
            if (!form) return false
            const texts = Array.from(form.querySelectorAll('input[type="text"], input[type="email"], input:not([type])'))
            return texts.length > 0 && texts.every((el) => !el.value)
          }).catch(() => false)
          if (bouncedBlank) {
            trace.push({ step: 'submit_rejected_bounce', detail: { retURL: String(expectedReceiptUrl).slice(0, 200), url: conf.url } })
            return {
              status: 'blocked',
              blocker_kind: 'submit_rejected_bounce',
              provably_not_submitted: true,
              blocker_detail: 'The portal rejected the submission: it returned the ORIGIN form blank and its own declared receipt page (retURL) was never reached — provably NOT submitted, safe to re-run. Most common cause is a CAPTCHA token that aged out between solve and submit; Hamilton now re-solves at the boundary.',
              ...retainedSubmitFields(),
              filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn,
            }
          }
        }
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
        // An information page (acf.gov's TANF program page, a grants LISTING)
        // often carries a "Next" pagination link and nothing to fill. One blind
        // Next is allowed — a real multi-step form can open with an intro page —
        // but a SECOND page with still nothing filled is not an application.
        if (filled.length === 0 && blindNextClicks >= 1) {
          trace.push({ step: 'no_application_form', detail: { reason: 'next_without_fields', pages_visited: pagesVisited } })
          return {
            status: 'blocked',
            blocker_kind: 'no_application_form',
            blocker_detail: 'This page has no application form to fill — Hamilton followed "Next" once and found nothing to fill on either page (informational or listing page). Hamilton degrades to the manual funder-contact packet pathway.',
            filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn,
          }
        }
        if (filled.length === 0) blindNextClicks += 1
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
      // A landing page with no controls at all but an "Apply" ANCHOR (the
      // Gates Scholarship home, tnachieves.org/tn-promise) is one click from
      // the form. Follow it before declaring no progress.
      if (filled.length === 0 && (await tryFollowApplyButton() || await tryFollowApplyAnchor())) continue
      trace.push({ step: 'no_progress', detail: { reason: 'no advance button found' } })
      return { status: 'blocked', blocker_kind: 'no_progress', blocker_detail: 'Hamilton could not find a Next/Submit button to continue', filled_fields: filled, pages_visited: pagesVisited, trace }
    }

    return { status: 'blocked', blocker_kind: 'too_many_pages', blocker_detail: `Hit ${MAX_PAGES} page cap`, filled_fields: filled, pages_visited: pagesVisited, trace }
  } catch (err) {
    const raw = err?.message || String(err)
    if (submitClicked) await retainSubmitCapture()
    if (err instanceof DocumentDownloadTarget) {
      trace.push({ step: 'document_download_target', detail: { url: String(err.documentUrl || '').slice(0, 300) } })
      return {
        status: 'blocked',
        blocker_kind: 'document_download',
        blocker_detail: `The application link is a downloadable document, not a web form: ${err.documentUrl}. Hamilton switches to the document (print/mail) pathway with that file as the form.`,
        document_url: err.documentUrl,
        filled_fields: filled, pages_visited: pagesVisited, trace, logged_in: loggedIn,
      }
    }
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
  isAdmissionsApplicationLink, applicantProvablyEnrolled,
  computeAgeYears,
  ageAffirmationVerdict, eligibilityAffirmationVerdict, deriveEligibilityFacts,
  parseAddressBlob, stateValueAlternates,
  FIELD_RULES, STANDING_ATTESTATION_PATTERNS, HARD_ATTESTATION_PATTERNS,
  SIGNATURE_FIELD_PATTERNS, isTypedSignatureField, signatureConsentFor, detectAttestationGate,
  SUBMIT_BUTTON_PATTERNS, NEXT_BUTTON_PATTERNS, DRAFT_BUTTON_PATTERNS,
  matchFieldKey, readProfileValues, applyNarrativeAnswers,
  clickButtonByBid, clickSubmitControl, clickButtonByBidVerdict, FEEDBACK_VALIDATION_IGNORE_RX,
  detectGate, detectBotWall, attemptLogin, attemptLoginDetailed, readLoginFailureText,
  detectIdpLoginSurface, detectSsoEntryLinks, SSO_IDP_HOST_RX, SSO_ENTRY_PATH_RX, NEXT_BUTTON_EXCLUDE_RX,
  isIncidentalLoginWidget, readCaptchaShape, detectPaymentGate,
  retryOnContextLoss, navigateWithRecovery, DocumentDownloadTarget,
  detectApplyLinks, isContactOrNewsletterForm, CONTEXT_LOSS_RX,
  extractConfirmationReference,
  extractConfirmationReferenceFromUrl,
  detectReceiptAcknowledgement,
  RECEIPT_ACK_RX,
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
