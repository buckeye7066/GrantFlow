import { describe, expect, it } from 'vitest'

import {
  buildAnyaHandoff,
  classifySourceFailure,
  evaluateDiscovery,
} from '../services/amy/amyReport.js'
import { FINDING_TYPES } from '../services/amy/amyConstants.js'
import { actorFor } from '../services/amy/findingActorRegistry.js'
import { createSbirGovAdapter } from '../crawler-os/adapters/sbirGovAdapter.js'
import { outcomeForBenignFetchFailure } from '../crawler-os/pipeline.js'
import { CRAWLER_OUTCOME } from '../crawler-os/contract.js'

const scenario = Object.freeze({
  scenario_id: 'source-outcome-contract-v1',
  category: 'business',
  label: 'Business source outcome contract',
  expected: { needs: [], state: null },
})

function recommendation(index, overrides = {}) {
  return {
    id: `opp-${index}`,
    opportunity_id: `opp-${index}`,
    title: `Concrete Business Grant ${index}`,
    kind: 'DIRECT_GRANT',
    decision: 'ACCEPT',
    match_score: 90,
    amount_max: 1_000,
    ...overrides,
  }
}

function evaluate({ sources = [], recommendations = [recommendation(1)] } = {}) {
  return evaluateDiscovery(scenario, 'profile-source-outcome', {
    run: {
      run_id: 'crawler-run-source-outcome',
      stored: recommendations.length,
      sources,
      recommendations,
    },
    thesis: {
      applicant_types: ['business'],
      needs: ['capital'],
      location: {},
      is_student: false,
    },
  })
}

const findingTypes = (evaluation) => evaluation.findings.map((finding) => finding.type)

describe('Amy source health follows the canonical outcome before reason text', () => {
  it.each(['ok', 'EMPTY', 'skipped'])(
    '%s stays non-failing even when the reason retains forbidden/error text',
    (outcome) => {
      const source = {
        source_id: 'sbir_gov',
        outcome,
        reason: 'api_outage:sbir_public_api_403_forbidden parse_error',
      }
      expect(classifySourceFailure(source)).toBeNull()

      const evaluation = evaluate({ sources: [source] })
      expect(findingTypes(evaluation)).not.toContain(FINDING_TYPES.SOURCE_FETCH_FAILED)
      expect(findingTypes(evaluation)).not.toContain(FINDING_TYPES.SOURCE_PARSE_FAILED)
      expect(evaluation.sources_failed).toBe(0)
      expect(evaluation.sources_parse_failed).toBe(0)
      expect(evaluation.source_failures_total).toBe(0)
    },
  )

  it.each(['fetch_error', 'rate_limited', 'error'])(
    '%s is a fetch failure even if its explanatory text mentions parsing',
    (outcome) => {
      const source = { source_id: 'transport_source', outcome, reason: 'parse_error after transport outcome' }
      expect(classifySourceFailure(source)).toBe('fetch')
      const evaluation = evaluate({ sources: [source] })
      expect(findingTypes(evaluation)).toContain(FINDING_TYPES.SOURCE_FETCH_FAILED)
      expect(findingTypes(evaluation)).not.toContain(FINDING_TYPES.SOURCE_PARSE_FAILED)
      expect(evaluation.sources_failed).toBe(1)
      expect(evaluation.sources_parse_failed).toBe(0)
    },
  )

  it('keeps a canonical BLOCKED run observable without creating an adapter code defect', () => {
    const source = {
      source_id: 'sbir_gov',
      outcome: 'blocked',
      reason: 'external_blocked:sbir_public_api_403_forbidden',
    }
    expect(classifySourceFailure(source)).toBe('external_blocked')
    const evaluation = evaluate({ sources: [source] })
    expect(findingTypes(evaluation)).not.toContain(FINDING_TYPES.SOURCE_FETCH_FAILED)
    expect(findingTypes(evaluation)).not.toContain(FINDING_TYPES.SOURCE_PARSE_FAILED)
    expect(evaluation.sources_failed).toBe(0)
    expect(evaluation.source_failures_total).toBe(0)
    expect(evaluation.sources_external_blocked).toBe(1)
    expect(evaluation.external_blocked_sources).toEqual([
      expect.objectContaining({ id: 'sbir_gov', failure_kind: 'external_blocked' }),
    ])
    const report = buildAnyaHandoff({ runId: 'amy-external-block', evaluations: [evaluation] })
    expect(report.amy_summary.source_health).toMatchObject({
      scenarios_with_source_failures: 0,
      scenarios_with_external_blocks: 1,
    })
  })

  it('recognizes only the two exact SBIR maintenance response shapes', () => {
    const classifySbirBenignFetchFailure = createSbirGovAdapter().benignFetchFailure
    expect(classifySbirBenignFetchFailure({
      status: 403,
      body: JSON.stringify({ message: 'Forbidden' }),
    })).toBe('external_blocked:sbir_public_api_403_forbidden')
    expect(classifySbirBenignFetchFailure({
      status: 503,
      body: JSON.stringify({ Message: 'Public API is not available at this time' }),
    })).toBe('external_blocked:sbir_public_api_unavailable')
    expect(classifySbirBenignFetchFailure({
      status: 403,
      body: JSON.stringify({ message: 'Forbidden: invalid credentials' }),
    })).toBe(false)
    expect(outcomeForBenignFetchFailure('external_blocked:sbir_public_api_403_forbidden')).toBe(CRAWLER_OUTCOME.BLOCKED)
    expect(outcomeForBenignFetchFailure('propublica_end_of_data')).toBe(CRAWLER_OUTCOME.EMPTY)
  })

  it('reports PARSE_ERROR separately while preserving fetch-only legacy fields', () => {
    const source = { source_id: 'changed_schema', outcome: 'parse_error', reason: 'required results list missing' }
    expect(classifySourceFailure(source)).toBe('parse')

    const evaluation = evaluate({ sources: [source] })
    expect(findingTypes(evaluation)).not.toContain(FINDING_TYPES.SOURCE_FETCH_FAILED)
    expect(findingTypes(evaluation)).toContain(FINDING_TYPES.SOURCE_PARSE_FAILED)
    expect(evaluation.sources_failed).toBe(0)
    expect(evaluation.failed_sources).toEqual([])
    expect(evaluation.sources_parse_failed).toBe(1)
    expect(evaluation.parse_failed_sources).toEqual([
      expect.objectContaining({ id: 'changed_schema', failure_kind: 'parse' }),
    ])
    expect(evaluation.source_failures_total).toBe(1)

    const report = buildAnyaHandoff({ runId: 'amy-source-contract', evaluations: [evaluation] })
    expect(report.amy_summary.source_health).toEqual({
      scenarios_with_source_failures: 1,
      scenarios_with_fetch_failures: 0,
      scenarios_with_parse_failures: 1,
      scenarios_with_external_blocks: 0,
    })
  })

  it('keeps historical reports readable when only sources_failed exists', () => {
    const report = buildAnyaHandoff({
      runId: 'amy-historical-source-contract',
      evaluations: [{
        scenario_id: 'historical-evaluation',
        category: 'business',
        status: 'ok',
        sources_failed: 1,
        findings: [],
      }],
    })
    expect(report.amy_summary.source_health).toEqual({
      scenarios_with_source_failures: 1,
      scenarios_with_fetch_failures: 1,
      scenarios_with_parse_failures: 0,
      scenarios_with_external_blocks: 0,
    })
  })

  it.each([
    [{ source_id: 'legacy', outcome: 'FAILED' }, 'fetch'],
    [{ source_id: 'legacy', reason: '403 forbidden by upstream' }, 'fetch'],
    [{ source_id: 'legacy', outcome: 'legacy_parse_failure' }, 'parse'],
  ])('uses fuzzy fallback only for legacy missing/unrecognized outcomes', (source, expected) => {
    expect(classifySourceFailure(source)).toBe(expected)
  })

  it('registers a closeable actor for the new parse finding', () => {
    expect(actorFor(FINDING_TYPES.SOURCE_PARSE_FAILED)).toMatchObject({
      lever: 'adapter_source_health',
      emitted: true,
      evidence_key: 'parse_failed_sources',
    })
  })
})

describe('Amy amount recall uses the canonical no-per-award kind registry', () => {
  it.each(['DIRECTORY', 'BENEFIT', 'referral', 'school_portal', 'past_award_intel'])(
    'excludes %s rows from the measurable amount denominator',
    (kind) => {
      const recommendations = Array.from({ length: 5 }, (_, index) => recommendation(index, {
        kind,
        decision: 'REVIEW',
        match_score: 50,
        amount_max: null,
      }))
      const evaluation = evaluate({ recommendations })
      expect(findingTypes(evaluation)).not.toContain(FINDING_TYPES.AMOUNT_RECALL_MISS)
    },
  )

  it.each(['DIRECT_GRANT', undefined])(
    'keeps measurable %s rows in the denominator',
    (kind) => {
      const recommendations = Array.from({ length: 5 }, (_, index) => recommendation(index, {
        kind,
        decision: 'REVIEW',
        match_score: 50,
        amount_max: null,
      }))
      const evaluation = evaluate({ recommendations })
      expect(findingTypes(evaluation)).toContain(FINDING_TYPES.AMOUNT_RECALL_MISS)
    },
  )
})
