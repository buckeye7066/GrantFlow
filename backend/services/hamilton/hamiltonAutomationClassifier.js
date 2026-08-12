/**
 * hamiltonAutomationClassifier.js
 *
 * Pure, deterministic classifier that maps a selected funding source
 * to one of Hamilton's eight completion pathways:
 *
 *   portal          — fillable web portal (Playwright supervised flow)
 *   pdf_docx        — downloadable PDF / DOCX form
 *   mail            — printed packet sent via post
 *   fax             — fax submission
 *   email           — email submission
 *   no_application  — directory / awareness resource, no app needed
 *   auto_profile    — FAFSA / institutional / nomination-only / automatic match
 *   unknown         — Hamilton cannot tell — humans should review
 *
 * Rules (in priority order):
 *
 *   1. Explicit metadata wins:
 *        opportunity.application_mode  / source.application_mode
 *        opportunity.application_method / source.application_method
 *        opportunity.application_format
 *        grant.application_mode
 *
 *   2. Auto-profile signals (always pre-empt portal/pdf paths):
 *        result_kind == 'auto_match'
 *        application_mode == 'auto_profile' / 'fafsa' / 'institutional'
 *        opportunity_kind == 'fafsa' / 'auto_profile' / 'nomination'
 *        title/description contains FAFSA / institutional aid / nomination
 *
 *   3. No-application signals:
 *        result_kind == 'directory' / 'awareness' / 'reference'
 *        opportunity_kind == 'directory' / 'reference'
 *
 *   4. Email / fax / mail signals:
 *        contact_methods or apply_email / apply_fax / apply_mail
 *        opportunity text containing "submit by email", "fax to ...", etc.
 *
 *   5. Portal vs pdf_docx vs unknown:
 *        URL points at .pdf / .docx / .doc → pdf_docx
 *        URL has https/http → portal
 *        no URL but mailing address present → mail
 *        otherwise unknown
 *
 * Confidence is always reported. The classifier never invents missing
 * data — when it cannot find a signal it returns unknown rather than
 * guessing.
 */

import { isSearchEngineUrl } from '../../config/urlRules.js'
import { isPointerKind } from '../../config/opportunityKindClasses.js'

// Owner directive 2026-08-03: a POINTER row that carries a usable web URL is a
// PAGE OF several awards — route it to the portal engine so listing triage can
// decompose it, instead of a static no_application packet. Env-flaggable so the
// behaviour can be toggled without a redeploy if it ever misbehaves in prod.
const DECOMPOSE_POINTER_LISTINGS = String(process.env.HAMILTON_DECOMPOSE_POINTER_LISTINGS ?? 'true').toLowerCase() !== 'false'

const PORTAL_RESULT_KINDS = new Set(['application', 'portal', 'apply'])
const AUTO_PROFILE_RESULT_KINDS = new Set(['auto_match', 'institutional_match', 'nomination'])
const NO_APPLICATION_RESULT_KINDS = new Set(['directory', 'awareness', 'reference', 'no_application'])

const FAFSA_RX = /\bfafsa\b|free\s+application\s+for\s+federal\s+student\s+aid/i
const NOMINATION_RX = /nominat(ion|ed|or)/i
const INSTITUTIONAL_RX = /institutional\s+aid|automatic\s+award|need-\s*based\s+aid|verified\s+by\s+the\s+(school|college|university)/i
// These test against crawled/scraped portal page text — untrusted, adversarial
// input. Chaining several `(optional)?\s*` groups back to back (each of which
// can match empty) gives the regex engine an exponential number of equivalent
// ways to partition a run of whitespace, which is a classic polynomial/
// catastrophic ReDoS shape. Bounding every whitespace gap to `\s{0,20}` keeps
// the same practical matching behavior (real text never has runs of 20+
// whitespace chars where these expect a gap) while making the state space
// provably small regardless of input length.
const SUBMIT_EMAIL_RX = /(submit|send|return|email)\s{0,20}(this|the|completed)?\s{0,20}(application|form|packet|materials|documents)?\s{0,20}(by|via|to)?\s{0,20}e[-\s]?mail/i
const SUBMIT_FAX_RX = /(submit|send|return|fax)\s{0,20}(this|the|completed)?\s{0,20}(application|form|packet|materials|documents)?\s{0,20}(by|via|to)?\s{0,20}fax/i
const SUBMIT_MAIL_RX = /(mail|post|send)\s{0,20}(application|form|packet|materials|documents)?\s{0,20}(to|via|by)\s{0,20}(post|mail|usps)|return\s{0,20}(this|the)\s{0,20}(application|form|packet)\s{0,20}by\s{0,20}mail|(must\s{0,20}be\s{0,20})?postmarked/i

const PDF_DOCX_RX = /\.(pdf|docx?|rtf)(\?|#|$)/i
const FAX_NUMBER_RX = /\bfax(?:[\s:.]+)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/i

// ── FAFSA-linkage detection (the "link your FAFSA" portal class) ─────────────
// Many portals on a student profile require NO application of their own — the
// whole "application" is connecting the student's already-filed FAFSA (state
// aid portals like the TSAA, schools that award straight from FAFSA data,
// "import your FAFSA" flows). Detection is deliberately PRECISE: a page merely
// MENTIONING FAFSA eligibility ("FAFSA encouraged", "may also qualify for
// federal aid") is NOT link-only. A hit requires explicit linkage/import
// language, an awards-directly-from-FAFSA claim, or the-FAFSA-IS-the-
// application phrasing — plus student-aid context. This flag never asserts a
// linkage HAPPENED; it only marks that the portal's requirement IS the FAFSA.
const FAFSA_LINK_PATTERNS = [
  // Direct linkage/import verbs aimed at the FAFSA or the federal student aid account.
  /\b(?:link|links|linking|import|imports|importing|connect|connects|connecting|sync|syncs|syncing|transfer|transfers|transferring)\s+(?:your\s+|the\s+|a\s+)?fafsa\b/i,
  /\b(?:link|import|connect)\w*\s+(?:your\s+|the\s+)?(?:federal\s+student\s+aid|studentaid\.gov)\s+(?:account|information|data|record)s?\b/i,
  // The FAFSA IS the application.
  /\bfafsa\s+(?:is|serves\s+as|acts\s+as)\s+(?:the|your)\s+(?:only\s+|sole\s+)?application\b/i,
  /\bno\s+(?:separate|additional|other)\s+application[^.\n]{0,120}\bfafsa\b/i,
  /\bfafsa\b[^.\n]{0,120}\bno\s+(?:separate|additional|other)\s+application\b/i,
  // Awards determined straight from FAFSA data.
  /\b(?:awarded?|considered|determined|selected|evaluated)\s+(?:automatically\s+)?(?:based\s+(?:solely\s+|entirely\s+)?on|using|directly\s+from|from)\s+(?:the\s+|your\s+)?fafsa\b/i,
  /\buses?\s+(?:your\s+|the\s+)?fafsa\s+(?:data|information|results?)\s+directly\b/i,
  /\bschools?\s+(?:that\s+)?us(?:e|ing)\s+fafsa\s+data\s+directly\b/i,
  // "Just complete/submit/file the FAFSA to apply / be considered."
  /\b(?:complete|submit|file)\w*\s+(?:the\s+|your\s+|a\s+)?fafsa\s+to\s+(?:apply|be\s+considered|qualify|receive)\b/i,
  /\bonly\s+requir\w+\s+(?:is\s+)?(?:a\s+|the\s+|your\s+)?(?:completed\s+|submitted\s+)?fafsa\b/i,
]
const STUDENT_AID_CONTEXT_RX = /\b(?:students?|scholarships?|tuition|colleges?|universit(?:y|ies)|education|financial\s+aid|student\s+aid|\baid\b|grants?|semesters?|undergraduate|graduate)\b/i

function lower(value) { return String(value || '').toLowerCase() }
function nonEmpty(value) { return value !== null && value !== undefined && String(value).trim() !== '' }
function buildText(opportunity) {
  return [
    opportunity?.title,
    opportunity?.description,
    opportunity?.eligibility_text,
    opportunity?.summary,
    opportunity?.application_instructions,
  ].filter(Boolean).join('\n')
}

function readMode(opportunity, grant) {
  return (
    opportunity?.application_mode
    || opportunity?.application_method
    || opportunity?.application_format
    || opportunity?.apply_mode
    || grant?.application_mode
    || grant?.application_method
    || null
  )
}

function readUrl(opportunity, grant) {
  const candidates = [
    opportunity?.application_url,
    opportunity?.apply_url,
    opportunity?.url,
    opportunity?.source_url,
    grant?.application_url,
    grant?.apply_url,
    grant?.url,
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    // URL-hygiene rule: a search-engine RESULTS page (google.com/search?q=…)
    // is never an application target. Legacy rows persisted before the insert
    // gate can still carry one; skipping it here means resolved_url is null and
    // the source classifies as unknown/mail instead of "portal" — so Hamilton
    // never drives the login flow against a search page (she was retrying
    // Google's sign-in wall 5x per task in prod). The orchestrator then
    // re-persists the nulled URL onto the task row, healing it in place.
    if (isSearchEngineUrl(candidate)) continue
    return candidate
  }
  return null
}

/**
 * Does this source's application method consist of LINKING the student's
 * FAFSA (rather than filing anything of its own)? Pure — no IO. Reads the
 * same explicit metadata the classifier honors (application_mode /
 * opportunity_kind === 'fafsa') plus precise linkage phrasing in the copy.
 * Profile-agnostic by design: the verdict is about the PORTAL, never about
 * who is applying.
 *
 * @returns {{ fafsa_link: boolean, signal: string|null }}
 */
export function detectFafsaLinkRequirement({ opportunity = null, grant = null } = {}) {
  const mode = lower(readMode(opportunity, grant) || '')
  const oppKind = lower(opportunity?.opportunity_kind || grant?.opportunity_kind || '')
  if (mode === 'fafsa' || oppKind === 'fafsa') {
    return { fafsa_link: true, signal: `metadata.fafsa:${mode || oppKind}` }
  }
  const text = [
    buildText(opportunity || {}),
    grant?.title,
    grant?.description,
    grant?.eligibility_text,
    grant?.notes,
  ].filter(Boolean).join('\n')
  if (!FAFSA_RX.test(text)) return { fafsa_link: false, signal: null }
  if (!STUDENT_AID_CONTEXT_RX.test(text)) return { fafsa_link: false, signal: null }
  for (const rx of FAFSA_LINK_PATTERNS) {
    const m = rx.exec(text)
    if (m) return { fafsa_link: true, signal: `text.fafsa_link:${String(m[0]).slice(0, 60)}` }
  }
  return { fafsa_link: false, signal: null }
}

function readContact(opportunity, grant, key) {
  return (
    opportunity?.[key]
    || opportunity?.contact_info?.[key]
    || opportunity?.contact_methods?.[key]
    || grant?.[key]
    || null
  )
}

/**
 * Classify a single funding source. Pure — no IO.
 *
 * @param {object} input
 * @param {object} [input.opportunity]   funding_opportunities row
 * @param {object} [input.grant]         grants row (pipeline item)
 * @param {object} [input.profile]       profile (used to bias institutional vs external)
 * @param {object} [input.portalLink]    application_portal_links row, when present
 * @returns {{
 *   automation_type: 'portal'|'pdf_docx'|'mail'|'fax'|'email'|'no_application'|'auto_profile'|'unknown',
 *   confidence: number,
 *   reasons: Array<{ rule: string, signal: string }>,
 *   resolved_url: string|null,
 *   mailing_address: string|null,
 *   apply_email: string|null,
 *   apply_fax: string|null,
 *   fafsa_link: boolean,
 * }}
 */
export function classifyFundingSource({ opportunity = null, grant = null, profile = null, portalLink = null } = {}) {
  void profile
  const reasons = []
  const url = readUrl(opportunity, grant)
  const mode = readMode(opportunity, grant)
  const text = buildText(opportunity || {})
  const resultKind = lower(opportunity?.result_kind || grant?.result_kind || '')
  const opportunityKind = lower(opportunity?.opportunity_kind || grant?.opportunity_kind || '')

  const applyEmail = readContact(opportunity, grant, 'apply_email')
    || readContact(opportunity, grant, 'application_email')
    || readContact(opportunity, grant, 'submission_email')
  const applyFax = readContact(opportunity, grant, 'apply_fax')
    || readContact(opportunity, grant, 'application_fax')
    || readContact(opportunity, grant, 'fax')
  const mailingAddress = readContact(opportunity, grant, 'mailing_address')
    || readContact(opportunity, grant, 'application_address')
    || readContact(opportunity, grant, 'address')

  // FAFSA-linkage marker (additive — never changes automation_type). A portal
  // whose whole application method is "link your FAFSA" carries fafsa_link so
  // preflight/pathways can answer it from the profile's education record
  // instead of raising generic stops.
  const fafsaLink = detectFafsaLinkRequirement({ opportunity, grant })
  if (fafsaLink.fafsa_link) reasons.push({ rule: 'fafsa.link_only', signal: fafsaLink.signal })

  const setAndReturn = (type, conf, rule, signal) => {
    reasons.push({ rule, signal })
    return {
      automation_type: type,
      confidence: conf,
      reasons,
      resolved_url: url || null,
      mailing_address: mailingAddress || null,
      apply_email: applyEmail || null,
      apply_fax: applyFax || null,
      fafsa_link: fafsaLink.fafsa_link,
    }
  }

  // 1. Explicit metadata.
  if (mode) {
    const m = lower(mode)
    if (m === 'portal' || m === 'web' || m === 'online') return setAndReturn('portal', 0.95, 'metadata.application_mode', m)
    if (m === 'pdf' || m === 'docx' || m === 'paper_form' || m === 'download') return setAndReturn('pdf_docx', 0.95, 'metadata.application_mode', m)
    if (m === 'mail' || m === 'post' || m === 'usps') return setAndReturn('mail', 0.95, 'metadata.application_mode', m)
    if (m === 'fax') return setAndReturn('fax', 0.95, 'metadata.application_mode', m)
    if (m === 'email') return setAndReturn('email', 0.95, 'metadata.application_mode', m)
    if (m === 'no_application' || m === 'none') return setAndReturn('no_application', 0.95, 'metadata.application_mode', m)
    if (m === 'auto_profile' || m === 'auto_match' || m === 'fafsa' || m === 'institutional' || m === 'nomination') {
      return setAndReturn('auto_profile', 0.95, 'metadata.application_mode', m)
    }
    if (m === 'manual' || m === 'offline' || m === 'manual_or_offline') return setAndReturn('mail', 0.7, 'metadata.application_mode', m)
  }

  // 2. Auto-profile signals.
  if (AUTO_PROFILE_RESULT_KINDS.has(resultKind)) {
    return setAndReturn('auto_profile', 0.85, 'metadata.result_kind', resultKind)
  }
  if (FAFSA_RX.test(text)) return setAndReturn('auto_profile', 0.8, 'text.fafsa', 'matched FAFSA pattern')
  if (NOMINATION_RX.test(text)) return setAndReturn('auto_profile', 0.7, 'text.nomination', 'matched nomination pattern')
  if (INSTITUTIONAL_RX.test(text)) return setAndReturn('auto_profile', 0.7, 'text.institutional_aid', 'matched institutional aid pattern')

  // 2b. Pointer-kind DECOMPOSITION (owner directive 2026-08-03). A directory /
  // referral / school_portal / past_award_intel row that carries a usable web
  // URL is a page listing several awards. Send it to the portal engine so
  // listing triage decomposes it into per-award candidates, rather than a
  // static no_application packet that turns the whole page down. Takes
  // precedence over the no_application routes below. The pointer row's OWN match
  // stays a pointer (locator rule: recommendable at REVIEW, never ACCEPT) —
  // decomposition mints NEW opportunity rows through the canonical inserter.
  if (DECOMPOSE_POINTER_LISTINGS && isPointerKind(opportunityKind) && nonEmpty(url) && /^https?:/i.test(url)) {
    return setAndReturn('portal', 0.6, 'pointer_kind.decompose', opportunityKind)
  }

  // 3. No-application signals.
  if (NO_APPLICATION_RESULT_KINDS.has(resultKind)) {
    return setAndReturn('no_application', 0.85, 'metadata.result_kind', resultKind)
  }
  if (opportunityKind === 'directory' || opportunityKind === 'reference') {
    return setAndReturn('no_application', 0.8, 'metadata.opportunity_kind', opportunityKind)
  }

  // 4. Channel-specific submission signals.
  if (applyFax || SUBMIT_FAX_RX.test(text) || FAX_NUMBER_RX.test(text)) {
    return setAndReturn('fax', applyFax ? 0.85 : 0.6, 'contact.fax', applyFax || 'fax language in description')
  }
  if (applyEmail || SUBMIT_EMAIL_RX.test(text)) {
    return setAndReturn('email', applyEmail ? 0.85 : 0.6, 'contact.email', applyEmail || 'email language in description')
  }
  if (mailingAddress || SUBMIT_MAIL_RX.test(text)) {
    return setAndReturn('mail', mailingAddress ? 0.85 : 0.6, 'contact.mailing_address', mailingAddress || 'mail language in description')
  }

  // 5. URL-based signals.
  if (nonEmpty(url) && PDF_DOCX_RX.test(url)) {
    return setAndReturn('pdf_docx', 0.85, 'url.pdf_docx', url)
  }
  if (PORTAL_RESULT_KINDS.has(resultKind)) {
    return setAndReturn('portal', 0.8, 'metadata.result_kind', resultKind)
  }
  if (portalLink?.portal_type) {
    return setAndReturn('portal', 0.85, 'portal_link.portal_type', portalLink.portal_type)
  }
  if (nonEmpty(url) && /^https?:/i.test(url)) {
    return setAndReturn('portal', 0.55, 'url.http', url)
  }

  // 6. Last-resort: if there's a mailing address but nothing else, mail.
  if (nonEmpty(mailingAddress)) {
    return setAndReturn('mail', 0.5, 'contact.mailing_address', mailingAddress)
  }

  return setAndReturn('unknown', 0.3, 'no_signal', 'no recognised application channel found')
}

/**
 * Stage-aware: stamp `current_pipeline_stage` onto the result so the
 * orchestrator can persist it and the UI can render it.
 */
export function classifyWithStage(input, currentStage = null) {
  const out = classifyFundingSource(input)
  out.current_pipeline_stage = currentStage || null
  return out
}

export const _internal = {
  PORTAL_RESULT_KINDS, AUTO_PROFILE_RESULT_KINDS, NO_APPLICATION_RESULT_KINDS,
  FAFSA_RX, NOMINATION_RX, INSTITUTIONAL_RX,
  SUBMIT_EMAIL_RX, SUBMIT_FAX_RX, SUBMIT_MAIL_RX,
  PDF_DOCX_RX, FAX_NUMBER_RX,
  FAFSA_LINK_PATTERNS, STUDENT_AID_CONTEXT_RX,
  readMode, readUrl, readContact, buildText,
}
