import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { getAnyaMaintenanceStatus } from '../../backend/services/anyaMaintenanceStatus.js'
import { listToolMetadata } from '../../backend/services/anyaToolRegistry.js'
import { CHAT_CALLABLE_TOOL_DOCS, CHAT_TOOL_WHITELIST } from '../../backend/services/anyaOrchestrator.js'

function makeMaintenanceDb(state) {
  return {
    prepare(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim()
      if (normalized.startsWith('CREATE TABLE IF NOT EXISTS system_kv')) {
        return { run: async () => ({ changes: 0 }) }
      }
      if (normalized.startsWith('SELECT value FROM system_kv')) {
        return {
          get: async () => (state ? { value: JSON.stringify(state) } : undefined),
        }
      }
      throw new Error('Unexpected SQL in maintenance test: ' + normalized)
    },
  }
}

test('Anya chat advertises the live maintenance-status tool', async () => {
  const metadata = listToolMetadata()
  assert.ok(metadata.some((entry) => entry.name === 'app.getMaintenanceStatus'))
  assert.ok(CHAT_TOOL_WHITELIST.includes('app.getMaintenanceStatus'))
  assert.match(
    CHAT_CALLABLE_TOOL_DOCS.find(([name]) => name === 'app.getMaintenanceStatus')?.[1] || '',
    /banner is on or off/i,
  )

  const source = await readFile('backend/services/anyaOrchestrator.js', 'utf8')
  assert.match(source, /Never send the user to Admin Tools for this public live status/)
})

test('Anya reports the maintenance banner off when GrantFlow is open', async () => {
  const result = await getAnyaMaintenanceStatus({}, { db: makeMaintenanceDb(null) })
  assert.equal(result.phase, 'open')
  assert.equal(result.active, false)
  assert.equal(result.banner_visible, false)
  assert.equal(result.banner_state, 'off')
  assert.match(result.answer, /banner is off/i)
})

test('Anya reports the maintenance banner on for an active warning window', async () => {
  const now = Date.now()
  const result = await getAnyaMaintenanceStatus({}, {
    db: makeMaintenanceDb({
      active: true,
      reason: 'deploy',
      message: 'Finishing an update.',
      started_at: new Date(now - 60_000).toISOString(),
      grace_until: new Date(now + 10 * 60_000).toISOString(),
      estimated_end_at: new Date(now + 25 * 60_000).toISOString(),
      scheduled_by: 'test',
    }),
  })

  assert.equal(result.phase, 'warning')
  assert.equal(result.active, true)
  assert.equal(result.banner_visible, true)
  assert.equal(result.banner_state, 'on')
  assert.match(result.answer, /banner is on/i)
})
