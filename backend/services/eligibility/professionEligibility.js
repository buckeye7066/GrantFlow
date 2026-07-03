/**
 * professionEligibility.js — profession-lock eligibility predicate.
 *
 * WHY THIS EXISTS
 * ---------------
 * Robert (a Tennessee PARAMEDIC student) had his Hamilton "Needs your input"
 * queue polluted with items like "Ohio Nurses Foundation — Continuing Education
 * Scholarships", "Texas/Florida Nurses Foundation", and "Nurse.org — Nursing
 * Scholarships". These are locked to a DIFFERENT licensed profession (nursing)
 * than the applicant is in. They leaked in because:
 *   - a free-text employment note ("400 hours in skilled nursing facilities")
 *     seeded a "nursing scholarships" open-web search (buildThesis interest
 *     seeds), and
 *   - nothing on the write path or in the boot sweep hard-gates an opportunity
 *     that is restricted to a profession the profile does not practise. The
 *     scorer only applies SOFT penalties; the pipeline-insert gate
 *     (applicantTypeGate) only knows individual/org/business; and these rows
 *     carry match_score IS NULL (doctrine-protected) so the relevance floor
 *     never touches them.
 *
 * THE RULE (high-precision, conservative)
 * ---------------------------------------
 * An opportunity that is LOCKED to a specific licensed profession X (nursing,
 * dentistry, pharmacy, …) is INELIGIBLE for a profile whose declared field is a
 * DIFFERENT recognised profession Y (X ≠ Y). We only ever reject when BOTH sides
 * resolve to a recognised, distinct profession:
 *   - If the opportunity is NOT clearly profession-locked → never reject.
 *   - If the profile's field is unknown / not a recognised profession → never
 *     reject (we cannot establish a mismatch, so we leave it alone).
 *   - If the profile already practises the locked profession → eligible.
 * This keeps false positives near-zero: a nursing scholarship is only ever
 * dropped from the pipeline of someone we can positively identify as being in a
 * different profession (e.g. a paramedic), never from a nurse, a nursing
 * student, or a profile with no declared field.
 *
 * IMPORTANT: the profile's profession is resolved ONLY from CURATED identity
 * fields (intended major, field of study, career goal, occupation) — NEVER from
 * free-text experience blurbs, so Robert's "skilled nursing facilities"
 * *experience* does not misidentify him as a nurse.
 *
 * Symmetrically, the OPPORTUNITY lock is detected ONLY from its IDENTITY (title +
 * funder), NEVER from its description/notes. A profession-restricted program
 * names the profession in its title ("Ohio Nurses Foundation", "NASW — Social
 * Work CE"); an incidental mention in a description (a general WIOA training fund
 * whose notes list "nursing" as one example use, or "TennCare CHOICES" long-term
 * NURSING-HOME care) must NOT lock the opportunity. Use opportunityLockText().
 */

/**
 * Recognised licensed professions. Each carries:
 *   - field: matches when the PROFILE (its curated identity fields) is in/pursuing
 *            this profession.
 *   - lock:  matches when the OPPORTUNITY is restricted TO this profession
 *            (professional-org name, licensure credential, "for <profession>").
 * Patterns are deliberately tight (word-boundaried, credential/org-anchored) so a
 * mere passing mention of a field does not lock an opportunity.
 *
 * Only DISTINCT, clearly-licensed fields are listed. Broad umbrellas
 * ("healthcare", "medical", "education", "STEM") are intentionally absent — they
 * are not profession locks and must never cause a rejection.
 */
export const PROFESSION_DEFS = Object.freeze([
  {
    key: 'nursing',
    field: /\b(nurse|nurses|nursing|bsn|adn|lpn|rn|cna|nurse practitioner)\b/i,
    lock: /\b(nurse|nurses|nursing|bsn|adn|lpn|nclex|nurse practitioner)\b/i,
  },
  {
    key: 'emergency_medical',
    field: /\b(paramedic|paramedicine|emt|ems|emergency medical)\b/i,
    lock: /\b(paramedic|paramedicine|emt|emergency medical technician)\b/i,
  },
  {
    key: 'dentistry',
    field: /\b(dental|dentist|dentistry|dds|dmd|dental hygien(e|ist))\b/i,
    lock: /\b(dental|dentist|dentistry|dds|dmd|dental hygien(e|ist))\b/i,
  },
  {
    key: 'pharmacy',
    field: /\b(pharmacy|pharmacist|pharmd)\b/i,
    lock: /\b(pharmacy|pharmacist|pharmd)\b/i,
  },
  {
    key: 'veterinary',
    field: /\b(veterinary|veterinarian|dvm|vet tech(nician)?)\b/i,
    lock: /\b(veterinary|veterinarian|dvm)\b/i,
  },
  {
    key: 'law',
    field: /\b(law student|law school|attorney|juris doctor|jd|paralegal|legal studies)\b/i,
    lock: /\b(law school|bar association|attorney|juris doctor|paralegal)\b/i,
  },
  {
    key: 'social_work',
    field: /\b(social work|social worker|msw|bsw)\b/i,
    lock: /\b(social work|social worker|msw|bsw)\b/i,
  },
  {
    key: 'accounting',
    field: /\b(accounting|accountant|cpa)\b/i,
    lock: /\b(accountant|accountants|cpa|society of accountants)\b/i,
  },
  {
    key: 'cosmetology',
    field: /\b(cosmetology|cosmetologist|barber|esthetician)\b/i,
    lock: /\b(cosmetology|cosmetologist|barbering|beauty school)\b/i,
  },
])

/** Curated profile section fields that legitimately declare a profession/field
 * of study. Free-text experience/notes are intentionally EXCLUDED so a job in a
 * "skilled nursing facility" never types the applicant as a nurse. */
const PROFESSION_FIELD_KEYS = Object.freeze([
  'intended_major', 'major', 'field_of_study', 'program_of_study', 'area_of_study',
  'degree', 'degree_program', 'career_goal', 'career_goals', 'occupation',
  'profession', 'job_title', 'current_role', 'desired_field', 'concentration',
])

/** Sections whose curated fields we consult (identity/field-of-study bearing). */
const PROFESSION_SECTION_KEYS = Object.freeze([
  'basic_information', 'education', 'employment', 'career', 'professional',
])

function coerceObject(data) {
  if (!data) return null
  if (typeof data === 'object') return data
  try { return JSON.parse(data) } catch { return null }
}

/**
 * Build the CURATED profession-signal text for a profile from its sections.
 * @param {Record<string, any>} sectionsByKey - map of section_key → data (object or JSON string)
 * @returns {string} lowercased concatenation of curated field values only
 */
export function professionSignalTextFromSections(sectionsByKey = {}) {
  const parts = []
  for (const key of PROFESSION_SECTION_KEYS) {
    const data = coerceObject(sectionsByKey?.[key])
    if (!data || typeof data !== 'object') continue
    for (const fk of PROFESSION_FIELD_KEYS) {
      const v = data[fk]
      if (typeof v === 'string' && v.trim()) parts.push(v)
      else if (Array.isArray(v)) parts.push(v.filter((x) => typeof x === 'string').join(' '))
    }
  }
  return parts.join(' ').toLowerCase()
}

/**
 * Resolve the set of recognised professions a profile is in/pursuing, from its
 * curated signal text. Returns an empty Set when nothing recognised — the
 * caller MUST treat an empty set as "field unknown → never reject".
 * @returns {Set<string>}
 */
export function resolveProfileProfessions(signalText) {
  const text = String(signalText || '')
  const out = new Set()
  if (!text.trim()) return out
  for (const def of PROFESSION_DEFS) {
    if (def.field.test(text)) out.add(def.key)
  }
  return out
}

/**
 * Build the IDENTITY text an opportunity/grant lock is detected from: title +
 * funder/sponsor ONLY (never description/notes — see the module header). Accepts
 * either a grants row (title/funder) or an opportunity row (title/sponsor).
 */
export function opportunityLockText(row = {}) {
  return [row.title, row.funder, row.sponsor]
    .filter((v) => typeof v === 'string' && v.trim())
    .join(' ')
}

/**
 * Detect which single profession an opportunity/grant is LOCKED to, from its
 * IDENTITY text (title + funder — pass opportunityLockText(row)). Returns the
 * profession key, or null when it is not clearly locked to exactly one
 * recognised profession.
 *
 * Requiring exactly ONE matched profession avoids mislabeling a broad
 * multi-field directory (which is not a single-profession lock).
 */
export function detectOpportunityProfessionLock(itemText) {
  const text = String(itemText || '')
  if (!text.trim()) return null
  const hits = []
  for (const def of PROFESSION_DEFS) {
    if (def.lock.test(text)) hits.push(def.key)
  }
  return hits.length === 1 ? hits[0] : null
}

/**
 * Assess a single (profile, opportunity) pair for a profession-lock mismatch.
 *
 * @param {Object} args
 * @param {string} args.itemText   - opportunity/grant text (title + funder + desc)
 * @param {Set<string>} args.professions - the profile's recognised professions
 * @returns {{ ineligible: boolean, lock: string|null, reason: string }}
 */
export function assessProfessionEligibility({ itemText, professions }) {
  const lock = detectOpportunityProfessionLock(itemText)
  if (!lock) return { ineligible: false, lock: null, reason: 'not_profession_locked' }
  const has = professions instanceof Set ? professions : new Set(professions || [])
  if (has.size === 0) return { ineligible: false, lock, reason: 'profile_field_unknown' }
  if (has.has(lock)) return { ineligible: false, lock, reason: 'profession_match' }
  return {
    ineligible: true,
    lock,
    reason: `profession_mismatch: opportunity restricted to ${lock}; profile field is ${[...has].join('/')}`,
  }
}

export const __testables = {
  PROFESSION_FIELD_KEYS,
  PROFESSION_SECTION_KEYS,
}
