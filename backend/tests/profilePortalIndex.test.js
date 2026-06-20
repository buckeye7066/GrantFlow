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
      application_method TEXT,
      contact_name TEXT, contact_email TEXT, contact_phone TEXT,
      funder_fax TEXT, funder_address TEXT,
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

  it('returns empty portals + mailFaxSources for a profile with no portals', async () => {
    const out = await getProfilePortals(db, 'p1')
    expect(out).toEqual({ portals: [], mailFaxSources: [] })
  })

  it('derives a funding_source portal from a pipeline grant with an online application_method', async () => {
    db.prepare('INSERT INTO grants (id, profile_id, title, application_url, application_method) VALUES (?, ?, ?, ?, ?)')
      .run('g1', 'p1', 'Gates Grant', 'https://apply.gates.org/forms/123', 'portal')
    const { portals, mailFaxSources } = await getProfilePortals(db, 'p1')
    expect(portals).toHaveLength(1)
    expect(mailFaxSources).toHaveLength(0)
    expect(portals[0].portalHost).toBe('gates.org')
    expect(portals[0].kind).toBe('funding_source')
    expect(portals[0].status).toBe('needs_setup')
    expect(portals[0].loginUrl).toContain('gates.org')
    expect(portals[0].sources[0]).toMatchObject({ title: 'Gates Grant', grantId: 'g1' })
  })

  it('treats a login/apply URL path as a portal even without application_method', async () => {
    db.prepare('INSERT INTO grants (id, profile_id, title, application_url) VALUES (?, ?, ?, ?)')
      .run('g1', 'p1', 'AcademicWorks Award', 'https://foundation.example.org/apply/scholarship')
    const { portals, mailFaxSources } = await getProfilePortals(db, 'p1')
    expect(portals).toHaveLength(1)
    expect(portals[0].portalHost).toBe('example.org')
    expect(mailFaxSources).toHaveLength(0)
  })

  it('classifies a known application platform host as a portal', async () => {
    db.prepare('INSERT INTO grants (id, profile_id, title, application_url) VALUES (?, ?, ?, ?)')
      .run('g1', 'p1', 'Bold Scholarship', 'https://bold.org/scholarships/foo')
    const { portals } = await getProfilePortals(db, 'p1')
    expect(portals).toHaveLength(1)
    expect(portals[0].portalHost).toBe('bold.org')
  })

  it('routes a mail/fax/email source to mailFaxSources (NOT a portal tile)', async () => {
    db.prepare(`INSERT INTO grants
      (id, profile_id, title, application_url, application_method, contact_name, contact_email, contact_phone, funder_fax, funder_address)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('g1', 'p1', 'Smith Family Foundation', 'https://smithfamilyfdn.org', 'mail',
        'Jane Smith', 'grants@smithfamilyfdn.org', '555-1212', '555-3434', '1 Main St, Townville')
    const { portals, mailFaxSources } = await getProfilePortals(db, 'p1')
    expect(portals).toHaveLength(0)
    expect(mailFaxSources).toHaveLength(1)
    const s = mailFaxSources[0]
    expect(s.host).toBe('smithfamilyfdn.org')
    expect(s.applicationMethod).toBe('mail')
    expect(s.grantId).toBe('g1')
    expect(s.url).toBe('https://smithfamilyfdn.org')
    expect(s.contact).toMatchObject({
      name: 'Jane Smith',
      email: 'grants@smithfamilyfdn.org',
      phone: '555-1212',
      fax: '555-3434',
      address: '1 Main St, Townville',
    })
  })

  it('defaults an ambiguous info-only homepage to a mail/fax packet, not a tile', async () => {
    db.prepare('INSERT INTO grants (id, profile_id, title, url) VALUES (?, ?, ?, ?)')
      .run('g1', 'p1', 'Generic Foundation', 'https://genericfdn.org/')
    const { portals, mailFaxSources } = await getProfilePortals(db, 'p1')
    expect(portals).toHaveLength(0)
    expect(mailFaxSources).toHaveLength(1)
    expect(mailFaxSources[0].host).toBe('genericfdn.org')
  })

  it('excludes junk search-engine hosts from both lists', async () => {
    db.prepare('INSERT INTO grants (id, profile_id, title, application_url) VALUES (?, ?, ?, ?)')
      .run('g1', 'p1', 'Junk', 'https://www.google.com/search?q=grants')
    const { portals, mailFaxSources } = await getProfilePortals(db, 'p1')
    expect(portals).toHaveLength(0)
    expect(mailFaxSources).toHaveLength(0)
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
    db.prepare('INSERT INTO grants (id, profile_id, title, application_url, application_method) VALUES (?, ?, ?, ?, ?)')
      .run('g1', 'p1', 'Gates Grant', 'https://apply.gates.org/forms/123', 'portal')
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
    db.prepare('INSERT INTO grants (id, profile_id, title, application_url, application_method) VALUES (?, ?, ?, ?, ?)')
      .run('g1', 'p1', 'Gates Grant', 'https://apply.gates.org/forms/123', 'portal')
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
