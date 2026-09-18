import { afterEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { normalizeProfile, computeProfileFingerprint } from '../services/profileNormalizer.js'
import { computeMatchDecision } from '../services/matchEngine.js'
import { buildPersistedMatchExplain, isStaleMatchExplain, staleMatchExplainSql } from '../services/matching/matchExplainPersistence.js'

const profile = { id: 'school-calendar', primary_type: 'college_student', state: 'TN', needs: ['education'] }
const sections = { education: { is_student: true, high_school_graduation_year: 2027, high_school_county: 'Raleigh', high_school_state: 'WV', high_school_type: 'public' } }
const opportunity = { id: 'school-calendar-award', title: 'Community Education Scholarship', description: 'Scholarships are restricted to graduates of a public high school in Raleigh County.', entity_types_allowed: ['individual'], need_types_supported: ['education'], is_national: true, application_url: 'https://example.org/apply' }
afterEach(() => vi.useRealTimers())

it('changes the profile fingerprint when the graduation completion period changes', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2027-06-30T12:00:00Z'))
  const before = normalizeProfile(profile, sections)
  vi.setSystemTime(new Date('2027-07-01T12:00:00Z'))
  const after = normalizeProfile(profile, sections)
  expect(computeProfileFingerprint(before)).not.toBe(computeProfileFingerprint(after))
})
it('selects an old school-origin decision for refresh after rollover in both JS and SQLite', () => {
  vi.useFakeTimers()
  const db = new Database(':memory:')
  try {
    db.exec('CREATE TABLE matches (match_explain_json TEXT)')
    vi.setSystemTime(new Date('2027-06-30T12:00:00Z'))
    const before = buildPersistedMatchExplain(computeMatchDecision(profile, opportunity, { profileSections: sections }))
    expect(before.school_origin_period).toBe('2027-H1')
    expect(isStaleMatchExplain(before)).toBe(false)
    db.prepare('INSERT INTO matches VALUES (?)').run(JSON.stringify(before))
    // audit:allow dynamic-sql -- canonical predicate with a literal fixture alias; no external input.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM matches m WHERE ${staleMatchExplainSql('m')}`).get().n).toBe(0)
    vi.setSystemTime(new Date('2027-07-01T12:00:00Z'))
    expect(isStaleMatchExplain(before)).toBe(true)
    // audit:allow dynamic-sql -- canonical predicate with a literal fixture alias; no external input.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM matches m WHERE ${staleMatchExplainSql('m')}`).get().n).toBe(1)
    const after = buildPersistedMatchExplain(computeMatchDecision(profile, opportunity, { profileSections: sections }))
    expect(after.school_origin_period).toBe('2027-H2')
    expect(isStaleMatchExplain(after)).toBe(false)
    db.prepare('UPDATE matches SET match_explain_json=?').run(JSON.stringify(after))
    // audit:allow dynamic-sql -- canonical predicate with a literal fixture alias; no external input.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM matches m WHERE ${staleMatchExplainSql('m')}`).get().n).toBe(0)
  } finally { db.close() }
})
