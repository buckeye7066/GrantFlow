/**
 * Service-commitment eligibility (owner ruling 2026-08-23).
 *
 * "Army ROTC Scholarships" sat at ACCEPT 100 in a real incoming-freshman
 * profile whose military_service section declares `veteran: false` and nothing
 * else military. The row is a web_search mint with NULL eligibility_text, so
 * every MISSING = NEUTRAL gate admitted it. The owner's ruling inverts the
 * default for this ONE class: a service-commitment award (ROTC / service
 * academies / enlistment incentives) requires a POSITIVE declared military
 * affiliation — absence refuses.
 */

import { describe, it, expect } from 'vitest'
import {
  detectServiceCommitmentLock,
  hasDeclaredMilitaryAffiliation,
  assessServiceCommitmentEligibility,
  SERVICE_COMMITMENT_LOCK_PATTERNS,
} from '../services/eligibility/serviceCommitmentEligibility.js'
import { makeDecision } from '../services/matchEngine.js'

describe('the lock — identity text only, commitment programs only', () => {
  it.each([
    ['Army ROTC Scholarships', 'rotc'],
    ['Navy ROTC Scholarship Program', 'rotc'],
    ['United States Military Academy at West Point', 'service_academy'],
    ['Air Force Academy Appointment', 'service_academy'],
    ['National Guard Enlistment Bonus', 'enlistment_incentive'],
  ])('locks %s as %s', (title, label) => {
    expect(detectServiceCommitmentLock(title)).toBe(label)
  })

  it('a VETERAN-benefit or military-FAMILY program is NOT a commitment lock (already-served people are governed by requiresVeteran)', () => {
    for (const title of [
      'VA Housing Grants for Disabled Veterans',
      'Military Spouse Career Advancement Accounts',
      'Folds of Honor Scholarship for Military Families',
      'Pat Tillman Foundation Scholars',
      'Academy of Country Music Scholarship', // 'academy' alone never locks
    ]) {
      expect(detectServiceCommitmentLock(title), title).toBeNull()
    }
  })

  it('the registry is word-bounded (no substring locks)', () => {
    for (const { rx } of SERVICE_COMMITMENT_LOCK_PATTERNS) {
      expect(rx.flags).toContain('i')
    }
    // 'rotc' must not fire inside another word.
    expect(detectServiceCommitmentLock('Microtcell Research Grant')).toBeNull()
  })
})

describe('the declaration — structured flags + curated identity only, never notes', () => {
  it('explicit veteran:false (the real profile shape) declares NOTHING military', () => {
    expect(hasDeclaredMilitaryAffiliation({ military_service: { veteran: false } })).toBe(false)
  })
  it('an explicit true flag declares it', () => {
    expect(hasDeclaredMilitaryAffiliation({ military_service: { veteran: true } })).toBe(true)
    expect(hasDeclaredMilitaryAffiliation({ military_service: { rotc: true } })).toBe(true)
    expect(hasDeclaredMilitaryAffiliation({ military_service: { national_guard: true } })).toBe(true)
  })
  it('a curated identity field declaring a military path counts', () => {
    expect(hasDeclaredMilitaryAffiliation({ education: { intended_major: 'Military Science (ROTC)' } })).toBe(true)
    expect(hasDeclaredMilitaryAffiliation({ career: { career_goal: 'Commissioned military officer' } })).toBe(true)
  })
  it('the NEGATION TRAP: a denial in free-text notes never declares (notes are not read)', () => {
    expect(hasDeclaredMilitaryAffiliation({
      military_service: { veteran: false, notes: 'No military affiliation or documentation indicating veteran or ROTC status.' },
    })).toBe(false)
  })
  it('an empty/absent sections map declares nothing', () => {
    expect(hasDeclaredMilitaryAffiliation({})).toBe(false)
    expect(hasDeclaredMilitaryAffiliation(undefined)).toBe(false)
  })
})

describe('the verdict', () => {
  it('locked + undeclared → ineligible; locked + declared → eligible; unlocked → silent', () => {
    expect(assessServiceCommitmentEligibility({ itemText: 'Army ROTC Scholarships U.S. Army', declared: false }).ineligible).toBe(true)
    expect(assessServiceCommitmentEligibility({ itemText: 'Army ROTC Scholarships U.S. Army', declared: true }).ineligible).toBe(false)
    expect(assessServiceCommitmentEligibility({ itemText: 'HOPE Scholarship Tennessee Lottery', declared: false }).ineligible).toBe(false)
  })
})

describe('makeDecision consumes the gate (the ACCEPT-100 regression)', () => {
  const FRESHMAN = { id: 'p-student', primary_type: 'student', state: 'TN', needs: ['education', 'tuition'] }
  const NO_MILITARY_SECTIONS = {
    basic_information: { academic_status: { education_level: 'College Freshman (incoming)' } },
    education: { current_institution: 'State University', intended_major: 'Forensic Science' },
    military_service: { veteran: false },
  }
  const ROTC_ROW = {
    title: 'Army ROTC Scholarships',
    sponsor: 'U.S. Army',
    // The real row's shape: a web mint with nothing to gate on.
    eligibility_text: null,
  }

  it('the verbatim ROTC row is a REJECT for a veteran:false student with no military declaration', () => {
    const res = makeDecision(100, FRESHMAN, ROTC_ROW, null, null, null, NO_MILITARY_SECTIONS)
    expect(res.decision).toBe('REJECT')
    expect(res.explanation).toMatch(/service commitment/i)
  })

  it('a declared ROTC cadet keeps the row (never rejected by this gate)', () => {
    const sections = { ...NO_MILITARY_SECTIONS, military_service: { veteran: false, rotc: true } }
    const res = makeDecision(100, FRESHMAN, ROTC_ROW, null, null, null, sections)
    expect(String(res.explanation ?? '')).not.toMatch(/service commitment/i)
  })

  it('a declared military career goal keeps the row', () => {
    const sections = { ...NO_MILITARY_SECTIONS, career: { career_goal: 'Army officer via ROTC' } }
    const res = makeDecision(100, FRESHMAN, ROTC_ROW, null, null, null, sections)
    expect(String(res.explanation ?? '')).not.toMatch(/service commitment/i)
  })

  it('an ordinary scholarship is untouched by the gate', () => {
    const res = makeDecision(100, FRESHMAN, { title: 'HOPE Scholarship', sponsor: 'Tennessee Lottery' }, null, null, null, NO_MILITARY_SECTIONS)
    expect(String(res.explanation ?? '')).not.toMatch(/service commitment/i)
  })
})
