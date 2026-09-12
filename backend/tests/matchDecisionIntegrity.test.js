import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

import { REVIEW_SCORE } from '../config/matchThresholds.js'
import { normalizePersistedMatchDecisionIntegrity } from '../services/matching/matchDecisionIntegrity.js'

function makeDb() {
  const db = new Database(':memory:')
  db.dialect = 'sqlite'
  db.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      opportunity_kind TEXT
    );
    CREATE TABLE profile_opportunity_matches (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      opportunity_id TEXT NOT NULL,
      match_score INTEGER,
      match_decision TEXT,
      match_explain_json TEXT,
      matcher_version TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(profile_id, opportunity_id)
    );
  `)
  return db
}

const positiveProof = {
  direct_funding: true,
  all_passed: true,
  real: {
    passed: true,
    reality_status: 'VERIFIED',
    evidence_url: 'https://funder.example/program',
    evidence_captured_at: '2026-09-03T00:00:00.000Z',
    content_hash_present: true,
  },
  relatable: { passed: true, canonical_decision: 'ACCEPT' },
  meets_profile_need: { passed: true, matched_needs: ['housing'], profile_needs_defaulted: false },
  profile_qualifies: { passed: true, eligibility: 'yes' },
}

function insert(db, {
  id,
  profileId = 'profile-1',
  kind = 'DIRECT',
  score = 10,
  decision = 'accept',
  canonicalDecision = null,
  proof = null,
  matcherVersion = 'crawler-os',
}) {
  db.prepare('INSERT INTO funding_opportunities (id, opportunity_kind) VALUES (?, ?)').run(id, kind)
  db.prepare(`
    INSERT INTO profile_opportunity_matches (
      id, profile_id, opportunity_id, match_score, match_decision,
      match_explain_json, matcher_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    `match-${profileId}-${id}`,
    profileId,
    id,
    score,
    decision,
    canonicalDecision || proof
      ? JSON.stringify({ canonical_decision: canonicalDecision, four_truth_proof: proof })
      : null,
    matcherVersion,
  )
}

function match(db, profileId, opportunityId) {
  return db.prepare(`
    SELECT * FROM profile_opportunity_matches
     WHERE profile_id = ? AND opportunity_id = ?
  `).get(profileId, opportunityId)
}

describe('normalizePersistedMatchDecisionIntegrity', () => {
  it('removes surfaced rejects and below-review resources; canonical reject cannot be relabelled', async () => {
    const db = makeDb()
    insert(db, {
      id: 'persisted-reject',
      decision: 'reject',
      canonicalDecision: 'accept',
      matcherVersion: 'web-llm',
    })
    insert(db, {
      id: 'canonical-reject',
      decision: 'accept',
      canonicalDecision: 'reject',
      matcherVersion: 'crawler-os-xmatch',
    })
    insert(db, {
      id: 'resource-low',
      kind: 'DIRECTORY',
      score: REVIEW_SCORE - 1,
      decision: 'accept',
      matcherVersion: 'web-llm',
    })
    insert(db, {
      id: 'resource-review',
      kind: 'SCHOOL_PORTAL',
      score: REVIEW_SCORE,
      decision: 'accept',
    })
    insert(db, {
      id: 'resource-unscored',
      kind: 'REFERRAL',
      score: null,
      decision: 'accept',
    })
    insert(db, {
      id: 'direct-accept',
      kind: 'DIRECT_GRANT',
      score: 14,
      decision: 'accept',
      proof: positiveProof,
    })
    insert(db, {
      id: 'direct-unproven',
      kind: 'DIRECT_GRANT',
      score: 99,
      decision: 'accept',
    })

    const result = await normalizePersistedMatchDecisionIntegrity(db)

    expect(result).toMatchObject({
      ok: true,
      removed_rejects: 1,
      removed_canonical_rejects: 1,
      removed_unproven_direct_accepts: 1,
      removed_below_review_resources: 1,
      normalized_resources: 2,
      repaired: 6,
    })
    expect(match(db, 'profile-1', 'persisted-reject')).toBeUndefined()
    expect(match(db, 'profile-1', 'canonical-reject')).toBeUndefined()
    expect(match(db, 'profile-1', 'resource-low')).toBeUndefined()
    expect(match(db, 'profile-1', 'resource-review')?.match_decision).toBe('review')
    expect(match(db, 'profile-1', 'resource-unscored')?.match_decision).toBe('review')
    expect(match(db, 'profile-1', 'direct-accept')?.match_decision).toBe('accept')
    expect(match(db, 'profile-1', 'direct-unproven')).toBeUndefined()

    const second = await normalizePersistedMatchDecisionIntegrity(db)
    expect(second).toMatchObject({ ok: true, repaired: 0 })
    db.close()
  })

  it('never deletes a proof-less ACCEPT from a linker/recall lane (2026-09-12 tug-of-war), and converges', async () => {
    const db = makeDb()
    // Same shape as a real `institution_aid_linkage` / `national_assistance_recall`
    // row: ACCEPT, a real (non-pointer) opportunity kind, no four_truth_proof —
    // by design, since these writers never build one (matchExplainPersistence
    // never attaches a proof; only crawler-os/matchEngine + catalogRescoreSweep do).
    insert(db, {
      id: 'institution-accept-no-proof',
      kind: 'DIRECT_GRANT',
      score: 41,
      decision: 'accept',
      matcherVersion: 'institution-link',
    })
    insert(db, {
      id: 'national-assistance-accept-no-proof',
      kind: 'PROGRAM',
      score: 20,
      decision: 'accept',
      matcherVersion: 'national-assistance-link',
    })
    // A non-linker lane (crawler-os) ACCEPT with no proof must still be removed
    // — the exemption is scoped to recall-net lanes, not a general amnesty.
    insert(db, {
      id: 'crawler-os-accept-no-proof',
      kind: 'DIRECT_GRANT',
      score: 55,
      decision: 'accept',
      matcherVersion: 'crawler-os',
    })

    const result = await normalizePersistedMatchDecisionIntegrity(db)

    expect(result.removed_unproven_direct_accepts).toBe(1)
    expect(match(db, 'profile-1', 'institution-accept-no-proof')?.match_decision).toBe('accept')
    expect(match(db, 'profile-1', 'national-assistance-accept-no-proof')?.match_decision).toBe('accept')
    expect(match(db, 'profile-1', 'crawler-os-accept-no-proof')).toBeUndefined()

    // CONVERGENCE GUARD: a second pass over the same DB must repair nothing —
    // the linker-lane rows must not be re-flagged, re-deleted, or re-inserted.
    const second = await normalizePersistedMatchDecisionIntegrity(db)
    expect(second).toMatchObject({ ok: true, repaired: 0 })
    expect(match(db, 'profile-1', 'institution-accept-no-proof')?.match_decision).toBe('accept')
    expect(match(db, 'profile-1', 'national-assistance-accept-no-proof')?.match_decision).toBe('accept')
    db.close()
  })

  it('is profile-scoped and includes the web-llm surfaced lane', async () => {
    const db = makeDb()
    insert(db, {
      id: 'p1-web-reject',
      profileId: 'profile-1',
      decision: 'reject',
      matcherVersion: 'web-llm',
    })
    insert(db, {
      id: 'p2-web-reject',
      profileId: 'profile-2',
      decision: 'reject',
      matcherVersion: 'web-llm',
    })

    const result = await normalizePersistedMatchDecisionIntegrity(db, { profileId: 'profile-1' })

    expect(result).toMatchObject({ ok: true, profile_count: 1, removed_rejects: 1 })
    expect(match(db, 'profile-1', 'p1-web-reject')).toBeUndefined()
    expect(match(db, 'profile-2', 'p2-web-reject')).toBeDefined()
    db.close()
  })

  it('degrades safely when the match schema is unavailable', async () => {
    const db = new Database(':memory:')
    db.dialect = 'sqlite'
    const result = await normalizePersistedMatchDecisionIntegrity(db)
    expect(result).toMatchObject({ ok: false, reason: 'schema_unavailable', repaired: 0 })
    db.close()
  })
})
