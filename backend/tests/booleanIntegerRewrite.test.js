import { describe, expect, it } from 'vitest'
import { fixBooleanIntegers } from '../db/index.js'

// Regression guard for the SQLite→Postgres boolean rewrite.
//
// SQLite stores booleans as 0/1 integers, so the codebase writes
// `WHERE is_loan = 0`. Postgres uses a real BOOLEAN type and raises
// `operator does not exist: boolean = integer` (an unhandled HTTP 500) for
// such comparisons. The Postgres shim rewrites `<bool_col> = 1/0` to
// `= TRUE/FALSE`, but only for columns in KNOWN_BOOLEAN_COLUMNS. When the
// funding-pipeline boolean columns were missing from that list, every
// unguarded query on them 500'd ("process funding sources through the
// pipeline"). These cases pin the columns that must stay covered.
describe('fixBooleanIntegers (Postgres boolean compatibility)', () => {
  const fundingBooleanColumns = [
    'is_active',
    'is_national',
    'is_loan',
    'requires_match',
    'requires_501c3',
    'usable_for_housing',
    'refund_potential',
    'verified_url',
  ]

  for (const col of fundingBooleanColumns) {
    it(`rewrites ${col} = 1 → TRUE and = 0 → FALSE`, () => {
      expect(fixBooleanIntegers(`SELECT 1 FROM t WHERE ${col} = 1`)).toBe(
        `SELECT 1 FROM t WHERE ${col} = TRUE`,
      )
      expect(fixBooleanIntegers(`SELECT 1 FROM t WHERE ${col} = 0`)).toBe(
        `SELECT 1 FROM t WHERE ${col} = FALSE`,
      )
    })
  }

  it('handles real funding-pipeline query shapes that previously 500d', () => {
    const sql =
      "SELECT * FROM funding_opportunities WHERE is_active = 1 " +
      "AND (state = ? OR state = 'nationwide' OR is_national = 1) " +
      'AND (requires_match = 0 OR requires_match IS NULL) ' +
      'AND (is_loan = 0 OR is_loan IS NULL)'
    const out = fixBooleanIntegers(sql)
    expect(out).not.toMatch(/(is_active|is_national|requires_match|is_loan)\s*=\s*[01]\b/)
    expect(out).toContain('is_active = TRUE')
    expect(out).toContain('is_national = TRUE')
    expect(out).toContain('requires_match = FALSE')
    expect(out).toContain('is_loan = FALSE')
  })

  it('does not touch integer columns that merely look boolean-ish', () => {
    // e.g. a genuine integer level column must keep its = 1 comparison.
    expect(fixBooleanIntegers('SELECT 1 FROM t WHERE priority_level = 1')).toBe(
      'SELECT 1 FROM t WHERE priority_level = 1',
    )
    expect(fixBooleanIntegers('SELECT 1 FROM t WHERE match_percentage = 0')).toBe(
      'SELECT 1 FROM t WHERE match_percentage = 0',
    )
  })
})
