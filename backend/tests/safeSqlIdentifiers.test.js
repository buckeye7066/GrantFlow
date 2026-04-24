/**
 * Unit tests for safeSql identifier validation helpers.
 *
 * These guard the SQL-identifier safety fix surfaced by the admin audit:
 *   - assertSafeIdentifier throws for non-allowlisted tables/columns
 *   - buildWhere refuses unknown columns and keeps values parameterised
 */
import { describe, it, expect } from 'vitest'
import {
  assertSafeIdentifier,
  buildWhere,
  registerAllowedSqlIdentifiers,
  getAllowedSqlColumns,
  getAllowedSqlTables,
} from '../utils/safeSql.js'

describe('assertSafeIdentifier', () => {
  it('accepts known table names', () => {
    expect(assertSafeIdentifier('funding_opportunities', 'table')).toBe('funding_opportunities')
    expect(assertSafeIdentifier('applications', 'table')).toBe('applications')
  })

  it('accepts known column names', () => {
    expect(assertSafeIdentifier('status', 'column')).toBe('status')
    expect(assertSafeIdentifier('id', 'column')).toBe('id')
  })

  it('rejects empty/null/undefined identifiers', () => {
    expect(() => assertSafeIdentifier('', 'column')).toThrow(/Unsafe SQL/)
    expect(() => assertSafeIdentifier(null, 'column')).toThrow(/Unsafe SQL/)
    expect(() => assertSafeIdentifier(undefined, 'column')).toThrow(/Unsafe SQL/)
  })

  it('rejects SQL-injection-shaped identifiers', () => {
    expect(() => assertSafeIdentifier('foo; DROP TABLE users', 'table')).toThrow(/Unsafe SQL/)
    expect(() => assertSafeIdentifier('1; DELETE FROM profiles', 'column')).toThrow(/Unsafe SQL/)
    expect(() => assertSafeIdentifier('foo bar', 'column')).toThrow(/Unsafe SQL/)
    expect(() => assertSafeIdentifier('foo"bar', 'column')).toThrow(/Unsafe SQL/)
  })

  it('rejects valid-syntax identifiers that are not in the allowlist', () => {
    expect(() => assertSafeIdentifier('not_a_real_table', 'table')).toThrow(/Unsafe SQL table/)
    expect(() => assertSafeIdentifier('arbitrary_column_xyz', 'column')).toThrow(/Unsafe SQL column/)
  })

  it('falls back to regex-only check when kind is "identifier"', () => {
    expect(assertSafeIdentifier('anything_shaped_like_an_identifier')).toBe(
      'anything_shaped_like_an_identifier'
    )
    expect(() => assertSafeIdentifier('1 OR 1=1')).toThrow(/Unsafe SQL identifier/)
  })
})

describe('registerAllowedSqlIdentifiers', () => {
  it('extends the allowlist for project-specific tables/columns', () => {
    const customTable = 'test_custom_table_xyz'
    const customColumn = 'test_custom_column_xyz'
    registerAllowedSqlIdentifiers({ tables: [customTable], columns: [customColumn] })

    expect(getAllowedSqlTables()).toContain(customTable)
    expect(getAllowedSqlColumns()).toContain(customColumn)
    expect(assertSafeIdentifier(customTable, 'table')).toBe(customTable)
    expect(assertSafeIdentifier(customColumn, 'column')).toBe(customColumn)
  })

  it('rejects registration of malformed identifiers', () => {
    expect(() => registerAllowedSqlIdentifiers({ tables: ['; drop'] })).toThrow(/bad table name/)
    expect(() => registerAllowedSqlIdentifiers({ columns: ['no spaces allowed'] })).toThrow(
      /bad column name/
    )
  })
})

describe('buildWhere', () => {
  it('emits a parameterised WHERE clause in declaration order', () => {
    const { sql, clause, params } = buildWhere({ profile_id: 'p1', status: 'active' })
    expect(sql).toBe('WHERE profile_id = ? AND status = ?')
    expect(clause).toBe('profile_id = ? AND status = ?')
    expect(params).toEqual(['p1', 'active'])
  })

  it('skips undefined values but keeps explicit nulls', () => {
    const { sql, params } = buildWhere({ profile_id: 'p1', deleted_at: null, status: undefined })
    expect(sql).toBe('WHERE profile_id = ? AND deleted_at IS NULL')
    expect(params).toEqual(['p1'])
  })

  it('returns empty SQL for an empty filter set', () => {
    const result = buildWhere({})
    expect(result.sql).toBe('')
    expect(result.clause).toBe('')
    expect(result.params).toEqual([])
  })

  it('expands arrays into parameterised IN () clauses', () => {
    const { sql, params } = buildWhere({ source: ['grants_gov', 'state_portal'] })
    expect(sql).toBe('WHERE source IN (?, ?)')
    expect(params).toEqual(['grants_gov', 'state_portal'])
  })

  it('throws on non-allowlisted columns', () => {
    expect(() => buildWhere({ arbitrary_injected_col: 'x' })).toThrow(/Unsafe SQL column/)
  })

  it('supports operator overrides', () => {
    const { sql, params } = buildWhere([
      { column: 'amount_min', value: 1000, op: '>=' },
      { column: 'deadline', value: '2026-01-01', op: '<=' },
    ])
    expect(sql).toBe('WHERE amount_min >= ? AND deadline <= ?')
    expect(params).toEqual([1000, '2026-01-01'])
  })

  it('rejects injection attempts through the operator slot', () => {
    expect(() => buildWhere([{ column: 'status', value: 'x', op: '=; DROP TABLE' }])).toThrow(
      /Unsafe SQL operator/
    )
  })
})
