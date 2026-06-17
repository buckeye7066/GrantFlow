/**
 * yanaBlockerClassifier.js
 *
 * Pure, deterministic blocker classifier. Given an arbitrary blocker
 * signal — text from a portal page, an engine `blocker_kind`, or a
 * preflight finding — returns one of fifteen canonical categories
 * defined by the Hard-Stop Resolver spec.
 *
 *   01 missing_required_information
 *   02 missing_required_document
 *   03 login_required
 *   04 sso_required
 *   05 two_factor_required
 *   06 captcha_required
 *   07 payment_required
 *   08 wet_signature_required
 *   09 legal_attestation_required
 *   10 portal_terms_block
 *   11 portal_anti_bot_block
 *   12 ambiguous_required_field
 *   13 final_review_screen
 *   14 deadline_expired
 *   15 unknown_application_method
 *
 * The classifier never throws. Unrecognised inputs come back as
 * `category='unknown'` so callers can always surface them in the
 * audit trail without a try/catch.
 */

export const BLOCKER_CATEGORIES = Object.freeze([
  'missing_required_information',
  'missing_required_document',
  'login_required',
  'sso_required',
  'two_factor_required',
  'captcha_required',
  'payment_required',
  'wet_signature_required',
  'legal_attestation_required',
  'portal_terms_block',
  'portal_anti_bot_block',
  'ambiguous_required_field',
  'final_review_screen',
  'deadline_expired',
  'unknown_application_method',
])

// Mapping from raw engine `blocker_kind` strings to canonical categories.
const ENGINE_KIND_MAP = Object.freeze({
  login: 'login_required',
  sso: 'sso_required',
  '2fa': 'two_factor_required',
  two_factor: 'two_factor_required',
  captcha: 'captcha_required',
  payment: 'payment_required',
  signature: 'wet_signature_required',
  attestation: 'legal_attestation_required',
  validation: 'ambiguous_required_field',
  no_progress: 'unknown_application_method',
  too_many_pages: 'portal_anti_bot_block',
  click_failed: 'portal_anti_bot_block',
  preflight: 'missing_required_information',
})

const TEXT_RULES = Object.freeze([
  // login / sso first — order matters because /login/ would otherwise
  // match generic auth text before SSO is detected.
  { rx: /\b(shibboleth|cas\b|sso\b|single\s*sign[-\s]*on|university\s*login|school\s*login|google\s*sign[-\s]*in|microsoft\s*login|clever\s*login|sign\s*in\s*with\s*google|sign\s*in\s*with\s*microsoft)\b/i, category: 'sso_required' },
  { rx: /\b(2fa|two[-\s]*factor|multi[-\s]*factor|otp\b|one[-\s]*time\s*code|authenticator|verification\s*code|push\s*notification|hardware\s*key|security\s*key|sms\s*code|email\s*code)\b/i, category: 'two_factor_required' },
  { rx: /\b(g[-\s]?recaptcha|recaptcha|hcaptcha|captcha|i'?m\s*not\s*a\s*robot|cloudflare\s*challenge|bot\s*challenge|prove\s*you'?re\s*human|image\s*puzzle)\b/i, category: 'captcha_required' },
  { rx: /\b(application\s*fee|transcript\s*fee|portal\s*fee|test\s*score\s*send\s*fee|submission\s*fee|processing\s*fee|payment\s*required|fee\s*of|\$[0-9]+\.\d{2})\b/i, category: 'payment_required' },
  { rx: /\b(wet\s*signature|hand[-\s]*written\s*signature|notarized?|signed\s*in\s*ink|original\s*signature|sign\s*and\s*mail)\b/i, category: 'wet_signature_required' },
  { rx: /\b(electronic\s*signature|e[-\s]?signature|sign\s*here|sign\s*below|penalty\s*of\s*perjury|under\s*oath|i\s*certify|i\s*swear|i\s*understand|i\s*am\s*the\s*applicant|legal\s*attestation|i\s*affirm|i\s*declare\s*under\s*penalty)\b/i, category: 'legal_attestation_required' },
  { rx: /(automated\s*(submissions?|access|completion)|automation)\s*(is\s+|are\s+)?(prohibit|forbid|not\s*permit|not\s*allow)|no\s*bots?\s*allowed|robots\s*not\s*allowed|terms\s*of\s*service\s*prohibit|third[-\s]*party\s*agent\s*submission/i, category: 'portal_terms_block' },
  { rx: /\b(access\s*denied|forbidden|too\s*many\s*requests|rate[-\s]*limit|blocked\s*for\s*automated|cloudflare\s*ray\s*id|akamai|imperva|datadome|perimeterx)\b/i, category: 'portal_anti_bot_block' },
  { rx: /\b(deadline\s*has\s*passed|application\s*closed|no\s*longer\s*accepting|past\s*due|submissions\s*closed|expired)\b/i, category: 'deadline_expired' },
  { rx: /\b(review\s*and\s*submit|application\s*review|final\s*review|review\s*your\s*application|please\s*review)\b/i, category: 'final_review_screen' },
  { rx: /\b(transcript|tax\s*return|tax\s*form|w[-\s]?2|fafsa\s*confirmation|acceptance\s*letter|recommendation\s*letter|letter\s*of\s*recommendation|resume|cv\b|government\s*id|driver'?s\s*license|passport|proof\s*of\s*residence|utility\s*bill|birth\s*certificate)\b/i, category: 'missing_required_document' },
  { rx: /\b(login\s*required|password|sign\s*in|log\s*in\s*to\s*continue|please\s*authenticate|account\s*credentials)\b/i, category: 'login_required' },
])

function safeText(v) {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'object') {
    try { return JSON.stringify(v) } catch { return String(v) }
  }
  return String(v)
}

/**
 * Classify a blocker signal.
 *
 * @param {object} input
 * @param {string} [input.kind]     engine `blocker_kind` (login, 2fa, ...)
 * @param {string} [input.text]     captured page text or label
 * @param {string} [input.detail]   engine `blocker_detail`
 * @param {string} [input.url]      current page URL
 * @param {object} [input.context]  arbitrary structured context
 * @returns {{
 *   category: string,
 *   confidence: number,
 *   reasons: string[],
 *   source: 'engine'|'text'|'preflight'|'unknown',
 *   raw: object
 * }}
 */
export function classifyBlocker(input = {}) {
  const reasons = []
  const text = `${safeText(input.text)} ${safeText(input.detail)} ${safeText(input.url)}`.trim()

  // 1. Engine kind takes precedence — it's already structured.
  if (input.kind && ENGINE_KIND_MAP[input.kind]) {
    const cat = ENGINE_KIND_MAP[input.kind]
    reasons.push(`engine_kind=${input.kind}`)
    return {
      category: cat,
      confidence: 0.95,
      reasons,
      source: 'engine',
      raw: input,
    }
  }

  // 2. Preflight inputs are pre-categorised.
  if (input.kind === 'missing_field' || input.kind === 'missing_required_field') {
    return { category: 'missing_required_information', confidence: 0.95, reasons: ['preflight_missing_field'], source: 'preflight', raw: input }
  }
  if (input.kind === 'missing_document' || input.kind === 'missing_required_document') {
    return { category: 'missing_required_document', confidence: 0.95, reasons: ['preflight_missing_document'], source: 'preflight', raw: input }
  }
  if (input.kind === 'missing_url' || input.kind === 'missing_address' || input.kind === 'missing_email' || input.kind === 'missing_fax') {
    return { category: 'unknown_application_method', confidence: 0.9, reasons: [`preflight_${input.kind}`], source: 'preflight', raw: input }
  }
  if (input.kind === 'missing_authorization') {
    return { category: 'legal_attestation_required', confidence: 0.85, reasons: ['preflight_missing_authorization'], source: 'preflight', raw: input }
  }
  if (input.kind === 'deadline_expired' || input.kind === 'expired') {
    return { category: 'deadline_expired', confidence: 0.95, reasons: ['preflight_deadline_expired'], source: 'preflight', raw: input }
  }

  // 3. Text rules — first match wins.
  if (text) {
    for (const rule of TEXT_RULES) {
      if (rule.rx.test(text)) {
        reasons.push(`text_match:${rule.category}`)
        return {
          category: rule.category,
          confidence: 0.85,
          reasons,
          source: 'text',
          raw: input,
        }
      }
    }
  }

  return {
    category: 'unknown',
    confidence: 0.2,
    reasons: ['no_signal_matched'],
    source: 'unknown',
    raw: input,
  }
}

/**
 * Bulk classify a list of preflight findings (from yanaPreflight).
 * Returns an array of classification objects, one per input.
 */
export function classifyPreflightFindings(findings = []) {
  return (findings || []).map((f) => classifyBlocker({
    kind: f.kind,
    text: f.label,
    detail: f.detail,
    context: f,
  }))
}

export const _internal = { ENGINE_KIND_MAP, TEXT_RULES }
