/**
 * Producer-side scope gates in backend/services/matchEngine.js makeDecision().
 *
 * Every case here is a REAL prod pair from the 2026-08-01 GeneMac report (an
 * Indiana senior, `primary_type: 'senior'`, needs housing + health/medical) and
 * FAILS on pre-fix code, where:
 *   • the geography gate compared a US STATE and nothing else, so a foreign
 *     program (state NULL) skipped it — and, having no state, was also stamped
 *     `is_national`, i.e. scored as a fully-eligible NATIONWIDE US program;
 *   • a county locator carried its place only in its TITLE, so the same empty
 *     `state` short-circuit made "Polk County, TN" nationwide for an Indiana
 *     household;
 *   • an institutional award ceiling was never compared to the profile at all —
 *     `applicantTypeGate` reads eligibility PROSE and these rows carry none
 *     (HUD FHIP in prod: eligibility_text NULL, entity_types_allowed []).
 */

import { describe, it, expect } from 'vitest'
import { makeDecision, isIndividualLikeProfileType } from '../services/matchEngine.js'

const SENIOR_IN = {
  id: 'p-genemac',
  primary_type: 'senior',
  state: 'IN',
  city: 'Lagrange',
  postal_code: '46761',
  needs: ['housing', 'health_medical'],
}

const ORG_IN = {
  id: 'p-org',
  primary_type: 'nonprofit',
  state: 'IN',
  needs: ['housing'],
}

describe('makeDecision — foreign jurisdiction is a REJECT, not a nationwide match', () => {
  it('rejects the Irish Housing Adaptation Grant that reached a US senior', () => {
    const res = makeDecision(28, SENIOR_IN, {
      title: 'Housing Adaptation Grant for People with a Disability',
      sponsor: 'Local Authorities',
      description: 'Grant to adapt a home for a person with a disability.',
      source_url: 'https://www.citizensinformation.ie/en/housing/housing-grants-and-schemes/',
      // Exactly how prod stores it: no state, and therefore stamped national.
      state: null,
      is_national: true,
    })
    expect(res.decision).toBe('REJECT')
    expect(res.explanation).toMatch(/outside the United States/i)
  })

  it('rejects other live foreign hosts regardless of profile type', () => {
    for (const url of [
      'https://www.gov.uk/disabled-facilities-grants',
      'https://srd.sassa.gov.za/',
      'https://www.housingauthority.gov.hk/en/',
    ]) {
      for (const profile of [SENIOR_IN, ORG_IN]) {
        const res = makeDecision(40, profile, {
          title: 'Housing support scheme',
          description: 'Assistance with housing costs.',
          source_url: url,
          state: null,
          is_national: true,
        })
        expect(res.decision, `${url} / ${profile.primary_type}`).toBe('REJECT')
      }
    }
  })

  it('does NOT reject a US funder, and a link shortener is never foreign evidence', () => {
    const us = makeDecision(40, SENIOR_IN, {
      title: 'Indiana FSSA Benefits Portal',
      description: 'State benefits for Indiana households.',
      source_url: 'https://fssabenefits.in.gov',
      state: 'IN',
      is_national: false,
    })
    expect(us.decision).not.toBe('REJECT')

    const shortened = makeDecision(40, SENIOR_IN, {
      title: 'Housing assistance',
      description: 'Help with rent.',
      source_url: 'https://lnkd.in/dC6VRfHD',
      state: null,
      is_national: true,
    })
    expect(shortened.decision).not.toBe('REJECT')
  })
})

describe('makeDecision — a locator that names its own place is exclusive to it', () => {
  const polkCountyTn = {
    title: 'Polk County, TN — Local assistance programs near you (findhelp)',
    sponsor: 'findhelp (Aunt Bertha)',
    description: 'Local assistance programs near you.',
    source_url: 'https://www.findhelp.org/search_results/37323',
    opportunity_kind: 'DIRECTORY',
    // Exactly how prod stores every one of these: place ONLY in the title.
    state: null,
    is_national: true,
    geo_county: null,
    geo_zip: null,
  }

  it('rejects another state’s county locator for an Indiana household', () => {
    const res = makeDecision(13, SENIOR_IN, polkCountyTn)
    expect(res.decision).toBe('REJECT')
    expect(res.explanation).toMatch(/Geographic mismatch/i)
  })

  it('keeps the profile’s OWN county locator (the fix must not silence the local fleet)', () => {
    const res = makeDecision(13, SENIOR_IN, {
      ...polkCountyTn,
      title: 'La Grange County, IN — Local assistance programs near you (findhelp)',
      source_url: 'https://www.findhelp.org/search_results/46761',
    })
    expect(res.decision).not.toBe('REJECT')
  })

  it('leaves a genuinely national resource national', () => {
    const res = makeDecision(13, SENIOR_IN, {
      title: '211 - Local help with rent, utilities, food & emergencies',
      description: 'United Way 211 national helpline.',
      source_url: 'https://www.211.org',
      opportunity_kind: 'DIRECTORY',
      state: null,
      is_national: true,
    })
    expect(res.decision).not.toBe('REJECT')
  })

  it('never REJECTs on a declared place when the profile has NO state (missing = neutral)', () => {
    const res = makeDecision(13, { id: 'p-nostate', primary_type: 'individual', needs: ['housing'] }, polkCountyTn)
    expect(res.decision).not.toBe('REJECT')
  })
})

describe('makeDecision — institutional award scale is not individual assistance', () => {
  const fhip = {
    title: 'Fair Housing Initiative Program - Education and Outreach Initiative',
    sponsor: 'HUD',
    description: 'This program funds initiatives aimed at educating the public about fair housing rights and responsibilities.',
    source_url: 'https://www.hud.gov/program_offices/fair_housing_equal_opp/fiip',
    // Prod: NO eligibility prose at all — a text gate can never reach this row.
    eligibility_text: null,
    eligibility_bullets: [],
    entity_types_allowed: [],
    amount_min: 0,
    amount_max: 1250000,
    state: null,
    is_national: true,
  }

  it('rejects HUD FHIP ($1.25M) for the senior it matched as "Individual applicant"', () => {
    const res = makeDecision(28, SENIOR_IN, fhip)
    expect(res.decision).toBe('REJECT')
    expect(res.explanation).toMatch(/Institutional award scale/i)
  })

  it('rejects the rest of the live institutional cohort for person-type profiles', () => {
    const rows = [
      { title: 'Oceanographic Facilities and Equipment Support', amount_min: 5000, amount_max: 47500000 },
      { title: 'FY26 Pathways to Removing Obstacles to Housing (PRO Housing)', amount_min: 5000000, amount_max: 10000000 },
      { title: 'Title X Family Planning Services Grants', amount_min: 200000, amount_max: 22000000 },
    ]
    for (const row of rows) {
      for (const type of ['individual', 'senior', 'family', 'student', 'veteran']) {
        const res = makeDecision(44, { ...SENIOR_IN, primary_type: type }, {
          ...row,
          description: 'Federal grant program.',
          source_url: 'https://www.grants.gov/x',
          state: null,
          is_national: true,
        })
        expect(res.decision, `${row.title} / ${type}`).toBe('REJECT')
      }
    }
  })

  it('leaves ORGANIZATIONS alone — a large award is legitimate for them', () => {
    const res = makeDecision(44, ORG_IN, fhip)
    expect(res.decision).not.toBe('REJECT')
  })

  it('leaves real individual assistance alone, and a row with NO stated amount is exempt', () => {
    const scholarship = makeDecision(44, SENIOR_IN, {
      title: 'Housing repair assistance',
      description: 'Assistance for low-income homeowners.',
      source_url: 'https://example.org/repair',
      amount_min: 500,
      amount_max: 25000,
      state: 'IN',
    })
    expect(scholarship.decision).not.toBe('REJECT')

    const silent = makeDecision(44, SENIOR_IN, {
      title: 'Area Agency on Aging & Eldercare Locator',
      description: 'Find local aging services.',
      source_url: 'https://eldercare.acl.gov',
      opportunity_kind: 'DIRECTORY',
      amount_min: null,
      amount_max: null,
      state: null,
      is_national: true,
    })
    expect(silent.decision).not.toBe('REJECT')
  })
})

describe('isIndividualLikeProfileType — leaf types roll up through the registry', () => {
  it('sees a person behind every individual-root leaf (the hand-written list did not)', () => {
    for (const t of ['individual', 'senior', 'family', 'student', 'veteran', 'college_student', 'high_school_student']) {
      expect(isIndividualLikeProfileType(t), t).toBe(true)
    }
  })

  it('never widens onto an org, and treats an unknown type as NOT a person', () => {
    for (const t of ['nonprofit', 'church', 'school', 'business', 'government', 'organization', 'wat', '', null, undefined]) {
      expect(isIndividualLikeProfileType(t), String(t)).toBe(false)
    }
  })
})
