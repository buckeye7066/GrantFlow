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

  it('accepts a real policy string as current', () => {
    expect(isStaleMatchExplain({
      gate: 'attendance',
      scoring_policy_version: 'need_first_v2',
    })).toBe(false)
    expect(isStaleMatchExplain(JSON.stringify({
      scoreBreakdown: { scoring_policy_version: 'need_first_v2' },
    }))).toBe(false)
  })
})

describe('staleMatchExplainSql', () => {
  it('scopes the column to the requested alias', () => {
    const sql = staleMatchExplainSql('m')
    expect(sql).toContain('m.match_explain_json')
    expect(sql).toContain('scoring_policy_version')
  })
})
