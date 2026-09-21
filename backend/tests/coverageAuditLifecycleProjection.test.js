import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { auditProfileResultCoverage } from '../services/coverageAudit/profileResultCoverageAudit.js'

vi.mock('../services/profileHelpers.js', () => ({
  loadProfileContext: async () => ({ profile: { id: 'p', applicant_type: 'individual' }, sections: {} }),
}))

describe('coverage audit reads the persisted lifecycle evidence', () => {
  it.each([0, 1])('does not lose the hidden flag while projecting SQL rows (%s)', async hidden => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE funding_opportunities (
        id TEXT, title TEXT, sponsor TEXT, description TEXT, categories TEXT,
        opportunity_kind TEXT, deadline TEXT, deadline_at TEXT, deadline_type TEXT,
        application_url TEXT, source_url TEXT, evidence_url TEXT, reality_status TEXT,
        is_active INTEGER, is_hidden INTEGER
      );
      CREATE TABLE profile_opportunity_matches (
        profile_id TEXT, opportunity_id TEXT, matcher_version TEXT,
        match_score REAL, match_decision TEXT, match_explain_json TEXT
      );
    `)
    db.prepare("INSERT INTO funding_opportunities(id,title,opportunity_kind,source_url,reality_status,is_active,is_hidden) VALUES('o','Local housing resource','DIRECTORY','https://example.org/housing','directory',1,?)").run(hidden)
    db.prepare("INSERT INTO profile_opportunity_matches VALUES('p','o','crawler-os',3,'review',?)").run(JSON.stringify({
      scoring_policy_version: 'need_first_v2', matchedNeeds: ['housing'], matchedSignals: ['geo:county', 'needs'],
      dataPointEvidence: { total: 60, matched: [{ kind: 'need', value: 'housing', credit: 1 }] },
    }))
    const audit = await auditProfileResultCoverage(db, 'p', {
      thesis: { is_student: false, schools: [], location: {} }, resultTarget: 20,
      applyabilityCtx: { applyableFloor: 3 },
    })
    expect(audit.surfaced_qualifying).toBe(hidden ? 0 : 1)
    db.close()
  })
})
