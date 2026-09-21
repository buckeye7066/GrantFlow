/**
 * Golden-outcome sentinel (`coverage.goldenOutcomes`) — owner-verified
 * results on REAL profiles must never silently regress (the Gilbert/Kim
 * ECF-lane class: a lane fix verified live, then lost by a later change,
 * with nobody noticing until the owner did).
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { getCheckById } from '../services/sam/samRegistry.js'

const KV_KEY = 'golden_outcome_expectations'
const check = getCheckById('coverage.goldenOutcomes')

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE profiles (id TEXT PRIMARY KEY, display_name TEXT, status TEXT, deleted_at TEXT);
    CREATE TABLE funding_opportunities (id TEXT PRIMARY KEY, title TEXT, source TEXT, opportunity_kind TEXT, source_url TEXT, reality_status TEXT, is_active INTEGER, is_hidden INTEGER);
    CREATE TABLE profile_opportunity_matches (id TEXT PRIMARY KEY, profile_id TEXT, opportunity_id TEXT, matcher_version TEXT, match_score REAL, match_decision TEXT, match_explain_json TEXT);
  `)
  return db
}

const putExpectations = (db, payload) =>
  db.prepare('INSERT OR REPLACE INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)')
    .run(KV_KEY, JSON.stringify(payload), new Date().toISOString())

function seedMatch(db, { profileId, source, oppId }) {
  db.prepare("INSERT OR IGNORE INTO profiles (id, display_name, status) VALUES (?, ?, 'active')")
    .run(profileId, profileId)
  db.prepare('INSERT INTO funding_opportunities (id, title, source) VALUES (?, ?, ?)')
    .run(oppId, `opp ${oppId}`, source)
  db.prepare('INSERT INTO profile_opportunity_matches (id, profile_id, opportunity_id) VALUES (?, ?, ?)')
    .run(`m-${oppId}`, profileId, oppId)
  db.prepare("UPDATE funding_opportunities SET opportunity_kind='DIRECTORY', source_url='https://resources.example.test/housing', reality_status='directory', is_active=1, is_hidden=0 WHERE id=?").run(oppId)
  db.prepare("UPDATE profile_opportunity_matches SET matcher_version='crawler-os', match_score=3, match_decision='review', match_explain_json=? WHERE opportunity_id=?").run(JSON.stringify({ scoring_policy_version:'need_first_v2', matchedNeeds:['housing'], matchedSignals:['geo:county','needs'], dataPointEvidence:{total:60,matched:[{kind:'need',value:'housing',credit:1}]} }),oppId)
}

describe('sam check coverage.goldenOutcomes', () => {
  it('is registered as a non-heavy internal check with high severity', () => {
    expect(check).toBeTruthy()
    expect(check.kind).toBe('internal')
    expect(check.heavy).toBeFalsy()
    expect(check.severityOnFailure).toBe('high')
  })

  it('fails open with no db and skips green when no expectations are recorded yet', async () => {
    expect((await check.run({})).ok).toBe(true)
    const db = makeDb()
    const res = await check.run({ db })
    expect(res.ok).toBe(true)
    expect(res.skipped).toBe(true)
    db.close()
  })

  it('holds green when every golden profile still has its required-source matches', async () => {
    const db = makeDb()
    seedMatch(db, { profileId: 'profile-gilbert', source: 'tn_ecf_choices', oppId: 'o1' })
    seedMatch(db, { profileId: 'profile-kim', source: 'tn_ecf_choices', oppId: 'o2' })
    seedMatch(db, { profileId: 'profile-kim', source: 'state_hcbs_waivers', oppId: 'o3' })
    putExpectations(db, [
      { profile_id: 'profile-gilbert', label: 'Gilbert', require_sources: ['tn_ecf_choices'] },
      { profile_id: 'profile-kim', label: 'Kim', require_sources: ['tn_ecf_choices', 'state_hcbs_waivers'] },
    ])
    const res = await check.run({ db })
    expect(res.ok).toBe(true)
    expect(res.evidence.assertions).toBe(3)
    db.close()
  })

  it('reds with the profile + missing source named when a verified lane regresses', async () => {
    const db = makeDb()
    seedMatch(db, { profileId: 'profile-gilbert', source: 'grants_gov', oppId: 'o1' })
    putExpectations(db, [
      { profile_id: 'profile-gilbert', label: 'Gilbert', require_sources: ['tn_ecf_choices'] },
    ])
    const res = await check.run({ db })
    expect(res.ok).toBe(false)
    expect(res.summary).toContain('Gilbert')
    expect(res.summary).toContain('tn_ecf_choices')
    expect(res.recommended_fix).toBeTruthy()
    db.close()
  })

  it('reds when a golden profile itself disappears or is deactivated', async () => {
    const db = makeDb()
    seedMatch(db, { profileId: 'profile-kim', source: 'tn_ecf_choices', oppId: 'o1' })
    db.prepare("UPDATE profiles SET status = 'archived' WHERE id = 'profile-kim'").run()
    putExpectations(db, [
      { profile_id: 'profile-kim', label: 'Kim', require_sources: ['tn_ecf_choices'] },
    ])
    const res = await check.run({ db })
    expect(res.ok).toBe(false)
    expect(res.summary).toContain('Kim')
    db.close()
  })
})

it.each(['hidden','inactive','rejected','unproven','unsurfaced'])('does not count a %s stored match as verified coverage', async reason => {
  const db=makeDb()
  seedMatch(db,{profileId:'profile-example',source:'resource',oppId:'o1'})
  putExpectations(db,[{profile_id:'profile-example',require_sources:['resource']}])
  if(reason==='hidden') db.prepare('UPDATE funding_opportunities SET is_hidden=1').run()
  if(reason==='inactive') db.prepare('UPDATE funding_opportunities SET is_active=0').run()
  if(reason==='rejected') db.prepare("UPDATE profile_opportunity_matches SET match_decision='reject'").run()
  if(reason==='unproven') db.prepare("UPDATE profile_opportunity_matches SET match_explain_json='{}'").run()
  if(reason==='unsurfaced') db.prepare("UPDATE profile_opportunity_matches SET matcher_version='retired-lane'").run()
  expect((await check.run({db})).ok).toBe(false)
  db.close()
})