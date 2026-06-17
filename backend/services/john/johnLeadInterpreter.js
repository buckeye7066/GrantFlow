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

function rolePriority(role) {
  if (!role) return 99
  const lower = String(role).toLowerCase()
  for (let i = 0; i < ROLE_PREFERENCE.length; i++) {
    if (lower.includes(ROLE_PREFERENCE[i])) return i
  }
  return 50
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
 * Returns a short salutation. Uses the contact's first name if Yana
 * provided one and it looks safe; otherwise falls back to "Hi team," to
 * avoid awkwardly including a role in the greeting.
 */
export function buildSalutation(contact) {
  if (!contact || !contact.name) return 'Hi team,'
  const trimmed = String(contact.name).trim()
  if (!trimmed) return 'Hi team,'
  // If the name looks like an email, role string, or list, fall back.
  if (trimmed.includes('@') || trimmed.includes(',') || trimmed.length > 60) {
    return 'Hi team,'
  }
  // Use only the first whitespace-delimited token; strip honorifics.
  const first = trimmed
    .split(/\s+/)[0]
    .replace(/[^A-Za-z'-]/g, '')
  if (!first || first.length < 2) return 'Hi team,'
  const HONORIFICS = ['mr', 'mrs', 'ms', 'dr', 'rev', 'pastor', 'fr', 'sr']
  const lower = first.toLowerCase()
  if (HONORIFICS.includes(lower)) {
    // Use the next token if available.
    const next = trimmed.split(/\s+/)[1]?.replace(/[^A-Za-z'-]/g, '')
    if (next && next.length >= 2) return `Hi ${next},`
    return 'Hi team,'
  }
  return `Hi ${first},`
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
    salutation: contact.ok ? buildSalutation(contact) : 'Hi team,',
    organization_name: lead?.organization_name || null,
    organization_type: lead?.organization_type || null,
    location: lead?.location || null,
    funding_need_summary: lead?.funding_need_summary || null,
    grantflow_fit_summary: lead?.grantflow_fit_summary || null,
    recommended_outreach_angle: lead?.recommended_outreach_angle || null,
  }
}
