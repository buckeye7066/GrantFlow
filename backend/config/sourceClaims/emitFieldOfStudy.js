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

/** Award nouns a field can directly modify to name an applicant restriction.
 *  fund/endowment are award VEHICLES (a "Nursing Education Fund" funds nursing
 *  students), not funder-identity words — so they belong here, NOT in ORG_WORD. */
const AWARD_NOUN = '(?:scholarships?|grants?|awards?|fellowships?|bursar(?:y|ies)|prizes?|funds?|endowments?)'
/** Words that mark a field as naming the RECIPIENT population. */
const RECIPIENT_NOUN = '(?:students?|majors?|scholars?|applicants?|candidates?)'
/** Org-name words: when the field sits inside one of these, it names the FUNDER.
 *  Deliberately EXCLUDES fund/endowment (award vehicles, above) — those follow a
 *  field/purpose ("Nursing Fund") far more often than a funder's proper name. */
const ORG_WORD_RX =
  /\b(?:society|association|foundation|institute|council|academy|coalition|federation|guild|alliance|order|club|chapter|trust|organization|organisation)\b/i
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
  // "Scholar/Student in|of <field>" ("Tucker Scholar in Nursing").
  if (new RegExp(`\\b${RECIPIENT_NOUN}\\s+(?:in|of)\\s+[\\w\\s]{0,16}?${f}\\b`, 'i').test(title)) return true
  return false
}

/** Is the field embedded in a school's name ("College of Nursing", "Nursing College")? */
function inInstitutionName(title, phrase) {
  const f = escapeRe(phrase)
  if (new RegExp(`${INSTITUTION_WORD_RX.source}\\s+of\\s+${f}\\b`, 'i').test(title)) return true
  if (new RegExp(`\\b${f}\\s+${INSTITUTION_WORD_RX.source}\\b`, 'i').test(title)) return true
  return false
}

/** Separators that end a funder-name prefix and start the award/eligibility clause. */
const SEGMENT_SEP_RX = /[—–:|·]|\s[-]\s|\bpresents\b|\boffers\b|\bawards?\b\s|'s\s/i

/** The stretch of `before` AFTER the last funder/segment separator. */
function afterLastSeparator(before) {
  const parts = String(before).split(SEGMENT_SEP_RX)
  return parts[parts.length - 1]
}

/**
 * Is the field named as the applicant's COURSE OF STUDY — a degree or program in
 * it? "Master of Science in Nursing", "Bachelor of Engineering", "Nursing
 * Program", "Program in Anesthesia Nursing", "degree in Nursing", "Nursing major
 * / degree / education". These name what the applicant STUDIES, so a profile in a
 * different field provably cannot receive it — the class the title-only gate got
 * right but the first scope pass wrongly dropped to sponsor.
 */
const DEGREE_WORD = '(?:master|bachelor|associate|doctor|doctorate|ph\\.?d|degree|diploma|certificate|b\\.?s\\.?n|m\\.?s\\.?n)'
function inDegreeOrProgramContext(title, phrase) {
  const f = escapeRe(phrase)
  // "<degree> [of X] in [X] <field>"  →  "Master of Science in Nursing"
  if (new RegExp(`\\b${DEGREE_WORD}\\b[\\w.\\s]{0,24}?\\bin\\s+[\\w\\s]{0,24}?${f}\\b`, 'i').test(title)) return true
  // "<field> program / degree / major / studies / education / training"
  if (new RegExp(`\\b${f}\\s+(?:program(?:me)?|degree|major|studies|education|training)\\b`, 'i').test(title)) return true
  // "program / degree / major / studies in|of [X] <field>"  →  "Program in Anesthesia Nursing"
  if (new RegExp(`\\b(?:program(?:me)?|degree|major|studies|study|training)\\s+(?:in|of)\\s+[\\w\\s]{0,24}?${f}\\b`, 'i').test(title)) return true
  return false
}

/**
 * Is the field the TAIL/MIDDLE of the funder's own name — an org word sits within
 * ~2 words AFTER the field ("Ohio Nurses Foundation Scholarship", "…Engineers
 * Society Award")? Then the award noun modifies the whole org name, not the field.
 */
function fieldFollowedByOrgWord(title, phrase) {
  const f = escapeRe(phrase)
  return new RegExp(`\\b${f}\\b(?:\\s+\\w+){0,2}?\\s+${ORG_WORD_RX.source}`, 'i').test(title)
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

    // A. The field is INSIDE the funder's contiguous org name — an org word leads
    //    into it with no separator ("American Society of Highway Engineers
    //    Scholarship"). The award noun modifies the whole org name, not the field.
    //    Separator-aware: a funder-name PREFIX followed by a separator ("ANA
    //    Foundation — Nursing Scholarship") does NOT count — the field after the
    //    separator is its own eligibility clause.
    if (ORG_WORD_RX.test(afterLastSeparator(before))) {
      push(makeClaim({ dimension: DIMENSION, value: hit.id, scope: 'sponsor', strength: 'detected', evidence: evTitle }))
      continue
    }

    // B. Part of a school's name ("X College of Nursing") → institution scope.
    if (inInstitutionName(title, hit.phrase)) {
      push(makeClaim({ dimension: DIMENSION, value: hit.id, scope: 'institution', strength: 'detected', evidence: evTitle }))
      continue
    }

    // C. The field is the TAIL of the funder's name — an org word within ~2 words
    //    AFTER it ("Ohio Nurses Foundation Scholarship") → sponsor.
    if (fieldFollowedByOrgWord(title, hit.phrase)) {
      push(makeClaim({ dimension: DIMENSION, value: hit.id, scope: 'sponsor', strength: 'detected', evidence: evTitle }))
      continue
    }

    // D. APPLICANT signals — the field names who may RECEIVE the award, or names
    //    the applicant's course of study:
    //    - directly modifies the award noun ("Nursing Scholarship")
    //    - names the recipient population ("for Nursing students / majors")
    //    - modifies the award across 1–2 words ("Nursing Career Recovery Scholarship")
    //    - a degree/program in the field ("Master of Science in Nursing")
    const directAward = directlyModifiesAwardNoun(title, hit.phrase)
    const recipients = namesRecipients(title, hit.phrase)
    const gapped = gappedModifiesAwardNoun(title, hit.phrase)
    const degree = inDegreeOrProgramContext(title, hit.phrase)
    if (directAward || recipients || gapped || degree) {
      addApplicant(hit, (directAward || gapped || degree) ? 'explicit' : 'detected')
      continue
    }

    // E. Genuinely ambiguous → the safer, NON-rejecting scope.
    push(makeClaim({ dimension: DIMENSION, value: hit.id, scope: 'sponsor', strength: 'detected', evidence: evTitle }))
  }

  if (applicantClaim) claims.push(applicantClaim)
  return claims
}
