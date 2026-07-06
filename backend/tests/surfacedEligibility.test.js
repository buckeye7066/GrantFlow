/**
 * Tests for surfacedEligibility.reScoreSurfacedIneligible — the general net that
 * demotes currently-surfacing matches the FAITHFUL engine hard-rejects, while
 * leaving REVIEW-band (below-floor) matches alone (recall preservation).
 *
 * Deps (context/thesis/scorer) are injected so the test needs no real
 * loadProfileContext schema or engine.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { reScoreSurfacedIneligible, liveOppToOs } from '../services/coverageAudit/surfacedEligibility.js'

function makeDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, display_name TEXT, status TEXT, deleted_at TEXT);
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, description TEXT, sponsor TEXT, categories TEXT,
      applicant_types TEXT, opportunity_kind TEXT, is_active INTEGER DEFAULT 1,
      is_national INTEGER, state TEXT, amount_min NUMERIC, amount_max NUMERIC
    );
    CREATE TABLE profile_opportunity_matches (
      id TEXT PRIMARY KEY, profile_id TEXT, opportunity_id TEXT,
      match_score REAL, match_decision TEXT, match_explanation TEXT, matcher_version TEXT
    );
  `)
  raw.prepare("INSERT INTO profiles (id, display_name, status) VALUES ('p1','Test Profile','active')").run()
  return raw
}

let seq = 0
function addMatch(db, { title, kind = 'DIRECT_GRANT', score, decision, matcher = 'web-llm' }) {
  seq += 1
  const oid = `o${seq}`; const mid = `m${seq}`
  db.prepare('INSERT INTO funding_opportunities (id,title,opportunity_kind) VALUES (?,?,?)').run(oid, title, kind)
  db.prepare('INSERT INTO profile_opportunity_matches (id,profile_id,opportunity_id,match_score,match_decision,matcher_version) VALUES (?,?,?,?,?,?)')
    .run(mid, 'p1', oid, score, decision, matcher)
  return mid
}

const deps = {
  loadContext: () => ({ profile: { id: 'p1' }, sections: {} }),
  resolveThesis: () => ({ profile_id: 'p1', applicant_types: ['individual'], needs: [], is_student: false }),
}
// Faithful scorer stub: reject titles containing "REJECTME", else review at 68.
const scoreOpp = (osOpp) => ({
  decision: /rejectme/i.test(osOpp.title || '') ? 'reject' : 'review',
  match_score: /rejectme/i.test(osOpp.title || '') ? 0 : 68,
})

describe('reScoreSurfacedIneligible', () => {
  it('demotes a surfacing match the faithful engine rejects', async () => {
    const db = makeDb()
    const mid = addMatch(db, { title: 'Grant REJECTME Program', score: 89, decision: 'accept' })
    const res = await reScoreSurfacedIneligible(db, { ...deps, scoreOpp })
    expect(res.demoted).toBe(1)
    const row = db.prepare('SELECT match_decision, match_score FROM profile_opportunity_matches WHERE id=?').get(mid)
    expect(row.match_decision).toBe('reject')
    // Below the display floor (25, need-anchored scale) so it stops surfacing.
    expect(row.match_score).toBeLessThan(25)
  })

  it('leaves a REVIEW-band (below-floor) match ALONE — recall preserved', async () => {
    const db = makeDb()
    // Surfacing only because of a stale ACCEPT; faithful engine says review@68 (not reject).
    const mid = addMatch(db, { title: 'Legit Community Grant', score: 80, decision: 'accept' })
    const res = await reScoreSurfacedIneligible(db, { ...deps, scoreOpp })
    expect(res.demoted).toBe(0)
    expect(db.prepare('SELECT match_decision FROM profile_opportunity_matches WHERE id=?').get(mid).match_decision).toBe('accept')
  })

  it('never demotes a directory (directories always survive)', async () => {
    const db = makeDb()
    const mid = addMatch(db, { title: 'REJECTME Scholarship Directory', kind: 'DIRECTORY', score: 90, decision: 'accept' })
    const res = await reScoreSurfacedIneligible(db, { ...deps, scoreOpp })
    expect(res.demoted).toBe(0)
    expect(db.prepare('SELECT match_decision FROM profile_opportunity_matches WHERE id=?').get(mid).match_decision).toBe('accept')
  })

  it('ignores a match that is NOT currently surfacing (review below floor already hidden)', async () => {
    const db = makeDb()
    // decision review + score 20 (below the 25 display floor, need-anchored
    // scale) => not surfacing => not a candidate even though scorer would reject.
    addMatch(db, { title: 'REJECTME Buried', score: 20, decision: 'review' })
    const res = await reScoreSurfacedIneligible(db, { ...deps, scoreOpp })
    expect(res.demoted).toBe(0)
  })

  it('count-only when apply:false (no mutation)', async () => {
    const db = makeDb()
    const mid = addMatch(db, { title: 'REJECTME Program', score: 88, decision: 'accept' })
    const res = await reScoreSurfacedIneligible(db, { ...deps, scoreOpp, apply: false })
    expect(res.enforced).toBe(false)
    expect(res.scanned).toBe(1)
    expect(res.demoted).toBe(0)
    expect(db.prepare('SELECT match_decision FROM profile_opportunity_matches WHERE id=?').get(mid).match_decision).toBe('accept')
  })

  it('is idempotent — a second pass demotes nothing', async () => {
    const db = makeDb()
    addMatch(db, { title: 'REJECTME Program', score: 88, decision: 'accept' })
    const first = await reScoreSurfacedIneligible(db, { ...deps, scoreOpp })
    expect(first.demoted).toBe(1)
    const second = await reScoreSurfacedIneligible(db, { ...deps, scoreOpp })
    expect(second.demoted).toBe(0)
  })

  it('scopes to a single profile when profileId is given (per-crawl choke point)', async () => {
    const db = makeDb()
    db.prepare("INSERT INTO profiles (id, display_name, status) VALUES ('p2','Other','active')").run()
    const m1 = addMatch(db, { title: 'REJECTME One', score: 88, decision: 'accept' })
    // A rejectable match on p2 that must NOT be touched when we scope to p1.
    const oid = 'op2'; const m2 = 'mp2'
    db.prepare('INSERT INTO funding_opportunities (id,title,opportunity_kind) VALUES (?,?,?)').run(oid, 'REJECTME Two', 'DIRECT_GRANT')
    db.prepare('INSERT INTO profile_opportunity_matches (id,profile_id,opportunity_id,match_score,match_decision,matcher_version) VALUES (?,?,?,?,?,?)')
      .run(m2, 'p2', oid, 88, 'accept', 'web-llm')
    const res = await reScoreSurfacedIneligible(db, { ...deps, scoreOpp, profileId: 'p1' })
    expect(res.demoted).toBe(1)
    expect(db.prepare('SELECT match_decision FROM profile_opportunity_matches WHERE id=?').get(m1).match_decision).toBe('reject')
    // p2 untouched — it was out of scope.
    expect(db.prepare('SELECT match_decision FROM profile_opportunity_matches WHERE id=?').get(m2).match_decision).toBe('accept')
  })

  it('liveOppToOs maps geography, needs, and funding faithfully', () => {
    const os = liveOppToOs({ id: 'x', title: 'T', description: 'D', categories: '["housing"]', is_national: 0, state: 'TN', amount_min: 100, amount_max: 500 })
    expect(os.geography.states).toEqual(['TN'])
    expect(os.geography.national).toBe(false)
    expect(os.need_categories).toEqual(['housing'])
    expect(os.funding.amount_max).toBe(500)
  })

  // The false-demotion class (2026-07-06): live rows never persist the OS
  // applicant_types field; passing [] made the faithful engine treat the
  // opportunity as serving NOBODY and hard-reject at 0, so the sweep demoted
  // REAL eligible matches (NIH Parent STTR for a biotech: reject@0 with []
  // vs review@80 with honest types).
  it('liveOppToOs never emits an empty applicant list: inferred from text, else broad-neutral', () => {
    // Inferable from text: small-business phrasing → business bucket.
    const sbir = liveOppToOs({
      id: 's', title: 'NIH Small Business Technology Transfer Grant (Parent STTR)',
      description: 'For small business concerns partnering with research institutions.',
    })
    expect(sbir.applicant_types.length).toBeGreaterThan(0)
    expect(sbir.applicant_types).not.toEqual([])

    // Nothing inferable: unknown is NEUTRAL ('*'), never a hard exclusion.
    const opaque = liveOppToOs({ id: 'o', title: 'Community Betterment Fund', description: 'Support for local efforts.' })
    expect(opaque.applicant_types.length).toBeGreaterThan(0)

    // A persisted list is passed through untouched.
    const stored = liveOppToOs({ id: 'p', title: 'T', applicant_types: '["veteran"]' })
    expect(stored.applicant_types).toEqual(['veteran'])
  })
})
