import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const modulePath = path.resolve(__dirname, '..', '..', 'backend', 'services', 'matching', 'qualityGate.js')
const moduleUrl = pathToFileURL(modulePath).href

const {
  applyFundableOpportunityNormalization,
  evaluateFundableOpportunity,
  getReferralTemplateKey,
  inferOpportunityDisplayType,
  isFundableOpportunity,
} = await import(moduleUrl)

test('qualityGate: rejects Church Law & Tax article URL from grant scoring', () => {
  const record = {
    title: 'Benevolence Fund Basics',
    type: 'grant',
    application_url: 'https://www.churchlawandtax.com/web/2021/september/benevolence-fund-basics.html',
  }

  const result = evaluateFundableOpportunity(record)

  assert.equal(isFundableOpportunity(record), false)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'article_or_informational_url')
})

test('qualityGate: allows article-like path only when explicitly tagged as an application page', () => {
  const result = evaluateFundableOpportunity({
    title: 'Community Grant Application Guide',
    type: 'grant',
    application_url: 'https://foundation.example/apply/guide',
    page_type: 'application',
  })

  assert.equal(result.ok, true)
})

test('qualityGate: surfaces GrantWatch category pages as directory instead of grant', () => {
  const record = {
    title: 'Vehicle Grants Directory',
    type: 'grant',
    opportunity_type: 'directory',
    application_url: 'https://www.grantwatch.com/cat/41/vehicle-grants.html',
  }

  const result = evaluateFundableOpportunity(record)
  const normalized = applyFundableOpportunityNormalization(record, result)

  assert.equal(result.ok, true)
  assert.equal(inferOpportunityDisplayType(record), 'directory')
  assert.equal(normalized.opportunity_type, 'directory')
  assert.equal(normalized.type, 'DIRECTORY')
})

test('qualityGate: collapses Community Action Partnership ZIP lookup permutations by host and path', () => {
  const first = {
    title: 'Find Your Local Community Action Agency',
    type: 'grant',
    application_url: 'https://communityactionpartnership.com/find-a-cap/?zip=43215',
  }
  const second = {
    title: 'Find Your Local Community Action Agency',
    type: 'grant',
    application_url: 'https://communityactionpartnership.com/find-a-cap/?zip=44101',
  }

  const firstResult = evaluateFundableOpportunity(first)
  const secondResult = evaluateFundableOpportunity(second)
  const normalized = applyFundableOpportunityNormalization(first, firstResult)

  assert.equal(firstResult.kind, 'referral_template')
  assert.equal(firstResult.referralKey, secondResult.referralKey)
  assert.equal(getReferralTemplateKey(first), 'communityactionpartnership.com/find-a-cap')
  assert.equal(normalized.opportunity_type, 'referral')
  assert.equal(normalized.application_url, 'https://communityactionpartnership.com/find-a-cap/')
})

test('qualityGate: collapses Foundation Locator state lookup permutations by host and path', () => {
  const ohio = {
    title: 'Foundation Locator',
    application_url: 'https://example.org/foundation-locator?state=OH',
  }
  const michigan = {
    title: 'Foundation Locator',
    application_url: 'https://example.org/foundation-locator?state=MI',
  }

  assert.equal(getReferralTemplateKey(ohio), 'example.org/foundation-locator')
  assert.equal(getReferralTemplateKey(ohio), getReferralTemplateKey(michigan))
})
