import test from 'node:test'
import assert from 'node:assert/strict'

import { getSafeHealthSummary } from '../../backend/services/diagnosticsService.js'

function makeDb({ dialect = 'sqlite', opportunities = 0, failures = 0 } = {}) {
  return {
    dialect,
    async healthcheck() {
      return { ok: true, dialect }
    },
    prepare(sql) {
      const normalized = String(sql)
      return {
        get: async () => {
          if (normalized.includes('COUNT(*)') && normalized.includes('funding_opportunities')) {
            return { count: opportunities }
          }
          if (normalized.includes('COUNT(*)') && normalized.includes('crawler_jobs')) {
            return { count: failures }
          }
          return { ok: 1 }
        },
      }
    },
  }
}

test('getSafeHealthSummary: returns stable shape (db missing)', async () => {
  const result = await getSafeHealthSummary(null)
  assert.equal(typeof result.timestamp, 'string')
  assert.equal(result.status, 'error')
  assert.deepEqual(Object.keys(result.counts).sort(), ['opportunities', 'recentFailures'].sort())
  assert.equal(typeof result.summary, 'string')
})

test('getSafeHealthSummary: healthy when opportunities exist and no failures', async () => {
  const db = makeDb({ opportunities: 5, failures: 0 })
  const result = await getSafeHealthSummary(db)
  assert.equal(result.status, 'healthy')
  assert.equal(result.counts.opportunities, 5)
  assert.equal(result.counts.recentFailures, 0)
})

test('getSafeHealthSummary: warning when failures exist', async () => {
  const db = makeDb({ opportunities: 5, failures: 2 })
  const result = await getSafeHealthSummary(db)
  assert.equal(result.status, 'warning')
  assert.equal(result.counts.recentFailures, 2)
})

