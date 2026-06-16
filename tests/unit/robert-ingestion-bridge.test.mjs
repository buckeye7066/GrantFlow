import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ingestOpportunity, ingestOpportunities } from '../../backend/services/robert/robertIngestionBridge.js'

const SAMPLE_OPP = {
  title: 'Test Grant',
  sponsor: 'Test Sponsor',
  application_url: 'https://www.fema.gov/grants/x/apply',
  source_url: 'https://www.fema.gov/grants/x',
  record_origin: 'discovered',
}

describe('robertIngestionBridge — delegates to canonical upsertFundingOpportunity', () => {
  it('uses the injected upsert and never bypasses canonical gates', async () => {
    let received = null
    const upsert = async (_db, opp, opts) => {
      received = { opp, opts }
      return { id: 'opp-1', inserted: true, skipped: false }
    }
    const result = await ingestOpportunity({ db: { prepare: () => {} }, opportunity: SAMPLE_OPP, upsertFundingOpportunity: upsert })
    assert.equal(result.id, 'opp-1')
    assert.equal(result.inserted, true)
    // Verify canonical safety options are explicitly DISABLED for bypass:
    assert.equal(received.opts.allowLoans, false)
    assert.equal(received.opts.allowDirectories, false)
    assert.equal(received.opts.allowExpired, false)
    assert.equal(received.opts.allowMatchingFunds, false)
    assert.equal(received.opts.skipVerification, false)
  })

  it('passes through skip results with reason', async () => {
    const upsert = async () => ({ id: null, inserted: false, skipped: true, reason: 'policy:no_real_url' })
    const result = await ingestOpportunity({ db: {}, opportunity: SAMPLE_OPP, upsertFundingOpportunity: upsert })
    assert.equal(result.skipped, true)
    assert.equal(result.reason, 'policy:no_real_url')
  })

  it('tallies a batch correctly', async () => {
    const responses = [
      { id: 'a', inserted: true, skipped: false },
      { id: null, inserted: false, skipped: true, reason: 'quality:duplicate' },
      { id: 'b', inserted: false, updated: true, skipped: false },
    ]
    let i = 0
    const upsert = async () => responses[i++]
    const tally = await ingestOpportunities({
      db: {}, opportunities: [SAMPLE_OPP, SAMPLE_OPP, SAMPLE_OPP],
      upsertFundingOpportunity: upsert,
    })
    assert.equal(tally.inserted, 1)
    assert.equal(tally.updated, 1)
    assert.equal(tally.skipped, 1)
    assert.equal(tally.errors, 0)
  })

  it('throws if no opportunity provided', async () => {
    await assert.rejects(() => ingestOpportunity({ db: {}, opportunity: null, upsertFundingOpportunity: async () => ({}) }))
  })
})
