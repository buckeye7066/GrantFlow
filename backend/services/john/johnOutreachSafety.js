/**
 * John — outreach safety + environment configuration.
 *
 * This module is the single source of truth for John's safety posture:
 *   - reads JOHN_* environment variables with strict defaults
 *   - classifies email addresses, domains, subjects, and bodies
 *   - exposes pure predicates the agent uses as pre-flight checks
 *
 * Strict defaults: disabled, observe-mode, draft-only, send blocked.
 *
 * No I/O happens at import time. `getJohnConfig()` re-reads env on every call
 * so tests and admin endpoints can mutate `process.env` and observe changes.
 */

import { BLOCK_REASONS, SAFETY_STATUS, makeSafetyReport } from './johnTypes.js'

export function readEnvBool(name, fallback = false) {
  const raw = process.env[name]
  if (raw === undefined || raw === null) return fallback
  const v = String(raw).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(v)) return true
  if (['0', 'false', 'no', 'off', 'disabled'].includes(v)) return false
  return fallback
}

export function readEnvInt(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === null || raw === '') return fallback
  const parsed = Number.parseInt(String(raw), 10)
  if (Number.isNaN(parsed)) return fallback
  return parsed
}

export function readEnvString(name, fallback = '') {
  const raw = process.env[name]
  if (raw === undefined || raw === null) return fallback
  return String(raw)
}

/**
 * Centralised configuration. Defaults are deliberately conservative:
 *   - JOHN_ENABLED            false
 *   - JOHN_MODE               observe
 *   - JOHN_DRAFT_ONLY         true
 *   - JOHN_ALLOW_SEND         false  (can never be flipped to true in
 *                                     this version — see assertDraftOnly)
 *   - JOHN_MAX_DRAFTS_PER_24H 50
 *   - JOHN_MAX_DRAFTS_PER_RUN 50
 *   - JOHN_MAX_DRAFTS_PER_HOUR 10
 *   - JOHN_MIN_LEAD_SCORE     70
 */
export function getJohnConfig() {
  const draftOnly = readEnvBool('JOHN_DRAFT_ONLY', true)
  const allowSendRaw = readEnvBool('JOHN_ALLOW_SEND', false)
  return {
    enabled: readEnvBool('JOHN_ENABLED', false),
    runOnStartup: readEnvBool('JOHN_RUN_ON_STARTUP', false),
    runOnSchedule: readEnvBool('JOHN_RUN_ON_SCHEDULE', false),
    schedule: readEnvString('JOHN_SCHEDULE', '30 9 * * *'),
    mode: readEnvString('JOHN_MODE', 'observe'),

    primaryMailbox: readEnvString(
      'JOHN_PRIMARY_MAILBOX',
      'dr.johnwhite@axiombiolabs.org'
    ),
    fromAlias: readEnvString('JOHN_FROM_ALIAS', 'GrantFlow@axiombiolabs.org'),
    replyTo: readEnvString('JOHN_REPLY_TO', 'GrantFlow@axiombiolabs.org'),
    displayName: readEnvString('JOHN_DISPLAY_NAME', 'Dr. John White | GrantFlow'),

    draftOnly: draftOnly,
    // John is draft-only in this version. Even if an operator flips
    // JOHN_ALLOW_SEND=true and JOHN_DRAFT_ONLY=false, the runtime asserts
    // draft-only via assertDraftOnly(). The flag is exposed so the admin UI
    // and tests can inspect what the operator *requested*.
    allowSend: allowSendRaw && !draftOnly,
    requireHumanReview: readEnvBool('JOHN_REQUIRE_HUMAN_REVIEW', true),

    maxDraftsPer24h: readEnvInt('JOHN_MAX_DRAFTS_PER_24H', 50),
    maxDraftsPerRun: readEnvInt('JOHN_MAX_DRAFTS_PER_RUN', 50),
    maxDraftsPerHour: readEnvInt('JOHN_MAX_DRAFTS_PER_HOUR', 10),

    minLeadScore: readEnvInt('JOHN_MIN_LEAD_SCORE', 70),
    requireYanaQualified: readEnvBool('JOHN_REQUIRE_YANA_QUALIFIED', true),
    requirePublicEvidence: readEnvBool('JOHN_REQUIRE_PUBLIC_EVIDENCE', true),
    requireContactSource: readEnvBool('JOHN_REQUIRE_CONTACT_SOURCE', true),

    suppressionEnabled: readEnvBool('JOHN_SUPPRESSION_ENABLED', true),
    optOutLanguageRequired: readEnvBool('JOHN_OPT_OUT_LANGUAGE_REQUIRED', true),
    physicalAddressRequired: readEnvBool('JOHN_PHYSICAL_ADDRESS_REQUIRED', true),
    physicalAddress: readEnvString('JOHN_PHYSICAL_ADDRESS', ''),
    testRecipient: readEnvString(
      'JOHN_TEST_RECIPIENT',
      'dr.johnwhite@axiombiolabs.org'
    ),

    allowPrimaryMailboxFallbackDrafts: readEnvBool(
      'JOHN_ALLOW_PRIMARY_MAILBOX_FALLBACK_DRAFTS',
      true
    ),
    requireAliasReviewIfFallback: readEnvBool(
      'JOHN_REQUIRE_ALIAS_REVIEW_IF_FALLBACK',
      true
    ),

    msTenantId: readEnvString('MICROSOFT_TENANT_ID', ''),
    msClientId: readEnvString('MICROSOFT_CLIENT_ID', ''),
    msClientSecret: readEnvString('MICROSOFT_CLIENT_SECRET', ''),
    msRedirectUri: readEnvString('MICROSOFT_REDIRECT_URI', ''),
    msScopes: readEnvString(
      'MICROSOFT_GRAPH_SCOPES',
      'Mail.ReadWrite Mail.Send User.Read offline_access'
    ),
  }
}

export function assertDraftOnly(config = getJohnConfig()) {
  if (!config.draftOnly) {
    const err = new Error(
      'John runtime guard: JOHN_DRAFT_ONLY must be true. John never sends in this version.'
    )
    err.code = 'JOHN_DRAFT_ONLY_REQUIRED'
    throw err
  }
}

const SECRET_KEY_PATTERNS = [
  /(client[_-]?secret)/i,
  /(api[_-]?key)/i,
  /(access[_-]?token)/i,
  /(refresh[_-]?token)/i,
  /(bearer)/i,
  /(authorization)/i,
  /(password)/i,
]

/**
 * Mask anything that looks like a secret in arbitrary strings or objects.
 * Used by the Outlook provider and the agent so logs never leak credentials.
 */
export function maskSecrets(value) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
      .replace(/eyJ[A-Za-z0-9._-]{10,}/g, 'eyJ***')
  }
  if (Array.isArray(value)) return value.map(maskSecrets)
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      const isSecretKey = SECRET_KEY_PATTERNS.some((re) => re.test(k))
      if (isSecretKey && typeof v === 'string' && v.length > 0) {
        out[k] = '***'
      } else {
        out[k] = maskSecrets(v)
      }
    }
    return out
  }
  return value
}

const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i

export function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false
  return EMAIL_RE.test(email.trim())
}

export function emailDomain(email) {
  if (!isValidEmail(email)) return null
  return email.trim().split('@')[1].toLowerCase()
}

/**
 * Subjects John is forbidden from drafting. Lower-case for comparison.
 * These map directly to the BLOCK_REASONS.DECEPTIVE_SUBJECT category.
 */
const DECEPTIVE_SUBJECT_PATTERNS = [
  /you have been approved/i,
  /grant money waiting/i,
  /^urgent\b/i,
  /^re:\s/i, // John never sends a reply
  /\bguaranteed\b/i,
  /\bcongratulations\b/i,
  /your\s+grant\s+application/i,
]

const FUNDING_GUARANTEE_PATTERNS = [
  /\bguarantee(s|d)?\b/i,
  /\bensures?\b\s+funding/i,
  /\bwill\s+(get|receive|win|secure)\b\s+(grant|funding|money)/i,
  /\b100%\s+(approval|funding)/i,
  /\bapproved\s+for\s+funding\b/i,
  /you\s+(will|are)\s+approved/i,
]

const PRIOR_RELATIONSHIP_PATTERNS = [
  /\bas\s+(we|I)\s+discussed\b/i,
  /\bper\s+our\s+(call|meeting|conversation)\b/i,
  /\bfollowing\s+up\s+from\s+our\b/i,
  /\bnice\s+(meeting|talking)\s+(with\s+)?you/i,
]

const PREDATORY_PATTERNS = [
  /\bdesperate\b/i,
  /\blast\s+chance\b/i,
  /\bdon'?t\s+miss\s+out\b/i,
  /\byou\s+can'?t\s+afford\s+to\b/i,
]

export function classifySubject(subject) {
  const s = String(subject || '').trim()
  if (!s) {
    return { ok: false, reasons: [BLOCK_REASONS.DECEPTIVE_SUBJECT], detail: 'empty subject' }
  }
  for (const re of DECEPTIVE_SUBJECT_PATTERNS) {
    if (re.test(s)) {
      return {
        ok: false,
        reasons: [BLOCK_REASONS.DECEPTIVE_SUBJECT],
        detail: `subject matches blocked pattern ${re}`,
      }
    }
  }
  return { ok: true, reasons: [], detail: 'subject ok' }
}

const OPT_OUT_PHRASES = [
  'no thanks',
  'unsubscribe',
  'remove me',
  'i will not follow up',
  'reply',
  'opt out',
]

export function bodyHasOptOut(body) {
  const text = String(body || '').toLowerCase()
  return OPT_OUT_PHRASES.some((p) => text.includes(p))
}

export function classifyBody(body, { physicalAddress, requirePhysicalAddress } = {}) {
  const text = String(body || '')
  const reasons = []
  for (const re of FUNDING_GUARANTEE_PATTERNS) {
    if (re.test(text)) {
      reasons.push(BLOCK_REASONS.GUARANTEES_FUNDING)
      break
    }
  }
  for (const re of PRIOR_RELATIONSHIP_PATTERNS) {
    if (re.test(text)) {
      reasons.push(BLOCK_REASONS.CLAIMS_PRIOR_RELATIONSHIP)
      break
    }
  }
  for (const re of PREDATORY_PATTERNS) {
    if (re.test(text)) {
      reasons.push(BLOCK_REASONS.PREDATORY_TARGETING)
      break
    }
  }
  if (!bodyHasOptOut(text)) {
    reasons.push(BLOCK_REASONS.MISSING_OPT_OUT)
  }
  if (requirePhysicalAddress) {
    const addr = String(physicalAddress || '').trim()
    if (!addr || !text.includes(addr)) {
      reasons.push(BLOCK_REASONS.MISSING_PHYSICAL_ADDRESS)
    }
  }
  return { ok: reasons.length === 0, reasons }
}

/**
 * Final pre-flight gate that combines lead-quality, recipient validity,
 * suppression, and content classification. Returns a SafetyReport-shaped
 * object that callers persist on the draft and audit row.
 *
 * Inputs:
 *   - lead:           normalised Yana lead packet
 *   - draft:          { subject, body, recipient_email, recipient_name }
 *   - suppression:    { isSuppressed({type, value}) -> bool } (optional)
 *   - config:         from getJohnConfig() (optional, will read env if absent)
 *   - alreadyDrafted: boolean — true if Yana lead already has a John draft
 */
export function evaluateDraftSafety({
  lead,
  draft,
  suppression,
  config = getJohnConfig(),
  alreadyDrafted = false,
} = {}) {
  const reasons = []
  const warnings = []

  if (!lead || typeof lead !== 'object') {
    return makeSafetyReport({
      status: SAFETY_STATUS.BLOCKED,
      reasons: [BLOCK_REASONS.MISSING_PUBLIC_EVIDENCE],
    })
  }

  if (alreadyDrafted) reasons.push(BLOCK_REASONS.ALREADY_DRAFTED)

  if (config.requireYanaQualified && lead.qualified !== true) {
    reasons.push(BLOCK_REASONS.LEAD_NOT_QUALIFIED_BY_YANA)
  }

  if (
    typeof config.minLeadScore === 'number' &&
    typeof lead.lead_score === 'number' &&
    lead.lead_score < config.minLeadScore
  ) {
    reasons.push(BLOCK_REASONS.LOW_LEAD_SCORE)
  }

  if (Array.isArray(lead.do_not_contact_flags) && lead.do_not_contact_flags.length > 0) {
    reasons.push(BLOCK_REASONS.DO_NOT_CONTACT)
  }

  if (config.requirePublicEvidence) {
    const hasEvidence =
      Array.isArray(lead.public_evidence) && lead.public_evidence.length > 0
    if (!hasEvidence) reasons.push(BLOCK_REASONS.MISSING_PUBLIC_EVIDENCE)
  }

  if (config.requireContactSource) {
    const hasContactSource =
      Array.isArray(lead.source_urls) && lead.source_urls.length > 0
    if (!hasContactSource) reasons.push(BLOCK_REASONS.MISSING_CONTACT_SOURCE)
  }

  const recipientEmail = draft?.recipient_email || ''
  if (!recipientEmail) reasons.push(BLOCK_REASONS.MISSING_RECIPIENT)
  else if (!isValidEmail(recipientEmail)) reasons.push(BLOCK_REASONS.INVALID_RECIPIENT)

  if (config.suppressionEnabled && suppression && typeof suppression.isSuppressed === 'function') {
    if (recipientEmail && suppression.isSuppressed({ type: 'email', value: recipientEmail })) {
      reasons.push(BLOCK_REASONS.SUPPRESSED_EMAIL)
    }
    const dom = emailDomain(recipientEmail)
    if (dom && suppression.isSuppressed({ type: 'domain', value: dom })) {
      reasons.push(BLOCK_REASONS.SUPPRESSED_DOMAIN)
    }
    if (lead.organization_name && suppression.isSuppressed({ type: 'organization', value: lead.organization_name })) {
      reasons.push(BLOCK_REASONS.SUPPRESSED_ORG)
    }
  }

  const subj = classifySubject(draft?.subject)
  if (!subj.ok) reasons.push(...subj.reasons)

  const body = classifyBody(draft?.body, {
    physicalAddress: config.physicalAddress,
    requirePhysicalAddress: config.physicalAddressRequired,
  })
  if (!body.ok) reasons.push(...body.reasons)

  const status = reasons.length > 0 ? SAFETY_STATUS.BLOCKED : SAFETY_STATUS.PASSED
  return makeSafetyReport({ status, reasons, warnings })
}
