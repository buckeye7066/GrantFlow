import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeSourceTrustScore,
  classifySourceType,
  ROBERT_SEED_SOURCES,
} from '../../backend/services/robert/robertSourceRegistry.js'

describe('robertSourceRegistry — trust scoring', () => {
  it('high score for grants.gov / .gov / .edu', () => {
    assert.ok(computeSourceTrustScore('https://www.grants.gov/') >= 90)
    assert.ok(computeSourceTrustScore('https://www.fema.gov/grants') >= 80)
    assert.ok(computeSourceTrustScore('https://www.harvard.edu/scholarships') >= 80)
  })

  it('zero for placeholder/search-engine URLs', () => {
    assert.equal(computeSourceTrustScore('https://example.com/grant'), 0)
    assert.equal(computeSourceTrustScore('https://www.google.com/search?q=grants'), 0)
  })

  it('mid-tier for unknown .org', () => {
    const score = computeSourceTrustScore('https://example-org-foundation.org/')
    assert.ok(score >= 50 && score < 80)
  })

  it('classifies common source types', () => {
    assert.equal(classifySourceType('https://www.grants.gov/'), 'federal_portal')
    assert.equal(classifySourceType('https://www.fema.gov/grants'), 'fire_department_grants')
    assert.equal(classifySourceType('https://studentaid.gov/'), 'education_directory')
    assert.equal(classifySourceType('https://www.example.edu/scholarships'), 'university_scholarship_portal')
  })

  it('seed registry contains real .gov sources only (no placeholders)', () => {
    for (const seed of ROBERT_SEED_SOURCES) {
      assert.match(seed.source_url, /^https:\/\//)
      assert.doesNotMatch(seed.source_url, /example\.com|localhost/)
      assert.ok(seed.trust_score >= 70, `seed ${seed.source_name} below trust 70`)
    }
  })
})
