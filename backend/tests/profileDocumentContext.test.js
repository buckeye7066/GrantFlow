import { it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { loadProfileContext } from '../services/profileHelpers.js'

it('loads uploaded document evidence from the canonical schema without an uploaded_at column', async () => {
  const db = new Database(':memory:')
  db.dialect = 'sqlite'
  try {
    db.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'))
    db.prepare("INSERT INTO profiles (id, display_name, primary_type) VALUES ('p1', 'Fixture nonprofit', 'nonprofit')").run()
    db.prepare("INSERT INTO documents (id, profile_id, name, type, extracted_text, created_at) VALUES ('d1', 'p1', 'Project needs', 'other', 'Funding needed for equipment and rural community facilities.', '2026-09-08 12:00:00')").run()
    const ctx = await loadProfileContext(db, 'p1')
    expect(ctx.documents).toHaveLength(1)
    expect(ctx.documents[0].id).toBe('d1')
    expect(ctx.documents[0].extracted_text).toContain('rural community facilities')
  } finally { db.close() }
})
