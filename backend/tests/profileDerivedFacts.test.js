import { describe, it, expect } from 'vitest'
import {
  DERIVED_FACT_FIELDS,
  NON_TOPICAL_TERMS,
  PLACE_TERMS,
  MAX_TOPICAL_TERMS,
  normalizeTerm,
  isTopicalTerm,
  deriveStageOfLife,
  deriveProfileFacts,
  searchTermsFromFacts,
  titleStatesTerm,
  termLikePattern,
} from '../config/profileDerivedFacts.js'
import { PROFILE_INSTITUTION_FIELDS } from '../config/profileInstitutions.js'
import { AID_TYPE_KEYS } from '../config/aidTypePreferences.js'

/**
 * ANASTASIA WHITE — the real prod profile this module exists for
 * (`c4a92724-9cee-416f-ba30-e91b9b5cd885`), read read-only 2026-08-02. Trimmed
 * to the fields under test; every value below is verbatim from prod.
 */
const ANASTASIA_SECTIONS = {
  basic_information: {
    current_school: 'Middle Tennessee State University',
    location: { city: 'Cleveland', state: 'TN', county: 'Bradley County', zip_code: '37312' },
    academic_status: { gpa: 3.84, act_score: 28, education_level: 'High School Senior', college_courses: 'Yes', sat_score: 1230 },
    // The prose-split garbage that a naive "interests" read would ingest.
    interests: [
      'Academic achievement',
      'college readiness',
      'and community engagement are key interests for Anastasia Nicole White. As a high school senior enrolled in college-level courses at Cleveland State Community College',
    ],
  },
  education: {
    highest_level: 'Associates Degree',
    current_institution: 'Middle Tennessee State University',
    gpa: '3.84',
    act_score: '28',
    intended_major: 'Forensic Science',
    schools: { name: 'Cleveland State Community College', status: 'Current', type: 'Community College' },
    target_colleges: ['Middle Tennessee State University', 'Oberlin College', 'Harvard University', 'Penn State University'],
    interests: ['Forensic Science', 'Criminal Justice', 'STEM', 'DNA Analysis', 'Crime Scene Investigation'],
    aid_types_accepted: ['grant', 'endowment', 'scholarship'],
  },
  programs_services: {
    interests: ['Forensic Science Education Programs', 'Scholarship Opportunities for STEM Students', 'Educational Equity Initiatives'],
    keywords: ['forensic science', 'criminal justice', 'stem', 'research', 'laboratory', 'tennessee student', 'forensic pathology', 'women in stem'],
  },
}

describe('profileDerivedFacts — the REGISTRY is total', () => {
  it('every registry entry is consulted by deriveProfileFacts and carries a fact kind', () => {
    const facts = deriveProfileFacts({}, ANASTASIA_SECTIONS)
    const consumedFactKinds = new Set([
      ...facts.topicalTerms.map((t) => t.fact),
      facts.stageOfLife ? 'stage_of_life' : null,
      'academic_standing',
      'accepted_aid_types',
    ].filter(Boolean))
    for (const field of DERIVED_FACT_FIELDS) {
      expect(typeof field.id, `${field.id} needs an id`).toBe('string')
      expect(typeof field.read, `${field.id} needs a reader`).toBe('function')
      expect(typeof field.fact, `${field.id} needs a fact kind`).toBe('string')
      expect(consumedFactKinds.has(field.fact), `fact kind "${field.fact}" (${field.id}) reaches no consumer`).toBe(true)
    }
  })

  it('every registry reader survives a garbage / empty / string-JSON section map', () => {
    for (const field of DERIVED_FACT_FIELDS) {
      expect(() => field.read({})).not.toThrow()
      expect(() => field.read({ education: 'not json', programs_services: 42, basic_information: null })).not.toThrow()
      expect(() => field.read({ education: '{"intended_major":"Nursing"}' })).not.toThrow()
    }
  })

  it('institutions are DELEGATED to profileInstitutions — never re-derived here', () => {
    // A second door onto the attendance-vs-aspiration rule is exactly what
    // #1090 had to close. This module must not own a school field of its own.
    const institutionFieldIds = new Set(PROFILE_INSTITUTION_FIELDS.map((f) => f.id))
    for (const field of DERIVED_FACT_FIELDS) {
      expect(institutionFieldIds.has(field.id), `${field.id} duplicates a profileInstitutions field`).toBe(false)
    }
    const facts = deriveProfileFacts({}, ANASTASIA_SECTIONS)
    expect(facts.institutions.evidence).toContain('profileInstitutions')
  })

  it('accepted aid types are DELEGATED to aidTypePreferences and stay in its taxonomy', () => {
    const facts = deriveProfileFacts({}, ANASTASIA_SECTIONS)
    for (const key of facts.acceptedAidTypes.value) expect(AID_TYPE_KEYS).toContain(key)
  })
})

describe('profileDerivedFacts — the Anastasia regression (the defect this exists for)', () => {
  it('the topical budget is spent on her FIELD, not on her name and gender', () => {
    const terms = searchTermsFromFacts(deriveProfileFacts({ display_name: 'Anastasia Nicole White' }, ANASTASIA_SECTIONS))
    // The shipped-before behavior, measured in prod: `buildThesis` resolved
    // interest_terms to her first/middle/last name plus gender synonyms.
    for (const junk of ['anastasia', 'nicole', 'white', 'female', 'woman', 'women', 'girl', 'female identifying']) {
      expect(terms, `"${junk}" must never be a topical term`).not.toContain(junk)
    }
    expect(terms[0]).toBe('forensic science')
    expect(terms).toContain('criminal justice')
    expect(terms).toContain('dna analysis')
    expect(terms).toContain('crime scene investigation')
  })

  it('the declared MAJOR outranks every mined keyword — the bound truncates the weakest evidence', () => {
    const facts = deriveProfileFacts({}, ANASTASIA_SECTIONS)
    expect(facts.topicalTerms.length).toBeLessThanOrEqual(MAX_TOPICAL_TERMS)
    expect(facts.topicalTerms[0].evidence).toBe('education.intended_major')
    const majorIdx = facts.topicalTerms.findIndex((t) => t.evidence === 'education.intended_major')
    const minedIdx = facts.topicalTerms.findIndex((t) => t.evidence === 'programs_services.keywords')
    if (minedIdx >= 0) expect(majorIdx).toBeLessThan(minedIdx)
  })

  it('every derived fact names the FIELD it came from', () => {
    const facts = deriveProfileFacts({}, ANASTASIA_SECTIONS)
    const registryIds = new Set(DERIVED_FACT_FIELDS.map((f) => f.id))
    for (const t of facts.topicalTerms) expect(registryIds.has(t.evidence), `${t.term} has no registry provenance`).toBe(true)
    expect(facts.acceptedAidTypes.evidence).toBe('education.aid_types_accepted')
    expect(facts.academicStanding.gpa.evidence).toBe('education.gpa')
    expect(facts.stageOfLife.evidence).toContain('basic_information.academic_status.education_level')
  })

  it('prose masquerading as an interest never becomes a term', () => {
    // basic_information.interests holds a SENTENCE split on commas in prod. It
    // is not in the registry at all, and even if it were the length bound and
    // the stoplist refuse it.
    const terms = searchTermsFromFacts(deriveProfileFacts({}, ANASTASIA_SECTIONS))
    for (const t of terms) expect(t.length).toBeLessThanOrEqual(40)
    expect(terms.some((t) => t.includes('anastasia nicole white'))).toBe(false)
  })

  it('only DECLARED education fields may authorize a catalog look', () => {
    const facts = deriveProfileFacts({}, ANASTASIA_SECTIONS)
    const allowed = new Set(['education.intended_major', 'education.major', 'student_portal_plan.major', 'education.interests'])
    expect(facts.recallTerms.length).toBeGreaterThan(0)
    for (const t of facts.recallTerms) expect(allowed.has(t.evidence), `${t.evidence} must not be recall-safe`).toBe(true)
    // Mined keywords are search-only: measured 2026-08-02, admitting them turned
    // 613 pairs into 471 links, 211 of them from one profile's "human services".
    expect(facts.recallTerms.some((t) => t.evidence === 'programs_services.keywords')).toBe(false)
  })
})

describe('profileDerivedFacts — the precision rules (each was measured)', () => {
  it('a single word is never a topical term', () => {
    // "science" reaches 258 STEM rows; "white" is a surname.
    for (const w of ['science', 'research', 'white', 'chemistry', 'biology', 'stem']) {
      expect(isTopicalTerm(w), `"${w}" must be refused`).toBe(false)
    }
  })

  it('a US state name is a PLACE, never a field of study', () => {
    // Measured: admitting "south dakota" linked 15 rows to a South Dakota
    // ministry on the state name alone — a claim the geography gate already owns.
    expect(isTopicalTerm('south dakota')).toBe(false)
    expect(isTopicalTerm('new hampshire')).toBe(false)
    expect(isTopicalTerm('puerto rico')).toBe(false)
    expect(PLACE_TERMS.has('tennessee')).toBe(true)
    // The list is DERIVED from STATE_REGISTRY, so it cannot drift.
    expect(PLACE_TERMS.size).toBeGreaterThanOrEqual(51)
  })

  it('generic academic / funding vocabulary is refused', () => {
    for (const t of ['financial aid', 'funding opportunities', 'research and development', 'community support', 'high school senior']) {
      expect(isTopicalTerm(t), `"${t}" must be refused`).toBe(false)
      expect(NON_TOPICAL_TERMS.has(t)).toBe(true)
    }
  })

  it('a real discipline phrase is accepted', () => {
    for (const t of ['forensic science', 'criminal justice', 'assistive technology', 'vocational rehabilitation', 'emergency medical services']) {
      expect(isTopicalTerm(t), `"${t}" must be accepted`).toBe(true)
    }
  })

  it('titleStatesTerm is TOKEN-BOUNDARY, not substring', () => {
    expect(titleStatesTerm('forensic science', 'AFTE Forensic Science Scholarship')).toBe(true)
    expect(titleStatesTerm('criminal justice', 'Criminal Justice & Forensics Scholarship Directory')).toBe(true)
    // Direction: TERM inside TITLE only.
    expect(titleStatesTerm('AFTE Forensic Science Scholarship', 'forensic science')).toBe(false)
    // Must not hit inside a longer word (the `renal` ⊄ `adrenal` rule).
    expect(titleStatesTerm('renal care', 'Adrenal Careers Fund')).toBe(false)
    expect(titleStatesTerm('forensic science', 'Forensic Sciences Institute')).toBe(false)
  })

  it('termLikePattern is a SUPERSET so candidate discovery can be a SQL predicate', () => {
    const pat = termLikePattern('Forensic Science')
    expect(pat).toBe('%forensic science%')
    // Anything titleStatesTerm accepts must first survive the LIKE superset, or
    // the predicate would silently starve the adjudicator (#944).
    const title = 'AFTE Forensic Science Scholarship'
    expect(title.toLowerCase().includes(pat.replaceAll('%', ''))).toBe(true)
  })

  it('normalizeTerm collapses punctuation and case without mangling words', () => {
    expect(normalizeTerm('  Crime-Scene   Investigation! ')).toBe('crime scene investigation')
    expect(normalizeTerm(null)).toBe('')
  })
})

describe('profileDerivedFacts — stage of life is DERIVED, never guessed', () => {
  it('High School Senior + college courses => dual-enrolled incoming freshman', () => {
    const stage = deriveStageOfLife(ANASTASIA_SECTIONS)
    expect(stage.value).toBe('dual_enrolled_incoming_freshman')
    expect(stage.evidence).toContain('basic_information.academic_status.college_courses')
  })

  it('a high schooler NOT taking college courses is not a dual-enrolled freshman', () => {
    expect(deriveStageOfLife({
      basic_information: { academic_status: { education_level: 'High School Senior', college_courses: 'No' } },
    }).value).toBe('high_school_student')
  })

  it('a graduate level wins over an undergraduate word', () => {
    expect(deriveStageOfLife({ education: { highest_level: 'Master of Science' } }).value).toBe('graduate_student')
  })

  it('a profile that says nothing gets NO stage — silence is never resolved', () => {
    expect(deriveStageOfLife({})).toBeNull()
    expect(deriveStageOfLife({ education: {} })).toBeNull()
    expect(deriveProfileFacts({}, {}).stageOfLife).toBeNull()
  })
})

describe('profileDerivedFacts — an absent fact is ABSENT', () => {
  it('an empty profile yields no terms, no stage, no invented standing', () => {
    const facts = deriveProfileFacts({}, {})
    expect(facts.topicalTerms).toEqual([])
    expect(facts.recallTerms).toEqual([])
    expect(facts.stageOfLife).toBeNull()
    expect(facts.academicStanding.gpa).toBeNull()
    expect(facts.academicStanding.act).toBeNull()
  })

  it('an undeclared aid preference is reported as DEFAULTED, with null evidence', () => {
    const facts = deriveProfileFacts({}, {})
    expect(facts.acceptedAidTypes.declared).toBe(false)
    expect(facts.acceptedAidTypes.evidence).toBeNull()
    // aidTypePreferences' documented default: everything except debt.
    expect(facts.acceptedAidTypes.value).toContain('grant')
    expect(facts.acceptedAidTypes.value).not.toContain('loan')
  })

  it('deriveProfileFacts never throws on hostile input', () => {
    for (const bad of [null, undefined, 'string', 42, [], { education: [] }]) {
      expect(() => deriveProfileFacts(bad, bad)).not.toThrow()
    }
  })
})
