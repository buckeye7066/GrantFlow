/**
 * emitProfession.js — the `profession` dimension emitter for the sourceClaims
 * evidence model (see ./core.js).
 *
 * A profession word in an opportunity is one of two very different facts, and
 * the whole reason this dimension carries a SCOPE:
 *
 *   - APPLICANT  — the profession is a REQUIREMENT on who may receive the award
 *                  ("Nurse Corps Scholarship", "Grant for Licensed Practical
 *                  Nurses"). Scope 'applicant' — the only scope that can
 *                  hard-reject a profile.
 *   - SPONSOR    — the profession sits in the FUNDER's identity ("American
 *                  Dental Association Foundation Grant", "National Nurses United
 *                  Scholarship", or the word is in the sponsor/funder field). A
 *                  professional society funding students does not bar
 *                  non-members, so scope 'sponsor' — never an applicant bar.
 *
 * The profession VOCABULARY and the single-lock detection are REUSED wholesale
 * from services/eligibility/professionEligibility.js — this file forks no second
 * profession list. It only adds the scope heuristic the eligibility predicate
 * does not need. When the signal is ambiguous we prefer 'sponsor', because a
 * false applicant bar is the dangerous error this whole model exists to prevent.
 */

import { makeClaim } from './core.js'
import {
  PROFESSION_DEFS,
  detectOpportunityProfessionLock,
  opportunityLockText,
} from '../../services/eligibility/professionEligibility.js'

// Org-identity vocabulary (a profession word wrapped in these is a FUNDER name).
const ORG_TYPE_WORDS =
  'association|society|foundation|federation|union|institute|academy|alliance|board|council|guild|coalition|college|corporation|trust'
// A profession word directly modified by one of these is an APPLICANT award.
const AWARD_NOUNS =
  'scholarship|scholarships|grant|grants|fund|funds|award|awards|fellowship|fellowships|bursary|prize|stipend|loan|loans'

function strOf(v) {
  if (typeof v === 'string') return v
  return v === null || v === undefined ? '' : String(v)
}

function claim(value, scope, strength, field, text) {
  return makeClaim({
    dimension: 'profession',
    value,
    scope,
    strength,
    evidence: { field, text },
  })
}

/** First match of a fresh (state-free) copy of a def's lock pattern. */
function matchProfession(text, def) {
  return new RegExp(def.lock.source, 'i').exec(text)
}

/** Index of the first alternation hit in `text`, or -1. */
function firstIndex(text, alternation) {
  const m = new RegExp(`\\b(?:${alternation})\\b`, 'i').exec(text)
  return m ? m.index : -1
}

/** An org prefix (American/National/…) GOVERNING the profession word — i.e.
 * sitting within a couple of words before it: the funder-name shape. */
function orgPrefixGoverning(before) {
  return /\b(?:american|national|international|royal)\s+(?:[a-z&'’.-]+\s+){0,2}$/i.test(before)
}

/** The profession word is an explicit ELIGIBILITY modifier ("for <prof>",
 * "<prof> only", "reserved for <prof>", …) → an applicant requirement. */
function eligibilityModifier(before, after) {
  if (/\bfor\s+(?:[a-z]+\s+){0,3}$/i.test(before)) return true
  if (
    /\b(?:restricted to|open only to|open to|must be an?|limited to|reserved for|available to|exclusively for)\s+(?:[a-z]+\s+){0,3}$/i.test(
      before,
    )
  ) {
    return true
  }
  if (/^s?\s*,?\s*only\b/i.test(after)) return true
  return false
}

/**
 * emitProfession — the profession claims an opportunity makes about itself.
 * @param {object} opportunity  a grant/opportunity row (title, sponsor, funder, organization)
 * @returns {import('./core.js').Claim[]}  at most one claim
 */
export default function emitProfession(opportunity = {}) {
  const row = opportunity && typeof opportunity === 'object' ? opportunity : {}
  const title = strOf(row.title)
  const sponsor = strOf(row.sponsor)
  const funder = strOf(row.funder)
  const organization = strOf(row.organization)

  // Reuse the eligibility module's single-lock detector. It requires EXACTLY
  // one recognised profession across the identity text, which keeps this
  // conservative (a multi-field directory never locks). Fall back to the
  // organization field, which opportunityLockText does not read.
  const lockKey =
    detectOpportunityProfessionLock(opportunityLockText(row)) ||
    detectOpportunityProfessionLock(organization)
  if (!lockKey) return []

  const def = PROFESSION_DEFS.find((d) => d.key === lockKey)
  if (!def) return []

  const titleMatch = title ? matchProfession(title, def) : null

  // 1) The TITLE settles it first, in priority order.
  if (titleMatch) {
    const before = title.slice(0, titleMatch.index)
    const after = title.slice(titleMatch.index + titleMatch[0].length)
    // A governing funder-name prefix wins over everything (safe direction).
    if (orgPrefixGoverning(before)) {
      return [claim(def.key, 'sponsor', 'detected', 'title', title)]
    }
    // An explicit eligibility modifier is an applicant requirement.
    if (eligibilityModifier(before, after)) {
      return [claim(def.key, 'applicant', 'explicit', 'title', title)]
    }
  }

  // 2) The profession sitting in a FUNDER identity field → sponsor.
  for (const [field, text] of [
    ['sponsor', sponsor],
    ['funder', funder],
    ['organization', organization],
  ]) {
    if (text && def.lock.test(text)) {
      return [claim(def.key, 'sponsor', 'detected', field, text)]
    }
  }

  // 3) Weaker title heuristics for the remaining title occurrences.
  if (titleMatch) {
    const before = title.slice(0, titleMatch.index)
    const after = title.slice(titleMatch.index + titleMatch[0].length)
    const orgIdx = firstIndex(after, ORG_TYPE_WORDS)
    const awardIdx = firstIndex(after, AWARD_NOUNS)
    // An org-type noun after the profession, BEFORE any award noun → funder name.
    if (orgIdx >= 0 && (awardIdx < 0 || orgIdx < awardIdx)) {
      return [claim(def.key, 'sponsor', 'detected', 'title', title)]
    }
    // The profession directly modifies an award noun → applicant requirement.
    if (awardIdx >= 0 || firstIndex(before, AWARD_NOUNS) >= 0) {
      return [claim(def.key, 'applicant', 'explicit', 'title', title)]
    }
    // Bare profession word, no award/org context → prefer sponsor (never a
    // false applicant bar).
    return [claim(def.key, 'sponsor', 'detected', 'title', title)]
  }

  return []
}
