import { describe, expect, it } from 'vitest'
import {
  PIPELINE_LEDGER_SQL,
  parseProfileIds,
  summarizePipelineDollarRows,
} from '../../scripts/production-audit/pipeline-dollar-ledger.mjs'
import {
  PIPELINE_ACTIVE_STATUSES,
  WIDE_AWARD_RANGE_RATIO,
} from '../config/pipelineValue.js'
import { NO_PER_AWARD_FIGURE_KINDS } from '../config/opportunityKindClasses.js'

describe('protected production pipeline-dollar ledger', () => {
  it('is import-safe, parameterized, read-only SQL using the canonical contract', () => {
    expect(Array.isArray(PIPELINE_ACTIVE_STATUSES)).toBe(true)
    expect(PIPELINE_LEDGER_SQL).toContain('g.status = ANY($1::text[])')
    expect(PIPELINE_LEDGER_SQL).toContain('$2::text[] IS NULL')
    expect(PIPELINE_LEDGER_SQL).toContain(`g.amount_min * ${WIDE_AWARD_RANGE_RATIO}`)
    for (const kind of NO_PER_AWARD_FIGURE_KINDS) {
      expect(PIPELINE_LEDGER_SQL).toContain(String(kind))
    }
    expect(PIPELINE_LEDGER_SQL).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COPY)\b/i)
  })

  it('treats an empty profile scope as all profiles and validates explicit ids', () => {
    expect(parseProfileIds('')).toEqual([])
    expect(parseProfileIds('profile-1, profile_2,profile-1')).toEqual(['profile-1', 'profile_2'])
    expect(() => parseProfileIds('bad profile id')).toThrow(/Invalid profile id/)
  })

  it('builds per-profile old/corrected totals, exclusions, wide rows, and positive inflaters', () => {
    const rows = [
      {
        profile_id: 'p1', display_name: 'Test Nonprofit', grant_id: 'g1',
        funding_opportunity_id: 'o1', title: 'Direct Award', funder: 'Agency', status: 'submitted',
        opportunity_kind: 'direct', old_value: 5000, corrected_value: 5000, correction_reason: null,
      },
      {
        profile_id: 'p1', display_name: 'Test Nonprofit', grant_id: 'g2',
        funding_opportunity_id: 'o2', title: 'Wide Program', funder: 'Agency', status: 'submitted',
        opportunity_kind: 'direct', amount_requested: 42_000_000, amount_min: 1_000_000, amount_max: 42_000_000,
        old_value: 42_000_000, corrected_value: 1_000_000, correction_reason: 'wide_range_auto_ceiling',
      },
      {
        profile_id: 'p1', display_name: 'Test Nonprofit', grant_id: 'g3',
        funding_opportunity_id: 'o3', title: 'Directory', funder: 'Foundation', status: 'discovered',
        opportunity_kind: 'directory', old_value: 90_000, corrected_value: 0, correction_reason: 'no_per_award:directory',
      },
      {
        profile_id: 'p1', display_name: 'Test Nonprofit', grant_id: 'g4',
        funding_opportunity_id: 'o4', title: 'Rejected Grant', funder: 'Agency', status: 'interested',
        opportunity_kind: 'direct', old_value: 20_000, corrected_value: 0, correction_reason: 'reject',
      },
      {
        profile_id: 'p1', display_name: 'Test Nonprofit', grant_id: 'g5',
        funding_opportunity_id: 'dup', title: 'Duplicate Award', funder: 'Agency', status: 'submitted',
        opportunity_kind: 'direct', old_value: 1000, corrected_value: 1000, correction_reason: null,
      },
      {
        profile_id: 'p1', display_name: 'Test Nonprofit', grant_id: 'g6',
        funding_opportunity_id: 'dup', title: 'Duplicate Award', funder: 'Agency', status: 'submitted',
        opportunity_kind: 'direct', old_value: 1000, corrected_value: 1000, correction_reason: null,
      },
      {
        profile_id: 'p2', display_name: 'Student Profile', grant_id: 'g7',
        funding_opportunity_id: 'o7', title: 'Unvalued Scholarship', funder: 'School', status: 'discovered',
        opportunity_kind: 'direct', old_value: 0, corrected_value: 0, correction_reason: null,
      },
    ]

    const ledger = summarizePipelineDollarRows(rows, { generatedAt: '2026-09-01T00:00:00.000Z' })
    expect(ledger.summary.profiles).toBe(2)
    expect(ledger.summary.old_total).toBe(42_117_000)
    expect(ledger.summary.corrected_total).toBe(1_007_000)
    expect(ledger.summary.overstatement).toBe(41_110_000)
    expect(ledger.summary.excluded).toEqual({ ineligible: 0, reject: 1, no_per_award: 1 })
    expect(ledger.summary.wide_range_auto_ceiling_rows).toBe(1)
    expect(ledger.summary.duplicate_groups).toBe(1)

    const nonprofit = ledger.profiles.find((profile) => profile.profile_id === 'p1')
    expect(nonprofit.top_inflation_contributors.map((row) => row.grant_id)).toEqual(['g2', 'g3', 'g4'])
    expect(nonprofit.wide_range_auto_ceiling_rows[0].corrected_value).toBe(1_000_000)
    expect(nonprofit.duplicates[0]).toMatchObject({ count: 2, grant_ids: ['g5', 'g6'] })

    const student = ledger.profiles.find((profile) => profile.profile_id === 'p2')
    expect(student.useful_unvalued_rows).toBe(1)
  })
})
