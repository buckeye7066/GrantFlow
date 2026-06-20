/**
 * Recall + precision tests for the targeted "stop silently dropping legitimate
 * student aid" fixes. These prove the bounded recall fixes work WITHOUT
 * re-introducing junk:
 *
 *   (a) A loosely-tagged TN student profile gets TN HOPE + Pell as eligible
 *       (REVIEW/ACCEPT, NOT REJECT), AND a curated/trusted aid row scoring
 *       40–54 SAVES (passes the trusted floor) and is NOT purged by the boot
 *       sweep.
 *   (b) A clearly non-student nonprofit/business profile still does NOT get
 *       student scholarships (the hard REJECT is preserved — precision).
 *   (c) A missing-state profile is NOT state-REJECTed, but a known-DIFFERENT
 *       state profile still is.
 *   (d) Two distinct rows sharing a title with an EMPTY funder are NOT merged
 *       by the dedup invariant (no false-duplicate recall loss).
 *
 * Uses in-memory better-sqlite3 (sync handle is a valid stand-in for the async
 * prod wrapper — awaiting a non-promise resolves to its value), matching the
 * convention of saveToProfilePipelineGates.test.js / enforceInvariants.test.js.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { computeMatchDecision } from '../services/matchEngine.js'
import { saveToProfilePipeline } from '../services/opportunityMatcher.js'
import { enforceRelevanceFloor, __resetFloorCache } from '../startup/enforceInvariants.js'
import {
  RELEVANCE_FLOOR,
  TRUSTED_RELEVANCE_FLOOR,
  TRUSTED_RECORD_ORIGINS,
  isTrustedRecordOrigin,
} from '../config/relevanceFloor.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A loosely-tagged TN student: NO explicit is_student boolean, but the profile
// is obviously student-adjacent (TN state, education section with a school +
// field of study, young-adult age, student-aid need). This is exactly the kind
// of profile that used to get HARD-REJECTED off student aid.
const looseTnStudent = {
  profile: {
    id: 'p-student',
    state: 'TN',
    age: 19,
    needs: ['education', 'student_aid'],
  },
  sections: {
    education_information: {
      answers: {
        school_name: 'Middle Tennessee State University',
        field_of_study: 'Nursing',
        highest_level: 'high school',
      },
    },
  },
}

// TN HOPE (state student-only aid, explicitly requires student status).
const tnHope = {
  id: 'opp-hope',
  title: 'Tennessee HOPE Scholarship',
  description: 'Lottery-funded scholarship for enrolled Tennessee students pursuing an undergraduate degree.',
  sponsor: 'Tennessee Student Assistance Corporation',
  state: 'TN',
  requires_student: true,
  url: 'https://www.tn.gov/collegepays/hope',
  record_origin: 'curated_catalog',
  source: 'scholarship_crawler',
}

// Pell (federal student aid, requires student status).
const pellGrant = {
  id: 'opp-pell',
  title: 'Federal Pell Grant',
  description: 'Need-based federal student aid for undergraduate students; cost of attendance, FAFSA required.',
  sponsor: 'U.S. Department of Education',
  is_national: true,
  requires_student: true,
  url: 'https://studentaid.gov/pell',
  record_origin: 'grants_gov',
  source: 'grants_gov',
}

// A clearly NON-student org: a nonprofit with no education signal whatsoever.
const nonprofitProfile = {
  profile: {
    id: 'p-nonprofit',
    state: 'TN',
    organization_type: 'nonprofit',
    entity_type: 'nonprofit',
    is_nonprofit: true,
    needs: ['operating_support'],
  },
  sections: null,
}

// ---------------------------------------------------------------------------
// (a) Recall: loosely-tagged TN student → student aid is eligible, not REJECT
// ---------------------------------------------------------------------------

describe('(a) loosely-tagged TN student gets student aid as eligible (not REJECT)', () => {
  it('TN HOPE is REVIEW/ACCEPT (not REJECT) for a student-adjacent profile', () => {
    const d = computeMatchDecision(looseTnStudent.profile, tnHope, {
      profileSections: looseTnStudent.sections,
    })
    expect(d.decision).not.toBe('REJECT')
    expect(['REVIEW', 'ACCEPT']).toContain(d.decision)
    expect(d.eligible).not.toBe(false)
  })

  it('Pell is REVIEW/ACCEPT (not REJECT) for a student-adjacent profile', () => {
    const d = computeMatchDecision(looseTnStudent.profile, pellGrant, {
      profileSections: looseTnStudent.sections,
    })
    expect(d.decision).not.toBe('REJECT')
    expect(['REVIEW', 'ACCEPT']).toContain(d.decision)
    expect(d.eligible).not.toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (a) Recall: a trusted aid row scoring 40–54 SAVES via the trusted floor
// ---------------------------------------------------------------------------

function makeSaveDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, organization_id TEXT);
    CREATE TABLE funding_opportunities (id TEXT PRIMARY KEY, title TEXT, record_origin TEXT);
    CREATE TABLE exclusion_rules (id TEXT PRIMARY KEY, action TEXT);
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      organization_id TEXT,
      profile_id TEXT,
      funding_opportunity_id TEXT,
      title TEXT NOT NULL,
      funder TEXT,
      status TEXT DEFAULT 'discovered',
      deadline TEXT,
      match_score INTEGER,
      match_reasons TEXT,
      notes TEXT,
      application_url TEXT,
      application_method TEXT,
      contact_name TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      amount_requested TEXT,
      amount_min TEXT,
      amount_max TEXT,
      url TEXT,
      fingerprint TEXT,
      fingerprint_version INTEGER
    );
  `)
  raw.prepare('INSERT INTO profiles (id, organization_id) VALUES (?, ?)').run('p-student', 'org1')
  return raw
}

describe('(a) trusted student aid scoring 40–54 SAVES via the trusted floor', () => {
  it('saves a trusted-origin aid row scored below 55 but at/above 40', async () => {
    const db = makeSaveDb()
    // Score deliberately in the dead zone the student-aid caps produce: below
    // the 55 insert floor, at/above the 40 trusted floor.
    const score = 45
    expect(score).toBeLessThan(RELEVANCE_FLOOR)
    expect(score).toBeGreaterThanOrEqual(TRUSTED_RELEVANCE_FLOOR)

    const res = await saveToProfilePipeline(
      db,
      tnHope,
      'p-student',
      looseTnStudent,
      score, // explicit match% so we exercise the THRESHOLD gate deterministically
      0, // caller relaxed its own threshold (the crawler-quota case)
    )

    expect(res.saved).toBe(true)
    expect(res.threshold).toBe(TRUSTED_RELEVANCE_FLOOR)
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM grants').get().n)).toBe(1)
  })

  it('still BLOCKS an UNTRUSTED open-web aid row at the same below-55 score', async () => {
    const db = makeSaveDb()
    const untrusted = { ...tnHope, id: 'opp-openweb', record_origin: 'live_crawl' }
    const res = await saveToProfilePipeline(db, untrusted, 'p-student', looseTnStudent, 45, 0)
    expect(res.saved).toBe(false)
    expect(res.gate).toBe('THRESHOLD')
    expect(res.threshold).toBe(RELEVANCE_FLOOR)
  })
})

// ---------------------------------------------------------------------------
// (a) Recall: trusted aid below 55 is NOT purged by the boot sweep
// ---------------------------------------------------------------------------

function makePurgeDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, organization_id TEXT);
    CREATE TABLE funding_opportunities (id TEXT PRIMARY KEY, record_origin TEXT);
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      organization_id TEXT,
      profile_id TEXT,
      funding_opportunity_id TEXT,
      title TEXT NOT NULL,
      funder TEXT,
      status TEXT DEFAULT 'discovered',
      match_score INTEGER,
      fingerprint TEXT,
      deadline TEXT,
      url TEXT,
      application_url TEXT,
      amount_requested TEXT
    );
  `)
  raw.prepare('INSERT INTO profiles (id, organization_id) VALUES (?, ?)').run('p-student', 'org1')
  return raw
}

describe('(a) boot purge exempts trusted-origin aid below the floor', () => {
  beforeEach(() => {
    __resetFloorCache()
    delete process.env.ENFORCE_RELEVANCE_FLOOR
  })

  it('does NOT purge a trusted-origin aid row scoring below the lenient floor', async () => {
    const db = makePurgeDb()
    db.prepare('INSERT INTO funding_opportunities (id, record_origin) VALUES (?, ?)').run('fo-hope', 'curated_catalog')
    // Trusted aid at a clearly-low 30 (below the lenient 50 purge floor) — would
    // be purged if untrusted, but the trusted-origin exemption protects it.
    db.prepare(
      `INSERT INTO grants (id, profile_id, organization_id, funding_opportunity_id, title, match_score, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('g-hope', 'p-student', 'org1', 'fo-hope', 'Tennessee HOPE Scholarship', 30, 'discovered')
    // A genuine untrusted junk row alongside (no FK → no trusted origin).
    db.prepare(
      `INSERT INTO grants (id, profile_id, organization_id, title, match_score, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('g-junk', 'p-student', 'org1', 'Random low-score row', 30, 'discovered')

    const res = await enforceRelevanceFloor(db)
    expect(res.ok).toBe(true)
    expect(res.repaired).toBe(1) // only the untrusted junk
    expect(res.trustedExempt).toBe(1) // the trusted aid was exempted
    const surviving = db.prepare('SELECT id FROM grants ORDER BY id').all().map((r) => r.id)
    expect(surviving).toEqual(['g-hope'])
  })
})

// ---------------------------------------------------------------------------
// (b) Precision: a clearly non-student org still does NOT get scholarships
// ---------------------------------------------------------------------------

describe('(b) precision — non-student org still REJECTED for student-only aid', () => {
  it('TN HOPE is REJECT for a nonprofit with no education signal', () => {
    const d = computeMatchDecision(nonprofitProfile.profile, tnHope, {
      profileSections: nonprofitProfile.sections,
    })
    expect(d.decision).toBe('REJECT')
    expect(d.eligible).toBe(false)
  })

  it('Pell is REJECT for a business with no education signal', () => {
    const business = {
      profile: {
        id: 'p-biz',
        state: 'TN',
        entity_type: 'business',
        is_business: true,
        needs: ['working_capital'],
      },
      sections: null,
    }
    const d = computeMatchDecision(business.profile, pellGrant, {
      profileSections: business.sections,
    })
    expect(d.decision).toBe('REJECT')
    expect(d.eligible).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (c) Missing state = neutral; known-different state = REJECT
// ---------------------------------------------------------------------------

describe('(c) state-exclusivity: missing = neutral, known-different = REJECT', () => {
  // A TN-residents-only opportunity (not student-gated so we isolate the geo arm).
  const tnResidentsOnly = {
    id: 'opp-tn-res',
    title: 'Tennessee Emergency Relief Fund',
    description: 'Emergency assistance for Tennessee residents only.',
    sponsor: 'TN Relief',
    state: 'TN',
    url: 'https://tn.gov/relief',
  }

  it('does NOT REJECT when the profile state is missing/unresolved', () => {
    const noState = { id: 'p-nostate', needs: ['emergency'] }
    const d = computeMatchDecision(noState, tnResidentsOnly, {})
    expect(d.decision).not.toBe('REJECT')
  })

  it('STILL REJECTs when the profile state is known and DIFFERENT', () => {
    const txProfile = { id: 'p-tx', state: 'TX', needs: ['emergency'] }
    const d = computeMatchDecision(txProfile, tnResidentsOnly, {})
    expect(d.decision).toBe('REJECT')
    expect(d.eligible).toBe(false)
  })

  it('normalizes "Tennessee" → "TN" so a same-state resident is not rejected', () => {
    const tnLong = { id: 'p-tnlong', state: 'Tennessee', needs: ['emergency'] }
    const d = computeMatchDecision(tnLong, tnResidentsOnly, {})
    expect(d.decision).not.toBe('REJECT')
  })
})

// ---------------------------------------------------------------------------
// (d) Dedup invariant does NOT merge distinct rows sharing a title w/ empty funder
// ---------------------------------------------------------------------------

import { enforceNoDuplicateGrants } from '../startup/enforceInvariants.js'

function makeDedupeDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, organization_id TEXT);
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      organization_id TEXT,
      profile_id TEXT,
      funding_opportunity_id TEXT,
      title TEXT NOT NULL,
      funder TEXT,
      status TEXT DEFAULT 'discovered',
      match_score INTEGER,
      fingerprint TEXT,
      deadline TEXT,
      url TEXT,
      application_url TEXT,
      amount_requested TEXT
    );
  `)
  raw.prepare('INSERT INTO profiles (id, organization_id) VALUES (?, ?)').run('p1', 'org1')
  return raw
}

describe('(d) dedup does NOT collapse distinct rows sharing a title with empty funder', () => {
  it('keeps two same-title, empty-funder rows separate (no false-duplicate merge)', async () => {
    const db = makeDedupeDb()
    // Same title, EMPTY funder, different programs (different urls/deadlines). The
    // weak title+funder key must NOT fire without a non-empty funder + corroborator.
    db.prepare(
      `INSERT INTO grants (id, profile_id, organization_id, title, funder, status, match_score, deadline, url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('d1', 'p1', 'org1', 'Community Grant', '', 'discovered', 80, '2026-01-01', 'https://a.example.org/x')
    db.prepare(
      `INSERT INTO grants (id, profile_id, organization_id, title, funder, status, match_score, deadline, url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('d2', 'p1', 'org1', 'Community Grant', '', 'discovered', 80, '2027-06-15', 'https://b.example.org/y')

    const res = await enforceNoDuplicateGrants(db)
    expect(res.duplicatesRemoved).toBe(0)
    const surviving = db.prepare('SELECT id FROM grants ORDER BY id').all().map((r) => r.id)
    expect(surviving).toEqual(['d1', 'd2'])
  })

  it('still merges when funder is non-empty AND a field corroborates (real duplicate)', async () => {
    const db = makeDedupeDb()
    db.prepare(
      `INSERT INTO grants (id, profile_id, organization_id, title, funder, status, match_score, url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('e1', 'p1', 'org1', 'Health Fund', 'HRSA', 'discovered', 80, 'https://hrsa.gov/fund')
    db.prepare(
      `INSERT INTO grants (id, profile_id, organization_id, title, funder, status, match_score, url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('e2', 'p1', 'org1', 'health FUND', 'hrsa', 'discovered', 80, 'https://hrsa.gov/fund')

    const res = await enforceNoDuplicateGrants(db)
    expect(res.duplicatesRemoved).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Sanity: the trusted-origin allowlist + floors are wired as specified
// ---------------------------------------------------------------------------

describe('trusted-origin config', () => {
  it('exposes the canonical trusted set and floors', () => {
    expect(TRUSTED_RELEVANCE_FLOOR).toBeLessThanOrEqual(RELEVANCE_FLOOR)
    for (const o of ['curated_catalog', 'scholarship_crawler', 'scholarships', 'grants_gov', 'verified_real', 'school_portal']) {
      expect(TRUSTED_RECORD_ORIGINS).toContain(o)
      expect(isTrustedRecordOrigin(o)).toBe(true)
    }
    expect(isTrustedRecordOrigin('live_crawl')).toBe(false)
    expect(isTrustedRecordOrigin(null)).toBe(false)
  })
})
