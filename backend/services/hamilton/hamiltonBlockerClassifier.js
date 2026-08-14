/**
 * hamiltonBlockerClassifier.js
 *
 * Pure, deterministic blocker classifier. Given an arbitrary blocker
 * signal — text from a portal page, an engine `blocker_kind`, or a
 * preflight finding — returns one of the canonical categories
 * defined by the Hard-Stop Resolver spec.
 *
 *   01 missing_required_information
 *   02 missing_required_document
 *   03 login_required
 *   04 sso_required
 *   05 two_factor_required
 *   06 captcha_required
 *   07 payment_required
 *   08 wet_signature_required        (hand-written / notarized — print & sign)
 *   09 digital_signature_required    (e-sign in the portal — user must sign)
 *   10 legal_attestation_required    (certify under penalty / oath — judgment)
 *   11 portal_terms_block
 *   12 portal_anti_bot_block
 *   13 ambiguous_required_field
 *   14 final_review_screen
 *   15 deadline_expired
 *   16 unknown_application_method
 *   17 portal_unreachable            (DNS/connection/navigation failure — the
 *                                     site is down or the stored URL is dead)
 *
 * 08/09/10 are deliberately distinct: a wet signature needs ink, a digital
 * signature needs the applicant to e-sign (Hamilton never forges either), and
 * an attestation needs fresh personal/legal judgment — different hard stops,
 * different resolutions.
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
  'digital_signature_required',
  'legal_attestation_required',
  'portal_terms_block',
  'portal_anti_bot_block',
  'ambiguous_required_field',
  'final_review_screen',
  'deadline_expired',
  'unknown_application_method',
  'portal_unreachable',
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
  digital_signature: 'digital_signature_required',
  esignature: 'digital_signature_required',
  e_signature: 'digital_signature_required',
  attestation: 'legal_attestation_required',
  validation: 'ambiguous_required_field',
  no_progress: 'unknown_application_method',
  // Informational page with no application form (engine's submit-hunt
  // truthfulness gate) — same degrade path as no_progress: the resolver
  // produces the manual funder-contact packet.
  no_application_form: 'unknown_application_method',
  too_many_pages: 'portal_anti_bot_block',
  click_failed: 'portal_anti_bot_block',
  // Full-page bot-protection interstitial (Cloudflare managed challenge / Akamai
  // / DataDome) that replaced the app before it loaded. Distinct from `captcha`
  // (an embedded widget on a real page): the whole site is refusing our
  // datacenter browser, so the resolution is human-driven side-by-side co-browse.
  bot_protected: 'portal_anti_bot_block',
  preflight: 'missing_required_information',
  portal_unreachable: 'portal_unreachable',
})

const TEXT_RULES = Object.freeze([
  // Network/navigation failures first — a raw Playwright/Chromium error string
  // (net::ERR_*, ENOTFOUND, navigation timeout) is unambiguous and must never
  // fall through to `unknown` ("Hamilton could not classify this blocker:
  // page.goto: net::ERR_NAME_NOT_RESOLVED" reached users verbatim).
  { rx: /net::ERR_[A-Z_]+|\b(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH)\b|getaddrinfo|name\s*not\s*resolved|page\.goto.*?(timeout|exceeded)|navigation\s*(timeout|failed)/i, category: 'portal_unreachable' },
  // login / sso next — order matters because /login/ would otherwise
  // match generic auth text before SSO is detected.
  { rx: /\b(shibboleth|cas\b|sso\b|single\s*sign[-\s]*on|university\s*login|school\s*login|google\s*sign[-\s]*in|microsoft\s*login|clever\s*login|sign\s*in\s*with\s*google|sign\s*in\s*with\s*microsoft)\b/i, category: 'sso_required' },
  { rx: /\b(2fa|two[-\s]*factor|multi[-\s]*factor|otp\b|one[-\s]*time\s*code|authenticator|verification\s*code|push\s*notification|hardware\s*key|security\s*key|sms\s*code|email\s*code)\b/i, category: 'two_factor_required' },
  // Vendor-agnostic (owner: captchas change; detection must generalize):
  // named vendors + the phrasings human-verification widgets share.
  { rx: /\b(g[-\s]?recaptcha|recaptcha|hcaptcha|captcha|turnstile|funcaptcha|arkose|i'?m\s*not\s*a\s*robot|cloudflare\s*challenge|bot\s*challenge|prove\s*(that\s*)?you'?re\s*(a\s*)?human|verify\s*(that\s*)?you\s*are\s*(a\s*)?human|checking\s*your\s*browser|image\s*puzzle|slide\s*to\s*verify|select\s*all\s*(the\s*)?(images|squares)|challenge[-\s]platform)\b/i, category: 'captcha_required' },
  { rx: /\b(application\s*fee|transcript\s*fee|portal\s*fee|test\s*score\s*send\s*fee|submission\s*fee|processing\s*fee|payment\s*required|fee\s*of|\$[0-9]+\.\d{2})\b/i, category: 'payment_required' },
  { rx: /\b(wet\s*signature|hand[-\s]*written\s*signature|notarized?|signed\s*in\s*ink|original\s*signature|sign\s*and\s*mail)\b/i, category: 'wet_signature_required' },
  // Digital/e-signature must be checked BEFORE attestation: it's a signature
  // action the applicant performs in the portal, distinct from certifying a
  // legal statement. Hamilton never applies it on the user's behalf.
  { rx: /\b(electronic\s*signature|e[-\s]?signature|e[-\s]?sign\b|digital\s*signature|sign\s*here|sign\s*below|docusign|adobe\s*sign|hellosign|type\s*your\s*name\s*to\s*sign|draw\s*your\s*signature)\b/i, category: 'digital_signature_required' },
  { rx: /\b(penalty\s*of\s*perjury|under\s*oath|i\s*certify|i\s*swear|i\s*understand|i\s*am\s*the\s*applicant|legal\s*attestation|i\s*affirm|i\s*declare\s*under\s*penalty)\b/i, category: 'legal_attestation_required' },
  { rx: /(automated\s*(submissions?|access|completion)|automation)\s*(is\s+|are\s+)?(prohibit|forbid|not\s*permit|not\s*allow)|no\s*bots?\s*allowed|robots\s*not\s*allowed|terms\s*of\s*service\s*prohibit|third[-\s]*party\s*agent\s*submission/i, category: 'portal_terms_block' },
  { rx: /\b(access\s*denied|forbidden|too\s*many\s*requests|rate[-\s]*limit|blocked\s*for\s*automated|cloudflare\s*ray\s*id|akamai|imperva|datadome|perimeterx)\b/i, category: 'portal_anti_bot_block' },
  // A DEAD SESSION IS NOT A DEAD DEADLINE (2026-08-14). `TEXT_RULES` is
  // first-match-wins, and the deadline rule below used to carry a BARE
  // `expired` alternative — so every "Your session has expired, please sign in
  // again" page classified `deadline_expired` and the `login_required` rule at
  // the bottom of this list was unreachable for it. Two harms, both measured:
  //  (1) `hamiltonSessionKeepAlive` treats `deadline_expired` as neither an
  //      auth challenge nor inconclusive, so a portal that had just SAID the
  //      session was dead fell through to the re-persist branch, returned
  //      `refreshed`, and stamped `keepalive_confirmed_alive_at` — the exact
  //      manufactured liveness that module exists to prevent.
  //  (2) `hamiltonHardStopResolver` told the owner "the application deadline
  //      has passed … Hamilton suggests related opportunities and stops on
  //      this one" and set `required_action: 'find_alternate'` — abandoning a
  //      LIVE opportunity whose real fix is one sign-in.
  // Session wording is therefore claimed FIRST, and `expired` only counts as a
  // deadline when the thing that expired is the application/opportunity.
  { rx: /\b(session\s*(?:has\s*)?(?:is\s*)?expired|session\s*timed?\s*out|session\s*timeout|logged\s*out\s*due\s*to\s*inactivity|signed?\s*out\s*for\s*(?:your\s*)?security|your\s*login\s*session)\b/i, category: 'login_required' },
  { rx: /\b(deadline\s*has\s*passed|application\s*closed|no\s*longer\s*accepting|past\s*due|submissions\s*closed|(?:application|submission|opportunity|deadline|posting|competition)\s*(?:has\s*)?expired|expired\s*(?:on|deadline))\b/i, category: 'deadline_expired' },
  { rx: /\b(review\s*and\s*submit|application\s*review|final\s*review|review\s*your\s*application|please\s*review)\b/i, category: 'final_review_screen' },
  { rx: /\b(transcript|tax\s*return|tax\s*form|w[-\s]?2|fafsa\s*confirmation|acceptance\s*letter|recommendation\s*letter|letter\s*of\s*recommendation|resume|cv\b|government\s*id|driver'?s\s*license|passport|proof\s*of\s*residence|utility\s*bill|birth\s*certificate)\b/i, category: 'missing_required_document' },
  { rx: /\b(login\s*required|password|sign\s*in|log\s*in\s*to\s*continue|please\s*authenticate|account\s*credentials)\b/i, category: 'login_required' },
])

// A STABLE server-side wall: the funder's infrastructure is deliberately
// refusing our datacenter browser (WAF/anti-bot/IP-reputation), as opposed to
// the site being transiently down or the URL being wrong. This is the signal
// the portal-policy registry learns from so Hamilton stops re-launching a
// browser that will just be refused again.
//
// Kept SEPARATE from classifyBlocker's category because the classifier maps
// every `net::ERR_*` to `portal_unreachable` (correct for its purpose), but for
// LEARNING a wall we must tell a WAF connection-reset (ERR_HTTP2_PROTOCOL_ERROR
// — what studentaid.gov threw at our datacenter) apart from a real outage
// (ERR_NAME_NOT_RESOLVED, ERR_CONNECTION_TIMED_OUT). Over-learning a transient
// outage as a permanent wall would wrongly retire a working portal.
const SERVER_WALL_RX =
  /\b(access\s*denied|forbidden|akamai|imperva|datadome|perimeterx|cloudflare\s*ray|blocked\s*for\s*automated|too\s*many\s*requests|rate[-\s]*limit)\b|\bERR_HTTP2_PROTOCOL_ERROR\b|(^|\D)(403|429)(\D|$)/i
// Signals that are an OUTAGE / bad URL, never a bot wall — an explicit
// exclusion so a future edit to SERVER_WALL_RX can't accidentally swallow them.
const TRANSIENT_OUTAGE_RX =
  /\b(ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_TIMED_OUT|ERR_CONNECTION_REFUSED|ERR_ADDRESS_UNREACHABLE|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH)\b|getaddrinfo|name\s*not\s*resolved/i

/**
 * True when `text` (a navigation error detail / captured page text) is a STABLE
 * server-side wall worth learning — not a transient outage. Pure, never throws.
 */
export function isServerWallSignal(text) {
  const s = safeText(text)
  if (!s) return false
  if (TRANSIENT_OUTAGE_RX.test(s)) return false
  return SERVER_WALL_RX.test(s)
}

function safeText(v) {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'object') {
    try { return JSON.stringify(v) } catch { return String(v) }
  }
  return String(v)
}

/**
 * The signature/attestation slice of TEXT_RULES, in that list's own order
 * (wet -> digital -> legal attestation). Derived, never re-typed, so a change
 * to the shared vocabulary cannot leave this refinement behind.
 */
const SIGNATURE_REFINEMENT_RULES = TEXT_RULES.filter((rule) => (
  rule.category === 'wet_signature_required' ||
  rule.category === 'digital_signature_required' ||
  rule.category === 'legal_attestation_required'
))

/**
 * The portal's OWN field label out of the engine's signature detail. The detail
 * is `Wet/digital signature attestation present: "<label>"`; that boilerplate
 * prefix contains the phrase "digital signature", so only the quoted span is
 * evidence about the portal. Falls back to `input.text` when there is no quote
 * (a hand-built or future detail shape) — never to the whole detail.
 */
function signatureEvidenceText(input = {}) {
  const detail = safeText(input.detail)
  const quoted = detail.match(/"([^"]*)"/)
  const label = quoted ? quoted[1] : ''
  return `${safeText(input.text)} ${label}`.trim()
}

/**
 * Refine an ambiguous `kind:'signature'` blocker from the portal's own field
 * label. Returns a category, or null when the label proves nothing.
 */
function refineSignatureCategory(input = {}) {
  const evidence = signatureEvidenceText(input)
  if (!evidence) return null
  for (const rule of SIGNATURE_REFINEMENT_RULES) {
    if (rule.rx.test(evidence)) return rule.category
  }
  return null
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

  // 0. AMBIGUOUS ENGINE KIND: `signature` (2026-08-14).
  //
  // `hamiltonAutopilotEngine.detectAttestationGate` emits ONE kind,
  // `signature`, for every member of its `HARD_ATTESTATION_PATTERNS` list —
  // and that list is `electronic signature`, `sign here|below|name`,
  // `penalty of perjury`, `under oath`, `digital signature`. NOT ONE of them
  // is wet-ink evidence, yet `ENGINE_KIND_MAP` resolved the ambiguity to
  // `wet_signature_required`, whose resolver returns `degraded(...)`. That is
  // not an alerting outcome, so the run built a MAILING packet, set the task
  // `waiting_for_review`, and recorded the autopilot run `completed` —
  // reporting success while handing the owner instructions that cannot finish
  // an in-portal e-signature, with no portal URL. The correct branch,
  // `resolveDigitalSignature`, escalates (`ask_user_to_esign`) and keeps the
  // task resumable.
  //
  // The engine's detail carries the portal's OWN field label inside quotes
  // (`Wet/digital signature attestation present: "<label>"`). Only that label
  // is evidence — the boilerplate prefix literally contains the words
  // "digital signature", so testing the whole detail would flip every blocker
  // the other way. Refinement uses the SAME vocabulary the text path already
  // uses, in the same precedence, so it can only ever be more precise; when
  // the label says nothing the historical `wet` default is kept.
  if (input.kind === 'signature') {
    const refined = refineSignatureCategory(input)
    if (refined && refined !== ENGINE_KIND_MAP.signature) {
      return {
        category: refined,
        confidence: 0.9,
        reasons: ['engine_kind=signature', 'refined_from_portal_field_label'],
        source: 'engine',
        raw: input,
      }
    }
  }

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
 * Bulk classify a list of preflight findings (from hamiltonPreflight).
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
