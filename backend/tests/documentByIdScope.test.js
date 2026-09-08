/**
 * A document read by id carries the caller's profile scope in the SQL.
 *
 * Measured in prod 2026-09-07 as an end user: GET /api/documents/:id and
 * /:id/download answered 500 — the tenant guard refused the bare
 * `WHERE id = ?` ("Profile-scoped SELECT on [documents] without required
 * scope predicate") — for the person's OWN documents as much as anyone
 * else's. Only the admin (buckeye7066@gmail.com) may read across profiles.
 * Another profile's document comes back as identity only (id + owner), so
 * the handler's access check answers 403 exactly as before, never a crash,
 * and never the content.
 */
import { describe, it, expect } from 'vitest'
import { loadDocumentForContext } from '../routes/documents.js'

function stubDb(rows) {
  const calls = []
  return {
    calls,
    prepare(sql) {
      return {
        get: (...params) => {
          const norm = sql.replace(/\s+/g, ' ').trim()
          calls.push({ sql: norm, params })
          const id = params[0]
          const scoped = params.slice(1)
          const row = rows.find((r) => r.id === id)
          if (!row) return undefined
          if (scoped.length && !scoped.includes(row.profile_id)) return undefined
          if (norm.startsWith('SELECT id, profile_id')) return { id: row.id, profile_id: row.profile_id }
          return row
        },
      }
    },
  }
}

const rows = [
  { id: 'doc-mine', profile_id: 'p-mine', name: 'my letter' },
  { id: 'doc-theirs', profile_id: 'p-theirs', name: 'their letter' },
]

describe('loadDocumentForContext', () => {
  it('a non-admin reads their own document with the profile predicate in the SQL', async () => {
    const db = stubDb(rows)
    const doc = await loadDocumentForContext({ db, params: { id: 'doc-mine' } }, { isAdmin: false, accessibleProfiles: new Set(['p-mine']) }, '*')
    expect(doc).toMatchObject({ id: 'doc-mine', name: 'my letter' })
    expect(db.calls[0].sql).toContain('profile_id IN (?)')
    expect(db.calls[0].params).toEqual(['doc-mine', 'p-mine'])
  })
  it("another profile's document comes back as identity only, so the handler answers 403 without a crash", async () => {
    const db = stubDb(rows)
    const doc = await loadDocumentForContext({ db, params: { id: 'doc-theirs' } }, { isAdmin: false, accessibleProfiles: new Set(['p-mine']) }, '*')
    expect(doc).toEqual({ id: 'doc-theirs', profile_id: 'p-theirs', __identity_only: true })
    expect(doc.name).toBeUndefined()
  })
  it('a missing document is null, and a caller with no accessible profiles only ever runs the identity read', async () => {
    const db = stubDb(rows)
    const doc = await loadDocumentForContext({ db, params: { id: 'doc-nope' } }, { isAdmin: false, accessibleProfiles: new Set() }, '*')
    expect(doc).toBeNull()
    expect(db.calls).toHaveLength(1)
    expect(db.calls[0].sql.startsWith('SELECT id, profile_id')).toBe(true)
  })
  it('the admin reads across profiles by id alone', async () => {
    const db = stubDb(rows)
    const doc = await loadDocumentForContext({ db, params: { id: 'doc-theirs' } }, { isAdmin: true, accessibleProfiles: new Set() }, '*')
    expect(doc).toMatchObject({ id: 'doc-theirs', name: 'their letter' })
    expect(db.calls[0].sql).toBe('SELECT * FROM documents WHERE id = ?')
  })
})
