/**
 * matchExplainPersistence — linker explain must carry engine policy, not
 * gate-only stubs (item 43 residue after catalog-rescore drain).
 */

import { describe, it, expect } from 'vitest'
import {
  buildPersistedMatchExplain,
  isStaleMatchExplain,
  staleMatchExplainSql,
} from '../services/matching/matchExplainPersistence.js'
import { SCORE_SCALE_ID } from '../config/matchThresholds.js'

describe('buildPersistedMatchExplain', () => {
  it('merges engine policy with linker gate provenance', () => {
    const out = buildPersistedMatchExplain(
      {
        scoringPolicyVersion: 'need_first_v2',
        scoreScaleId: 'data_point_test',
        matcherVersion: 'matcher-test',
        match_explain: { nested: true, scoreBreakdown: { total: 17 } },
      },
      { gate: 'attendance', institution: 'MTSU' },
    )
    expect(out.scoring_policy_version).toBe('need_first_v2')
    expect(out.score_scale_id).toBe('data_point_test')
    expect(out.matcher_version).toBe('matcher-test')
    expect(out.gate).toBe('attendance')
    expect(out.institution).toBe('MTSU')
    expect(out.nested).toBe(true)
  })

  it('does not invent a scoring_policy_version when the engine omitted one', () => {
    const out = buildPersistedMatchExplain(
      { match_explain: { gate_candidate: true } },
      { gate: 'declared_field_of_study', term: 'forensic science' },
    )
    expect(out.scoring_policy_version).toBeUndefined()
    expect(out.score_scale_id).toBe(SCORE_SCALE_ID)
    expect(out.gate).toBe('declared_field_of_study')
    expect(out.term).toBe('forensic science')
  })

  it('reads policy from explain.scoreBreakdown when decision top-level is absent', () => {
    const out = buildPersistedMatchExplain({
      match_explain: {
        scoreBreakdown: { scoring_policy_version: 'need_first_v2', total: 10 },
      },
    })
    expect(out.scoring_policy_version).toBe('need_first_v2')
  })
})

describe('isStaleMatchExplain', () => {
  it('treats null, empty, invalid JSON, and gate-only stubs as stale', () => {
    expect(isStaleMatchExplain(null)).toBe(true)
    expect(isStaleMatchExplain('')).toBe(true)
    expect(isStaleMatchExplain('{')).toBe(true)
    expect(isStaleMatchExplain(JSON.stringify({ gate: 'attendance' }))).toBe(true)
    expect(isStaleMatchExplain({ scoring_policy_version: null })).toBe(true)
    expect(isStaleMatchExplain({ scoring_policy_version: '' })).toBe(true)
  })

  it('accepts a real policy string as current WHEN the explain also carries evidence', () => {
    expect(isStaleMatchExplain({
      gate: 'attendance',
      scoring_policy_version: 'need_first_v2',
      matchedSignals: ['geo:state'],
    })).toBe(false)
    expect(isStaleMatchExplain(JSON.stringify({
      scoreBreakdown: { scoring_policy_version: 'need_first_v2' },
      matched_needs: ['housing'],
    }))).toBe(false)
  })

  it('an explain with a policy but NO match evidence is stale (2026-09-06)', () => {
    // The display gates read the per-pair evidence keys; an explain that lost
    // them reads as unproven even when the engine can prove the pair on the
    // spot. Real case: "Bradley-Cleveland Community Services Agency" — the
    // applicant's OWN county agency — stored as
    // {gate, source, needFirstPolicy, scoring_policy_version, dataPointEvidence,
    //  scoreBreakdown}, while a fresh score returns
    // matchedSignals ["geo:city","keywords","needs"] and 17 matched data points.
    expect(isStaleMatchExplain({
      gate: 'recorded_discovery_provenance',
      source: 'web_search',
      scoring_policy_version: 'need_first_v2',
      dataPointEvidence: { bonus_credit: 0, total_credit: 0 },
      scoreBreakdown: { total: 24 },
    })).toBe(true)
  })

  it('EMPTY evidence still counts as evidence, so a refreshed row converges', () => {
    // Key ABSENCE is the test, never emptiness: a fresh write always carries
    // the keys, so re-scoring a genuinely unmatched pair does not queue it
    // again on the next boot.
    expect(isStaleMatchExplain({
      scoring_policy_version: 'need_first_v2',
      matchedSignals: [],
      matchedNeeds: [],
    })).toBe(false)
  })

  it('reads BOTH persisted shapes as evidence', () => {
    for (const key of ['matchedSignals', 'matchedNeeds', 'matched_profile_facts', 'matched_location', 'matched_needs']) {
      expect(isStaleMatchExplain({ scoring_policy_version: 'need_first_v2', [key]: [] })).toBe(false)
    }
  })
})

describe('staleMatchExplainSql', () => {
  it('scopes the column to the requested alias', () => {
    const sql = staleMatchExplainSql('m')
    expect(sql).toContain('m.match_explain_json')
    expect(sql).toContain('scoring_policy_version')
  })
})
