/**
 * Smart Matcher — turn free-text funding requests into catalog search terms.
 * Rules-first (no API key required); optional OpenAI JSON boost when configured.
 *
 * Returns:
 *   {
 *     summary,
 *     search_terms,
 *     method,
 *     primary_category,        // e.g. 'professional_development', 'income_support', 'general'
 *     excluded_categories,     // categories the matcher should hard-exclude
 *     branded_program,         // recognized branded name (e.g. 'PROBE') if any
 *     credentials_detected,    // ['RN','LCSW',...] when extracted from text
 *   }
 */

import { createOpenAIClient } from '../utils/openaiClient.js'
import { invokeJsonWithFallback as invokeProviderJsonWithFallback } from '../utils/aiProviders.js'
import { expandNeed } from './shared/needTaxonomy.js'

const MAX_INPUT = 2000
// Raised from 18 to 24 in the student_aid + professional_development
// expansion era so overlapping rules (e.g. off-campus + student housing +
// MTSU + room-and-board) don't push high-signal terms like "student aid"
// or "fafsa" off the end of the array. SQL `LIKE` cost is linear in the
// number of OR clauses, but at 24 terms × 4 columns this is still well
// under the index-scan cliff for our funding_opportunities table sizes.
const MAX_TERMS = 24
const MAX_TERM_LEN = 64

const STOP = new Set(
  `a an the and or but if to of at by for from with without in on as is are was were be been being
   it this that these those i me my we our you your he she they them what which who whom
   help need want looking look find funding fund money grant grants source sources program programs
   assistance support please can could would should may might get obtain acquiring acquire give gives giving away free`
    .split(/\s+/),
)

/** @param {string} raw */
export function sanitizeSearchTerm(raw) {
  let s = String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[%_\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TERM_LEN)
  return s
}

// ---------------------------------------------------------------------------
// Branded CE / licensure / remediation program lookup
//
// When a user enters one of these well-known program names, we know the
// general category and can route to the appropriate funder pools instead of
// treating it as an unknown string. This was a real production bug: a query
// for "PROBE: Ethics and Boundaries" surfaced SSI cash assistance because the
// matcher had no concept of "professional ethics CE course."
// ---------------------------------------------------------------------------
const BRANDED_PROGRAMS = [
  {
    re: /\b(probe|pro\s*be)\b.*(ethics|boundar)/i,
    name: 'PROBE',
    program_type: 'ethics_remediation',
    add: [
      'probe ethics',
      'professional boundaries',
      'license reinstatement',
      'nursing reinstatement',
      'ethics course',
      'remediation course',
      'professional ethics ce',
      'continuing education',
      'professional development',
      'wioa training',
      'workforce training board',
      'vocational rehabilitation',
      'state nurses foundation',
    ],
  },
  // Catch the bare program name even without the "ethics/boundaries" suffix.
  // The user said “PROBE program” → still professional development, not SSI.
  {
    re: /\b(probe|pro\s*be)\s+(program|class|course)\b/i,
    name: 'PROBE',
    program_type: 'ethics_remediation',
    add: [
      'probe ethics',
      'professional boundaries',
      'license reinstatement',
      'remediation course',
      'continuing education',
      'professional development',
    ],
  },
  {
    re: /\bciti\s*(program|training|module|course)?\b/i,
    name: 'CITI',
    program_type: 'research_ethics',
    add: [
      'research ethics',
      'human subjects training',
      'irb training',
      'continuing education',
      'professional development',
      'university training',
    ],
  },
  {
    re: /\bscope\s*(program|course|training)\b/i,
    name: 'SCOPE',
    program_type: 'physician_remediation',
    add: [
      'physician remediation',
      'medical license remediation',
      'continuing medical education',
      'cme',
      'continuing education',
      'professional development',
    ],
  },
  {
    re: /\bpace\s*(program|course|training)?\b/i,
    name: 'PACE',
    program_type: 'physician_remediation',
    add: [
      'pace program',
      'physician assessment',
      'physician remediation',
      'continuing medical education',
      'cme',
      'continuing education',
      'professional development',
    ],
  },
  {
    re: /\bcpep\s*(program|course)?\b/i,
    name: 'CPEP',
    program_type: 'physician_remediation',
    add: [
      'cpep',
      'physician evaluation',
      'physician remediation',
      'continuing medical education',
      'cme',
      'continuing education',
    ],
  },
  {
    re: /\b(nclex|nclex.?rn|nclex.?pn)\b/i,
    name: 'NCLEX',
    program_type: 'nursing_licensure_exam',
    add: [
      'nclex prep',
      'nursing licensure',
      'nursing exam',
      'continuing education',
      'professional development',
      'wioa training',
    ],
  },
  {
    re: /\b(bls|acls|pals)\b\s*(certification|class|course|training)?/i,
    name: 'BLS/ACLS/PALS',
    program_type: 'medical_certification',
    add: [
      'bls certification',
      'acls certification',
      'medical certification',
      'continuing education',
      'professional development',
    ],
  },
]

// ---------------------------------------------------------------------------
// Credentials → professional_development pool
// ---------------------------------------------------------------------------
const CREDENTIAL_RE = /\b(RN|LPN|APRN|CNA|MD|DO|MBBS|PA|PA-C|NP|FNP|DNP|CRNA|LCSW|LMSW|LSW|MSW|LPC|LMFT|LMHC|PsyD|PhD|EdD|DDS|DMD|RDH|PharmD|RPh|DPT|PT|OT|OTR|SLP|RN-BC)\b/g

function extractCredentials(text) {
  const found = new Set()
  const matches = String(text || '').match(CREDENTIAL_RE) || []
  for (const m of matches) found.add(m.toUpperCase())
  return Array.from(found)
}

// ---------------------------------------------------------------------------
// Category detection: maps a free-text request to a primary_category and
// the set of categories that should be excluded from the result set.
//
// This is the rule from the user spec:
//   "if extracted keywords match the Professional Development taxonomy,
//    exclude general means-tested cash-assistance programs from the result
//    set unless explicitly requested."
// ---------------------------------------------------------------------------
const PROFESSIONAL_DEVELOPMENT_TRIGGERS = [
  /\b(probe|nclex|citi|scope|pace|cpep|bls|acls|pals)\b/i,
  /\b(ethics|boundary|boundaries)\s+(training|course|class|program|education|ce|ceu|cme|credit|credits|requirement|requirements|hours)\b/i,
  /\b(continuing\s+education|continuing\s+medical\s+education|cme|ceus?|ce credit|ceu credit)\b/i,
  /\b(license|licensure|licensing)\s+(reinstatement|renewal|restoration|exam|fee|prep)\b/i,
  /\b(remediation|remedial)\s+(course|class|program|education|training|coursework)\b/i,
  /\b(professional\s+development|professional\s+training|professional\s+education)\b/i,
  /\b(certification|recertification|credential|credentialing)\s+(course|class|exam|fee|training)?\b/i,
  /\b(nurse|nursing|social\s+work|counseling|counselor|therap(?:ist|y)|physician|medical|pharmacist|dental)\b\s+(?:scholarship|ce|continuing|reentry|re-entry|refresher|workforce|training|license|licensure|remediation)\b/i,
  /\b(workforce\s+development|wioa|individual\s+training\s+account|ita\b|vocational\s+rehab|voc\s+rehab|workforce\s+board|american\s+job\s+center|career\s+one\s*stop)\b/i,
  /\b(refresher|reentry|re-entry|return\s+to\s+practice|return\s+to\s+nursing)\b/i,
  /\b(professional\s+association\s+(scholarship|grant)|ana|nasw|amas?|apa|aacn|aanp)\s+(scholarship|grant|ce|fund)\b/i,
]

// ---------------------------------------------------------------------------
// Student aid / cost-of-attendance triggers.
//
// This is the new pool that powers queries like "off-campus living expenses
// at MTSU", "room and board scholarships", "rent help while in college",
// "cost of attendance gap". These ALL belong in the student_aid bucket so we
// route to scholarships.js / school cards / Pell / state student aid — NOT
// to generic homeless / Section 8 / utility programs (which dominate any
// "housing" or "rent" keyword query for a non-student profile).
// ---------------------------------------------------------------------------
const STUDENT_AID_TRIGGERS = [
  // Direct student-aid signals.
  /\b(financial\s+aid|fafsa|pell\s+grant|fseog|tuition\s+assistance|tuition\s+grant|college\s+aid)\b/i,
  /\b(scholarship(?:s)?|grant)\s+(?:for|to)\s+(?:students?|college|university|undergraduates?|graduate)\b/i,
  /\b(cost\s+of\s+attendance|coa\s+gap|coa\s+appeal|coa\s+adjustment)\b/i,
  /\b(room\s+and\s+board|room\s*&\s*board|board\s+scholarship)\b/i,
  /\b(off[\s-]?campus|on[\s-]?campus)\s+(?:hous|liv|rent|apartment|expense)/i,
  /\b(student\s+(?:hous|liv|rent|apartment|loan|emergency|debt|food)|residence\s+hall|dorm(?:itory)?|campus\s+hous)/i,
  /\b(college|university|undergrad(?:uate)?|graduate)\s+(?:hous|liv|rent|expense|emergency|food\s+pantry)/i,
  /\b(emergency\s+aid|completion\s+grant|micro\s+grant|persistence\s+grant)\s+(?:for|to)?\s*(?:student|college|university)?/i,
  // Branded student aid programs — explicit hooks for the most common ones
  // we surface in scholarships.js / nationalPrograms.js.
  /\b(hope\s+scholarship|tn\s+promise|tennessee\s+promise|tennessee\s+student\s+assistance|step\s+up\s+scholarship|aspire\s+award|cal\s+grant|tap\s+grant|map\s+grant)\b/i,
  // Common college / university name patterns. We can't enumerate every
  // school here, but a query mentioning a 4-letter university acronym or
  // "<word> University" / "<word> State" alongside a living/rent/expense
  // intent is almost always a cost-of-attendance question.
  /\b(mtsu|ucf|ucla|ucsb|ucsd|usc|nyu|psu|asu|fsu|fiu|fau|ksu|osu|tsu|ttu|wvu|byu|tcu|smu|csu|mu|uga|uva|umd|uw|um|umass|csun|cuny|suny)\b/i,
  /\b(university\s+of|state\s+university|community\s+college|technical\s+college|college\s+of)\b.*\b(hous|liv|rent|expense|tuition|scholarship|aid|cost|grant)\b/i,
  /\b(penn\s+state|ohio\s+state|iowa\s+state|michigan\s+state|florida\s+state|kansas\s+state|oklahoma\s+state|oregon\s+state|texas\s+state|tennessee\s+state|middle\s+tennessee\s+state)\b.*\b(hous|liv|rent|expense|tuition|scholarship|aid|cost|grant)\b/i,
  // University / college + tuition / aid / scholarship is always student aid.
  /\b(university|college|undergrad(?:uate)?|graduate)\b.*\b(tuition|scholarship|grant|aid|fafsa|pell|fseog|cost|hous|liv|rent|expense)\b/i,
]

const INCOME_SUPPORT_CATEGORIES = [
  'income_support',
  'cash_assistance',
  'ssi',
  'ssdi',
  'snap',
  'tanf',
  'wic',
  'liheap',
  'general_assistance',
]

// When the primary intent is student_aid, generic adult homelessness and
// Section 8 / shelter programs are not what the user wants ("rent help for
// college" ≠ "I am homeless"). Cap them via cross-category logic in
// routes/matching.js the same way professional_development does.
const ADULT_HOMELESSNESS_CATEGORIES = [
  'homelessness',
  'shelter',
  'public_housing',
  'section_8',
]

function detectPrimaryCategory(text, expandedTerms = []) {
  const haystack = `${String(text || '').toLowerCase()} ${expandedTerms.join(' ').toLowerCase()}`
  for (const re of PROFESSIONAL_DEVELOPMENT_TRIGGERS) {
    if (re.test(haystack)) {
      return {
        primary_category: 'professional_development',
        excluded_categories: INCOME_SUPPORT_CATEGORIES.slice(),
      }
    }
  }
  for (const re of STUDENT_AID_TRIGGERS) {
    if (re.test(haystack)) {
      return {
        primary_category: 'student_aid',
        // Do NOT exclude income_support outright — many low-income students
        // DO need SNAP / utility help in college. Per the user rule
        // "Population / eligibility mismatches must reduce score, not
        // discard results", we let the cross-category cap handle this in
        // matching.js (caps non-overlapping rows at 25%) and keep results
        // in the candidate set so the user sees them when sorting/filtering.
        excluded_categories: [],
      }
    }
  }
  // Other categories can be detected the same way later; default neutral.
  return { primary_category: 'general', excluded_categories: [] }
}

// ---------------------------------------------------------------------------
// Term expansion rules (rules-only path).
// ---------------------------------------------------------------------------
const EXPANSIONS = [
  {
    re: /\b(bereave|bereavement|funeral|grief|mourning|memorial|death in family|lost a loved one)\b/i,
    add: [
      'bereavement',
      'funeral assistance',
      'emergency travel',
      'family crisis',
      'travel assistance',
      'memorial',
    ],
  },
  {
    re: /\b(airplane|airline|plane ticket|flight ticket|air fare|airfare|fly to|flying)\b/i,
    add: ['travel assistance', 'transportation', 'emergency travel', 'trip assistance', 'airline'],
  },
  {
    re: /\b(passenger van|15[\s-]?passenger|minibus|church van|school van|transport van|wheelchair van|accessible van)\b/i,
    add: [
      'vehicle grant',
      'transportation equipment',
      'van',
      'accessible vehicle',
      'nonprofit vehicle',
      'fleet',
    ],
  },
  {
    re: /\b(van|minivan|suv|truck|car|vehicle|automobile)\b/i,
    add: ['vehicle assistance', 'transportation', 'car repair', 'automotive'],
  },
  {
    re: /\b(rent|rental|eviction|housing|homeless|mortgage|utilities|electric|heat|water bill)\b/i,
    add: ['housing assistance', 'rental assistance', 'utility assistance', 'home repair'],
  },
  {
    re: /\b(food|groceries|snap|hunger|meal)\b/i,
    add: ['food assistance', 'nutrition', 'food bank'],
  },
  {
    re: /\b(medical|health|hospital|prescription|dental|vision|disability)\b/i,
    add: ['healthcare', 'medical assistance', 'disability'],
  },
  {
    re: /\b(probe|pro-?be|ethics|boundaries|continuing education|cme|ce credits|licensure|license reinstatement|remediation|wioa|workforce training|professional development|board required|return to practice|nurse re-?entry|vocational rehabilitation|ita\b|etpl|nursing foundation|hrsa|nhsc|nasw|ana foundation|tuition reimbursement|certification exam)\b/i,
    add: [
      'wioa training',
      'workforce development board',
      'license reinstatement',
      'professional remediation',
      'nursing reentry',
      'vocational rehabilitation',
      'continuing education',
      'ethics training',
      'probe ethics',
      'professional boundaries',
      'nursing foundation',
      'training scholarship',
    ],
  },
  // Generic education (kept for college / K-12 routing).
  {
    re: /\b(education|tuition|scholarship|college|student|training)\b/i,
    add: ['education', 'scholarship', 'tuition assistance'],
  },
  // Student living / off-campus / cost-of-attendance.
  // This is the pool that surfaces room-and-board / cost-of-attendance
  // scholarships, school emergency-aid funds, Pell, FSEOG, and state
  // student-aid programs (HOPE / TSAA / STEP UP / Cal Grant / TAP / MAP)
  // for queries like "off-campus living expenses at MTSU" or "rent help
  // while I'm at college". Without this expansion, "off campus living"
  // and "MTSU" tokens never reach scholarships.js / school cards.
  //
  // IMPORTANT: 'student aid' is intentionally first in every add list so
  // it survives the MAX_TERMS=18 cap even when several rules fire and
  // produce overlapping expansions. This is the catalog-side guarantee
  // that "%student aid%" SQL LIKE queries hit the right candidate set.
  {
    re: /\b(off[\s-]?campus|on[\s-]?campus)\s+(?:hous|liv|rent|apartment|expense|cost)/i,
    add: [
      'student aid',
      'off-campus housing',
      'cost of attendance',
      'room and board',
      'student housing',
      'fafsa',
      'pell grant',
      'fseog',
      'scholarship',
      'off-campus living',
      'college housing',
      'student emergency aid',
    ],
  },
  // Bare "off campus" / "off-campus" mention (without an immediately
  // adjacent housing/rent token) — still a very strong student-aid
  // signal on its own. Common phrasing: "...rent off campus", "I live
  // off-campus and need help", "Studying off campus this year".
  {
    re: /\b(off[\s-]?campus|on[\s-]?campus)\b/i,
    add: [
      'student aid',
      'off-campus housing',
      'cost of attendance',
      'room and board',
      'student housing',
      'fafsa',
      'pell grant',
      'scholarship',
    ],
  },
  {
    re: /\b(student\s+(?:hous|liv|rent|apartment|food\s+pantry|emergency|debt)|residence\s+hall|dorm(?:itory)?|campus\s+hous)/i,
    add: [
      'student aid',
      'off-campus housing',
      'student housing',
      'cost of attendance',
      'room and board',
      'student living',
      'residence hall',
      'fafsa',
      'pell grant',
      'completion grant',
      'student emergency aid',
      'scholarship',
    ],
  },
  {
    re: /\b(room\s+and\s+board|room\s*&\s*board|board\s+scholarship|cost\s+of\s+attendance|coa\s+(?:gap|appeal|adjustment))\b/i,
    add: [
      'student aid',
      'room and board',
      'cost of attendance',
      'off-campus housing',
      'student housing',
      'fafsa',
      'pell grant',
      'fseog',
      'coa appeal',
      'scholarship',
    ],
  },
  {
    re: /\b(college|university|undergrad(?:uate)?|graduate)\s+(?:hous|liv|rent|expense|emergency|food\s+pantry|tuition|fees|cost|aid|scholarship|grant|financial)/i,
    add: [
      'student aid',
      'cost of attendance',
      'student housing',
      'room and board',
      'fafsa',
      'pell grant',
      'fseog',
      'scholarship',
      'tuition assistance',
      'institutional aid',
      'student emergency aid',
    ],
  },
  // Federal / state student aid program names.
  {
    re: /\b(financial\s+aid|fafsa|pell\s+grant|fseog|federal\s+work[\s-]?study|teach\s+grant)\b/i,
    add: [
      'student aid',
      'fafsa',
      'pell grant',
      'fseog',
      'cost of attendance',
      'federal work-study',
      'scholarship',
      'room and board',
      'teach grant',
    ],
  },
  {
    re: /\b(hope\s+scholarship|tn\s+hope|tennessee\s+hope|tn\s+promise|tennessee\s+promise|tennessee\s+student\s+assistance|tsaa|step\s+up\s+scholarship|aspire\s+award|hope\s+aspire|tn\s+reconnect|tennessee\s+reconnect)\b/i,
    add: [
      'student aid',
      'tennessee hope',
      'tn promise',
      'tennessee student assistance award',
      'tsaa',
      'step up scholarship',
      'aspire award',
      'state student aid',
      'pell grant',
      'fafsa',
      'scholarship',
      'cost of attendance',
      'room and board',
    ],
  },
  // Common college / university name expansions. Catches the "at MTSU" /
  // "at Penn State" / "at UCF" pattern from the test query.
  {
    re: /\b(mtsu|ucf|ucla|ucsb|ucsd|usc|nyu|psu|asu|fsu|fiu|fau|ksu|osu|tsu|ttu|wvu|byu|tcu|smu|csu|uga|uva|umd|uw|umass|csun|cuny|suny|university\s+of|state\s+university|community\s+college|technical\s+college|college\s+of|penn\s+state|ohio\s+state|iowa\s+state|michigan\s+state|florida\s+state|kansas\s+state|oklahoma\s+state|oregon\s+state|texas\s+state|tennessee\s+state)\b/i,
    add: [
      'student aid',
      'cost of attendance',
      'student housing',
      'room and board',
      'fafsa',
      'pell grant',
      'fseog',
      'scholarship',
      'institutional aid',
      'financial aid office',
      'emergency aid',
    ],
  },
  // Bare "living expenses" without an explicit student token still very
  // often means student living when paired with a school name, so we
  // emit student-aid terms in addition to housing-assistance terms. The
  // server cross-category cap keeps adult homelessness rows below the
  // threshold when student_aid is the primary category.
  {
    re: /\b(living\s+expense|living\s+cost|cost\s+of\s+living)\b/i,
    add: [
      'student aid',
      'cost of attendance',
      'student housing',
      'room and board',
      'rental assistance',
      'utility assistance',
    ],
  },
  // Plain "tuition assistance" / "tuition help" / generic university
  // tuition phrasing. Keeps "tuition" routed to the student-aid pool
  // even when no scholarship/Pell/FAFSA word is in the query.
  {
    re: /\b(tuition|undergrad(?:uate)?\s+aid|graduate\s+aid|college\s+aid)\b/i,
    add: [
      'student aid',
      'tuition assistance',
      'cost of attendance',
      'fafsa',
      'pell grant',
      'fseog',
      'scholarship',
    ],
  },
  // Professional development / continuing education / licensure.
  // This is the new pool that powers PROBE / CITI / nursing / social-work CE
  // queries. It deliberately includes workforce-board terms (WIOA / ITA /
  // American Job Center) because those are the primary funding channel for
  // license reinstatement and CE courses for individuals.
  {
    re: /\b(continuing\s+education|continuing\s+medical\s+education|cme|ceus?|ce credit|professional\s+development|professional\s+training)\b/i,
    add: [
      'continuing education',
      'professional development',
      'cme',
      'ceu',
      'license reinstatement',
      'wioa training',
      'individual training account',
      'workforce training board',
      'professional association scholarship',
      'state nurses foundation',
    ],
  },
  {
    re: /\b(licensure|license|licensing)\s+(reinstatement|renewal|restoration|exam|fee|prep)\b/i,
    add: [
      'license reinstatement',
      'license renewal',
      'licensure',
      'credential restoration',
      'recertification',
      'professional development',
      'continuing education',
      'wioa training',
      'workforce training board',
      'vocational rehabilitation',
    ],
  },
  {
    re: /\b(ethics|boundary|boundaries)\s+(training|course|class|program|education|ce|ceu|cme|credit|credits|requirement|requirements|hours)\b/i,
    add: [
      'ethics training',
      'professional boundaries',
      'probe ethics',
      'remediation course',
      'continuing education',
      'professional development',
      'license reinstatement',
    ],
  },
  {
    re: /\b(remediation|remedial)\s+(course|class|program|education|training|coursework)\b/i,
    add: [
      'remediation course',
      'remediation program',
      'professional remediation',
      'license reinstatement',
      'continuing education',
      'professional development',
    ],
  },
  {
    re: /\b(refresher|reentry|re-entry|return\s+to\s+practice|return\s+to\s+nursing)\b/i,
    add: [
      'nurse reentry',
      'return to practice',
      'nursing refresher',
      'continuing education',
      'license reinstatement',
      'professional development',
      'workforce reentry',
    ],
  },
  {
    re: /\b(certification|recertification|credential|credentialing)\b/i,
    add: [
      'certification',
      'recertification',
      'credentialing',
      'credential restoration',
      'professional development',
      'continuing education',
      'wioa training',
    ],
  },
  {
    re: /\b(workforce|wioa|individual\s+training\s+account|ita\b|vocational\s+rehab|voc\s+rehab|workforce\s+board|american\s+job\s+center|career\s+one\s*stop)\b/i,
    add: [
      'workforce development',
      'wioa training',
      'individual training account',
      'workforce training board',
      'american job center',
      'vocational rehabilitation',
    ],
  },
  {
    re: /\b(small business|startup|entrepreneur)\b/i,
    add: ['small business', 'entrepreneurship'],
  },
  {
    re: /\b(veteran|military|service member)\b/i,
    add: ['veteran', 'military'],
  },
]

function uniqueTerms(list) {
  const out = []
  const seen = new Set()
  for (const t of list) {
    const s = sanitizeSearchTerm(t)
    if (!s || s.length < 2) continue
    if (seen.has(s)) continue
    seen.add(s)
    out.push(s)
    if (out.length >= MAX_TERMS) break
  }
  return out
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
}

/**
 * Rule-based interpretation (always runs as baseline / fallback).
 * @param {string} text
 */
export function interpretFundingIntentRules(text) {
  const raw = String(text || '').trim().slice(0, MAX_INPUT)
  if (!raw) {
    return {
      summary: '',
      search_terms: [],
      method: 'rules',
      primary_category: 'general',
      excluded_categories: [],
      branded_program: null,
      credentials_detected: [],
    }
  }

  const added = []
  let brandedProgram = null

  // 1. Branded program lookup (highest signal — overrides loose token matches).
  for (const entry of BRANDED_PROGRAMS) {
    if (entry.re.test(raw)) {
      added.push(...entry.add)
      if (!brandedProgram) {
        brandedProgram = { name: entry.name, program_type: entry.program_type }
      }
    }
  }

  // 2. General term expansions.
  for (const { re, add } of EXPANSIONS) {
    if (re.test(raw)) added.push(...add)
  }

  const tokens = tokenize(raw)
  const phraseHints = []
  const bigram = []
  const words = raw.toLowerCase().split(/\s+/)
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i].replace(/[^a-z0-9]/g, '')
    const b = words[i + 1].replace(/[^a-z0-9]/g, '')
    if (a.length > 2 && b.length > 2) bigram.push(`${a} ${b}`)
  }
  phraseHints.push(...bigram.slice(0, 4))

  let search_terms = uniqueTerms([...added, ...phraseHints, ...tokens])

  const expanded = expandNeed(raw)
  if (expanded?.programCategories?.length) {
    search_terms.push(
      ...expanded.programCategories.slice(0, 6).map((c) => c.replace(/_/g, ' ')),
    )
  }
  if (expanded?.matchedKey === 'license_reinstatement' || expanded?.matchedKey === 'professional_development') {
    search_terms.push(
      'wioa training',
      'license reinstatement',
      'professional remediation',
      'continuing education',
      'nursing reentry',
    )
  }
  search_terms = uniqueTerms(search_terms)

  const credentials = extractCredentials(raw)
  // Credentials by themselves should also trigger the professional development
  // category because licensed-professional searches almost always benefit from
  // CE / workforce-board sources, even when the request text is generic.
  const haystack = `${raw.toLowerCase()} ${added.join(' ').toLowerCase()}`
  const cat = detectPrimaryCategory(raw, search_terms)
  if (
    cat.primary_category === 'general' &&
    credentials.length > 0 &&
    /\b(scholarship|ce|continuing|training|course|exam|license|funding|grant)\b/i.test(haystack)
  ) {
    cat.primary_category = 'professional_development'
    cat.excluded_categories = INCOME_SUPPORT_CATEGORIES.slice()
  }

  // Late-bound student_aid promotion: college + living-cost queries must win
  // over weak PD/taxonomy false positives (e.g. "cover" ⊂ "recovery"). Only
  // inspect the user's raw text — expanded terms like CITI → "university
  // training" must not trigger this path.
  {
    const rawLower = raw.toLowerCase()
    const collegeContext =
      /\b(student|college|university|undergrad|graduate|tuition|fafsa|pell|fseog|dorm|residence\s+hall|campus|off[\s-]?campus|cost\s+of\s+attendance|room\s+and\s+board|mtsu|ucf|ucla|ucsb|ucsd|usc|nyu|psu|asu|fsu|fiu|fau|ksu|osu|tsu|ttu|wvu|byu|tcu|smu|csu|uga|uva|umd|umass|csun|cuny|suny|penn\s+state|ohio\s+state|iowa\s+state|michigan\s+state|florida\s+state|kansas\s+state|oklahoma\s+state|texas\s+state|tennessee\s+state|middle\s+tennessee\s+state|state\s+university|community\s+college|technical\s+college|college\s+of)\b/i.test(rawLower)
    const livingCostContext =
      /\b(hous|liv|rent|apartment|expenses?|cost\s+of\s+attendance|room\s+and\s+board|off[\s-]?campus|tuition|board)\b/i.test(rawLower)
    const pdExplicit =
      /\b(probe|pro-?be|nclex|citi|scope|pace|cpep|ethics|boundaries|continuing education|cme|ce credits|ceu|licensure|license reinstatement|remediation|wioa|workforce training|professional development|board required|return to practice|nurse re-?entry|vocational rehabilitation|research compliance|human subjects)\b/i.test(rawLower)
    const studentAidDirect = detectPrimaryCategory(raw, [])
    const strongStudentAid =
      studentAidDirect.primary_category === 'student_aid' ||
      (collegeContext && livingCostContext)
    if (
      (cat.primary_category === 'general' || cat.primary_category === 'professional_development') &&
      strongStudentAid &&
      credentials.length === 0 &&
      !pdExplicit
    ) {
      cat.primary_category = 'student_aid'
      cat.excluded_categories = []
    }
  }

  let summary
  if (search_terms.length === 0) {
    summary = 'Describe what you need above — we will suggest search terms.'
  } else if (cat.primary_category === 'student_aid') {
    summary = `Routing to student aid sources (FAFSA, Pell, FSEOG, state student aid, room-and-board scholarships): ${search_terms.slice(0, 6).join(', ')}${search_terms.length > 6 ? '…' : ''}.`
  } else if (cat.primary_category === 'professional_development') {
    summary = `Routing to professional development / CE / licensure sources: ${search_terms.slice(0, 6).join(', ')}${search_terms.length > 6 ? '…' : ''}.`
  } else {
    summary = `Searching for opportunities related to: ${search_terms.slice(0, 6).join(', ')}${search_terms.length > 6 ? '…' : ''}.`
  }

  return {
    summary,
    search_terms,
    method: 'rules',
    primary_category: cat.primary_category,
    excluded_categories: cat.excluded_categories,
    branded_program: brandedProgram,
    credentials_detected: credentials,
    expanded_need: expanded?.canonicalNeed || null,
  }
}

/**
 * Optional OpenAI refinement: returns merged terms (capped).
 * @param {string} text
 * @param {import('openai').default|null} openai
 */
async function interpretWithOpenAI(text, openai) {
  const raw = String(text || '').trim().slice(0, MAX_INPUT)
  if (!raw) return null

  const providerResult = await invokeProviderJsonWithFallback({
    openai,
    openaiModel: process.env.SMART_MATCHER_INTENT_MODEL || 'gpt-4o-mini',
    temperature: 0.2,
    maxTokens: 400,
    system: `You help users find grant and assistance programs. Given a plain-language request, output JSON only:
{"summary":"one short sentence for the user","search_terms":["term1","term2",...]}
Rules:
- search_terms: 4-12 short lowercase phrases (2-4 words each) useful for SQL LIKE against titles/descriptions (funding, nonprofits, government programs, charities).
- Include both specific items (e.g. "bereavement travel", "passenger van") and adjacent help types (e.g. "emergency assistance", "transportation grant").
- For professional development / continuing education / licensure / nursing PROBE / CME / remediation requests, also include: "professional development", "continuing education", "license reinstatement", "wioa training", "workforce training board", "individual training account".
- For student / college / university / off-campus / on-campus / dorm / room-and-board / cost-of-attendance / FAFSA / Pell / financial-aid / tuition / scholarship requests, also include: "cost of attendance", "room and board", "student housing", "off-campus housing", "college housing", "fafsa", "pell grant", "fseog", "student emergency aid", "completion grant", "scholarship", "tuition assistance", "state student aid".
- No duplicates. No PII. English only.`,
    prompt: raw,
  })
  if (!providerResult.ok || !providerResult.json) return null
  const parsed = providerResult.json
  const terms = uniqueTerms(Array.isArray(parsed.search_terms) ? parsed.search_terms : [])
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : ''
  if (!terms.length) return null
  return {
    summary: summary || `Looking for: ${terms.slice(0, 5).join(', ')}.`,
    search_terms: terms,
    method: providerResult.provider,
  }
}

/**
 * @param {string} text
 * @param {{ openai?: import('openai').default | null }} [opts]
 */
export async function interpretFundingIntent(text, opts = {}) {
  const rules = interpretFundingIntentRules(text)
  let openai = opts.openai
  if (openai === undefined) {
    try {
      const r = createOpenAIClient({ allowMissing: true })
      openai = r?.openai ?? null
    } catch {
      openai = null
    }
  }

  try {
    const ai = await interpretWithOpenAI(text, openai)
    if (ai && ai.search_terms?.length) {
      const merged = uniqueTerms([...ai.search_terms, ...rules.search_terms])
      // Re-detect category against the merged term set so AI-only terms can
      // still trigger the professional_development pool.
      const cat = rules.primary_category !== 'general'
        ? { primary_category: rules.primary_category, excluded_categories: rules.excluded_categories }
        : detectPrimaryCategory(text, merged)
      return {
        summary: ai.summary || rules.summary,
        search_terms: merged.length ? merged : ai.search_terms,
        method: `${ai.method}+rules`,
        primary_category: cat.primary_category,
        excluded_categories: cat.excluded_categories,
        branded_program: rules.branded_program,
        credentials_detected: rules.credentials_detected,
      }
    }
  } catch (e) {
    console.warn('[smartMatcherIntent] AI intent refinement failed, using rules only:', e?.message || e)
  }

  return rules
}

// Exported for tests & for the matching route to re-detect category server-side
// when a frontend pre-dates the new fields.
export {
  detectPrimaryCategory,
  extractCredentials,
  INCOME_SUPPORT_CATEGORIES,
  ADULT_HOMELESSNESS_CATEGORIES,
  STUDENT_AID_TRIGGERS,
  PROFESSIONAL_DEVELOPMENT_TRIGGERS,
}
