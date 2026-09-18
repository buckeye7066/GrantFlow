import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateEvidenceSpans } from '../../backend/crawler-os/blindEvidenceValidator.js'
import { mapBlindFactsToCandidate } from '../../backend/crawler-os/blindFactsMapper.js'
import { normalize as normalizeCrawlerOpportunity } from '../../backend/crawler-os/normalizer.js'
import { normalizeOpportunity } from '../../backend/services/opportunityNormalizer.js'

const schoolRule = 'Applicants must be graduates of public high schools in Raleigh County.'

function throughBlindWeb(facts, pageText, canonicalShape) {
  const validated = validateEvidenceSpans(facts, pageText).facts
  const candidate = mapBlindFactsToCandidate(validated)
  const crawler = normalizeCrawlerOpportunity(candidate, { kind: candidate.kind, reality_status: 'verified' }, { source: { trust_tier: 'official' } })
  // The matcher maps source_id to source and summary to description. Its
  // canonical row does not retain source_id, so exercise both real shapes.
  const { source_id, ...canonical } = crawler
  const row = canonicalShape ? { ...canonical, source: source_id } : crawler
  return normalizeOpportunity({ ...row, description: crawler.summary })
}

for (const canonicalShape of [false, true]) {
  const shape = canonicalShape ? 'canonical source-only' : 'crawler source_id'
  test(`unsupported blind summary cannot re-enter school eligibility: ${shape}`, () => {
    const normalized = throughBlindWeb({
      title: 'Example Scholarship', sponsor: 'Example Foundation', summary: schoolRule,
      eligibility_text: schoolRule, eligibility_bullets: [], page_fact_schema_version: 1,
      page_url: 'https://example.org/scholarship', apply_url: 'https://example.org/apply',
      field_provenance: { eligibility: { value: schoolRule, evidence_snippet: schoolRule, source: 'page' } },
    }, 'Applications are open to students nationwide.', canonicalShape)
    assert.deepEqual(normalized.schoolOriginRequirements, [])
  })

  test(`source-supported blind eligibility survives both normalizers: ${shape}`, () => {
    const normalized = throughBlindWeb({
      title: 'Example Scholarship', sponsor: 'Example Foundation', summary: 'Education support.',
      eligibility_text: schoolRule, eligibility_bullets: [], page_fact_schema_version: 1,
      page_url: 'https://example.org/scholarship', apply_url: 'https://example.org/apply',
      field_provenance: { eligibility: { value: schoolRule, evidence_snippet: schoolRule, source: 'page' } },
    }, `Scholarship details. ${schoolRule}`, canonicalShape)
    assert.equal(normalized.schoolOriginRequirements.length, 1)
    assert.equal(normalized.schoolOriginRequirements[0].county, 'raleigh')
  })
}
