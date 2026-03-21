/**
 * State waiver benefits crawler and domain engines tests.
 * - state_waiver_benefits routes correctly by state (TN vs other)
 * - Each domain engine returns >= 6 directory items with URL
 * - URL required enforced (no item without url/application_url/source_url)
 * - Business-style engines exclude loans and matching funds
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateStateWaiverEligibility,
  crawlStateWaiverBenefits,
} from '../../backend/services/crawlers/stateWaiverBenefitsCrawler.js'
import { runTaxIncentiveEngine } from '../../backend/services/crawlers/domainEngines/taxIncentiveEngine.js'
import { runUtilitiesHardshipEngine } from '../../backend/services/crawlers/domainEngines/utilitiesHardshipEngine.js'
import { runHealthClinicalEngine } from '../../backend/services/crawlers/domainEngines/healthClinicalEngine.js'
import { runEducationStudentEngine } from '../../backend/services/crawlers/domainEngines/educationStudentEngine.js'
import { runHousingCommunityFinanceEngine } from '../../backend/services/crawlers/domainEngines/housingCommunityFinanceEngine.js'
import { runWorkforceUnionEngine } from '../../backend/services/crawlers/domainEngines/workforceUnionEngine.js'
import { runFamilyYouthSupportEngine } from '../../backend/services/crawlers/domainEngines/familyYouthSupportEngine.js'
import { runGeoDesignationEngine } from '../../backend/services/crawlers/domainEngines/geoDesignationEngine.js'
import { runAllDomainEngines } from '../../backend/services/crawlers/domainEngines/index.js'

const MIN_DIRECTORY_ITEMS = 6

test('evaluateStateWaiverEligibility: no state -> not eligible', () => {
  const r = evaluateStateWaiverEligibility({})
  assert.equal(r.eligible, false)
  assert.equal(r.state, null)
})

test('evaluateStateWaiverEligibility: state TN -> eligible', () => {
  const r = evaluateStateWaiverEligibility({
    signals: { location: { state: 'TN' } },
  })
  assert.equal(r.eligible, true)
  assert.equal(r.state, 'TN')
})

test('evaluateStateWaiverEligibility: state OH -> eligible', () => {
  const r = evaluateStateWaiverEligibility({
    signals: { location: { state: 'OH' } },
  })
  assert.equal(r.eligible, true)
  assert.equal(r.state, 'OH')
})

test('state_waiver_benefits: non-TN returns directory resources with URLs', async () => {
  const profile = { signals: { location: { state: 'OH' } } }
  const results = await crawlStateWaiverBenefits(profile, {})
  assert.ok(Array.isArray(results))
  assert.ok(results.length >= MIN_DIRECTORY_ITEMS, `expected >= ${MIN_DIRECTORY_ITEMS} items, got ${results.length}`)
  for (const o of results) {
    const url = o.url || o.application_url || o.source_url
    assert.ok(url && (url.startsWith('http://') || url.startsWith('https://')), `every item must have valid URL: ${JSON.stringify(o)}`)
  }
})

test('state_waiver_benefits: TN returns ECF-style results with URLs', async () => {
  const profile = {
    signals: { location: { state: 'TN' }, keywordSet: new Set(['medicaid']) },
    sections: { government_assistance: { medicaid_waiver_program: 'ecf_choices' } },
  }
  const results = await crawlStateWaiverBenefits(profile, {})
  assert.ok(Array.isArray(results))
  for (const o of results) {
    const url = o.url || o.application_url || o.source_url
    assert.ok(url && (url.startsWith('http://') || url.startsWith('https://')), `every item must have valid URL: ${JSON.stringify(o)}`)
  }
})

async function assertEngineMinItemsAndUrls(runEngine, name) {
  const results = await runEngine({}, {})
  assert.ok(Array.isArray(results), `${name}: must return array`)
  assert.ok(
    results.length >= MIN_DIRECTORY_ITEMS,
    `${name}: must return >= ${MIN_DIRECTORY_ITEMS} items, got ${results.length}`,
  )
  for (const o of results) {
    const url = o.url || o.application_url || o.source_url
    assert.ok(url && (url.startsWith('http://') || url.startsWith('https://')), `${name}: every item must have URL`)
  }
}

test('taxIncentiveEngine returns >= 6 directory items with URL', () => assertEngineMinItemsAndUrls(runTaxIncentiveEngine, 'taxIncentive'))
test('utilitiesHardshipEngine returns >= 6 directory items with URL', () => assertEngineMinItemsAndUrls(runUtilitiesHardshipEngine, 'utilitiesHardship'))
test('healthClinicalEngine returns >= 6 directory items with URL', () => assertEngineMinItemsAndUrls(runHealthClinicalEngine, 'healthClinical'))
test('educationStudentEngine returns >= 6 directory items with URL', () => assertEngineMinItemsAndUrls(runEducationStudentEngine, 'educationStudent'))
test('housingCommunityFinanceEngine returns >= 6 directory items with URL', () => assertEngineMinItemsAndUrls(runHousingCommunityFinanceEngine, 'housingCommunityFinance'))
test('workforceUnionEngine returns >= 6 directory items with URL', () => assertEngineMinItemsAndUrls(runWorkforceUnionEngine, 'workforceUnion'))
test('familyYouthSupportEngine returns >= 6 directory items with URL', () => assertEngineMinItemsAndUrls(runFamilyYouthSupportEngine, 'familyYouthSupport'))
test('geoDesignationEngine returns >= 6 directory items with URL', () => assertEngineMinItemsAndUrls(runGeoDesignationEngine, 'geoDesignation'))

test('runAllDomainEngines returns combined results with URLs', async () => {
  const results = await runAllDomainEngines({}, {})
  assert.ok(Array.isArray(results))
  assert.ok(results.length >= MIN_DIRECTORY_ITEMS * 2, 'runAllDomainEngines should return many items across engines')
  for (const o of results) {
    const url = o.url || o.application_url || o.source_url
    assert.ok(url && (url.startsWith('http://') || url.startsWith('https://')), 'every item must have URL')
  }
})

test('educationStudentEngine excludes loan/matching (strict_no_loans)', async () => {
  const results = await runEducationStudentEngine({}, {})
  const loanLike = ['loan', 'microloan', 'matching funds', 'cost share', 'repay']
  for (const o of results) {
    const text = [o.title, o.description, ...(o.keywords || [])].filter(Boolean).join(' ').toLowerCase()
    for (const bad of loanLike) {
      assert.ok(!text.includes(bad.toLowerCase()) || text.includes('grant') || text.includes('scholarship'), `education engine should not surface loan/matching: ${o.title}`)
    }
  }
})
