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
const express = (await import('express')).default
const request = (await import('supertest')).default
const { saveCredential } = await import('../services/hamilton/hamiltonPortalCredentialService.js')
const { importSession } = await import('../services/hamilton/hamiltonCredentialSessionService.js')
const {
  getProfilePortals,
  preResolveProfilePortals,
  ensureProfilePortalIndexSchema,
  _resetProfilePortalIndexSchemaCache,
} = await import('../services/hamilton/profilePortalIndex.js')
const {
  resolveProcessPortals,
  resolveStateBenefitUrl,
} = await import('../services/hamilton/processPortals.js')
const profilePortalsRouter = (await import('../routes/profilePortals.js')).default

function makeDb() {
  const db = new Database(':memory:')
  // Minimal schema the resolver reads from.
  db.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, display_name TEXT, email TEXT, primary_type TEXT, updated_at DATETIME);
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

// The DERIVED portals only (pipeline grants + colleges + saved identity).
// PROCESS/benefit/school tiles are resolved separately (and tested on their own
// below), so the classification tests here filter them out to assert precisely
// on what the derivation produced.
function derivedOnly(portals) {
  return (portals || []).filter((p) => !p.isProcessPortal)
}

describe('getProfilePortals', () => {
  let db
  beforeEach(async () => {
    _resetProfilePortalIndexSchemaCache()
    db = makeDb()
    db.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run('p1', 'Test Profile')
    await ensureProfilePortalIndexSchema(db)
  })

  it('returns no DERIVED portals + no mailFaxSources for a profile with no pipeline/colleges', async () => {
    const out = await getProfilePortals(db, 'p1')
    // Process/benefit tiles may exist (an individual profile can see SSA/211),
    // but nothing is DERIVED from pipeline/colleges, and there are no mail/fax
    // sources.
    expect(derivedOnly(out.portals)).toEqual([])
    expect(out.mailFaxSources).toEqual([])
  })

  it('derives a funding_source portal from a pipeline grant with an online application_method', async () => {
    db.prepare('INSERT INTO grants (id, profile_id, title, application_url, application_method) VALUES (?, ?, ?, ?, ?)')
      .run('g1', 'p1', 'Gates Grant', 'https://apply.gates.org/forms/123', 'portal')
    const { portals, mailFaxSources } = await getProfilePortals(db, 'p1')
    const derived = derivedOnly(portals)
    expect(derived).toHaveLength(1)
    expect(mailFaxSources).toHaveLength(0)
    expect(derived[0].portalHost).toBe('gates.org')
    expect(derived[0].kind).toBe('funding_source')
    expect(derived[0].status).toBe('needs_setup')
    expect(derived[0].loginUrl).toContain('gates.org')
    expect(derived[0].sources[0]).toMatchObject({ title: 'Gates Grant', grantId: 'g1' })
  })

  it('routes a direct_url online aid program to a portal tile, NOT a mail/fax packet', async () => {
    // FAFSA/TSAC-style aid programs carry application_method 'direct_url' and NO
    // mailing address or fax — they apply ONLINE. Regression: they used to fall
    // through classifyCandidate's "ambiguous" branch to nonportal and were shown
    // as mailable packets (a packet with no address to mail to).
    db.prepare('INSERT INTO grants (id, profile_id, title, application_url, application_method) VALUES (?, ?, ?, ?, ?)')
      .run('g1', 'p1', 'HOPE Scholarship', 'https://www.tn.gov/collegepays/financial-aid/hope.html', 'direct_url')
    const { portals, mailFaxSources } = await getProfilePortals(db, 'p1')
    expect(mailFaxSources).toHaveLength(0)
    const derived = derivedOnly(portals)
    expect(derived).toHaveLength(1)
    expect(derived[0].portalHost).toBe('tn.gov')
    expect(derived[0].sources[0]).toMatchObject({ title: 'HOPE Scholarship', grantId: 'g1' })
  })

  it('treats a login/apply URL path as a portal even without application_method', async () => {
    db.prepare('INSERT INTO grants (id, profile_id, title, application_url) VALUES (?, ?, ?, ?)')
      .run('g1', 'p1', 'AcademicWorks Award', 'https://foundation.example.org/apply/scholarship')
    const { portals, mailFaxSources } = await getProfilePortals(db, 'p1')
    const derived = derivedOnly(portals)
    expect(derived).toHaveLength(1)
    expect(derived[0].portalHost).toBe('example.org')
    expect(mailFaxSources).toHaveLength(0)
  })

  it('classifies a known application platform host as a portal', async () => {
    db.prepare('INSERT INTO grants (id, profile_id, title, application_url) VALUES (?, ?, ?, ?)')
      .run('g1', 'p1', 'Bold Scholarship', 'https://bold.org/scholarships/foo')
    const { portals } = await getProfilePortals(db, 'p1')
    const derived = derivedOnly(portals)
    expect(derived).toHaveLength(1)
    expect(derived[0].portalHost).toBe('bold.org')
  })

  it('routes a mail/fax/email source to mailFaxSources (NOT a portal tile)', async () => {
    db.prepare(`INSERT INTO grants
      (id, profile_id, title, application_url, application_method, contact_name, contact_email, contact_phone, funder_fax, funder_address)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('g1', 'p1', 'Smith Family Foundation', 'https://smithfamilyfdn.org', 'mail',
        'Jane Smith', 'grants@smithfamilyfdn.org', '555-1212', '555-3434', '1 Main St, Townville')
    const { portals, mailFaxSources } = await getProfilePortals(db, 'p1')
    expect(derivedOnly(portals)).toHaveLength(0)
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
    expect(derivedOnly(portals)).toHaveLength(0)
    expect(mailFaxSources).toHaveLength(1)
    expect(mailFaxSources[0].host).toBe('genericfdn.org')
  })

  it('excludes junk search-engine hosts from both lists', async () => {
    db.prepare('INSERT INTO grants (id, profile_id, title, application_url) VALUES (?, ?, ?, ?)')
      .run('g1', 'p1', 'Junk', 'https://www.google.com/search?q=grants')
    const { portals, mailFaxSources } = await getProfilePortals(db, 'p1')
    expect(derivedOnly(portals)).toHaveLength(0)
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
    const derived = derivedOnly(portals)
    expect(derived).toHaveLength(1)
    expect(derived[0].portalHost).toBe('mtsu.edu')
    expect(derived[0].kind).toBe('school')
    // mtsu is a REAL connector → two-way sync supported + friendly label.
    expect(derived[0].supportsTwoWaySync).toBe(true)
    expect(derived[0].connectorId).toBe('mtsu')
    expect(derived[0].sources.length).toBe(2)
  })

  it('suppresses the host-less SCHOOL process tile when a derived tile for the same school exists', async () => {
    // Student profile whose own school is MTSU (drives the host-less school
    // PROCESS tile) AND whose university_applications derive a REAL mtsu.edu
    // tile. Host-keyed dedupe can't see the null-host process tile — the
    // label fallback must collapse them to ONE tile (the derived one wins).
    db.prepare("UPDATE profiles SET primary_type = 'student' WHERE id = 'p1'").run()
    db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
      .run('p1', 'education', JSON.stringify({
        school_name: 'Middle Tennessee State University', currently_enrolled: true,
      }))
    db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
      .run('p1', 'university_applications', JSON.stringify({
        applications: [
          { name: 'Middle Tennessee State University', portals: { student_portal_url: 'https://pipeline.mtsu.edu/login' } },
        ],
      }))
    const { portals } = await getProfilePortals(db, 'p1')
    const mtsuTiles = portals.filter((p) => /middle tennessee|mtsu/i.test(String(p.label)))
    expect(mtsuTiles).toHaveLength(1)
    // The surviving tile is the derived one — real host, not the null-host stub.
    expect(mtsuTiles[0].portalHost).toBe('mtsu.edu')
    // A DIFFERENT school with no derived tile still gets its process tile
    // (the fallback only suppresses actual duplicates).
    const other = await (async () => {
      db.prepare("INSERT INTO profiles (id, display_name, primary_type) VALUES ('p2', 'Other Student', 'student')").run()
      db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
        .run('p2', 'education', JSON.stringify({ school_name: 'Central High School', currently_enrolled: true }))
      return getProfilePortals(db, 'p2')
    })()
    const central = other.portals.filter((p) => /central high/i.test(String(p.label)))
    expect(central).toHaveLength(1)
    expect(central[0].portalHost).toBe(null)
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

  it('a captured session unmasks a pending_registration credential (hasSession not masked by the credential short-circuit)', async () => {
    // The regression: Hamilton auto-provisioned a login here but never finished
    // registration (pending_registration=1), THEN the owner completed a
    // side-by-side login so a valid session exists. hasReadyIdentity used to
    // short-circuit on the credential and report hasSession:false, so the
    // autopilot resolver kept the tile stuck at needs_user / cant-auto-merge —
    // "no evidence it changed anything" even though Hamilton held the session.
    db.prepare('INSERT INTO grants (id, profile_id, title, application_url, application_method) VALUES (?, ?, ?, ?, ?)')
      .run('g1', 'p1', 'Scholarships.com', 'https://scholarships.com/apply', 'portal')
    await saveCredential(db, {
      userId: 'u1', profileId: 'p1', portalHost: 'scholarships.com',
      username: 't@icloud.com', password: 'pw', managedBy: 'hamilton',
    })
    db.prepare('UPDATE hamilton_portal_credentials SET pending_registration = 1 WHERE profile_id = ? AND portal_host = ?')
      .run('p1', 'scholarships.com')

    // Before the side-by-side login: credential yes, session honestly no.
    const before = (await getProfilePortals(db, 'p1')).portals
      .find((p) => p.portalHost === 'scholarships.com')
    expect(before.hasCredential).toBe(true)
    expect(before.hasSession).toBe(false)

    // The owner completes the side-by-side login → a valid session is captured.
    await importSession(db, {
      userId: 'u1', profileId: 'p1', portalHost: 'scholarships.com',
      storageState: { cookies: [{ name: 's', value: 'x', domain: 'scholarships.com', path: '/' }], origins: [] },
      authenticationStrategy: 'imported_session',
      expiresAt: new Date(Date.now() + 14 * 86400_000).toISOString(),
    })

    // After: BOTH flags are reported. The old short-circuit returned
    // hasSession:false whenever a credential matched, hiding the captured
    // session from every consumer that treats a session as stronger evidence
    // than a pending-registration credential.
    const after = (await getProfilePortals(db, 'p1')).portals
      .find((p) => p.portalHost === 'scholarships.com')
    expect(after.hasCredential).toBe(true)
    expect(after.hasSession).toBe(true)
    expect(after.status).toBe('ready')
  })

  it('pre-resolve warms the cache and read works with refresh disabled', async () => {
    db.prepare('INSERT INTO grants (id, profile_id, title, application_url, application_method) VALUES (?, ?, ?, ?, ?)')
      .run('g1', 'p1', 'Gates Grant', 'https://apply.gates.org/forms/123', 'portal')
    const n = await preResolveProfilePortals(db, 'p1')
    expect(n).toBe(1)
    const cached = db.prepare('SELECT * FROM profile_portal_index WHERE profile_id = ?').all('p1')
    expect(cached).toHaveLength(1)
    expect(cached[0].portal_host).toBe('gates.org')
    // With refresh:false the derived (cached) funding portal must still serve
    // from the warmed cache. Filter to the derived portal — process/benefit
    // tiles may co-reside but are resolved separately, not from this cache.
    const { portals } = await getProfilePortals(db, 'p1', { refresh: false })
    const derived = portals.filter((p) => !p.isProcessPortal)
    expect(derived).toHaveLength(1)
    expect(derived[0].loginUrl).toContain('gates.org')
  })
})

// ── PROCESS portals: relevance + geography gating ────────────────────────────
// These exercise the declarative registry directly with synthetic signals so the
// gating logic is verified independent of the full profile-context pipeline.

function ids(tiles) {
  return tiles.map((t) => t.id)
}

describe('resolveProcessPortals — relevance + geo gating', () => {
  it('a STUDENT gets FAFSA + ACT + College Board (national, no state needed)', () => {
    const tiles = resolveProcessPortals({
      applicantType: 'student',
      needs: new Set(),
      location: { state: 'TN' },
    })
    const got = ids(tiles)
    expect(got).toContain('fafsa')
    expect(got).toContain('act')
    expect(got).toContain('collegeboard_sat')
    expect(got).toContain('collegeboard_css')
    // A student is NOT an org → no Grants.gov/SAM.gov.
    expect(got).not.toContain('grants_gov')
    expect(got).not.toContain('sam_gov')
  })

  it('a NON-student individual does NOT get FAFSA/ACT', () => {
    const tiles = resolveProcessPortals({
      applicantType: 'individual',
      needs: new Set(['food']),
      location: { state: 'TN' },
    })
    const got = ids(tiles)
    expect(got).not.toContain('fafsa')
    expect(got).not.toContain('act')
  })

  it('lists the student\'s own high school as a school tile (loginUrl may be null)', () => {
    const tiles = resolveProcessPortals({
      applicantType: 'student',
      needs: new Set(),
      location: { state: 'TN' },
      education: { school_name: 'Central High School' },
    })
    const school = tiles.find((t) => t.kind === 'school')
    expect(school).toBeTruthy()
    expect(school.label).toBe('Central High School')
    // No resolvable portal → tile still shows, loginUrl null.
    expect(school.loginUrl).toBe(null)
  })

  it('shows in-state benefit portals only when the matching need is present', () => {
    const tiles = resolveProcessPortals({
      applicantType: 'family',
      needs: new Set(['food', 'healthcare']),
      location: { state: 'TN' },
    })
    const got = ids(tiles)
    // food → SNAP (TN), healthcare → Medicaid (TN)
    expect(got).toContain('snap:TN')
    expect(got).toContain('medicaid:TN')
    // No utilities/employment need → no LIHEAP/unemployment.
    expect(got).not.toContain('liheap:TN')
    expect(got).not.toContain('unemployment:TN')
    // Each state tile points at the correct state's portal — never another state.
    const snap = tiles.find((t) => t.id === 'snap:TN')
    expect(snap.loginUrl).toContain('tn.gov')
    expect(snap.state).toBe('TN')
  })

  it('NEVER shows another state\'s benefit portal (single-state profile)', () => {
    const tiles = resolveProcessPortals({
      applicantType: 'individual',
      needs: new Set(['food']),
      location: { state: 'OH' },
    })
    const snapTiles = tiles.filter((t) => t.id.startsWith('snap:'))
    expect(snapTiles).toHaveLength(1)
    expect(snapTiles[0].id).toBe('snap:OH')
    expect(snapTiles[0].loginUrl).toContain('ohio.gov')
  })

  it('an OUT-OF-STATE student gets benefit portals for BOTH states (home + school)', () => {
    const tiles = resolveProcessPortals({
      applicantType: 'student',
      needs: new Set(['food']),
      location: { states: ['OH', 'TN'] },
    })
    const snapTiles = tiles.filter((t) => t.id.startsWith('snap:')).map((t) => t.id).sort()
    expect(snapTiles).toEqual(['snap:OH', 'snap:TN'])
    // Still a student → also FAFSA.
    expect(ids(tiles)).toContain('fafsa')
  })

  it('unknown state falls back to a federal benefit finder, never a wrong state', () => {
    expect(resolveStateBenefitUrl('CA', 'snap')).toMatch(/benefits\.gov/i)
    expect(resolveStateBenefitUrl('TN', 'snap')).toMatch(/tn\.gov/i)
    expect(resolveStateBenefitUrl('OH', 'medicaid')).toMatch(/ohio\.gov/i)
  })

  it('a NONPROFIT/ORG gets Grants.gov + SAM.gov and no student/benefit tiles', () => {
    const tiles = resolveProcessPortals({
      applicantType: 'nonprofit',
      needs: new Set(['food']),
      location: { state: 'TN' },
    })
    const got = ids(tiles)
    expect(got).toContain('grants_gov')
    expect(got).toContain('sam_gov')
    expect(got).not.toContain('fafsa')
    // An org is not an individual/family → no SNAP benefit tile.
    expect(got.some((id) => id.startsWith('snap:'))).toBe(false)
  })
})

// ── Packet → Documents: save + status shape ──────────────────────────────────

function makePacketApp(db) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    req.user = { role: 'admin', id: 'admin1' }
    req.ctx = { userId: 'admin1', isAdmin: true }
    next()
  })
  app.use('/api', profilePortalsRouter)
  return app
}

function makePacketDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, display_name TEXT, primary_type TEXT, updated_at DATETIME);
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
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, profile_id TEXT, grant_id TEXT,
      name TEXT, type TEXT, mime_type TEXT, file_size INTEGER,
      extracted_text TEXT, processing_status TEXT, notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_documents (profile_id TEXT, document_id TEXT, PRIMARY KEY (profile_id, document_id));
  `)
  db.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run('p1', 'Test Profile')
  return db
}

describe('POST /api/profiles/:id/portals/packet → Documents + status shape', () => {
  beforeEach(() => { _resetProfilePortalIndexSchemaCache() })

  const source = {
    title: 'Smith Family Foundation',
    grantId: 'g1',
    host: 'smithfamilyfdn.org',
    url: 'https://smithfamilyfdn.org',
    applicationMethod: 'mail',
    contact: { name: 'Jane Smith', email: 'grants@smithfamilyfdn.org', address: '1 Main St' },
  }

  it('saves the packet as a durable Document and returns a documentId', async () => {
    const db = makePacketDb()
    const app = makePacketApp(db)
    const res = await request(app)
      .post('/api/profiles/p1/portals/packet')
      .send({ source, profileName: 'Test Profile' })
    expect(res.status).toBe(200)
    expect(res.body.documentId).toBeTruthy()
    expect(res.body.reused).toBe(false)

    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(res.body.documentId)
    expect(doc.type).toBe('application_packet')
    expect(doc.name).toBe('Smith Family Foundation application packet')
    expect(doc.mime_type).toBe('text/html')
    // The stored copy carries the rendered packet HTML.
    expect(String(doc.extracted_text)).toContain('Application Packet')
    // Durable bytes column was self-healed onto the documents table.
    const cols = db.prepare('PRAGMA table_info(documents)').all().map((c) => c.name)
    expect(cols).toContain('file_bytes')

    // Re-saving the same source re-uses the existing document (idempotent).
    const res2 = await request(app)
      .post('/api/profiles/p1/portals/packet')
      .send({ source, profileName: 'Test Profile' })
    expect(res2.body.documentId).toBe(res.body.documentId)
    expect(res2.body.reused).toBe(true)
  })

  it('bulk: makes one packet per selected source, idempotent on re-run', async () => {
    const db = makePacketDb()
    const app = makePacketApp(db)
    const sources = [
      source,
      { title: 'Doe Trust', grantId: 'g2', host: 'doetrust.org', url: 'https://doetrust.org', applicationMethod: 'fax', contact: { fax: '555-0100' } },
    ]
    const res = await request(app)
      .post('/api/profiles/p1/portals/packets')
      .send({ sources, profileName: 'Test Profile' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.created).toBe(2)
    expect(res.body.reused).toBe(0)
    expect(res.body.failed).toBe(0)
    expect(res.body.results).toHaveLength(2)
    // One application_packet Document per source, linked to the profile.
    const docs = db.prepare("SELECT * FROM documents WHERE type = 'application_packet' ORDER BY name").all()
    expect(docs).toHaveLength(2)
    expect(docs.map((d) => d.name)).toEqual(['Doe Trust application packet', 'Smith Family Foundation application packet'])
    const links = db.prepare('SELECT COUNT(*) AS n FROM profile_documents WHERE profile_id = ?').get('p1')
    expect(Number(links.n)).toBe(2)

    // Re-running reuses both — no duplicate documents.
    const res2 = await request(app)
      .post('/api/profiles/p1/portals/packets')
      .send({ sources, profileName: 'Test Profile' })
    expect(res2.body.created).toBe(0)
    expect(res2.body.reused).toBe(2)
    expect(db.prepare("SELECT COUNT(*) AS n FROM documents WHERE type = 'application_packet'").get().n).toBe(2)
  })

  it('bulk: rejects an empty source list', async () => {
    const db = makePacketDb()
    const app = makePacketApp(db)
    const res = await request(app).post('/api/profiles/p1/portals/packets').send({ sources: [] })
    expect(res.status).toBe(400)
  })

  it('GET portals annotates each mailFaxSource with a packet status shape', async () => {
    const db = makePacketDb()
    const app = makePacketApp(db)
    db.prepare(`INSERT INTO grants
      (id, profile_id, title, url, application_method, contact_name)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run('g1', 'p1', 'Smith Family Foundation', 'https://smithfamilyfdn.org', 'mail', 'Jane Smith')

    // Before saving: packet.generated is false with the full shape present.
    const before = await request(app).get('/api/profiles/p1/portals')
    expect(before.status).toBe(200)
    expect(before.body.mailFaxSources).toHaveLength(1)
    expect(before.body.mailFaxSources[0].packet).toEqual({
      generated: false,
      documentId: null,
      at: null,
    })

    // Save, then the same source reports generated:true + a documentId.
    const saved = await request(app)
      .post('/api/profiles/p1/portals/packet')
      .send({ source, profileName: 'Test Profile' })
    const after = await request(app).get('/api/profiles/p1/portals')
    const pkt = after.body.mailFaxSources[0].packet
    expect(pkt.generated).toBe(true)
    expect(pkt.documentId).toBe(saved.body.documentId)
  })
})
