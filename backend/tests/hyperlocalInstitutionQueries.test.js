/**
 * hyperlocalInstitutionQueries.test.js
 *
 * Regression coverage for the 2026-07-06 hyperlocal_recall_miss /
 * institution_recall_miss fix set in buildWebQueries: local money flows
 * through named LOCAL ENTITY CLASSES (churches, county education foundations,
 * civic clubs, emergency funds, chambers, workforce boards, extension
 * offices) and org funding flows through INSTITUTION-CLASS programs (AFG for
 * a VFD, CDBG for a CDC, OVW for a DV shelter, USDA co-op programs for an
 * agricultural cooperative) — none of which generic "grants ${geo}" phrasing
 * can reach.
 */
import { describe, it, expect } from 'vitest'
import { buildWebQueries } from '../crawler-os/webQueries.js'

const YEAR = 2026
const LOC = { city: 'Cleveland', state: 'TN', county: 'Bradley', nearby_cities: [] }

// Collect the FULL query universe (core + entire extra pool) for assertions.
function allQueries(thesis) {
  return buildWebQueries(thesis, { max: 200, year: YEAR, seed: 0 })
}
// The capped set a real run gets — used to assert CORE placement.
function cappedQueries(thesis, max = 14) {
  return buildWebQueries(thesis, { max, year: YEAR, seed: 0 })
}
const hasMatch = (queries, re) => queries.some((q) => re.test(q))

describe('hyperlocal recall — a local-need profile does NOT stop at national grants', () => {
  const NEEDY_FAMILY = {
    applicant_types: ['family', 'individual'],
    needs: ['housing', 'food', 'energy'],
    location: LOC,
    keywords: [],
  }

  it('emits church / emergency-fund entity queries in the CAPPED (core) set', () => {
    const qs = cappedQueries(NEEDY_FAMILY)
    expect(hasMatch(qs, /churches that help with/i)).toBe(true)
    expect(hasMatch(qs, /emergency assistance fund/i)).toBe(true)
  })

  it('broadens to utility / food / housing entity searches in the pool', () => {
    const qs = allQueries(NEEDY_FAMILY)
    expect(hasMatch(qs, /utility bill assistance/i)).toBe(true)
    expect(hasMatch(qs, /food pantry/i)).toBe(true)
    expect(hasMatch(qs, /housing assistance programs/i)).toBe(true)
    expect(hasMatch(qs, /salvation army/i)).toBe(true)
  })

  it('keeps the county + community-foundation core lanes', () => {
    const qs = cappedQueries(NEEDY_FAMILY)
    expect(hasMatch(qs, /Bradley County/i)).toBe(true)
    expect(hasMatch(qs, /community foundation/i)).toBe(true)
  })
})

describe('hyperlocal recall — students reach local scholarship ENTITIES', () => {
  const STUDENT = {
    applicant_types: ['student', 'individual'],
    is_student: true,
    needs: ['scholarship', 'education'],
    location: LOC,
    schools: ['Cleveland State Community College'],
  }

  it('county education foundation is CORE (survives the cap)', () => {
    const qs = cappedQueries(STUDENT)
    expect(hasMatch(qs, /Bradley County.*education foundation|education foundation.*Bradley County/i)).toBe(true)
  })

  it('civic clubs / Dollars for Scholars / church scholarships are in the pool', () => {
    const qs = allQueries(STUDENT)
    expect(hasMatch(qs, /rotary club scholarship/i)).toBe(true)
    expect(hasMatch(qs, /dollars for scholars/i)).toBe(true)
    expect(hasMatch(qs, /church scholarships/i)).toBe(true)
  })
})

describe('institution recall — org profiles get institution-class program queries', () => {
  it('VFD/EMS → Assistance to Firefighters Grant is CORE', () => {
    const vfd = {
      applicant_types: ['vfd', 'government'],
      needs: ['public_safety', 'emergency', 'equipment'],
      location: LOC,
    }
    expect(hasMatch(cappedQueries(vfd), /assistance to firefighters grant/i)).toBe(true)
    expect(hasMatch(allQueries(vfd), /EMS equipment grants/i)).toBe(true)
  })

  it('DV shelter (nonprofit + domestic_violence need) → shelter/OVW program queries', () => {
    const shelter = {
      applicant_types: ['nonprofit'],
      needs: ['domestic_violence', 'housing', 'mental_health'],
      location: LOC,
    }
    expect(hasMatch(cappedQueries(shelter), /domestic violence shelter grants/i)).toBe(true)
    expect(hasMatch(allQueries(shelter), /OVW grant programs/i)).toBe(true)
    expect(hasMatch(allQueries(shelter), /VOCA victim assistance/i)).toBe(true)
  })

  it('community development corporation → CDBG core + CDFI/CHDO pool', () => {
    const cdc = {
      applicant_types: ['nonprofit'],
      needs: ['housing_development', 'economic_development', 'community_facilities'],
      location: LOC,
    }
    expect(hasMatch(cappedQueries(cdc), /community development block grant/i)).toBe(true)
    expect(hasMatch(allQueries(cdc), /CDFI fund/i)).toBe(true)
    expect(hasMatch(allQueries(cdc), /CHDO funding/i)).toBe(true)
  })

  it('agricultural cooperative → USDA rural development core + co-op programs pool', () => {
    const coop = {
      applicant_types: ['farm', 'business'],
      needs: ['agriculture', 'economic_development', 'equipment'],
      location: LOC,
    }
    expect(hasMatch(cappedQueries(coop), /USDA rural development grants/i)).toBe(true)
    const pool = allQueries(coop)
    expect(hasMatch(pool, /value-added producer grant/i)).toBe(true)
    expect(hasMatch(pool, /rural cooperative development grant/i)).toBe(true)
    expect(hasMatch(pool, /extension office/i)).toBe(true)
  })

  it('clinic (nonprofit + medical/equipment needs) → rural health / HRSA lanes', () => {
    const clinic = {
      applicant_types: ['nonprofit'],
      needs: ['medical', 'equipment', 'operations'],
      location: LOC,
    }
    expect(hasMatch(cappedQueries(clinic), /rural health grants/i)).toBe(true)
    expect(hasMatch(allQueries(clinic), /HRSA funding opportunities/i)).toBe(true)
  })

  it('church applicant → faith-based grant lanes in the pool', () => {
    const church = {
      applicant_types: ['church', 'nonprofit'],
      needs: ['programs', 'capital'],
      location: LOC,
    }
    const pool = allQueries(church)
    expect(hasMatch(pool, /grants for churches/i)).toBe(true)
    expect(hasMatch(pool, /faith-based organization grants/i)).toBe(true)
  })
})

describe('closed loop — a learned hyperlocal_gap escalates to entity queries', () => {
  it('non-student: gap steering forces the county emergency-fund entity query into CORE', () => {
    const thesis = {
      applicant_types: ['individual'],
      needs: ['medical'],
      location: LOC,
      learned_gaps: { classes: ['hyperlocal_gap'] },
    }
    const qs = cappedQueries(thesis, 20)
    expect(hasMatch(qs, /local assistance programs Bradley County/i)).toBe(true)
    expect(hasMatch(qs, /Bradley County.*emergency assistance fund/i)).toBe(true)
  })

  it('student: gap steering forces the education-foundation entity query', () => {
    const thesis = {
      applicant_types: ['student', 'individual'],
      is_student: true,
      needs: ['scholarship'],
      location: LOC,
      learned_gaps: { classes: ['hyperlocal_gap'] },
    }
    const qs = cappedQueries(thesis, 20)
    expect(hasMatch(qs, /Bradley County.*education foundation/i)).toBe(true)
  })
})
