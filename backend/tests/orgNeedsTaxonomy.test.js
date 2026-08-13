/**
 * Profile-driven needs taxonomy (owner directive 2026-08-12).
 *
 * "When a profile identifies as a given org type, automatically populate a
 * predetermined list of candidate needs — UNLESS ALREADY SHOWN TO HAVE it —
 * plus the owner's own free-text needs, and run an honest real search for each."
 *
 * The properties pinned here are the ones whose failure would be INVISIBLE in
 * production — a need silently vanishing, a need silently invented, or a
 * suppression rule firing on silence:
 *
 *   1. The biolab blueprint covers the owner's stated minimum, by code.
 *   2. SUPPRESSION IS ONE-WAY. Each rule is exercised in BOTH directions in the
 *      same test: evidence present → the need is absent from `open`; the SAME
 *      profile with that one field cleared → the need is back in `open`. A
 *      disabled suppression fails the first half; an over-eager suppression
 *      (firing on empty/unknown) fails the second. Neither half can pass
 *      vacuously, which is the "a check that cannot fail proves nothing" bar.
 *   3. CONSERVATION. candidates === open + suppressed + not_applicable +
 *      truncated, so no need can disappear without a named reason.
 *   4. User-added needs are verbatim and are NEVER suppressed by our rules.
 *   5. Blueprint/taxonomy drift: every code in every blueprint resolves.
 *   6. No score inflation: the plan carries no manufactured percentage.
 */

import { describe, it, expect } from 'vitest'

import {
  deriveOrgNeeds,
  resolveBlueprint,
  evaluateSatisfaction,
  collectUserNeeds,
  getNeedDefinition,
  buildSearchSubject,
  NEED_BLUEPRINTS,
  GROUP_BLUEPRINTS,
  ORG_BASELINE,
  SATISFACTION_RULES,
  MAX_PLAN_NEEDS,
} from '../services/needs/orgNeedsTaxonomy.js'
import { PROFILE_SCHEMA, PROFILE_TYPE_OPTIONS, FACILITY_STATUS_OPTIONS, isFieldScored } from '../config/profileSchema.js'
import { ALL_ORG_TYPES } from '../../shared/profileSectionApplicability.js'

const BIOLAB = { primary_type: 'research_lab', display_name: 'Axiom Bio Labs' }

/** Deep-ish clone good enough for the plain-JSON section fixtures below. */
const clone = (value) => JSON.parse(JSON.stringify(value))

const codesOf = (needs) => needs.map((need) => need.code)

// ---------------------------------------------------------------------------

describe('org needs taxonomy — biolab blueprint coverage', () => {
  it('covers every need class the owner named for a biolab', () => {
    const plan = deriveOrgNeeds({ profile: BIOLAB, sections: {} })
    expect(plan.blueprint).toEqual({ key: 'research_lab', source: 'profile_type' })

    // Every candidate, regardless of which bucket it landed in — coverage is
    // about the blueprint containing the need, not about it being open today.
    const all = new Set([
      ...codesOf(plan.open),
      ...codesOf(plan.suppressed),
      ...codesOf(plan.not_applicable),
    ])

    const required = {
      'licensing/permits — state & local': 'operating_licensing',
      'licensing/permits — federal': 'federal_registration',
      'licensing/permits — biosafety': 'biosafety_certification',
      'licensing/permits — CLIA/CAP clinical': 'clinical_lab_certification',
      'licensing/permits — controlled substance / DEA': 'controlled_substance_registration',
      'physical facility (lease, buildout, BSL space)': 'facility_space',
      'equipment — capital instruments': 'equipment',
      'equipment — consumables': 'lab_consumables',
      'staff (salaries, postdocs, techs)': 'staffing_salary',
      'working capital / operating runway': 'working_capital',
      insurance: 'business_insurance',
      'regulatory & compliance (IRB/IACUC/FDA)': 'regulatory_compliance',
      'IP / legal (patent filing)': 'ip_legal',
      utilities: 'utilities_support',
      'waste disposal': 'hazardous_waste_disposal',
      'IT / data infrastructure': 'data_infrastructure',
    }

    for (const [label, code] of Object.entries(required)) {
      expect(all.has(code), `biolab blueprint must cover ${label} (${code})`).toBe(true)
    }
  })

  it('an empty biolab profile suppresses NOTHING — absence is not possession', () => {
    const plan = deriveOrgNeeds({ profile: BIOLAB, sections: {} })
    expect(plan.suppressed).toEqual([])
    expect(plan.open.length).toBeGreaterThan(10)
  })

  it('every open need carries a concrete, non-empty search subject', () => {
    const plan = deriveOrgNeeds({ profile: BIOLAB, sections: {} })
    for (const need of plan.open) {
      expect(typeof need.search_subject, `${need.code} search_subject type`).toBe('string')
      expect(need.search_subject.trim().length, `${need.code} search_subject non-empty`).toBeGreaterThan(3)
      // The subject must be real words a crawler can use — never the raw code.
      expect(need.search_subject).not.toBe(need.code)
    }
  })
})

// ---------------------------------------------------------------------------

describe('org needs taxonomy — "unless already shown to have" suppression', () => {
  /**
   * The mutation harness. For each rule: build a profile that HAS the thing,
   * assert the need is suppressed; then clear ONLY that evidence field and
   * assert the need comes back open.
   *
   * This is what makes the suite fail if suppression is disabled (half 1 breaks)
   * AND if suppression is made unconditional (half 2 breaks).
   */
  const CASES = [
    {
      code: 'clinical_lab_certification',
      evidenceField: 'licenses_held',
      sections: {
        organization_details: {
          licenses_held: ['CLIA Certificate of Compliance #44D1234567'],
          // clinical signal so the conditional gate lets the need through at all
          mission: 'We report clinical diagnostic results on patient specimens.',
        },
      },
    },
    {
      code: 'biosafety_certification',
      evidenceField: 'licenses_held',
      sections: { organization_details: { licenses_held: ['State biosafety permit — BSL-2'] } },
    },
    {
      code: 'facility_space',
      evidenceField: 'facility_status',
      sections: { organization_details: { facility_status: 'leased' } },
    },
    {
      code: 'business_insurance',
      evidenceField: 'insurance_held',
      sections: { organization_details: { insurance_held: ['General liability', 'Workers compensation'] } },
    },
    {
      code: 'equipment',
      evidenceField: 'equipment_owned',
      sections: { organization_details: { equipment_owned: ['-80C freezer', 'Class II biosafety cabinet'] } },
    },
    {
      code: 'regulatory_compliance',
      evidenceField: 'regulatory_approvals_held',
      sections: { organization_details: { regulatory_approvals_held: ['IACUC protocol 2026-114 approved'] } },
    },
    {
      code: 'federal_registration',
      evidenceField: 'sam_gov_registered',
      sections: { organization_details: { sam_gov_registered: true } },
    },
  ]

  for (const testCase of CASES) {
    it(`${testCase.code}: suppressed when held, and RETURNS when the evidence is cleared`, () => {
      // --- half 1: evidence present → the need must NOT be open -------------
      const withEvidence = deriveOrgNeeds({ profile: BIOLAB, sections: clone(testCase.sections) })
      expect(
        codesOf(withEvidence.open),
        `${testCase.code} must not be surfaced as an open need when the profile shows it is held`,
      ).not.toContain(testCase.code)

      const suppressedEntry = withEvidence.suppressed.find((n) => n.code === testCase.code)
      expect(suppressedEntry, `${testCase.code} must appear in suppressed[]`).toBeTruthy()
      expect(suppressedEntry.reason).toBe('already_held')
      // The evidence must be quotable — a silent disappearance is the defect.
      expect(suppressedEntry.evidence.field).toBe(`organization_details.${testCase.evidenceField}`)
      expect(suppressedEntry.evidence.value).toBeTruthy()

      // --- half 2: same profile, that one field cleared → the need is back ---
      const cleared = clone(testCase.sections)
      delete cleared.organization_details[testCase.evidenceField]
      const withoutEvidence = deriveOrgNeeds({ profile: BIOLAB, sections: cleared })
      expect(
        codesOf(withoutEvidence.open),
        `${testCase.code} must be an OPEN need once the evidence is gone (suppression must not be unconditional)`,
      ).toContain(testCase.code)
      expect(codesOf(withoutEvidence.suppressed)).not.toContain(testCase.code)
    })
  }

  it('empty / unknown / "none" values never suppress', () => {
    // Every one of these is silence, not a yes. If any of them suppressed, an
    // under-filled profile would be told it needs nothing.
    const silentShapes = [
      { facility_status: '' },
      { facility_status: 'unknown' },
      { facility_status: 'none' },
      { licenses_held: [] },
      { licenses_held: [''] },
      { licenses_held: ['', '   '] },
      { licenses_held: ['none'] },
      { licenses_held: ['n/a'] },
      { insurance_held: [] },
      { equipment_owned: [] },
      { regulatory_approvals_held: ['unknown'] },
      { sam_gov_registered: false },
      { sam_gov_registered: 0 },
      { sam_gov_registered: 'false' },
      // The `keywords: null` rules (equipment_owned, insurance_held) accept ANY
      // non-empty entry as evidence, so NON_EVIDENCE_VALUES is the ONLY thing
      // standing between a placeholder value and a wrongly-suppressed need.
      // Mutation check: neutering `isEvidenceText` survives every other case in
      // this list because the keyword/allow-list comparison does that work — it
      // is killed only here. Do not delete these five.
      { equipment_owned: ['none'] },
      { equipment_owned: ['unknown'] },
      { equipment_owned: ['n/a'] },
      { insurance_held: ['none'] },
      { insurance_held: ['tbd'] },
    ]

    for (const shape of silentShapes) {
      const plan = deriveOrgNeeds({ profile: BIOLAB, sections: { organization_details: shape } })
      expect(
        plan.suppressed,
        `${JSON.stringify(shape)} is silence and must suppress nothing`,
      ).toEqual([])
    }
  })

  it('facility_status only suppresses for owned/leased — not shared or none', () => {
    for (const status of ['owned', 'leased']) {
      const plan = deriveOrgNeeds({ profile: BIOLAB, sections: { organization_details: { facility_status: status } } })
      expect(codesOf(plan.open), `${status} must suppress facility_space`).not.toContain('facility_space')
    }
    for (const status of ['shared', 'none', 'unknown', '']) {
      const plan = deriveOrgNeeds({ profile: BIOLAB, sections: { organization_details: { facility_status: status } } })
      expect(codesOf(plan.open), `${status} must NOT suppress facility_space`).toContain('facility_space')
    }
    // The allow-list must be a real subset of the schema enum, or the UI can
    // offer a value the rule can never read.
    for (const status of ['owned', 'leased', 'shared', 'none', 'unknown']) {
      expect(FACILITY_STATUS_OPTIONS).toContain(status)
    }
  })

  it('evaluateSatisfaction returns quotable evidence, or an honest false', () => {
    expect(evaluateSatisfaction('facility_space', {})).toEqual({ satisfied: false, evidence: null })
    const hit = evaluateSatisfaction('business_insurance', {
      organization_details: { insurance_held: ['Professional liability / E&O'] },
    })
    expect(hit.satisfied).toBe(true)
    expect(hit.evidence.value).toBe('Professional liability / E&O')
    expect(hit.evidence.field).toBe('organization_details.insurance_held')
    // A need with no rules can never be suppressed by accident.
    expect(evaluateSatisfaction('lab_consumables', { organization_details: { equipment_owned: ['everything'] } }).satisfied).toBe(false)
  })
})

// ---------------------------------------------------------------------------

describe('org needs taxonomy — conservation (nothing silently dropped)', () => {
  const FIXTURES = [
    { name: 'empty biolab', profile: BIOLAB, sections: {} },
    {
      name: 'well-equipped biolab',
      profile: BIOLAB,
      sections: {
        organization_details: {
          licenses_held: ['CLIA', 'DEA Schedule II', 'State biosafety permit'],
          insurance_held: ['General liability'],
          equipment_owned: ['-80 freezer'],
          regulatory_approvals_held: ['IRB approval'],
          facility_status: 'owned',
          sam_gov_registered: true,
          mission: 'Clinical diagnostics on patient specimens using controlled substance reference standards.',
        },
      },
    },
    { name: 'volunteer fire department', profile: { primary_type: 'volunteer_fire_department' }, sections: {} },
    { name: 'nonprofit', profile: { primary_type: 'nonprofit' }, sections: {} },
    { name: 'public school', profile: { primary_type: 'public_school' }, sections: {} },
    { name: 'small business', profile: { primary_type: 'business' }, sections: {} },
  ]

  for (const fixture of FIXTURES) {
    it(`${fixture.name}: candidates === open + suppressed + not_applicable + truncated`, () => {
      const plan = deriveOrgNeeds({ profile: fixture.profile, sections: fixture.sections })
      const accounted =
        plan.open.length + plan.suppressed.length + plan.not_applicable.length + plan.truncated
      expect(accounted, 'every candidate need must land in a named bucket').toBe(plan.candidate_count)
      expect(plan.open.length).toBeLessThanOrEqual(MAX_PLAN_NEEDS)
    })
  }

  it('no need code appears in two buckets at once', () => {
    const plan = deriveOrgNeeds({
      profile: BIOLAB,
      sections: { organization_details: { facility_status: 'owned', licenses_held: ['CLIA'] } },
    })
    const all = [...codesOf(plan.open), ...codesOf(plan.suppressed), ...codesOf(plan.not_applicable)]
    expect(new Set(all).size).toBe(all.length)
  })
})

// ---------------------------------------------------------------------------

describe('org needs taxonomy — user-added needs are first-class', () => {
  it('carries the owner\'s words verbatim from both free-text fields', () => {
    const sections = {
      financial_information: {
        item_needs: ['qPCR thermocycler (96-well)', 'postdoc salary support'],
        assistance_needs: ['utilities'],
      },
    }
    const userNeeds = collectUserNeeds(sections)
    expect(userNeeds.map((n) => n.label)).toEqual([
      'qPCR thermocycler (96-well)',
      'postdoc salary support',
      'utilities',
    ])
    // Verbatim: the search subject is the owner's text, not a rewritten one.
    expect(userNeeds[0].search_subject).toBe('qPCR thermocycler (96-well)')
    expect(userNeeds[0].source).toBe('user_added')
    expect(userNeeds[0].origin_field).toBe('financial_information.item_needs')
  })

  it('a user-typed need is NEVER suppressed, even when we think it is already held', () => {
    // The profile says it owns a biosafety cabinet AND the owner typed that
    // they need one. The owner outranks our inference.
    const plan = deriveOrgNeeds({
      profile: BIOLAB,
      sections: {
        organization_details: { equipment_owned: ['Class II biosafety cabinet'] },
        financial_information: { item_needs: ['Class II biosafety cabinet'] },
      },
    })
    expect(codesOf(plan.suppressed)).toContain('equipment')
    expect(plan.user_added.map((n) => n.label)).toContain('Class II biosafety cabinet')
  })

  it('dedupes case-insensitively and drops blanks without dropping real entries', () => {
    const userNeeds = collectUserNeeds({
      financial_information: { item_needs: ['Freezer', 'freezer', '', '   ', 'Centrifuge'] },
    })
    expect(userNeeds.map((n) => n.label)).toEqual(['Freezer', 'Centrifuge'])
  })

  it('person profiles get no org blueprint but still get their typed needs', () => {
    const plan = deriveOrgNeeds({
      profile: { primary_type: 'college_student' },
      sections: { financial_information: { item_needs: ['laptop for engineering coursework'] } },
    })
    expect(plan.blueprint.source).toBe('not_an_organization')
    expect(plan.open).toEqual([])
    expect(plan.user_added.map((n) => n.label)).toEqual(['laptop for engineering coursework'])
  })
})

// ---------------------------------------------------------------------------

describe('org needs taxonomy — conditional needs are distinct from suppression', () => {
  it('a bench lab is not told it needs CLIA or a DEA licence', () => {
    const plan = deriveOrgNeeds({
      profile: BIOLAB,
      sections: { organization_details: { mission: 'Basic bench research on yeast metabolism.' } },
    })
    expect(codesOf(plan.open)).not.toContain('clinical_lab_certification')
    expect(codesOf(plan.open)).not.toContain('controlled_substance_registration')

    const clia = plan.not_applicable.find((n) => n.code === 'clinical_lab_certification')
    expect(clia.reason).toBe('conditional_signal_absent')
    // The reason must be a real explanation, not a bare flag.
    expect(clia.detail).toMatch(/clinical/i)
  })

  it('a clinical lab IS asked about CLIA', () => {
    const plan = deriveOrgNeeds({
      profile: BIOLAB,
      sections: { organization_details: { mission: 'We run diagnostic assays on patient samples.' } },
    })
    expect(codesOf(plan.open)).toContain('clinical_lab_certification')
  })

  it('a lab handling scheduled compounds IS asked about DEA registration', () => {
    const plan = deriveOrgNeeds({
      profile: BIOLAB,
      sections: { financial_information: { item_needs: ['secure storage for Schedule II reference standards'] } },
    })
    expect(codesOf(plan.open)).toContain('controlled_substance_registration')
  })
})

// ---------------------------------------------------------------------------

describe('org needs taxonomy — registry integrity', () => {
  it('every code in every blueprint resolves to a real definition', () => {
    const unresolved = []
    const check = (label, codes) => {
      for (const code of codes) if (!getNeedDefinition(code)) unresolved.push(`${label}:${code}`)
    }
    check('ORG_BASELINE', ORG_BASELINE)
    for (const [type, codes] of Object.entries(NEED_BLUEPRINTS)) check(type, codes)
    for (const group of GROUP_BLUEPRINTS) check(group.key, group.needs)
    for (const code of Object.keys(SATISFACTION_RULES)) check('SATISFACTION_RULES', [code])
    expect(unresolved, 'blueprint/taxonomy drift — these codes have no definition').toEqual([])
  })

  it('every organization profile type produces a non-empty, explained plan', () => {
    const emptyPlans = []
    for (const type of ALL_ORG_TYPES) {
      const blueprint = resolveBlueprint(type)
      if (blueprint.codes.length === 0) emptyPlans.push(type)
      expect(blueprint.source, `${type} blueprint source`).not.toBe('none')
    }
    expect(emptyPlans, 'every org type must resolve to some blueprint').toEqual([])
  })

  it('research_lab is a real, canonical profile type wired end to end', () => {
    expect(PROFILE_TYPE_OPTIONS).toContain('research_lab')
    expect(ALL_ORG_TYPES).toContain('research_lab')
    // The biolab aliases the owner is likely to type must land on it.
    for (const alias of ['biolab', 'laboratory', 'research_institute']) {
      expect(resolveBlueprint(alias).key, `${alias} must resolve to the research_lab blueprint`).toBe('research_lab')
    }
  })

  it('buildSearchSubject never returns an empty or code-shaped string', () => {
    for (const code of new Set([...ORG_BASELINE, ...Object.values(NEED_BLUEPRINTS).flat()])) {
      const subject = buildSearchSubject(code)
      expect(subject.trim().length, `${code} subject`).toBeGreaterThan(3)
      expect(subject, `${code} subject must not be the raw code`).not.toBe(code)
    }
  })
})

// ---------------------------------------------------------------------------

describe('org needs taxonomy — schema wiring and the #1067 scoring trap', () => {
  const EVIDENCE_FIELDS = [
    'licenses_held',
    'insurance_held',
    'equipment_owned',
    'regulatory_approvals_held',
    'facility_status',
  ]

  it('the evidence fields exist on organization_details', () => {
    for (const field of EVIDENCE_FIELDS) {
      expect(
        PROFILE_SCHEMA.organization_details.fields[field],
        `organization_details.${field} must exist for suppression to have anything to read`,
      ).toBeTruthy()
    }
  })

  it('every evidence field is UNSCORED — a new scored field shifts every profile\'s match_score', () => {
    // #1067: match_score = matched data points / TOTAL data points, and
    // isFieldScored defaults to TRUE. A scored addition here would silently
    // lower every existing profile's score on deploy and move rows across the
    // recalibrated bands. These fields record what the org HAS so we can stop
    // asking — they are not eligibility facts.
    for (const field of EVIDENCE_FIELDS) {
      const meta = PROFILE_SCHEMA.organization_details.fields[field]
      expect(isFieldScored(meta), `organization_details.${field} must be scored:false`).toBe(false)
    }
  })

  it('the plan manufactures no percentage or score (no fitPercent-class regression)', () => {
    const plan = deriveOrgNeeds({ profile: BIOLAB, sections: {} })
    const serialized = JSON.stringify(plan)
    expect(serialized).not.toMatch(/"(?:score|match_score|fit_percent|fit_score|percent|confidence)"\s*:/)
    for (const need of plan.open) {
      expect(Object.keys(need)).not.toContain('score')
    }
  })
})
