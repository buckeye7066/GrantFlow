import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function source(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8')
}

describe('late review contract guards', () => {
  it('passes Anya the derived needs array rather than its report wrapper', () => {
    const text = source('backend/services/anyaToolRegistry.js')
    expect(text).toMatch(/derivedItemReport\?\.needs/)
    expect(text).toMatch(/Array\.isArray\(derivedItemReport\?\.needs\)/)
  })

  it('keeps legacy crawl endpoints profile-scoped and reports compatibility failures', () => {
    const text = source('backend/routes/crawlers.js')
    const seed = text.slice(text.indexOf("router.post('/seed-all-real'"), text.indexOf("router.post('/real-crawl'"))
    const real = text.slice(text.indexOf("router.post('/real-crawl'"), text.indexOf("router.post('/real-crawl'") + 2600)

    expect(seed).toMatch(/profile_id is required/)
    expect(seed).toMatch(/seedAllRealFunding\(req\.db, \{ profileId \}\)/)
    expect(seed).toMatch(/await getOpportunityCountsByState\(req\.db\)/)
    expect(seed).toMatch(/status\(422\)/)

    expect(real).toMatch(/profile_id is required/)
    expect(real).toMatch(/const options = \{ profileId, state, onProgress \}/)
    expect(real).toMatch(/crawlAllStates\(req\.db, options\)/)
    expect(real).toMatch(/crawlRealOpportunities\(req\.db, options\)/)
    expect(real).toMatch(/status\(422\)/)
  })

  it('filters visibility before enforcing the crawler result limit', () => {
    const text = source('backend/services/crawlerOsCompatibility.js')
    expect(text).toMatch(/LIMIT \? OFFSET \?/)
    expect(text).toMatch(/visible\.length < requestedLimit/)
    expect(text).toMatch(/return visible\.slice\(0, requestedLimit\)/)
  })

  it('threads persisted four-truth proof through funding displays and coverage', () => {
    const route = source('backend/routes/fundingSources.js')
    const coverage = source('backend/services/profileResultCoverageAudit.js')
    expect(route).toMatch(/four_truth_proof:\s*fundingTruthProofFrom/)
    expect(route).toMatch(/match_explain_json:/)
    expect(coverage).toMatch(/m\.match_explain_json/)
    expect(coverage).toMatch(/fundingTruthProofFrom/)
  })

  it('lets an active no-payment promotion bypass pending payment state only', () => {
    const text = source('backend/services/billing/entitlementService.js')
    expect(text).toMatch(/promotionActive === true && requiresPayment === false/)
    expect(text).toMatch(/paymentStatus:\s*promotionActive/)
  })
})
