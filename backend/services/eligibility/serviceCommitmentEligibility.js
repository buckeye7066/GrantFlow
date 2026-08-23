/**
 * serviceCommitmentEligibility.js — service-commitment (ROTC / academy /
 * enlistment) eligibility predicate.
 *
 * WHY THIS EXISTS (owner ruling 2026-08-23)
 * -----------------------------------------
 * "Army ROTC Scholarships" sat at ACCEPT 100 in a real student's pipeline —
 * an incoming MTSU freshman whose profile declares `military_service.veteran:
 * false` and NOTHING else military. The owner's question was direct: "how did
 * Army ROTC make the cut considering there is not anything in her profile that
 * shows she is ROTC?" It made the cut because the row (a web_search mint)
 * carries NULL eligibility_text and every gate honors MISSING = NEUTRAL.
 *
 * THE RULE — AND WHY IT INVERTS silence-is-neutral FOR THIS ONE CLASS
 * -------------------------------------------------------------------
 * A service-commitment award is not a demographic restriction; it is a
 * years-long military SERVICE OBLIGATION (ROTC contracts, academy admission,
 * enlistment incentives). Surfacing one to a profile with zero declared
 * military interest fails the owner's "meets the needs in her profile" bar,
 * so for THIS class a POSITIVE declared military affiliation is REQUIRED and
 * absence refuses — the same owner-ordered shape as the mission-lane gate
 * (a mission lane must be ASKED for its mission). This is deliberately the
 * opposite default from professionEligibility's both-sides rule; the owner
 * ruled it 2026-08-23 (00:10 EDT) on the ROTC row specifically.
 *
 * PRECISION RULES (mirrors professionEligibility)
 * -----------------------------------------------
 *   - The LOCK is detected ONLY from the row's IDENTITY (title + funder /
 *     sponsor), never description prose, with tight word-boundaried patterns
 *     ("ROTC", the named service academies, enlistment-bonus shapes). A
 *     veteran-benefit or military-FAMILY program is NOT a commitment lock —
 *     those serve people who already served and are governed by the existing
 *     requiresVeteran gate.
 *   - The profile side reads ONLY structured `military_service` flags and
 *     CURATED identity fields (career goal, major, occupation) — never
 *     free-text notes, whose denials contain the very words being matched
 *     ("No military affiliation…" — the deriveApplicantTypes NEGATION TRAP).
 */

/** Identity patterns that mark an award as requiring a service commitment. */
export const SERVICE_COMMITMENT_LOCK_PATTERNS = Object.freeze([
  { rx: /\brotc\b/i, label: 'rotc' },
  { rx: /\b(?:west point|annapolis|air force academy|naval academy|military academy|coast guard academy|merchant marine academy)\b/i, label: 'service_academy' },
  { rx: /\benlist(?:ment|ing)\s+(?:bonus|incentive|scholarship)\b/i, label: 'enlistment_incentive' },
  { rx: /\bmilitary service (?:obligation|commitment)\b/i, label: 'service_obligation' },
])

/** Structured military_service flags that positively declare affiliation. */
const MILITARY_FLAG_KEYS = Object.freeze([
  'veteran', 'active_duty', 'national_guard', 'reservist', 'service_member',
  'servicemember', 'rotc', 'rotc_cadet', 'military',
])

/** Curated identity fields (never notes/experience prose). */
const IDENTITY_FIELD_KEYS = Object.freeze([
  'intended_major', 'major', 'field_of_study', 'career_goal', 'career_goals',
  'occupation', 'profession', 'job_title', 'current_role', 'desired_field',
])
const IDENTITY_SECTION_KEYS = Object.freeze([
  'basic_information', 'education', 'employment', 'career', 'occupation',
])

/** Curated-field vocabulary that declares a military path by identity. */
const MILITARY_IDENTITY_RX = /\b(rotc|military (?:officer|career|science)|armed forces|servicemember|service member|enlist(?:ed|ing)?|cadet|midshipman)\b/i

function coerceObject(data) {
  if (!data) return null
  if (typeof data === 'object') return data
  try { return JSON.parse(data) } catch { return null }
}

/**
 * Does the profile POSITIVELY declare a military affiliation or intent?
 * Structured flags must be explicitly === true (an explicit `veteran: false`
 * declares the opposite and contributes nothing).
 */
export function hasDeclaredMilitaryAffiliation(sectionsByKey = {}) {
  const military = coerceObject(sectionsByKey?.military_service)
  if (military && typeof military === 'object') {
    for (const k of MILITARY_FLAG_KEYS) {
      if (military[k] === true) return true
    }
  }
  for (const key of IDENTITY_SECTION_KEYS) {
    const data = coerceObject(sectionsByKey?.[key])
    if (!data || typeof data !== 'object') continue
    for (const fk of IDENTITY_FIELD_KEYS) {
      const v = data[fk]
      if (typeof v === 'string' && MILITARY_IDENTITY_RX.test(v)) return true
      if (Array.isArray(v) && v.some((x) => typeof x === 'string' && MILITARY_IDENTITY_RX.test(x))) return true
    }
  }
  return false
}

/**
 * Detect a service-commitment lock from IDENTITY text (title + funder —
 * pass professionEligibility's opportunityLockText(row)).
 * Returns the lock label, or null.
 */
export function detectServiceCommitmentLock(itemText) {
  const text = String(itemText || '')
  if (!text.trim()) return null
  for (const entry of SERVICE_COMMITMENT_LOCK_PATTERNS) {
    if (entry.rx.test(text)) return entry.label
  }
  return null
}

/**
 * Assess one (profile, opportunity) pair.
 * @returns {{ ineligible: boolean, lock: string|null, reason: string }}
 */
export function assessServiceCommitmentEligibility({ itemText, declared }) {
  const lock = detectServiceCommitmentLock(itemText)
  if (!lock) return { ineligible: false, lock: null, reason: 'not_service_commitment' }
  if (declared === true) return { ineligible: false, lock, reason: 'military_affiliation_declared' }
  return {
    ineligible: true,
    lock,
    reason: `service_commitment_undeclared: award requires a ${lock} service commitment the profile does not declare`,
  }
}

export const __testables = { MILITARY_FLAG_KEYS, IDENTITY_FIELD_KEYS, IDENTITY_SECTION_KEYS, MILITARY_IDENTITY_RX }
