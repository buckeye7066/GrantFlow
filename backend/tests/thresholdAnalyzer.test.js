/**
 * Guards for the threshold-awareness analyzer (owner rule: users must see what
 * they DO qualify for, what they ALMOST qualify for, exactly what closes the
 * gap, and a link to act). Pins:
 *   - extraction of explicit ACT/SAT/GPA/income/age requirements from real
 *     phrasing (and refusal to extract from noise)
 *   - the motivating case: requirement ACT 29 vs profile ACT 28 → NEAR
 *   - buildThresholdReport buckets pipeline sources into qualified/near/short
 *     and never guesses when a fact or requirement is missing
 *   - buildThresholdTodoCategory emits stable, deep-linkable plan items
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'b'.repeat(64)

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const {
  extractThresholds,
  classifyRequirement,
  buildThresholdReport,
  buildThresholdTodoCategory,
} = await import('../services/eligibility/thresholdAnalyzer.js')

const PID = 'threshold-profile-1'

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.dialect = 'sqlite'
  sqlite.exec(`
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, profile_id TEXT, title TEXT, status TEXT,
      url TEXT, application_url TEXT, funding_opportunity_id TEXT,
      eligibility_summary TEXT, program_description TEXT, selection_criteria TEXT
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, description TEXT,
      eligibility_bullets TEXT, eligibility_json TEXT, application_url TEXT, url TEXT
    );
  `)
  return wrapSqlite(sqlite)
}

function seedFacts(db, { act = '28', gpa = '3.84', income = 12000 } = {}) {
  db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
    .run(PID, 'education', JSON.stringify({ gpa, act_score: act, sat_score: '' }))
  db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
    .run(PID, 'financial_information', JSON.stringify({ household_income: income }))
}

describe('extractThresholds', () => {
  it('parses real scholarship phrasing', () => {
    const text =
      'Incoming freshmen need a minimum 3.5 high school GPA and a 29 ACT score. ' +
      'Household income must not exceed $36,000. Applicants must be at least 17 years old.'
    const reqs = extractThresholds(text)
    const byKind = Object.fromEntries(reqs.map((r) => [r.kind, r.value]))
    expect(byKind.act).toBe(29)
    expect(byKind.gpa).toBe(3.5)
    expect(byKind.income_max).toBe(36000)
    expect(byKind.age_min).toBe(17)
  })

  it('keeps the strictest requirement per kind and ignores out-of-range noise', () => {
    const reqs = extractThresholds('ACT of 22 required; honors track needs 30 ACT. Route 85 ACT bus.')
    const act = reqs.find((r) => r.kind === 'act')
    expect(act.value).toBe(30)
    expect(reqs.filter((r) => r.kind === 'act').length).toBe(1)
  })

  it('returns nothing for text without explicit thresholds (never guesses)', () => {
    expect(extractThresholds('Scholarship for forensic science students in Tennessee.')).toEqual([])
  })
})

describe('classifyRequirement', () => {
  it('ACT 29 needed with 28 on file is NEAR (the motivating case)', () => {
    expect(classifyRequirement({ kind: 'act', value: 29 }, { act: 28 })).toBe('near')
  })
  it('meets / short / unknown behave', () => {
    expect(classifyRequirement({ kind: 'act', value: 29 }, { act: 30 })).toBe('meets')
    expect(classifyRequirement({ kind: 'act', value: 34 }, { act: 28 })).toBe('short')
    expect(classifyRequirement({ kind: 'act', value: 29 }, { act: null })).toBe('unknown')
    expect(classifyRequirement({ kind: 'income_max', value: 36000 }, { income: 12000 })).toBe('meets')
    expect(classifyRequirement({ kind: 'gpa', value: 3.5 }, { gpa: 3.84 })).toBe('meets')
  })
})

describe('buildThresholdReport + buildThresholdTodoCategory', () => {
  let db
  beforeEach(() => {
    db = makeDb()
    seedFacts(db)
  })

  it('buckets sources and emits deep-linkable near-miss plan items', async () => {
    // Near-miss: wants ACT 29 (profile has 28) but GPA 3.5 is met.
    db.prepare(`INSERT INTO funding_opportunities (id, title, description, application_url) VALUES (?, ?, ?, ?)`)
      .run('opp-1', 'Rhea Centennial Scholarship', 'Minimum 3.5 GPA and a 29 ACT score required.', 'https://honors.mtsu.edu/scholarships/')
    db.prepare(`INSERT INTO grants (id, profile_id, title, status, funding_opportunity_id) VALUES (?, ?, ?, ?, ?)`)
      .run('g-1', PID, 'MTSU Honors Centennial Scholarship', 'discovery', 'opp-1')
    // Qualified: wants ACT 25 + GPA 3.5 — both met.
    db.prepare(`INSERT INTO grants (id, profile_id, title, status, eligibility_summary, application_url) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('g-2', PID, 'Presidential Scholarship', 'interested', 'ACT 25 and GPA of 3.5 required.', 'https://mtsu.edu/financial-aid/')
    // Short: wants ACT 34.
    db.prepare(`INSERT INTO grants (id, profile_id, title, status, eligibility_summary) VALUES (?, ?, ?, ?, ?)`)
      .run('g-3', PID, 'Guaranteed Centennial', 'discovery', 'Requires 34 ACT and 3.5 GPA.')
    // No explicit thresholds → not analyzed.
    db.prepare(`INSERT INTO grants (id, profile_id, title, status, eligibility_summary) VALUES (?, ?, ?, ?, ?)`)
      .run('g-4', PID, 'Community Grant', 'discovery', 'For local students with financial need.')
    // Terminal status → ignored entirely.
    db.prepare(`INSERT INTO grants (id, profile_id, title, status, eligibility_summary) VALUES (?, ?, ?, ?, ?)`)
      .run('g-5', PID, 'Closed Award', 'declined', 'Requires 20 ACT.')

    const report = await buildThresholdReport(db, PID)
    expect(report.facts.act).toBe(28)
    expect(report.facts.sat).toBeNull() // blank field = MISSING fact, never 0
    expect(report.near.map((i) => i.grant_id)).toEqual(['g-1'])
    expect(report.qualified.map((i) => i.grant_id)).toEqual(['g-2'])
    expect(report.short.map((i) => i.grant_id)).toEqual(['g-3'])
    expect(report.no_explicit_thresholds).toBe(1)

    const nearReq = report.near[0].requirements.find((r) => r.kind === 'act')
    expect(nearReq.need).toBe(29)
    expect(nearReq.have).toBe(28)
    expect(report.near[0].link).toBe('https://honors.mtsu.edu/scholarships/')

    const category = await buildThresholdTodoCategory(db, PID)
    expect(category).toBeTruthy()
    expect(category.source).toBe('threshold')
    const item = category.items.find((i) => i.title.includes('MTSU Honors Centennial'))
    expect(item).toBeTruthy()
    expect(item.title).toBe('Almost qualifies: MTSU Honors Centennial Scholarship — needs ACT 29 (has 28)')
    expect(item.link_url).toBe('https://honors.mtsu.edu/scholarships/')
    expect(item.field_key).toBe('act_score')
    expect(item.instructions).toMatch(/retake/i)
  })

  it('returns null category when nothing is near-miss (never an empty section)', async () => {
    db.prepare(`INSERT INTO grants (id, profile_id, title, status, eligibility_summary) VALUES (?, ?, ?, ?, ?)`)
      .run('g-only', PID, 'Presidential', 'discovery', 'ACT 25 and GPA of 3.5 required.')
    const category = await buildThresholdTodoCategory(db, PID)
    expect(category).toBeNull()
  })
})
