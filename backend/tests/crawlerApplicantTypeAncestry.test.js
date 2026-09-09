import { describe, it, expect } from 'vitest'
import { buildProfileSignals } from '../services/profileHelpers.js'
import { computeMatchDecision } from '../crawler-os/matchEngine.js'
import { hasPositiveFourTruthProof } from '../crawler-os/fundingTruthPolicy.js'

function decide({ type, applicants = [], eligibility = null, need = 'education', state = 'FL' }) {
  const profile = { id: 'ancestry-fixture', primary_type: type, state, city: 'Pensacola', needs: [need] }
  const sections = {
    basic_information: { profile_category: type, state, city: 'Pensacola' },
    programs_services: { focus_areas: [need], interests: [need] },
    narrative: { primary_goal: `${need} funding` },
  }
  const opportunity = {
    id: 'ancestry-award', source_id: 'web_search', kind: 'DIRECT_GRANT',
    title: 'Community Access Award', sponsor: 'Fixture Community Fund',
    summary: `Funding for ${need} projects and expenses.`,
    applicant_types: applicants, eligibility_text: eligibility,
    need_categories: [need], geography: { national: false, states: ['FL'] },
    apply_url: 'https://fixture.invalid/apply', info_url: 'https://fixture.invalid/award',
    reality_status: 'verified',
    evidence: { url: 'https://fixture.invalid/award', content_hash: 'captured-test-page', fetched_at: '2026-09-09T00:00:00Z' },
  }
  return computeMatchDecision(opportunity, {
    profile_id: profile.id, applicant_types: [type], needs: [need], needs_defaulted: false,
    location: { state, city: 'Pensacola' },
  }, { profileRow: profile, profileSections: sections, signals: buildProfileSignals({ profile, sections }), realityPassed: true })
}

describe('crawler applicant evidence uses the declared profile type hierarchy', () => {
  it.each([
    ['school_district', 'school', 'education'],
    ['school_food_service', 'school', 'education'],
    ['museum', 'nonprofit', 'education'],
    ['disabled_adult', 'individual', 'disability'],
    ['senior', 'individual', 'housing'],
  ])('%s can satisfy a source that explicitly permits %s', (type, applicant, need) => {
    const result = decide({ type, applicants: [applicant], need })
    expect(result.match_explain.matched_profile_type).toBe(true)
    expect(result.match_explain.four_truth_proof.profile_qualifies.passed).toBe(true)
    expect(result.decision).toBe('accept')
    expect(hasPositiveFourTruthProof(result)).toBe(true)
  })

  it('matches source eligibility prose for a county government without inventing applicant types', () => {
    const result = decide({ type: 'county_government', eligibility: 'Local government applicants may apply.', need: 'education' })
    expect(result.match_explain.matched_profile_type).toBe(true)
    expect(result.match_explain.four_truth_proof.profile_qualifies.applicant_type_evidence).toEqual([])
    expect(result.match_explain.four_truth_proof.profile_qualifies.eligibility_prose_evidence).toEqual(['local government applicants may apply.'])
    expect(result.decision).toBe('accept')
    expect(hasPositiveFourTruthProof(result)).toBe(true)
  })

  it('does not grant a general individual the identity of a student', () => {
    const result = decide({ type: 'individual', applicants: ['student'], eligibility: 'Only enrolled undergraduate students may apply.' })
    expect(hasPositiveFourTruthProof(result)).toBe(false)
    expect(result.decision).not.toBe('accept')
  })

  it('keeps an individual out of an organization-only award', () => {
    const result = decide({ type: 'senior', applicants: ['nonprofit'], eligibility: 'Nonprofit organizations only.', need: 'housing' })
    expect(result.decision).toBe('reject')
    expect(hasPositiveFourTruthProof(result)).toBe(false)
  })

  it('does not create applicant proof when the source never states who may apply', () => {
    const result = decide({ type: 'school_district' })
    expect(result.match_explain.four_truth_proof.profile_qualifies.passed).toBe(false)
    expect(result.decision).not.toBe('accept')
  })

  it.each([
    'Local government applicants may not apply.',
    'No local government applicants may apply.',
  ])('does not turn a negative government eligibility statement into permission: %s', (eligibility) => {
    const result = decide({ type: 'county_government', eligibility })
    expect(hasPositiveFourTruthProof(result)).toBe(false)
    expect(result.decision).not.toBe('accept')
  })
})
