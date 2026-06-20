/**
 * Unit tests for profilePortalIndex.js — the resolver/cache behind the per-
 * profile Portals dashboard (GET /api/profiles/:id/portals).
 *
 * Covers: deriving the portal set from pipeline grants + target colleges +
 * saved credentials, dedup by registrable host, green/red status, the
 * non-generic two-way-sync flag, graceful empty result, and cache pre-resolve.
 */

import { describe, it, expect, beforeEach } from 'vitest'

// Encryption key for the credential service the resolver pulls status from.
process.env.RUNTIME_SECRETS_KEY = 'a'.repeat(64)

const Database = (await import('better-sqlite3')).default
const { saveCredential } = await import('../services/hamilton/hamiltonPortalCredentialService.js')
const {
  getProfilePortals,
  preResolveProfilePortals,
  ensureProfilePortalIndexSchema,
  _resetProfilePortalIndexSchemaCache,
} = await import('../services/hamilton/profilePortalIndex.js')

function makeDb() {
  const db = new Database(':memory:')
  // Minimal schema the resolver reads from.
  db.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, display_name TEXT, email TEXT, updated_at DATETIME);
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, profile_id TEXT, title TEXT,
      application_url TEXT, portal_url TEXT, source_url TEXT, url TEXT,
      funding_opportunity_id TEXT
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, name TEXT,
      application_url TEXT, apply_url TEXT, apply_guidelines_url TEXT
    );
  `)
  return db
}

describe('getProfilePortals', () => {
  let db
  beforeEach(async () => {
    _resetProfilePortalIndexSchemaCache()
    db = makeDb()
    db.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run('p1', 'Test Profile')
    await ensureProfilePortalIndexSchema(db)
  })

  it('returns { portals: [] } for a profile with no portals', async () => {
    const out = await getProfilePortals(db, 'p1')
    expect(out).toEqual({ portals: [] })
  })

  it('derives a funding_source portal from a pipeline grant application_url', async () => {
    db.prepare('INSERT INTO grants (id, profile_id, title, application_url) VALUES (?, ?, ?, ?)')
      .run('g1', 'p1', 'Gates Grant', 'https://apply.gates.org/forms/123')
    const { portals } = await getProfilePortals(db, 'p1')
    expect(portals).toHaveLength(1)
    expect(portals[0].portalHost).toBe('gates.org')
    expect(portals[0].kind).toBe('funding_source')
    expect(portals[0].status).toBe('needs_setup')
    expect(portals[0].loginUrl).toContain('gates.org')
    expect(portals[0].sources[0]).toMatchObject({ title: 'Gates Grant', grantId: 'g1' })
  })

  it('derives a school portal from university_applications and dedups by host', async () => {
    // Two college references on the same registrable host → one portal entry.
    db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
      .run('p1', 'university_applications', JSON.stringify({
        applications: [
          { name: 'MTSU', portals: { student_portal_url: 'https://pipeline.mtsu.edu/login' } },
          { name: 'MTSU Aid', website_url: 'https://www.mtsu.edu/financial-aid' },
        ],
      }))
    const { portals } = await getProfilePortals(db, 'p1')
    expect(portals).toHaveLength(1)
    expect(portals[0].portalHost).toBe('mtsu.edu')
    expect(portals[0].kind).toBe('school')
    // mtsu is a REAL connector → two-way sync supported + friendly label.
    expect(portals[0].supportsTwoWaySync).toBe(true)
    expect(portals[0].connectorId).toBe('mtsu')
    expect(portals[0].sources.length).toBe(2)
  })

  it('marks status ready when the profile holds a credential for the host', async () => {
    db.prepare('INSERT INTO grants (id, profile_id, title, application_url) VALUES (?, ?, ?, ?)')
      .run('g1', 'p1', 'Gates Grant', 'https://apply.gates.org/forms/123')
    await saveCredential(db, {
      userId: 'u1', profileId: 'p1', portalHost: 'gates.org',
      username: 'a@example.com', password: 'pw',
    })
    const { portals } = await getProfilePortals(db, 'p1')
    const gates = portals.find((p) => p.portalHost === 'gates.org')
    expect(gates.status).toBe('ready')
    expect(gates.hasCredential).toBe(true)
  })

  it('pre-resolve warms the cache and read works with refresh disabled', async () => {
    db.prepare('INSERT INTO grants (id, profile_id, title, application_url) VALUES (?, ?, ?, ?)')
      .run('g1', 'p1', 'Gates Grant', 'https://apply.gates.org/forms/123')
    const n = await preResolveProfilePortals(db, 'p1')
    expect(n).toBe(1)
    const cached = db.prepare('SELECT * FROM profile_portal_index WHERE profile_id = ?').all('p1')
    expect(cached).toHaveLength(1)
    expect(cached[0].portal_host).toBe('gates.org')
    // With refresh:false the read must still serve from the warmed cache.
    const { portals } = await getProfilePortals(db, 'p1', { refresh: false })
    expect(portals).toHaveLength(1)
    expect(portals[0].loginUrl).toContain('gates.org')
  })
})
