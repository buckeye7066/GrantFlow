/**
 * Tripwire: the SQLite test helper must never open the application database.
 *
 * `backend/db/index.js` runs `export const db = getDb()` at import time. When
 * `tests/helpers/sqliteTestDb.mjs` imported its normalizer from there, every
 * parallel Vitest worker that used the helper opened the real
 * backend/data/grantflow.db under WAL at once — "SqliteError: disk I/O error"
 * in hamiltonBotBypassRegistry.test.js on 2026-09-07. The helper now imports
 * from the side-effect-free backend/db/sqliteArgs.js; this pins that.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { normalizeSqliteArgs, normalizeSqliteValue } from '../db/sqliteArgs.js'

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')

describe('sqlite test helper has no side effects', () => {
  it('tests/helpers/sqliteTestDb.mjs does not import backend/db/index.js (which opens the app db)', () => {
    const src = read('tests/helpers/sqliteTestDb.mjs')
    expect(src).not.toMatch(/backend\/db\/index\.js/)
    expect(src).toMatch(/backend\/db\/sqliteArgs\.js/)
  })

  it('backend/db/sqliteArgs.js imports nothing (pure)', () => {
    const src = read('backend/db/sqliteArgs.js')
    expect(src).not.toMatch(/^\s*import\s/m)
    expect(src).not.toMatch(/require\(/)
  })

  it('normalizer still matches the production adapter contract', () => {
    expect(normalizeSqliteValue(true)).toBe(1)
    expect(normalizeSqliteValue(false)).toBe(0)
    expect(normalizeSqliteValue(undefined)).toBeNull()
    expect(normalizeSqliteValue(new Date('2026-09-07T00:00:00Z'))).toBe('2026-09-07T00:00:00.000Z')
    expect(normalizeSqliteValue({ a: 1 })).toBe('{"a":1}')
    expect(normalizeSqliteArgs([true, 'x'])).toEqual([1, 'x'])
    expect(normalizeSqliteArgs([[true, null]])).toEqual([[1, null]])
    expect(normalizeSqliteArgs([{ flag: false, when: undefined }])).toEqual([{ flag: 0, when: null }])
  })
})
