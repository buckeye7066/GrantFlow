import { describe, it, expect } from 'vitest'
import { normalizeEntityType } from '../services/profileNormalizer.js'

// The Axiom BioLabs class (2026-07-06): unmapped free-text org types leaked
// through normalizeEntityType as literal entityTypes ('biotechnology'),
// silently failing every `entityType === '...'` eligibility-gate comparison.
describe('normalizeEntityType — org-shaped free text collapses to organization', () => {
  it('maps research-org raw types to organization', () => {
    for (const raw of [
      'biotechnology',
      'biotech',
      'research organization',
      'research_institution',
      'Biotechnology / research organization',
      'laboratory',
      'life sciences',
      'university',
      'hospital',
    ]) {
      expect(normalizeEntityType(raw), raw).toBe('organization')
    }
  })

  it('keeps existing canonical aliases intact', () => {
    expect(normalizeEntityType('church')).toBe('nonprofit')
    expect(normalizeEntityType('small business')).toBe('business')
    expect(normalizeEntityType('researcher')).toBe('researcher')
    expect(normalizeEntityType('academic')).toBe('researcher')
    expect(normalizeEntityType('family')).toBe('individual')
    expect(normalizeEntityType('college_student')).toBe('student')
  })

  it('still returns the raw key for genuinely unknown types (compat)', () => {
    expect(normalizeEntityType('platypus_wrangler')).toBe('platypus_wrangler')
    expect(normalizeEntityType(null)).toBeNull()
    expect(normalizeEntityType('')).toBeNull()
  })
})
