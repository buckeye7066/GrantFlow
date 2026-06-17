/**
 * Unit tests for backend/services/yana/studentFundingPortalLinker.js.
 *
 * Tests the classifier rules in the Yana spec:
 *   - institutional scholarship → scholarship/financial_aid
 *   - FAFSA / work-study → financial_aid
 *   - external scholarship → external_application
 *   - unknown source → manual_or_offline
 *   - confidence scoring is stable + explainable
 *   - profile scoping (one student's portals don't bleed into another)
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import {
  classifyFundingPortal,
  linkOpportunityToPortal,
  listFundingPortalLinks,
  _resetLinkSchemaCache,
} from '../../backend/services/yana/studentFundingPortalLinker.js'
import { _resetSchemaCache as _resetPortalCache } from '../../backend/services/yana/studentPortalStore.js'

function makeMemoryDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec('PRAGMA foreign_keys = OFF')
  // Profiles bootstrap so the FK on student_portals.profile_id works.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      display_name TEXT
    );
    INSERT INTO profiles (id, display_name) VALUES ('p-mtsu', 'Anastasia');
    INSERT INTO profiles (id, display_name) VALUES ('p-other', 'Other Student');
  `)
  // Wrap better-sqlite3 to match the "prepare(...).get/all/run" + .exec API.
  return {
    dialect: 'sqlite',
    prepare(sql) {
      const stmt = sqlite.prepare(sql)
      return {
        get: async (...params) => stmt.get(...params),
        all: async (...params) => stmt.all(...params),
        run: async (...params) => {
          const r = stmt.run(...params)
          return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }
        },
      }
    },
    exec(sql) { sqlite.exec(sql) },
    raw: sqlite,
  }
}

function mtsuProfile() {
  return {
    id: 'p-mtsu',
    user_id: 'u-1',
    university_applications: {
      applications: [
        { name: 'Middle Tennessee State University', status: 'committed', committed: true, program: 'Nursing' },
      ],
    },
  }
}

function otherProfile() {
  return {
    id: 'p-other',
    user_id: 'u-2',
    university_applications: { applications: [{ name: 'University of New Haven', status: 'submitted' }] },
  }
}

function instOpp(overrides = {}) {
  return {
    id: 'opp-1',
    title: 'MTSU Presidential Scholarship',
    description: 'A merit scholarship for incoming undergraduates at Middle Tennessee State University.',
    application_url: 'https://www.mtsu.edu/financial-aid/scholarships/',
    funding_source_type: 'university',
    category: 'scholarship',
    ...overrides,
  }
}

function fafsaOpp(overrides = {}) {
  return {
    id: 'opp-2',
    title: 'FAFSA-driven Federal Work-Study at MTSU',
    description: 'Need-based federal work-study available at Middle Tennessee State University. Requires current-year FAFSA.',
    application_url: 'https://www.mtsu.edu/financial-aid/',
    funding_source_type: 'university',
    ...overrides,
  }
}

function externalOpp(overrides = {}) {
  return {
    id: 'opp-3',
    title: 'Going Merry Scholarship Match',
    description: 'A general scholarship marketplace listing — apply through the Going Merry portal.',
    application_url: 'https://www.goingmerry.com/scholarships/example-12345',
    ...overrides,
  }
}

function unknownOpp(overrides = {}) {
  return {
    id: 'opp-4',
    title: 'Mystery Award',
    description: 'No funder name, no school, no application URL.',
    ...overrides,
  }
}

describe('classifyFundingPortal', () => {
  it('institutional scholarship maps to scholarship/financial_aid with high confidence', () => {
    const c = classifyFundingPortal({ profile: mtsuProfile(), opportunity: instOpp() })
    assert.ok(['scholarship', 'financial_aid'].includes(c.portal_type),
      `expected scholarship/financial_aid, got ${c.portal_type}`)
    assert.ok(c.confidence > 0.4, `expected confidence > 0.4, got ${c.confidence}`)
    assert.ok(c.reasons.some((r) => r.key === 'exact_school_name_match' || r.key === 'knownSchools_match'))
  })

  it('FAFSA / work-study maps to financial_aid', () => {
    const c = classifyFundingPortal({ profile: mtsuProfile(), opportunity: fafsaOpp() })
    assert.equal(c.portal_type, 'financial_aid')
    assert.ok(c.requires_user_login, 'financial-aid portals always require user login')
  })

  it('external marketplace scholarship maps to external_application', () => {
    const c = classifyFundingPortal({ profile: mtsuProfile(), opportunity: externalOpp() })
    assert.equal(c.portal_type, 'external_application')
    assert.ok(c.can_yana_attempt === true || c.confidence >= 0.2,
      'Yana should at least be allowed to draft external apps')
  })

  it('unknown opportunity falls back to manual_or_offline + admin review', () => {
    const c = classifyFundingPortal({ profile: mtsuProfile(), opportunity: unknownOpp() })
    assert.equal(c.portal_type, 'manual_or_offline')
    assert.equal(c.requires_admin_review, true)
    assert.equal(c.can_yana_attempt, false)
  })

  it('confidence is stable for identical inputs (deterministic)', () => {
    const a = classifyFundingPortal({ profile: mtsuProfile(), opportunity: instOpp() })
    const b = classifyFundingPortal({ profile: mtsuProfile(), opportunity: instOpp() })
    assert.equal(a.confidence, b.confidence)
    assert.deepEqual(a.reasons.map((r) => r.key), b.reasons.map((r) => r.key))
  })
})

describe('linkOpportunityToPortal — persistence + profile scoping', () => {
  it('persists a link row + auto-creates a student_portals row', async () => {
    _resetPortalCache()
    _resetLinkSchemaCache()
    const db = makeMemoryDb()
    const link = await linkOpportunityToPortal(db, {
      profile: mtsuProfile(),
      profileId: 'p-mtsu',
      opportunity: instOpp(),
    })
    assert.ok(link.link_id, 'link_id returned')
    assert.ok(['scholarship', 'financial_aid'].includes(link.portal_type))
    const links = await listFundingPortalLinks(db, 'p-mtsu')
    assert.equal(links.length, 1)
    assert.equal(links[0].profile_id, 'p-mtsu')
    const portals = db.raw.prepare('SELECT * FROM student_portals WHERE profile_id = ?').all('p-mtsu')
    assert.ok(portals.length >= 1, 'student_portals row created')
  })

  it('duplicate calls are idempotent (no second link row)', async () => {
    _resetPortalCache()
    _resetLinkSchemaCache()
    const db = makeMemoryDb()
    await linkOpportunityToPortal(db, { profile: mtsuProfile(), profileId: 'p-mtsu', opportunity: instOpp() })
    await linkOpportunityToPortal(db, { profile: mtsuProfile(), profileId: 'p-mtsu', opportunity: instOpp() })
    const links = await listFundingPortalLinks(db, 'p-mtsu')
    assert.equal(links.length, 1)
  })

  it('one student\'s portals do NOT leak into another profile', async () => {
    _resetPortalCache()
    _resetLinkSchemaCache()
    const db = makeMemoryDb()
    await linkOpportunityToPortal(db, { profile: mtsuProfile(), profileId: 'p-mtsu', opportunity: instOpp() })
    await linkOpportunityToPortal(db, {
      profile: otherProfile(),
      profileId: 'p-other',
      opportunity: { id: 'opp-other', title: 'New Haven Scholarship', description: 'University of New Haven scholarship.' },
    })
    const a = await listFundingPortalLinks(db, 'p-mtsu')
    const b = await listFundingPortalLinks(db, 'p-other')
    assert.equal(a.length, 1)
    assert.equal(b.length, 1)
    assert.equal(a[0].profile_id, 'p-mtsu')
    assert.equal(b[0].profile_id, 'p-other')
    // p-other shouldn't see MTSU's record
    const all = db.raw.prepare('SELECT profile_id FROM application_portal_links WHERE profile_id = ?').all('p-mtsu')
    assert.equal(all.length, 1)
  })
})
