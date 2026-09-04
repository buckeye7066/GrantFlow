import { describe, it, expect } from 'vitest'
import { buildNextStepsForMatch, buildProfileOnlyGuidance } from '../services/nextStepGuidance.js'

const MIN_PROFILE = {
  country: 'US',
  state: 'TN',
  city: 'Knoxville',
  zip: '37902',
  entityType: 'nonprofit',
  organizationType: 'nonprofit',
  populationServed: 'youth',
  missionFocus: 'education',
  needCategories: ['programs', 'operating'],
  fundingAmountNeeded: 25000,
  programDescriptions: ['Afterschool tutoring'],
  employeeCount: 5,
  annualRevenue: 200000,
  yearsInOperation: 6,
  industry: 'education',
}

describe('nextStepGuidance', () => {
  it('returns an "open the application page" step when opportunity has a real URL', () => {
    const { steps } = buildNextStepsForMatch({
      profile: MIN_PROFILE,
      opportunity: {
        id: 'o1',
        title: 'Youth Program Grant',
        apply_url: 'https://grants.nih.gov/foa',
        deadline: null,
      },
      score: 72,
    })
    const opn = steps.find((s) => s.id === 'open_apply_url')
    expect(opn).toBeTruthy()
    expect(opn.href).toBe('https://grants.nih.gov/foa')
    expect(opn.priority).toBe('high')
  })

  it('falls back to "informational_resource" when no actionable URL exists', () => {
    const { steps, rationale } = buildNextStepsForMatch({
      profile: MIN_PROFILE,
      opportunity: {
        id: 'o2',
        title: 'Community Notice',
        source_url: 'https://example.com/foo', // placeholder host
      },
    })
    expect(steps.find((s) => s.id === 'informational_resource')).toBeTruthy()
    expect(steps.find((s) => s.id === 'open_apply_url')).toBeFalsy()
    expect(rationale.some((r) => /informational|referral/i.test(r))).toBe(true)
  })

  it('flags expired opportunities with a similar-search next step', () => {
    const { steps, rationale } = buildNextStepsForMatch({
      profile: MIN_PROFILE,
      opportunity: {
        id: 'o3',
        title: 'Expired Grant',
        apply_url: 'https://grants.gov/foa',
        deadline: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString(),
      },
    })
    expect(steps.find((s) => s.id === 'find_similar')).toBeTruthy()
    expect(rationale.some((r) => /deadline has passed/i.test(r))).toBe(true)
  })

  it('raises critical urgency for deadlines within 14 days', () => {
    const { steps } = buildNextStepsForMatch({
      profile: MIN_PROFILE,
      opportunity: {
        id: 'o4',
        title: 'Imminent Grant',
        apply_url: 'https://grants.gov/foa',
        deadline: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      },
    })
    const deadlineStep = steps.find((s) => s.id === 'verify_deadline')
    expect(deadlineStep).toBeTruthy()
    expect(deadlineStep.priority).toBe('critical')
  })

  it('returns profile-completion suggestions when coverage is low', () => {
    const { steps, rationale } = buildNextStepsForMatch({
      profile: { country: 'US' },
      opportunity: {
        id: 'o5',
        title: 'General Grant',
        apply_url: 'https://grants.gov/foa',
      },
    })
    const profileSteps = steps.filter((s) => s.category === 'profile')
    expect(profileSteps.length).toBeGreaterThan(0)
    expect(rationale.some((r) => /% complete/.test(r))).toBe(true)
  })

  it('buildProfileOnlyGuidance escalates when result count is zero and coverage is thin', () => {
    const { steps, rationale } = buildProfileOnlyGuidance({
      profile: { country: 'US' },
      resultCount: 0,
    })
    expect(rationale.some((r) => /No opportunities/.test(r))).toBe(true)
    expect(steps.find((s) => s.id === 'profile.comprehensive_intake')).toBeTruthy()
  })

  it('walks a realistic discover → apply flow with appropriate CTAs at each stage', () => {
    // Stage 1: no application yet → should suggest saving to pipeline
    const stage1 = buildNextStepsForMatch({
      profile: MIN_PROFILE,
      opportunity: { id: 'o', apply_url: 'https://grants.gov/foa' },
      score: 72,
    })
    expect(stage1.steps.find((s) => s.id === 'save_to_pipeline')).toBeTruthy()

    // Stage 2: each transition CTA advances exactly one state.
    const stage2 = buildNextStepsForMatch({
      profile: MIN_PROFILE,
      opportunity: { id: 'o', apply_url: 'https://grants.gov/foa' },
      score: 72,
      application: { state: 'DISCOVERED' },
    })
    expect(stage2.steps.find((s) => s.id === 'start_application')?.meta?.target).toBe('DEDUPED')

    const deduped = buildNextStepsForMatch({
      profile: MIN_PROFILE,
      opportunity: { id: 'o', apply_url: 'https://grants.gov/foa' },
      score: 72,
      application: { state: 'DEDUPED' },
    })
    expect(deduped.steps.find((s) => s.id === 'qualify_application')?.meta?.target).toBe('QUALIFIED')

    const qualified = buildNextStepsForMatch({
      profile: MIN_PROFILE,
      opportunity: { id: 'o', apply_url: 'https://grants.gov/foa' },
      score: 72,
      application: { state: 'QUALIFIED' },
    })
    expect(qualified.steps.find((s) => s.id === 'build_application_schema')?.meta?.target).toBe('SCHEMA_READY')

    // Stage 3: schema_ready must map requirements before resolving them.
    const stage3 = buildNextStepsForMatch({
      profile: MIN_PROFILE,
      opportunity: { id: 'o', apply_url: 'https://grants.gov/foa' },
      score: 72,
      application: { state: 'SCHEMA_READY' },
    })
    expect(stage3.steps.find((s) => s.id === 'map_requirements')?.meta?.target).toBe('MAPPED')

    // Stage 4: drafting → upload docs
    const stage4 = buildNextStepsForMatch({
      profile: MIN_PROFILE,
      opportunity: { id: 'o', apply_url: 'https://grants.gov/foa' },
      score: 72,
      application: { state: 'DRAFTING' },
    })
    expect(stage4.steps.find((s) => s.id === 'upload_docs')).toBeTruthy()
  })
})
