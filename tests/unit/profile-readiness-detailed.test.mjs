import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import {
  computeDetailedReadiness,
  READINESS_CATEGORY_DEFINITIONS,
  __testables,
} from '../../backend/services/profileReadinessService.js'

function makeDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      primary_type TEXT,
      profile_category TEXT,
      state TEXT,
      postal_code TEXT,
      zip TEXT,
      city TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      website TEXT,
      keywords TEXT,
      interests TEXT,
      tags TEXT,
      amount_requested REAL
    );
    CREATE TABLE profile_sections (
      profile_id TEXT,
      section_key TEXT,
      data TEXT
    );
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      profile_id TEXT
    );
  `)
  return wrap(raw)
}

function wrap(raw) {
  return {
    dialect: 'sqlite',
    _raw: raw,
    prepare(sql) {
      const stmt = raw.prepare(sql)
      return {
        get: (...a) => stmt.get(...a),
        all: (...a) => stmt.all(...a),
        run: (...a) => stmt.run(...a),
      }
    },
  }
}

function seed(db, { id = 'p1', primary_type = null, sections = {}, profileExtra = {}, docs = 0 } = {}) {
  const cols = { id, primary_type, ...profileExtra }
  const keys = Object.keys(cols)
  const placeholders = keys.map(() => '?').join(',')
  db._raw
    .prepare(`INSERT INTO profiles (${keys.join(',')}) VALUES (${placeholders})`)
    .run(...keys.map((k) => cols[k]))
  for (const [section_key, data] of Object.entries(sections)) {
    db._raw
      .prepare(`INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)`)
      .run(id, section_key, JSON.stringify(data))
  }
  for (let i = 0; i < docs; i += 1) {
    db._raw.prepare('INSERT INTO documents (id, profile_id) VALUES (?, ?)').run(`d${i}`, id)
  }
  return id
}

test('READINESS_CATEGORY_DEFINITIONS sums to 100', () => {
  const total = READINESS_CATEGORY_DEFINITIONS.reduce((s, c) => s + c.weight, 0)
  assert.equal(total, 100)
})

test('returns score=0/poor when profile is not found', async () => {
  const db = makeDb()
  const result = await computeDetailedReadiness(db, 'missing')
  assert.equal(result.readiness_score, 0)
  assert.equal(result.status, 'poor')
  assert.deepEqual(result.missing_items, ['profile_not_found'])
})

test('empty profile scores poor and lists missing items per category', async () => {
  const db = makeDb()
  seed(db, { id: 'empty' })
  const r = await computeDetailedReadiness(db, 'empty')
  assert.equal(r.profile_id, 'empty')
  assert.ok(r.readiness_score < 35, `expected poor score, got ${r.readiness_score}`)
  assert.equal(r.status, 'poor')
  assert.ok(r.missing_items.length > 5, 'expected several missing items')
  assert.equal(r.categories.length, 10)
  assert.ok(r.recommended_questions.length > 0)
  assert.ok(r.impact_on_matching.length > 0)
})

test('readiness improves as fields are added', async () => {
  const db = makeDb()
  seed(db, {
    id: 'partial',
    primary_type: 'nonprofit',
    profileExtra: { state: 'OH', postal_code: '43215', city: 'Columbus', contact_email: 'a@b.org' },
    sections: {
      programs_services: {
        focus_areas: ['youth', 'literacy'],
        keywords: ['after-school'],
      },
      narrative: {
        mission: 'We provide free after-school literacy programs for low-income children in Columbus.',
        primary_goal: 'expand to second site',
      },
      organization_details: { organization_type: 'nonprofit', tax_status: '501(c)(3)' },
    },
    docs: 1,
  })
  const partial = await computeDetailedReadiness(db, 'partial')
  assert.ok(partial.readiness_score >= 65, `expected good, got ${partial.readiness_score}`)
  assert.ok(['good', 'excellent'].includes(partial.status))

  seed(db, { id: 'empty2' })
  const empty = await computeDetailedReadiness(db, 'empty2')
  assert.ok(partial.readiness_score > empty.readiness_score)
})

test('missing fields appear in missing_items and recommended_questions', async () => {
  const db = makeDb()
  seed(db, {
    id: 'p2',
    primary_type: 'nonprofit',
    profileExtra: { state: null, postal_code: null },
  })
  const r = await computeDetailedReadiness(db, 'p2')
  const locationCategory = r.categories.find((c) => c.key === 'location')
  assert.equal(locationCategory.present, false)
  assert.ok(r.missing_items.some((m) => m.toLowerCase().includes('state') || m.toLowerCase().includes('zip')))
  assert.ok(r.recommended_questions.some((q) => q.toLowerCase().includes('located')))
})

test('individual profiles do not require organization tax status', async () => {
  const db = makeDb()
  seed(db, {
    id: 'indiv',
    primary_type: 'individual',
    profileExtra: { state: 'OH', contact_email: 'a@b.com' },
    sections: {
      narrative: { mission: 'I am a single mother seeking funding for childcare costs to return to school.' },
      programs_services: { focus_areas: ['childcare', 'education'] },
    },
  })
  const r = await computeDetailedReadiness(db, 'indiv')
  const orgStatus = r.categories.find((c) => c.key === 'org_status')
  assert.equal(orgStatus.present, true, 'individual profile should not be penalized for missing tax status')
  assert.ok(orgStatus.earned >= 5)
})

test('organization profiles ARE penalized for missing tax status', async () => {
  const db = makeDb()
  seed(db, {
    id: 'org',
    primary_type: 'nonprofit',
    profileExtra: { state: 'OH' },
    sections: {
      narrative: { mission: 'We do good work in our community for over 20 years.' },
    },
  })
  const r = await computeDetailedReadiness(db, 'org')
  const orgStatus = r.categories.find((c) => c.key === 'org_status')
  assert.equal(orgStatus.present, false)
  assert.equal(orgStatus.earned, 0)
  assert.ok(orgStatus.missing_items.length > 0)
})

test('a fully-filled profile reaches excellent', async () => {
  const db = makeDb()
  seed(db, {
    id: 'full',
    primary_type: 'nonprofit',
    profileExtra: {
      state: 'OH',
      postal_code: '43215',
      city: 'Columbus',
      contact_email: 'team@acme.org',
      contact_phone: '555-1234',
      website: 'https://acme.org',
      amount_requested: 50000,
    },
    sections: {
      basic_information: { city: 'Columbus' },
      programs_services: {
        focus_areas: ['youth', 'literacy'],
        keywords: ['after-school'],
        interests: ['mentoring'],
        eligibility_notes: '501(c)(3), serving Franklin County',
        timeline: 'need funding by Q3 2026',
      },
      narrative: {
        mission:
          'We provide free after-school literacy and mentoring programs for low-income children across Franklin County, with a 12-year track record of serving 1,200+ students annually.',
        primary_goal: 'expand programming to two new schools',
        amount_requested: '$50,000',
        timeline: 'Q3 2026',
      },
      organization_details: { organization_type: 'nonprofit', tax_status: '501(c)(3)' },
      nonprofit_compliance: { tax_exempt_status: '501(c)(3) since 2014' },
    },
    docs: 3,
  })
  const r = await computeDetailedReadiness(db, 'full')
  assert.ok(r.readiness_score >= 85, `expected excellent, got ${r.readiness_score}`)
  assert.equal(r.status, 'excellent')
  assert.equal(r.missing_items.length, 0)
  assert.equal(r.recommended_questions.length, 0)
})

test('statusForScore boundaries', () => {
  const { statusForScore } = __testables
  assert.equal(statusForScore(0), 'poor')
  assert.equal(statusForScore(34), 'poor')
  assert.equal(statusForScore(35), 'needs_work')
  assert.equal(statusForScore(64), 'needs_work')
  assert.equal(statusForScore(65), 'good')
  assert.equal(statusForScore(84), 'good')
  assert.equal(statusForScore(85), 'excellent')
  assert.equal(statusForScore(100), 'excellent')
})

test('handles missing documents table gracefully', async () => {
  const db = makeDb()
  db._raw.exec('DROP TABLE documents')
  seed(db, { id: 'no_docs', primary_type: 'individual', profileExtra: { state: 'OH', contact_email: 'a@b.com' } })
  const r = await computeDetailedReadiness(db, 'no_docs')
  assert.ok(r.readiness_score >= 0)
  const docs = r.categories.find((c) => c.key === 'documents')
  assert.equal(docs.present, false)
})
