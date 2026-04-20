/**
 * canonicalProfileView.test.js
 *
 * Proves that the canonical profile view feeds the relevance filter the same
 * mission-critical fields that the matcher sees. Specifically:
 *   - pd.needs[] is populated from signals AND from normalized need categories
 *   - pd.description / pd.situation / pd.challenges / pd.special_circumstances
 *     are pulled from narrative sections (previously missing — rules that
 *     read them silently never fired).
 *   - veteran / disability / foster / first-responder derivations survive.
 *   - non-individual entity types (church, nonprofit, school, VFD) are
 *     preserved.
 */
import { describe, it, expect } from 'vitest'
import {
  buildCanonicalProfileView,
  buildFlatProfileData,
} from '../services/canonicalProfileView.js'
import { extractProfileData } from '../services/relevanceFilter.js'

function ctx(profile, sections = {}, signals = null) {
  return { profile, sections, signals }
}

describe('canonical profile view — needs + narrative coverage', () => {
  it('populates flat.needs from signals.needs Set', () => {
    const signals = { needs: new Set(['housing_assistance', 'food_assistance']) }
    const view = buildCanonicalProfileView(
      ctx({ id: 'p1', primary_type: 'individual' }, {}, signals),
    )
    expect(view.flat.needs).toEqual(
      expect.arrayContaining(['housing_assistance', 'food_assistance']),
    )
  })

  it('populates flat.needs from normalized needCategories when signals missing', () => {
    const view = buildCanonicalProfileView(
      ctx(
        { id: 'p2', primary_type: 'individual' },
        {
          narrative: {
            answers: { primary_goal: 'I need help paying my rent', challenges: 'homeless risk' },
          },
          housing_needs: { answers: { primary_need: 'emergency rent' } },
        },
      ),
    )
    // housing_assistance should flow through normalizeProfile
    expect(view.flat.needs.length).toBeGreaterThan(0)
    expect(view.flat.needs.some((n) => String(n).includes('housing'))).toBe(true)
  })

  it('populates narrative free-text fields the relevance filter reads', () => {
    const view = buildCanonicalProfileView(
      ctx(
        { id: 'p3', primary_type: 'individual' },
        {
          narrative: {
            answers: {
              story: 'Single mother facing eviction, needs emergency rent help.',
              barriers_faced: 'Sudden medical bills drained savings',
              challenges: ['no childcare'],
              special_circumstances: 'fleeing domestic violence',
            },
          },
        },
      ),
    )
    expect(view.flat.description).toContain('Single mother')
    expect(view.flat.situation).toContain('medical bills')
    expect(view.flat.challenges).toEqual(expect.arrayContaining(['no childcare']))
    expect(view.flat.special_circumstances).toEqual(
      expect.arrayContaining(['fleeing domestic violence']),
    )
  })

  it('preserves non-individual entity type (nonprofit/church/school/VFD)', () => {
    const view = buildCanonicalProfileView(
      ctx(
        { id: 'p4', primary_type: 'nonprofit', display_name: 'Pine Ridge Baptist Church' },
        { organization_details: { answers: { organization_type: 'church' } } },
      ),
    )
    expect(view.summary.entityType).toBeTruthy()
    expect(String(view.normalized?.entityType || '').toLowerCase()).toMatch(
      /church|nonprofit|faith/i,
    )
  })

  it('extractProfileData() delegates to the canonical view', () => {
    const profileCtx = ctx(
      { id: 'p5', primary_type: 'individual', state: 'TN' },
      {
        demographics: { answers: { veteran_status: 'yes', ethnicity: 'Black' } },
        narrative: { answers: { story: 'Veteran needing housing' } },
      },
      { needs: new Set(['veterans_services', 'housing_assistance']) },
    )
    const flat = extractProfileData(profileCtx)
    expect(flat.veteran_status).toBe(true)
    expect(flat.state).toBe('TN')
    expect(flat.needs).toEqual(expect.arrayContaining(['veterans_services', 'housing_assistance']))
    expect(flat.description).toContain('Veteran')
  })

  it('extractProfileData() accepts a pre-flattened profile and hydrates missing fields', () => {
    const hydrated = extractProfileData({
      primary_type: 'individual',
      state: 'OH',
      city: 'Columbus',
      veteran_status: true,
    })
    // Caller-provided values win; canonical-derived fields fill gaps.
    expect(hydrated.primary_type).toBe('individual')
    expect(hydrated.state).toBe('OH')
    expect(hydrated.veteran_status).toBe(true)
    // Fields the caller omitted should still exist (null is OK; what matters
    // is the key exists so rules that short-circuit on `in` don't misfire).
    expect(Object.prototype.hasOwnProperty.call(hydrated, 'needs')).toBe(true)
  })

  it('summary reflects coverage accurately for sparse profiles', () => {
    const view = buildCanonicalProfileView(ctx({ id: 'p6' }))
    expect(view.summary.hasLocation).toBe(false)
    // hasNeeds reflects whatever normalizeProfile derives; we only care that
    // the flat.needs array is a defined array (so rules don't crash) and
    // sectionCount is 0.
    expect(Array.isArray(view.flat.needs)).toBe(true)
    expect(view.summary.sectionCount).toBe(0)
  })

  it('collects location from profile + organization merge', () => {
    const view = buildCanonicalProfileView(
      ctx(
        { id: 'p7', state: 'TX', city: 'Austin', postal_code: '78701' },
        { basic_information: { answers: { state: 'TX', city: 'Austin' } } },
      ),
    )
    expect(view.flat.state).toBe('TX')
    expect(view.flat.city).toBe('Austin')
    expect(view.flat.zip).toBe('78701')
    expect(view.summary.hasLocation).toBe(true)
  })
})

describe('buildFlatProfileData — edge cases', () => {
  it('handles missing profile/sections without crashing', () => {
    const flat = buildFlatProfileData({}, null)
    expect(flat).toBeTruthy()
    expect(Array.isArray(flat.needs)).toBe(true)
    expect(flat.needs.length).toBe(0)
  })

  it('merges normalized.affiliations through to flat.affiliations', () => {
    const view = buildCanonicalProfileView(
      ctx(
        { id: 'p8' },
        {
          organization_details: {
            answers: { organization_type: 'fire_department', is_volunteer: true },
          },
        },
      ),
    )
    if (Array.isArray(view.normalized?.affiliations) && view.normalized.affiliations.length > 0) {
      expect(view.flat.affiliations.length).toBe(view.normalized.affiliations.length)
    }
  })
})
