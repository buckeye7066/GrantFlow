/**
 * The dynamic-SQL guardrail can SEE multi-line SQL.
 *
 * `scripts/codemod/safe-sql.mjs` used to require `db.prepare(<backtick>` and
 * `${` on the SAME source line. Measured on origin/main 2fcb599f: of 802
 * `db.(prepare|run|get|all)(<backtick>)` call sites under `backend/`, 284 carry
 * an interpolation and 100 of those (35.2%) put every interpolation on a
 * CONTINUATION line; per interpolation, 183 of 398 (46.0%) were unreachable.
 * The gate reported "OK (0 dynamic-SQL violations)" over code it could not read.
 *
 * The fixtures below are assembled from line arrays on purpose: writing them as
 * real template literals would make THIS file a scanner target and the samples
 * would flag themselves.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  auditSource,
  auditTree,
  evaluateAgainstBaseline,
  isDangerousInterpolation,
  readTemplateLiteral,
  tallyStatementViolations,
} from '../../scripts/codemod/safe-sql.mjs'

const BT = String.fromCharCode(96)
const src = (...lines) => lines.join('\n')

/** The ORIGINAL line-oriented rule, verbatim, so every claim below is an A/B. */
function originalLineRule(fileLabel, source) {
  const out = []
  const lines = source.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!new RegExp(`db\\.(prepare|run|get|all)\\s*\\(\\s*${BT}`).test(line)) continue
    if (!line.includes('${')) continue
    if (/audit:allow\s+(dynamic-sql|sql-interpolation)/i.test(line)) continue
    if (i > 0 && /audit:allow\s+(dynamic-sql|sql-interpolation)/i.test(lines[i - 1])) continue
    if (/assertSafeIdentifier|safeSqlIdentifier|buildWhere|orderBy\(|ident\(/.test(line)) continue
    const interpolations = [...line.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim())
    if (interpolations.some(isDangerousInterpolation)) out.push({ file: fileLabel, line: i + 1 })
  }
  return out
}

const MULTILINE_UNSAFE = src(
  'export function probe(db, req) {',
  '  const whereClause = buildFilter(req)',
  '  return db.prepare(' + BT,
  '    SELECT id FROM grants',
  '    WHERE ${whereClause}',
  '    ORDER BY id',
  '  ' + BT + ').all()',
  '}',
)

const SINGLE_LINE_UNSAFE = src(
  'export function probe(db, req) {',
  '  return db.prepare(' + BT + 'SELECT id FROM grants WHERE ${req.query.status}' + BT + ').all()',
  '}',
)

describe('safe-sql scanner: multi-line reach', () => {
  it('the OLD rule is BLIND to a multi-line unsafe statement; the NEW scanner catches it', () => {
    expect(originalLineRule('probe.js', MULTILINE_UNSAFE)).toEqual([])

    const found = auditSource('probe.js', MULTILINE_UNSAFE)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ file: 'probe.js', line: 5, expr: 'whereClause', pass: 'statement' })
  })

  it('the single-line TRUE-POSITIVE set does not shrink', () => {
    const old = originalLineRule('probe.js', SINGLE_LINE_UNSAFE)
    expect(old).toHaveLength(1)
    const found = auditSource('probe.js', SINGLE_LINE_UNSAFE).filter((v) => v.pass === 'line')
    expect(found.map((v) => v.line)).toEqual(old.map((v) => v.line))
    expect(found[0].expr).toBe('req.query.status')
  })

  it('a statement-level `audit:allow` on the opening line still covers the whole query', () => {
    const annotated = MULTILINE_UNSAFE.replace(
      '  return db.prepare(' + BT,
      '  return db.prepare(' + BT + ' -- audit:allow dynamic-sql',
    )
    expect(auditSource('probe.js', annotated)).toEqual([])
  })

  it('`audit:allow` next to the offending interpolation suppresses just that one', () => {
    const twoInterpolations = src(
      'export function probe(db) {',
      '  return db.prepare(' + BT,
      '    SELECT id FROM grants',
      '    WHERE ${whereClause} /* audit:allow dynamic-sql */',
      '    AND active = 1',
      '    ORDER BY ${orderByFragment}',
      '  ' + BT + ').all()',
      '}',
    )
    const found = auditSource('probe.js', twoInterpolations)
    expect(found.map((v) => v.expr)).toEqual(['orderByFragment'])
    expect(found.map((v) => v.line)).toEqual([6])
  })

  it('a trusted safeSql helper on the continuation line is safe by construction', () => {
    const guarded = MULTILINE_UNSAFE.replace('WHERE ${whereClause}', 'WHERE ${buildWhere(filters)}')
    expect(auditSource('probe.js', guarded)).toEqual([])
  })

  it('a nested template inside ${} does not terminate the literal early', () => {
    const nested = src(
      'export function probe(db, req) {',
      '  return db.prepare(' + BT,
      '    SELECT id FROM grants',
      '    WHERE tag = ${' + BT + 'x${req.params.id}y' + BT + '}',
      '    AND ${rawClause}',
      '  ' + BT + ').all()',
      '}',
    )
    const found = auditSource('probe.js', nested)
    // Both the nested-template interpolation and the one AFTER it are reached.
    expect(found.map((v) => v.line)).toEqual([4, 5])
  })

  it('readTemplateLiteral reports every top-level interpolation', () => {
    const text = BT + 'a${one}b${two}c' + BT
    const parsed = readTemplateLiteral(text, 0)
    expect(parsed.interpolations.map((i) => i.expr)).toEqual(['one', 'two'])
  })
})

describe('safe-sql scanner: baseline ratchet', () => {
  it('a NEW multi-line site fails; the same site inside the baseline is grandfathered', () => {
    const violations = auditSource('probe.js', MULTILINE_UNSAFE)
    const bare = evaluateAgainstBaseline(violations, {})
    expect(bare.failures).toHaveLength(1)
    expect(bare.failures[0].why).toMatch(/NEW multi-line/)

    const baselined = evaluateAgainstBaseline(violations, tallyStatementViolations(violations))
    expect(baselined.failures).toEqual([])
    expect(baselined.grandfathered).toHaveLength(1)
    expect(baselined.stale).toEqual([])
  })

  it('one MORE occurrence of a baselined expression still fails', () => {
    const violations = auditSource('probe.js', MULTILINE_UNSAFE)
    const twice = [...violations, { ...violations[0], line: 99 }]
    const result = evaluateAgainstBaseline(twice, tallyStatementViolations(violations))
    expect(result.failures).toHaveLength(1)
    expect(result.grandfathered).toHaveLength(1)
  })

  it('a baseline entry that over-counts reality fails as STALE (the list can only shrink)', () => {
    const result = evaluateAgainstBaseline([], { 'probe.js': { whereClause: 1 } })
    expect(result.stale).toEqual([{ file: 'probe.js', expr: 'whereClause', allowed: 1, seen: 0 }])
  })

  it('a SINGLE-LINE violation is NEVER grandfathered, whatever the baseline says', () => {
    const violations = auditSource('probe.js', SINGLE_LINE_UNSAFE)
    const result = evaluateAgainstBaseline(violations, tallyStatementViolations(violations))
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].pass).toBe('line')
  })
})

describe('safe-sql scanner: this repository', () => {
  const repoRoot = process.cwd()
  const baseline = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'scripts/codemod/safeSql.baseline.json'), 'utf8'),
  )
  const violations = auditTree(path.join(repoRoot, 'backend'), repoRoot)
  const result = evaluateAgainstBaseline(violations, baseline.sites)

  it('backend/ carries no un-baselined dynamic-SQL violations', () => {
    expect(result.failures.map((v) => `${v.file}:${v.line} ${v.why}`)).toEqual([])
  })

  it('the checked-in baseline is not stale', () => {
    expect(result.stale).toEqual([])
  })

  it('the baseline is a real, non-empty inventory of statements the OLD rule could not see', () => {
    // If this ever reaches 0, delete the baseline file and this assertion —
    // do not leave an empty inventory pretending to hold something.
    expect(result.grandfathered.length).toBeGreaterThan(0)
    expect(result.grandfathered.every((v) => v.pass === 'statement')).toBe(true)
  })
})
