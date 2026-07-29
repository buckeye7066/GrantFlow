import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

import { persistRun } from '../services/crawlerOsPersistence.js'

const PROFILE_ID = 'profile-resource-reconcile'

function makeDb() {
  const db = new Database(':memory:')
  db.dialect = 'sqlite'
  db.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      opportunity_kind TEXT,
      canonical_opportunity_key TEXT,
      amount_text TEXT,
      amount_status TEXT,
      amount_confidence REAL
    );

    CREATE TABLE profile_opportunity_matches (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      opportunity_id TEXT NOT NULL,
      match_score REAL,
      match_decision TEXT,
      match_explanation TEXT,
      match_reasons TEXT,
      match_explain_json TEXT,
      matcher_version TEXT,
      source_query TEXT,
      discovered_via TEXT,
      computed_at DATETIME,
      updated_at DATETIME,
      evaluated_at DATETIME
    );
    CREATE UNIQUE INDEX idx_pom_profile_opp
      ON profile_opportunity_matches(profile_id, opportunity_id);

    CREATE TABLE opportunity_sources (
      opportunity_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      external_id TEXT,
      apply_url TEXT,
      first_seen_at DATETIME,
      last_seen_at DATETIME,
      PRIMARY KEY (opportunity_id, source_id)
    );

    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      funding_opportunity_id TEXT,
      status TEXT,
      fingerprint TEXT,
      title TEXT,
      funder TEXT,
      deadline TEXT,
      url TEXT,
      application_url TEXT
    );

    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      last_discovery_at DATETIME
    );
    INSERT INTO profiles (id) VALUES ('${PROFILE_ID}');
  `)
  return db
}

function memStore(matches = []) {
  return {
    all(table) {
      if (table === 'profile_opportunity_matches') return matches
      return []
    },
  }
}

function seedOpportunity(db, id, kind) {
  db.prepare(
    'INSERT INTO funding_opportunities (id, title, opportunity_kind) VALUES (?, ?, ?)',
  ).run(id, `Opportunity ${id}`, kind)
}

function seedMatch(db, {
  opportunityId,
  score = 9,
  decision = 'review',
  matcherVersion = 'crawler-os',
}) {
  db.prepare(`
    INSERT INTO profile_opportunity_matches (
      id, profile_id, opportunity_id, match_score, match_decision,
      match_explanation, match_reasons, match_explain_json, matcher_version,
      computed_at, updated_at, evaluated_at
    ) VALUES (?, ?, ?, ?, ?, ?, '[]', '{}', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    `${PROFILE_ID}:${opportunityId}`,
    PROFILE_ID,
    opportunityId,
    score,
    decision,
    `Seeded ${decision} match`,
    matcherVersion,
  )
}

function currentMatches(db) {
  return db.prepare(`
    SELECT opportunity_id, match_score, match_decision, matcher_version
      FROM profile_opportunity_matches
     WHERE profile_id = ?
     ORDER BY opportunity_id
  `).all(PROFILE_ID)
}

describe('Crawler OS resource-preserving reconciliation', () => {
  it('preserves omitted resources while replacing stale direct-funding matches', async () => {
    const db = makeDb()
    try {
      const resourceKinds = ['DIRECTORY', 'REFERRAL', 'SCHOOL_PORTAL', 'PAST_AWARD_INTEL']
      for (const kind of resourceKinds) {
        const id = `resource-${kind.toLowerCase()}`
        seedOpportunity(db, id, kind)
        seedMatch(db, { opportunityId: id })
      }

      seedOpportunity(db, 'direct-stale', 'DIRECT_GRANT')
      seedMatch(db, { opportunityId: 'direct-stale', score: 17 })
      seedOpportunity(db, 'direct-current', 'DIRECT_GRANT')

      await persistRun(
        db,
        memStore([{
          profile_id: PROFILE_ID,
          opportunity_id: 'direct-current',
          match_score: 22,
          decision: 'review',
          match_explain_json: JSON.stringify({ why: 'Current direct match', matched_needs: ['housing'] }),
        }]),
        {},
        { primaryProfileId: PROFILE_ID },
      )

      const matches = currentMatches(db)
      const ids = matches.map((row) => row.opportunity_id)

      expect(ids).toContain('direct-current')
      expect(ids).not.toContain('direct-stale')
      for (const kind of resourceKinds) {
        expect(ids).toContain(`resource-${kind.toLowerCase()}`)
      }
      expect(matches.filter((row) => row.opportunity_id.startsWith('resource-'))).toHaveLength(4)
    } finally {
      db.close()
    }
  })

  it('removes a durable resource when the current run explicitly rejects it', async () => {
    const db = makeDb()
    try {
      seedOpportunity(db, 'resource-rejected', 'REFERRAL')
      seedMatch(db, { opportunityId: 'resource-rejected', matcherVersion: 'crawler-os-xmatch' })

      await persistRun(
        db,
        memStore([{
          profile_id: PROFILE_ID,
          opportunity_id: 'resource-rejected',
          match_score: 0,
          decision: 'reject',
          match_explain_json: JSON.stringify({ why: 'Explicitly irrelevant now', matched_needs: [] }),
        }]),
        {},
        { primaryProfileId: PROFILE_ID },
      )

      expect(currentMatches(db)).toEqual([])
    } finally {
      db.close()
    }
  })
})
