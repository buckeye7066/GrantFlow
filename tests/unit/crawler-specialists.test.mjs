import test from 'node:test'
import assert from 'node:assert/strict'

import { crawlECFBenefits } from '../../backend/services/crawlers/ecfBenefitsCrawler.js'

test('ecfBenefitsCrawler: TN-only specialist and uses section-based signals', async () => {
  const tnProfile = {
    state: 'TN',
    tags: [],
    sections: {
      government_assistance: { medicaid_enrolled: true },
      health_medical: { disability_type: ['intellectual disability'] },
    },
    signals: {
      location: { state: 'TN' },
      keywordSet: new Set(['ecf choices', 'tenncare']),
    },
  }

  const nonTnProfile = {
    state: 'CA',
    sections: { government_assistance: { medicaid_enrolled: true } },
    signals: { location: { state: 'CA' }, keywordSet: new Set(['ecf choices']) },
  }

  const tnResults = await crawlECFBenefits(tnProfile)
  assert.ok(tnResults.length >= 1, 'expected at least one ECF record for TN profile')
  assert.ok(tnResults.every((r) => r.state === 'TN'), 'expected all ECF records to be TN-scoped')

  const nonTnResults = await crawlECFBenefits(nonTnProfile)
  assert.equal(nonTnResults.length, 0, 'expected no ECF records for non-TN profile')
})

