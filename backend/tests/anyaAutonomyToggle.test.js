import { describe, expect, it, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

import {
  ensureSchema,
  _resetSchemaCache,
  getAgentSetting,
  setAgentSetting,
} from '../services/agentControl/agentControlStore.js'
import {
  isAutonomousEnabled,
  setAutonomousEnabled,
} from '../services/anyaAutonomousScheduler.js'

// Covers the persisted Control-Center toggle for Anya's autonomous scheduler:
//   - agent_settings KV round-trip (insert + upsert, cross-dialect-safe)
//   - the in-memory master switch helpers the toggle endpoint + boot seed use.

function makeDb() {
  _resetSchemaCache()
  return new Database(':memory:')
}

describe('agentControlStore agent_settings KV', () => {
  let db
  beforeEach(async () => {
    db = makeDb()
    await ensureSchema(db)
  })

  it('returns null for an unset key', async () => {
    expect(await getAgentSetting(db, 'anya.autonomous_enabled')).toBe(null)
  })

  it('persists and reads back a value (insert path)', async () => {
    await setAgentSetting(db, 'anya.autonomous_enabled', 'false', { updatedByEmail: 'owner@example.invalid' })
    expect(await getAgentSetting(db, 'anya.autonomous_enabled')).toBe('false')
  })

  it('upserts an existing key (update path) without duplicating the row', async () => {
    await setAgentSetting(db, 'anya.autonomous_enabled', 'false')
    await setAgentSetting(db, 'anya.autonomous_enabled', 'true')
    expect(await getAgentSetting(db, 'anya.autonomous_enabled')).toBe('true')
    const row = db.prepare('SELECT COUNT(*) AS n FROM agent_settings WHERE key = ?').get('anya.autonomous_enabled')
    expect(Number(row.n)).toBe(1)
  })
})

describe('anya autonomous master switch', () => {
  it('setAutonomousEnabled flips isAutonomousEnabled (used by the toggle + boot seed)', () => {
    setAutonomousEnabled(false)
    expect(isAutonomousEnabled()).toBe(false)
    setAutonomousEnabled(true)
    expect(isAutonomousEnabled()).toBe(true)
  })
})
