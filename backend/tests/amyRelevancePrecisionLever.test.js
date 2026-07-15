import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

import {
  applyGenericTitleAdditions,
  revertGenericTitleAdditions,
  readGenericTitleAdditions,
  persistGenericTitleAdditions,
  hydrateGenericTitleAdditions,
  KV_KEY,
} from '../services/amy/relevanceVocabularyEditor.js'
import { setGenericTitleAdditions, isGenericTitle } from '../config/genericTitleVocabulary.js'

// The vocabulary is a process-global live mirror — always reset it.
afterEach(() => setGenericTitleAdditions([]))

const SCHEMA_PATH = path.resolve(process.cwd(), 'backend', 'db', 'schema.sql')
function createDb() {
  const db = new Database(':memory:')
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
  return db
}

describe('relevanceVocabularyEditor — apply / revert / persist / hydrate', () => {
  it('applies additively and reverts exactly', async () => {
    expect(isGenericTitle('Statewide Benefits Lookup')).toBe(false)
    const applied = await applyGenericTitleAdditions(['statewide benefits lookup'])
    expect(applied.applied).toBe(true)
    expect(applied.from).toEqual([])
    expect(isGenericTitle('Statewide Benefits Lookup')).toBe(true)
    expect(isGenericTitle('Funding Finder')).toBe(true) // baseline never removed

    await revertGenericTitleAdditions(applied.from)
    expect(readGenericTitleAdditions()).toEqual([])
    expect(isGenericTitle('Statewide Benefits Lookup')).toBe(false)
    expect(isGenericTitle('Funding Finder')).toBe(true)
  })

  it('rejects a phrase list that sanitizes to nothing rather than clearing the vocabulary', async () => {
    const res = await applyGenericTitleAdditions(['a', '<script>', '   '])
    expect(res.applied).toBe(false)
    expect(res.reason).toBe('no_valid_phrases')
  })

  it('survives a redeploy: persisted to system_kv and hydrated back on boot', async () => {
    const db = createDb()
    try {
      await applyGenericTitleAdditions(['statewide benefits lookup'], { db })
      const row = db.prepare('SELECT value FROM system_kv WHERE key = ?').get(KV_KEY)
      expect(JSON.parse(row.value)).toEqual(['statewide benefits lookup'])

      // Simulate a restart: live mirror wiped, then boot hydration.
      setGenericTitleAdditions([])
      expect(isGenericTitle('Statewide Benefits Lookup')).toBe(false)
      const hydrated = await hydrateGenericTitleAdditions(db)
      expect(hydrated).toEqual(['statewide benefits lookup'])
      expect(isGenericTitle('Statewide Benefits Lookup')).toBe(true)
    } finally { db.close() }
  })

  it('persist is a no-op without a db and never throws', async () => {
    await expect(persistGenericTitleAdditions(null)).resolves.toBe(false)
  })
})
