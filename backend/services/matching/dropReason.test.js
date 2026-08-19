import { describe, it } from 'vitest'
import { canonicalResultForProfile } from './resultEnricher.js'

describe('debug', () => {
  it('traces why row is dropped', () => {
    const row = {
      id: 'opp-sentinel',
      title: 'Tennessee Promise',
      sponsor: 'Tennessee Student Assistance Corporation',
      description: 'Free community college.',
      application_url: 'https://example.org/apply',
      source_url: 'https://example.org/tnpromise',
      opportunity_kind: 'SCHOLARSHIP',
      is_national: 0,
      state: 'TN',
      match_score: 67,
      match_decision: 'ACCEPT',
      matcher_version: 'crawler-os',
      match_reasons: ['education', 'geography'],
    }
    const p = { id: 'p-sentinel', primary_type: 'individual', state: 'TN' }
    const result = canonicalResultForProfile({ profile: p, sections: {}, signals: null }, row, {
      preserveDirectories: true,
      rejectHardIneligible: true,
      useStoredDecision: true,
    })
    console.log('RESULT:', JSON.stringify({display: result.display, dropReason: result.dropReason}))
  })
})
