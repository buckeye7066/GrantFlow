import { it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { storeMemory, getMemory, getMemories, deleteMemory } from '../services/anyaBrainService.js'

it('keeps null, empty and named memory scopes distinct for reads and deletion', async () => {
  const db = new Database(':memory:')
  try {
    db.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'))
    for (const scopeId of [null, '', 'profile-1']) {
      await storeMemory(db, { scopeId, memoryKey: 'funding-goal', content: { scopeId } })
    }
    for (const scopeId of [null, '', 'profile-1']) {
      const memory = await getMemory(db, { scopeId, memoryKey: 'funding-goal' })
      expect(memory.content).toEqual({ scopeId })
      expect(await getMemories(db, { scopeId })).toHaveLength(1)
    }
    expect(await deleteMemory(db, { scopeId: null, memoryKey: 'funding-goal' })).toEqual({ deleted: true })
    expect(await getMemory(db, { memoryKey: 'funding-goal' })).toBeNull()
    expect(await getMemories(db, { scopeId: '' })).toHaveLength(1)
    expect(await getMemories(db, { scopeId: 'profile-1' })).toHaveLength(1)
  } finally { db.close() }
})
