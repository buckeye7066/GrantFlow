/**
 * Guard for the Profile Action Plan persistence (PrintableProfileTodo).
 *
 * The checklist used to live only in React state — it vanished on reload, so
 * "mark done" was impossible to keep. Now the plan + per-item completion persist
 * in profile_todo_plans. This test pins, against the REAL schema:
 *   1. the table exists with the columns the routes use,
 *   2. generating/regenerating a plan PRESERVES existing completions,
 *   3. toggling an item's completion writes/clears the keyed map entry.
 * It mirrors the exact SQL in backend/routes/ai.js (sqlite branch).
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

const SCHEMA_PATH = path.resolve(process.cwd(), 'backend', 'db', 'schema.sql')

function makeDb() {
  const db = new Database(':memory:')
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
  return db
}

const UPSERT_PLAN = `
  INSERT INTO profile_todo_plans (profile_id, plan, applicant_name, generated_at, updated_at)
  VALUES (?, ?, ?, datetime('now'), datetime('now'))
  ON CONFLICT (profile_id) DO UPDATE SET
    plan = EXCLUDED.plan,
    applicant_name = EXCLUDED.applicant_name,
    generated_at = EXCLUDED.generated_at,
    updated_at = EXCLUDED.updated_at
`

function getRow(db, pid) {
  return db.prepare('SELECT plan, completions, applicant_name FROM profile_todo_plans WHERE profile_id = ?').get(pid)
}

describe('profile_todo_plans persistence', () => {
  it('has the table with the expected columns', () => {
    const db = makeDb()
    const cols = new Set(db.prepare('PRAGMA table_info(profile_todo_plans)').all().map((r) => r.name))
    for (const c of ['profile_id', 'plan', 'completions', 'applicant_name', 'generated_at', 'updated_at']) {
      expect(cols.has(c)).toBe(true)
    }
    db.close()
  })

  it('regenerating the plan preserves existing completions', () => {
    const db = makeDb()
    const pid = 'p1'
    // First generate.
    db.prepare(UPSERT_PLAN).run(pid, JSON.stringify({ categories: [], total_items: 1 }), 'Anastasia')
    // User checks an item off.
    const map = { 'document gathering::gather identification documents': { done: true, doc_id: null, at: 'x' } }
    db.prepare(`UPDATE profile_todo_plans SET completions = ?, updated_at = datetime('now') WHERE profile_id = ?`)
      .run(JSON.stringify(map), pid)
    // Regenerate (new plan body) — completions must survive.
    db.prepare(UPSERT_PLAN).run(pid, JSON.stringify({ categories: [{ name: 'X' }], total_items: 2 }), 'Anastasia')

    const row = getRow(db, pid)
    expect(JSON.parse(row.plan).total_items).toBe(2) // plan updated
    expect(JSON.parse(row.completions)['document gathering::gather identification documents'].done).toBe(true) // kept
    db.close()
  })

  it('toggles a completion on and off', () => {
    const db = makeDb()
    const pid = 'p2'
    db.prepare(UPSERT_PLAN).run(pid, JSON.stringify({ categories: [] }), 'Test')
    const key = 'immediate actions::research potential funding opportunities'

    // mark done
    let map = {}
    map[key] = { done: true, doc_id: 'doc-9', at: 'now' }
    db.prepare(`UPDATE profile_todo_plans SET completions = ? WHERE profile_id = ?`).run(JSON.stringify(map), pid)
    expect(JSON.parse(getRow(db, pid).completions)[key].doc_id).toBe('doc-9')

    // un-mark (delete key)
    delete map[key]
    db.prepare(`UPDATE profile_todo_plans SET completions = ? WHERE profile_id = ?`).run(JSON.stringify(map), pid)
    expect(JSON.parse(getRow(db, pid).completions)[key]).toBeUndefined()
    db.close()
  })
})
