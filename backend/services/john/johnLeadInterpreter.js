/**
 * John — lead interpreter.
 *
 * Pure functions that take a Yana lead packet and pull out the pieces John
 * needs to write a personalized email:
 *   - the best contact point (preferring named role-based emails)
 *   - the most specific public-evidence hook
 *   - a salutation
 *   - normalised facts about the organisation
 *
 * No I/O, no state. Easy to unit test.
 */

import { isValidEmail } from './johnOutreachSafety.js'

export const DEFAULT_SALUTATION = 'Hello,'

const ROLE_PREFERENCE = [
  'executive director',
  'pastor',
  'principal',
  'chief',
  'fire chief',
  'superintendent',
  'director',
  'president',
  'chair',
  'manager',
  'coordinator',
  'office manager',
  'secretary',
]

const ROLE_SALUTATIONS = [
  { pattern: /\b(?:fire\s+)?chief\b/i, salutation: 'Hello Chief,' },
  { pattern: /\bpastor\b/i, salutation: 'Hello Pastor,' },
  { pattern: /\bprincipal\b/i, salutation: 'Hello Principal,' },
  { pattern: /\bsuperintendent\b/i, salutation: 'Hello Superintendent,' },
]

const PROFESSIONAL_TITLES = new Map([
  ['dr', 'Dr.'],
  ['doctor', 'Dr.'],
  ['rev', 'Rev.'],
  ['reverend', 'Rev.'],
  ['pastor', 'Pastor'],
  ['chief', 'Chief'],
  ['fr', 'Fr.'],
  ['father', 'Fr.'],
  ['rabbi', 'Rabbi'],
  ['principal', 'Principal'],
])

const SOCIAL_HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss'])
const GENERIC_NAME_TOKENS = new Set(['admin', 'contact', 'hello', 'info', 'office', 'staff', 'team'])

function rolePriority(role) {
  if (!role) return 99
  const lower = String(role).toLowerCase()
  for (let i = 0; i < ROLE_PREFERENCE.length; i++) {
    if (lower.includes(ROLE_PREFERENCE[i])) return i
  }
  return 50
}

function salutationFromRole(contact) {
  const role = String(contact?.role || '').trim()
  if (!role) return DEFAULT_SALUTATION
  for (const { pattern, salutation } of ROLE_SALUTATIONS) {
    if (pattern.test(role)) return salutation
  }
  return DEFAULT_SALUTATION
}

function cleanNameToken(token) {
  return String(token || '').replace(/[^A-Za-z'-]/g, '')
}

function buildTitledSalutation(tokens) {
  if (!tokens.length) return null
  const key = cleanNameToken(tokens[0]).toLowerCase()

  if (SOCIAL_HONORIFICS.has(key)) {
    const first = cleanNameToken(tokens[1])
    return first && first.length >= 2 ? `Hello ${first},` : null
  }

  const displayTitle = PROFESSIONAL_TITLES.get(key)
  if (!displayTitle || tokens.length < 2) return null

  const rest = tokens
    .slice(1)
    .map(cleanNameToken)
    .filter(Boolean)
    .slice(0, 3)

  if (!rest.length) return null
  return `Hello ${displayTitle} ${rest.join(' ')},`
}

/**
 * Pick the highest-priority valid email contact from a Yana lead packet.
 * Yana contact_points entries look like:
 *   { type: 'email', value: 'pastor@church.org', name: 'Pastor Smith', role: 'Pastor', confidence: 0.9 }
 *
 * We refuse to draft to "info@", "noreply@", "donotreply@" addresses unless
 * that is literally the only email present and the lead's contact_confidence
 * is above 0.6 — in which case we still surface it, but flag a warning so
 * Dr. White sees it during review.
 */
export function selectContactPoint(lead) {
  const pts = Array.isArray(lead?.contact_points) ? lead.contact_points : []
  const emails = pts.filter(
    (p) => p && (p.type === 'email' || p.type === 'mailto') && isValidEmail(p.value || p.email)
  )
  if (emails.length === 0) {
    return { ok: false, reason: 'no_email_contact_point' }
  }

  // Score: lower is better. Bonus for non-generic addresses.
  const scored = emails.map((p) => {
    const value = (p.value || p.email).trim()
    const local = value.split('@')[0].toLowerCase()
    const generic =
      ['info', 'contact', 'office', 'admin', 'hello', 'noreply', 'no-reply', 'donotreply'].includes(local)
    let score = rolePriority(p.role) * 10
    if (generic) score += 100
    if (typeof p.confidence === 'number') score -= Math.round(p.confidence * 10)
    return { p, value, generic, score }
  })

  scored.sort((a, b) => a.score - b.score)
  const best = scored[0]
  const warnings = []
  if (best.generic) warnings.push('generic_address_used')

  return {
    ok: true,
    email: best.value,
    name: best.p.name || null,
    role: best.p.role || null,
    confidence: typeof best.p.confidence === 'number' ? best.p.confidence : null,
    generic: best.generic,
    warnings,
  }
}

/**
 * Pick the most specific evidence string we can use as the "what caught my
 * attention" hook. Prefers items with a source_url and a project / need
 * description over generic sector labels.
 */
export function selectEvidenceHook(lead) {
  const evidence = Array.isArray(lead?.public_evidence) ? lead.public_evidence : []
  if (evidence.length === 0) return null
  const scored = evidence
    .map((e) => {
      if (!e) return null
      if (typeof e === 'string') {
        return { text: e, source: null, score: 50 }
      }
      const text = e.summary || e.text || e.headline || e.description || ''
      if (!text) return null
      const src = e.source_url || e.url || null
      let score = 50
      if (src) score -= 20
      if (text.length > 30) score -= 10
      if (e.specificity === 'high' || e.high_specificity) score -= 15
      return { text, source: src, score }
    })
    .filter(Boolean)
  if (scored.length === 0) return null
  scored.sort((a, b) => a.score - b.score)
  return scored[0]
}

/**
 * Returns a short, professional salutation. Uses a safe first name or title/name
 * when Yana provided one; otherwise falls back to a neutral "Hello," instead of
 * a generic team greeting. Role-based fallbacks are only used when they read
 * naturally (for example, Pastor, Chief, Principal, Superintendent).
 */
export function buildSalutation(contact) {
  if (!contact || !contact.name) return salutationFromRole(contact)

  const trimmed = String(contact.name).trim()
  if (!trimmed) return salutationFromRole(contact)
  if (trimmed.includes('@') || trimmed.length > 60) return salutationFromRole(contact)

  // Keep a safe title/name before role suffixes like "Chief Allen, Fire Chief".
  const primary = trimmed.split(',')[0].trim()
  if (!primary || /\b(and|or)\b/i.test(primary) || /[;&/]/.test(primary)) {
    return salutationFromRole(contact)
  }

  const tokens = primary.split(/\s+/).map(cleanNameToken).filter(Boolean)
  if (!tokens.length || tokens.some((t) => t.length > 30)) return salutationFromRole(contact)

  if (tokens.length === 1 && GENERIC_NAME_TOKENS.has(tokens[0].toLowerCase())) {
    return salutationFromRole(contact)
  }

  const titled = buildTitledSalutation(tokens)
  if (titled) return titled

  const first = tokens[0]
  if (!first || first.length < 2) return salutationFromRole(contact)
  return `Hello ${first},`
}

/**
 * Compose a full interpretation result the email writer can consume.
 */
export function interpretLead(lead) {
  const contact = selectContactPoint(lead)
  const evidence = selectEvidenceHook(lead)
  return {
    ok: contact.ok && !!evidence,
    contact,
    evidence,
    salutation: contact.ok ? buildSalutation(contact) : DEFAULT_SALUTATION,
    organization_name: lead?.organization_name || null,
    organization_type: lead?.organization_type || null,
    location: lead?.location || null,
    funding_need_summary: lead?.funding_need_summary || null,
    grantflow_fit_summary: lead?.grantflow_fit_summary || null,
    recommended_outreach_angle: lead?.recommended_outreach_angle || null,
  }
}
