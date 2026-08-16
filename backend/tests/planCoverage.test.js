/**
 * planCoverage — the insurance eligibility-hint layer (owner rule 2026-08-15:
 * "use their insurance plan against their profile to see what items and help
 * they are eligible for … or even a combination of the health insurance plan
 * and listed issues/ICD10 codes").
 *
 * The doctrine under test: a HINT layer, never an oracle — membership/order
 * unchanged, missing-either-key = silence, structured fields only, one
 * condition taxonomy shared by strings and ICD codes.
 */
import { describe, it, expect } from 'vitest'
import {
  PLAN_CLASSES,
  CONDITION_CLASSES,
  ICD10_TO_CONDITION,
  CONDITION_TERM_VOCABULARY,
  COVERAGE_RULES,
  resolvePlanClasses,
  resolveCoverageConditionClasses,
  annotateItemsWithCoverage,
  icdCodesIn,
} from '../config/planCoverage.js'

describe('planCoverage — registry totality', () => {
  it('every ICD prefix and term maps into CONDITION_CLASSES (one taxonomy, two spellings)', () => {
    const classes = new Set(CONDITION_CLASSES)
    for (const [code, cls] of Object.entries(ICD10_TO_CONDITION)) {
      expect(classes.has(cls), `ICD ${code} -> ${cls}`).toBe(true)
    }
    for (const [term, cls] of Object.entries(CONDITION_TERM_VOCABULARY)) {
      expect(classes.has(cls), `term "${term}" -> ${cls}`).toBe(true)
    }
  })

  it('every coverage rule references a known plan class and condition class', () => {
    const plans = new Set(PLAN_CLASSES)
    const classes = new Set(CONDITION_CLASSES)
    for (const rule of COVERAGE_RULES) {
      expect(plans.has(rule.plan), rule.plan).toBe(true)
      if (rule.condition !== null) expect(classes.has(rule.condition), String(rule.condition)).toBe(true)
      expect(rule.categories.length).toBeGreaterThan(0)
      expect(rule.note).toMatch(/typically|many/i) // class-level language, never a plan-document claim
    }
  })
})

describe('planCoverage — plan class resolution (structured fields, missing = neutral)', () => {
  it("resolves the verbatim prod ECF CHOICES enrollment from other_programs", () => {
    // Real prod shape: government_assistance.other_programs holds
    // "Medicaid Waiver Program (ECF CHOICES - TN)" verbatim.
    const classes = resolvePlanClasses({
      government_assistance: { other_programs: 'Medicaid Waiver Program (ECF CHOICES - TN)' },
    })
    expect(classes).toContain('medicaid_waiver')
    expect(classes).toContain('medicaid')
  })

  it('resolves both fleet enrollment-boolean shapes, and medicare vs medicare advantage', () => {
    expect(resolvePlanClasses({ government_assistance: { medicaid_enrolled: true } })).toContain('medicaid')
    expect(resolvePlanClasses({ government_assistance: { medicaid_recipient_self: true } })).toContain('medicaid')
    expect(resolvePlanClasses({ medical_insurance: { plan_type: 'Medicare Advantage' } })).toEqual(['medicare_advantage'])
    expect(resolvePlanClasses({ medical_insurance: { insurance_provider: 'Medicare' } })).toEqual(['medicare'])
  })

  it('a NEGATED program declaration declares nothing, and no insurance facts resolve to []', () => {
    expect(resolvePlanClasses({ government_assistance: { other_programs: 'Not enrolled in ECF CHOICES; denied Medicaid waiver' } })).toEqual([])
    expect(resolvePlanClasses({})).toEqual([])
    expect(resolvePlanClasses({ narrative: { notes: 'I have Medicaid' } })).toEqual([]) // prose never read
  })
})

describe('planCoverage — condition class resolution (strings + ICD codes, one taxonomy)', () => {
  it('resolves the real prod string shapes, including an inline ICD-10 code', () => {
    const classes = resolveCoverageConditionClasses({
      health_medical: { disability_type: ['Clawing effect in hands', 'Cognitive disability (F70)'] },
    })
    expect(classes).toContain('mobility_impairment')
    expect(classes).toContain('neuro_cognitive')
  })

  it('resolves bare ICD codes with word boundaries (E11.9 yes; a code inside a word, no)', () => {
    expect(icdCodesIn('Type 2 diabetes (E11.9)')).toEqual(['E11'])
    expect(icdCodesIn('CAFE110 room')).toEqual([])
    const classes = resolveCoverageConditionClasses({ health_medical: { conditions: ['E11.9'] } })
    expect(classes).toEqual(['diabetes'])
  })

  it('prose fields are never read', () => {
    expect(
      resolveCoverageConditionClasses({ medical_history: { notes: 'diabetes E11.9 wheelchair' } }),
    ).toEqual([])
  })
})

describe('planCoverage — annotation (a label, never a gate)', () => {
  const items = Object.freeze([
    Object.freeze({ item: 'Adaptive daily-living aids (built-up utensils, grip aids, reachers)', category: 'adaptive_equipment' }),
    Object.freeze({ item: 'Laptop', category: 'technology' }),
  ])

  it('ECF CHOICES waiver hints the adaptive-equipment item; unrelated items untouched', () => {
    const out = annotateItemsWithCoverage(items, {
      planClasses: ['medicaid_waiver', 'medicaid'],
      conditionClasses: ['mobility_impairment'],
    })
    expect(out).toHaveLength(2)
    expect(out[0].eligibility_hint).toBeTruthy()
    expect(out[0].eligibility_hint.plan_class).toBe('medicaid_waiver')
    expect(out[0].eligibility_hint.note).toMatch(/adaptive equipment/i)
    expect(out[0].eligibility_hint.note).toMatch(/check with your plan/i)
    expect(out[1].eligibility_hint).toBeUndefined()
  })

  it('Medicare × diabetes hints glucose-class items via the PAIRED rule', () => {
    const diabetic = [{ item: 'Blood glucose monitor', category: 'medical_equipment' }]
    const hinted = annotateItemsWithCoverage(diabetic, { planClasses: ['medicare'], conditionClasses: ['diabetes'] })
    expect(hinted[0].eligibility_hint?.note).toMatch(/glucose|diabetes/i)
    // Both keys required for paired rows: plan without the condition = silence
    // for condition-paired rules (mobility rule also misses — no condition).
    const noCondition = annotateItemsWithCoverage(diabetic, { planClasses: ['medicare'], conditionClasses: [] })
    expect(noCondition[0].eligibility_hint).toBeUndefined()
  })

  it('missing plan classes returns the input array object as-is (provably neutral)', () => {
    expect(annotateItemsWithCoverage(items, { planClasses: [], conditionClasses: ['diabetes'] })).toBe(items)
  })
})
