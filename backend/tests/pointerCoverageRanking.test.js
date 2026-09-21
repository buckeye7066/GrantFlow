import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { qualifiesForDisplay } from '../config/matchSurfacing.js'
import { normalizePersistedMatchDecisionIntegrity } from '../services/matching/matchDecisionIntegrity.js'
import { computeMatchDecision } from '../services/matchEngine.js'
import { buildPersistedMatchExplain } from '../services/matching/matchExplainPersistence.js'

function pointer(overrides = {}) {
  return { opportunity_kind: 'DIRECTORY', match_decision: 'review', match_score: 3,
    source_url: 'https://resources.example.test/housing', reality_status: 'directory',
    match_explain_json: { scoring_policy_version: 'need_first_v2', matchedNeeds: ['housing'],
      matchedSignals: ['geo:county', 'needs'], dataPointEvidence: { total: 60,
        matched: [{ kind: 'need', value: 'housing', credit: 1 }] } }, ...overrides }
}
describe('resource ranking without keyword inflation', () => {
  it('surfaces an exact-need resource after canonical scoring and evidence serialization', () => {
    const profile = { primary_type: 'individual', state: 'TN', county: 'Bradley', needs: ['housing'],
      interests: Array.from({ length: 60 }, (_, i) => `unrelated interest ${i}`) }
    const opportunity = { opportunity_kind: 'DIRECTORY', title: 'Bradley County housing resources',
      description: 'Bradley County Tennessee residents can find housing assistance through this resource directory.',
      state: 'TN', county: 'Bradley', applicant_types: ['individual'], categories: ['housing'],
      source_url: 'https://resources.example.test/housing', reality_status: 'directory' }
    const decision = computeMatchDecision(profile, opportunity)
    expect(decision.decision).toBe('REVIEW')
    expect(decision.score).toBeLessThan(7)
    expect(qualifiesForDisplay({ ...opportunity, match_decision: decision.decision,
      match_score: decision.score, match_explain_json: JSON.stringify(buildPersistedMatchExplain(decision)) })).toBe(true)
  })
  it('keeps a proved local need resource visible without changing its coverage percentage', () => {
    const row = pointer()
    expect(qualifiesForDisplay(row)).toBe(true)
    expect(row.match_score).toBe(3)
  })
  it.each(['geography', 'need', 'partial', 'rejected', 'expired', 'canonical_reject', 'policy', 'mismatch', 'eligibility'])('does not bypass the %s evidence gate', missing => {
    const row = pointer()
    if (missing === 'geography') row.match_explain_json.matchedSignals = ['needs']
    if (missing === 'need') row.match_explain_json.matchedNeeds = []
    if (missing === 'partial') row.match_explain_json.dataPointEvidence.matched[0].credit = 0.5
    if (missing === 'rejected') row.match_decision = 'reject'
    if (missing === 'expired') row.reality_status = 'expired'
    if (missing === 'canonical_reject') row.match_explain_json.canonical_decision = 'REJECT'
    if (missing === 'policy') delete row.match_explain_json.scoring_policy_version
    if (missing === 'mismatch') row.match_explain_json.dataPointEvidence.matched[0].value = 'medical'
    if (missing === 'eligibility') row.match_explain_json.eligibility_fit = 'no'
    expect(qualifiesForDisplay(row)).toBe(false)
  })
  it.each([false, true])('retains proven resources and preserves concurrent refreshes (%s)', async concurrentRefresh => {
    const db = new Database(':memory:')
    db.dialect = 'sqlite'
    db.exec(`CREATE TABLE funding_opportunities (id TEXT PRIMARY KEY, opportunity_kind TEXT, source_url TEXT, reality_status TEXT);
      CREATE TABLE profile_opportunity_matches (profile_id TEXT, opportunity_id TEXT, match_score REAL, match_decision TEXT,
        match_explain_json TEXT, matcher_version TEXT, updated_at TEXT, UNIQUE(profile_id, opportunity_id));`)
    try {
      for (const [id, row] of [['proved', pointer()], ['unsupported', pointer({ match_explain_json: {} })]]) {
        db.prepare('INSERT INTO funding_opportunities VALUES (?, ?, ?, ?)').run(id, row.opportunity_kind, row.source_url, row.reality_status)
        db.prepare('INSERT INTO profile_opportunity_matches VALUES (?, ?, ?, ?, ?, ?, NULL)').run('synthetic-profile', id, row.match_score, row.match_decision, JSON.stringify(row.match_explain_json), 'crawler-os')
      }
      const connection = { prepare(sql) {
        const statement = db.prepare(sql)
        if (concurrentRefresh && sql.includes('SELECT o.*')) return { all(...params) {
          const selected = statement.all(...params)
          db.prepare('UPDATE profile_opportunity_matches SET match_explain_json = ? WHERE opportunity_id = ?')
            .run(JSON.stringify(pointer().match_explain_json), 'unsupported')
          return selected
        } }
        return statement
      } }
      const result = await normalizePersistedMatchDecisionIntegrity(connection)
      expect(result.ok).toBe(true)
      expect(result.removed_below_review_resources).toBe(concurrentRefresh ? 0 : 1)
      expect(db.prepare('SELECT opportunity_id FROM profile_opportunity_matches ORDER BY opportunity_id').all()).toEqual(
        concurrentRefresh ? [{ opportunity_id: 'proved' }, { opportunity_id: 'unsupported' }] : [{ opportunity_id: 'proved' }],
      )
    } finally { db.close() }
  })
})
