/**
 * emitFieldOfStudy.js — the field_of_study CLAIM emitter (Stage-2 evidence model).
 *
 * A field word ("nursing", "engineering", "dental") is only a hard eligibility
 * signal when it names WHO MAY RECEIVE the award. The very same word is NOT a
 * bar when it is part of the FUNDER'S name ("American Society of Highway
 * ENGINEERS Scholarship", "Ohio NURSES Foundation Scholarship") or a school's
 * name ("X College of NURSING"). The field-of-study gate treats the second case
 * as if it were the first and WRONGLY hard-rejects — e.g. it closes the highway-
 * engineers award to a paramedic even though the applicant need not be an
 * engineer at all.
 *
 * This emitter reads the opportunity's IDENTITY text (title + sponsor/funder/
 * organization), detects the vocational field with the SHARED vocabulary from
 * `fieldOfStudyEligibility.js` (FIELD_CLASSES — never a forked second list), and
 * attaches the correct SCOPE:
 *
 *   - applicant   → the field modifies the AWARD and names who may receive it
 *                   ("Nursing Scholarship", "Scholarship for Nursing students",
 *                    "nursing majors"). This is the only scope that can hard-reject.
 *   - sponsor     → the field word is part of the FUNDER's org name ("Society of
 *                   X", "X Association / Foundation / Institute / Council",
 *                   "American / National X", or the word sits in the sponsor
 *                   field). Informs fit; never a hard reject.
 *   - institution → the field is part of a school's name ("X College of Nursing").
 *
 * When genuinely ambiguous, the safer non-rejecting scope ('sponsor') is chosen
 * UNLESS the field directly modifies the award noun. At most ONE applicant-scoped
 * field claim is emitted (the award's actual field restriction); sponsor and
 * institution claims may also be emitted.
 */

import { makeClaim } from './core.js'
import { FIELD_CLASSES } from '../fieldOfStudyEligibility.js'

const DIMENSION = 'field_of_study'

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Award nouns a field can directly modify to name an applicant restriction. */
const AWARD_NOUN = '(?:scholarships?|grants?|awards?|fellowships?|bursar(?:y|ies)|prizes?)'
/** Words that mark a field as naming the RECIPIENT population. */
const RECIPIENT_NOUN = '(?:students?|majors?|scholars?|applicants?|candidates?)'
/** Org-name words: when the field sits inside one of these, it names the FUNDER. */
const ORG_WORD_RX =
  /\b(?:society|association|foundation|institute|council|academy|coalition|federation|guild|alliance|order|club|chapter|endowment|trust|fund|organization|organisation)\b/i
/** School-name words: the field is part of an INSTITUTION's name. */
const INSTITUTION_WORD_RX = /\b(?:college|university|school|seminary|conservatory|polytechnic)\b/i

/**
 * Locate a FIELD_CLASS in a piece of text using the shared FIELD_CLASSES
 * patterns. Plural org names ("Engineers", "Nurses") are caught by singularising
 * a copy of the text so the vocabulary's singular patterns (/\bengineer\b/) still
 * fire — this REUSES FIELD_CLASSES rather than forking a second field list.
 *
 * @returns {{id, label, phrase, index}|null}
 */
function locateField(cls, raw) {
  for (const rx of cls.patterns) {
    const m = rx.exec(raw)
    if (m) return { id: cls.id, label: cls.label, phrase: m[0].trim(), index: m.index }
  }
  // Fallback: try a singularised copy, then map the hit back to the raw plural.
  const singular = raw.replace(/\b([A-Za-z]{3,}?)(?:es|s)\b/gi, '$1')
  if (singular === raw) return null
  for (const rx of cls.patterns) {
    const m = rx.exec(singular)
    if (!m) continue
    const back = new RegExp('\\b' + escapeRe(m[0].trim()) + '(?:es|s)?\\b', 'i').exec(raw)
    if (back) return { id: cls.id, label: cls.label, phrase: back[0].trim(), index: back.index }
    return { id: cls.id, label: cls.label, phrase: m[0].trim(), index: -1 }
  }
  return null
}

/** Every distinct FIELD_CLASS this text names, de-duplicated by class id. */
function detectFields(text) {
  const raw = String(text ?? '')
  if (!raw.trim()) return []
  const out = []
  const seen = new Set()
  for (const cls of FIELD_CLASSES) {
    const hit = locateField(cls, raw)
    if (hit && !seen.has(hit.id)) {
      seen.add(hit.id)
      out.push(hit)
    }
  }
  return out
}

/**
 * Does the field phrase DIRECTLY modify an award noun ("Nursing Scholarship",
 * "Scholarship in Nursing")? Immediate adjacency only — an org word between the
 * field and the award noun ("Nurses Foundation Scholarship") is NOT this.
 */
function directlyModifiesAwardNoun(title, phrase) {
  const f = escapeRe(phrase)
  if (new RegExp(`\\b${f}\\s+${AWARD_NOUN}\\b`, 'i').test(title)) return true // "<field> Scholarship"
  if (new RegExp(`\\b${AWARD_NOUN}\\s+(?:for|in|to|of)\\s+${f}\\b`, 'i').test(title)) return true // "Scholarship for/in <field>"
  return false
}

/** "<field> <word(s)> Scholarship" with 1–2 words between ("Nursing Excellence Grant"). */
function gappedModifiesAwardNoun(title, phrase) {
  const f = escapeRe(phrase)
  return new RegExp(`\\b${f}\\b(?:\\s+\\w+){1,2}\\s+${AWARD_NOUN}\\b`, 'i').test(title)
}

/** Does the field phrase name the RECIPIENT population ("nursing students/majors")? */
function namesRecipients(title, phrase) {
  const f = escapeRe(phrase)
  if (new RegExp(`\\b(?:for\\s+)?${f}\\s+${RECIPIENT_NOUN}\\b`, 'i').test(title)) return true
  if (new RegExp(`\\bfor\\s+${f}\\b`, 'i').test(title)) return true
  return false
}

/** Is the field embedded in a school's name ("College of Nursing", "Nursing College")? */
function inInstitutionName(title, phrase) {
  const f = escapeRe(phrase)
  if (new RegExp(`${INSTITUTION_WORD_RX.source}\\s+of\\s+${f}\\b`, 'i').test(title)) return true
  if (new RegExp(`\\b${f}\\s+${INSTITUTION_WORD_RX.source}\\b`, 'i').test(title)) return true
  return false
}

/**
 * emitFieldOfStudy — the emitter.
 * @param {object} opportunity  the catalog/candidate row
 * @returns {Array} Claim[]
 */
export default function emitFieldOfStudy(opportunity = {}) {
  const o = opportunity || {}
  const title = String(o.title ?? '')
  const sponsorField = o.sponsor ?? o.funder ?? o.organization
  const sponsorText = String(sponsorField ?? '')

  const claims = []
  const push = (c) => { if (c) claims.push(c) }

  // ── Sponsor FIELD: a field word sitting in the sponsor/funder column names the
  //    FUNDER, never the applicant. Always sponsor scope.
  for (const hit of detectFields(sponsorText)) {
    push(makeClaim({
      dimension: DIMENSION,
      value: hit.id,
      scope: 'sponsor',
      strength: 'detected',
      evidence: { field: 'sponsor', text: sponsorText.slice(0, 200) },
    }))
  }

  // ── TITLE: scope depends on WHERE and HOW the field appears.
  let applicantClaim = null // at most ONE applicant-scoped field claim
  const evTitle = { field: 'title', text: title.slice(0, 200) }
  // Keep only ONE applicant claim (prefer the explicit award-noun restriction).
  const addApplicant = (hit, strength) => {
    const candidate = makeClaim({ dimension: DIMENSION, value: hit.id, scope: 'applicant', strength, evidence: evTitle })
    if (candidate && (!applicantClaim || (candidate.strength === 'explicit' && applicantClaim.strength !== 'explicit'))) {
      applicantClaim = candidate
    }
  }
  for (const hit of detectFields(title)) {
    const before = hit.index >= 0 ? title.slice(0, hit.index) : ''
    const after = hit.index >= 0 ? title.slice(hit.index + hit.phrase.length) : title

    // 1. An org word BEFORE the field ("[Society] of Highway Engineers Scholarship")
    //    means the field belongs to the FUNDER's name — the award noun that follows
    //    modifies the whole org name, not the field. Safest non-rejecting scope.
    if (ORG_WORD_RX.test(before)) {
      push(makeClaim({ dimension: DIMENSION, value: hit.id, scope: 'sponsor', strength: 'detected', evidence: evTitle }))
      continue
    }

    // 2. Part of a school's name ("X College of Nursing") → institution scope.
    if (inInstitutionName(title, hit.phrase)) {
      push(makeClaim({ dimension: DIMENSION, value: hit.id, scope: 'institution', strength: 'detected', evidence: evTitle }))
      continue
    }

    // 3. The field IMMEDIATELY modifies the award noun ("Nursing Scholarship") or
    //    names the recipient population ("for Nursing students") → applicant.
    const directAward = directlyModifiesAwardNoun(title, hit.phrase)
    const recipients = namesRecipients(title, hit.phrase)
    if (directAward || recipients) {
      addApplicant(hit, directAward ? 'explicit' : 'detected')
      continue
    }

    // 4. An org word ELSEWHERE ("Ohio Nurses [Foundation] Scholarship", where the
    //    org word sits between the field and the award noun) → sponsor.
    if (ORG_WORD_RX.test(after) || ORG_WORD_RX.test(before)) {
      push(makeClaim({ dimension: DIMENSION, value: hit.id, scope: 'sponsor', strength: 'detected', evidence: evTitle }))
      continue
    }

    // 5. Field modifies the award noun across 1–2 words ("Nursing Excellence Grant"),
    //    with no org context → applicant.
    if (gappedModifiesAwardNoun(title, hit.phrase)) {
      addApplicant(hit, 'explicit')
      continue
    }

    // 6. Genuinely ambiguous → the safer, NON-rejecting scope.
    push(makeClaim({ dimension: DIMENSION, value: hit.id, scope: 'sponsor', strength: 'detected', evidence: evTitle }))
  }

  if (applicantClaim) claims.push(applicantClaim)
  return claims
}
