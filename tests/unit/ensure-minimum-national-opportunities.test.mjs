import test from 'node:test'
import assert from 'node:assert/strict'

import { ensureMinimumNationalOpportunities } from '../../backend/utils/ensureMinimumNationalOpportunities.js'

test('ensureMinimumNationalOpportunities awaits Postgres adapter reads', async () => {
  const calls = []
  const db = {
    dialect: 'postgres',
    prepare(sql) {
      calls.push(sql)
      return {
        async get() {
          if (sql.includes('information_schema.columns')) return { ok: 1 }
          if (/COUNT\(\*\)/i.test(sql)) return { count: '7' }
          return null
        },
        async all() {
          return []
        },
        async run() {
          return { changes: 0 }
        },
      }
    },
  }

  const result = await ensureMinimumNationalOpportunities(db, 0)

  assert.equal(result.ok, true)
  assert.equal(result.total, 7)
  assert.ok(calls.some((sql) => sql.includes('information_schema.columns')))
  assert.ok(calls.some((sql) => /COUNT\(\*\)/i.test(sql)))
})
