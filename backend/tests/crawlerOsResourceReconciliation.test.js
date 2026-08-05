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
      match_confidence REAL,
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
  confidence = 64,
  decision = 'review',
  matcherVersion = 'crawler-os',
}) {
  db.prepare(`
    INSERT INTO profile_opportunity_matches (
      id, profile_id, opportunity_id, match_score, match_confidence, match_decision,
      match_explanation, match_reasons, match_explain_json, matcher_version,
      computed_at, updated_at, evaluated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '{}', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    `${PROFILE_ID}:${opportunityId}`,
    PROFILE_ID,
    opportunityId,
    score,
    confidence,
    decision,
    `Seeded ${decision} match`,
    matcherVersion,
  )
}

function currentMatches(db) {
  return db.prepare(`
    SELECT opportunity_id, match_score, match_confidence, match_decision, matcher_version
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
          match_confidence: 81,
          decision: 'review',
          match_explain_json: JSON.stringify({
            why: 'Current direct match',
            matched_needs: ['housing'],
            scoring_policy_version: 'need_first_v2',
          }),
        }]),
        {},
        { primaryProfileId: PROFILE_ID },
      )

      const matches = currentMatches(db)
      const ids = matches.map((row) => row.opportunity_id)

      expect(ids).toContain('direct-current')
      expect(ids).not.toContain('direct-stale')
      expect(matches.find((row) => row.opportunity_id === 'direct-current')?.match_confidence).toBe(81)
      const directExplain = JSON.parse(db.prepare(
        'SELECT match_explain_json FROM profile_opportunity_matches WHERE profile_id = ? AND opportunity_id = ?',
      ).get(PROFILE_ID, 'direct-current').match_explain_json)
      expect(directExplain.match_confidence_provenance).toEqual({
        contract_version: 'crawler-os-confidence-v1',
        scoring_policy_version: 'need_first_v2',
        match_score: 22,
        match_decision: 'review',
        match_confidence: 81,
      })
      for (const kind of resourceKinds) {
        expect(ids).toContain(`resource-${kind.toLowerCase()}`)
      }
      expect(matches.filter((row) => row.opportunity_id.startsWith('resource-'))).toHaveLength(4)
      expect(matches.find((row) => row.opportunity_id === 'resource-directory')?.match_confidence).toBe(64)
    } finally {
      db.close()
    }
  })

  it('preserves resource confidence when crawler provenance columns are not installed yet', async () => {
    const db = makeDb()
    try {
      db.exec(`
        ALTER TABLE profile_opportunity_matches DROP COLUMN source_query;
        ALTER TABLE profile_opportunity_matches DROP COLUMN discovered_via;
      `)
      seedOpportunity(db, 'legacy-resource', 'DIRECTORY')
      seedMatch(db, {
        opportunityId: 'legacy-resource',
        score: 41,
        confidence: 67,
        decision: 'review',
      })

      await persistRun(db, memStore([]), {}, { primaryProfileId: PROFILE_ID })

      const preserved = currentMatches(db).find(
        (row) => row.opportunity_id === 'legacy-resource',
      )
      expect(preserved).toMatchObject({
        match_score: 41,
        match_confidence: 67,
        match_decision: 'review',
      })
    } finally {
      db.close()
    }
  })

  it('preserves ACCEPT confidence through the kind-free intermediate-schema fallback', async () => {
    const db = makeDb()
    try {
      db.exec(`
        ALTER TABLE profile_opportunity_matches DROP COLUMN source_query;
        ALTER TABLE profile_opportunity_matches DROP COLUMN discovered_via;
        ALTER TABLE funding_opportunities DROP COLUMN opportunity_kind;
      `)
      db.prepare(
        'INSERT INTO funding_opportunities (id, title) VALUES (?, ?)',
      ).run('legacy-accept', 'Legacy accepted award')
      seedMatch(db, {
        opportunityId: 'legacy-accept',
        score: 89,
        confidence: 92,
        decision: 'accept',
      })

      await persistRun(db, memStore([]), {}, { primaryProfileId: PROFILE_ID })

      const preserved = currentMatches(db).find(
        (row) => row.opportunity_id === 'legacy-accept',
      )
      expect(preserved).toMatchObject({
        match_score: 89,
        match_confidence: 92,
        match_decision: 'accept',
      })
    } finally {
      db.close()
    }
  })

  it('CROSS-MATCH PRECISION: a cross-profile row is stored only on ACCEPT (the Robert White class)', async () => {
    // Prod 2026-08-03: 4,577 of 4,792 xmatch rows were REVIEW — another
    // state's housing finance agency, disease directories on profiles with no
    // declared condition, "Goldwater Scholarship" at score 2 on churches.
    // A cross-profile REVIEW is scored against a thesis STUB and is
    // uncertainty, not eligibility. FAILING-FIRST: on the pre-fix writer both
    // other-profile rows below are stored.
    const db = makeDb()
    try {
      db.prepare("INSERT INTO profiles (id) VALUES ('profile-other')").run()
      seedOpportunity(db, 'opp-shared', 'DIRECTORY')
      seedOpportunity(db, 'opp-award', 'DIRECT_GRANT')

      await persistRun(
        db,
        memStore([
          // The PRIMARY profile keeps its own REVIEW (the locator rule).
          {
            profile_id: PROFILE_ID, opportunity_id: 'opp-shared', match_score: 31,
            match_confidence: 70, decision: 'review', match_explain_json: '{}',
          },
          // A cross-profile REVIEW is NOT a match — never stored.
          {
            profile_id: 'profile-other', opportunity_id: 'opp-shared', match_score: 31,
            match_confidence: 70, decision: 'review', match_explain_json: '{}',
          },
          // A cross-profile ACCEPT is an engine endorsement — stored as xmatch.
          {
            profile_id: 'profile-other', opportunity_id: 'opp-award', match_score: 82,
            match_confidence: 93, decision: 'accept',
            match_explain_json: JSON.stringify({ scoring_policy_version: 'need_first_v2' }),
          },
        ]),
        {},
        { primaryProfileId: PROFILE_ID },
      )

      const own = currentMatches(db)
      expect(own.map((r) => r.opportunity_id)).toContain('opp-shared')
      const others = db.prepare(
        "SELECT opportunity_id, match_confidence, match_decision, matcher_version FROM profile_opportunity_matches WHERE profile_id = 'profile-other' ORDER BY opportunity_id",
      ).all()
      expect(others).toEqual([
        { opportunity_id: 'opp-award', match_confidence: 93, match_decision: 'accept', matcher_version: 'crawler-os-xmatch' },
      ])
      const crossExplain = JSON.parse(db.prepare(
        "SELECT match_explain_json FROM profile_opportunity_matches WHERE profile_id = 'profile-other' AND opportunity_id = 'opp-award'",
      ).get().match_explain_json)
      expect(crossExplain.match_confidence_provenance).toMatchObject({
        match_score: 82,
        match_decision: 'accept',
        match_confidence: 93,
      })
    } finally {
      db.close()
    }
  })

  it('a PRE-EXISTING non-ACCEPT xmatch resource is not restored across a reconcile (converges)', async () => {
    // The resource snapshot preserves the profile's OWN review locators —
    // omission is not a negative verdict for a lane the run did not crawl —
    // but a cross-profile REVIEW was never evidence, and restoring it made
    // the junk rows structurally immortal. FAILING-FIRST: the pre-fix
    // snapshot restores 'xmatch-review-dir' below.
    const db = makeDb()
    try {
      seedOpportunity(db, 'own-review-dir', 'DIRECTORY')
      seedMatch(db, { opportunityId: 'own-review-dir', decision: 'review', matcherVersion: 'crawler-os' })
      seedOpportunity(db, 'xmatch-review-dir', 'DIRECTORY')
      seedMatch(db, { opportunityId: 'xmatch-review-dir', decision: 'review', matcherVersion: 'crawler-os-xmatch' })
      seedOpportunity(db, 'xmatch-accept-ref', 'REFERRAL')
      seedMatch(db, { opportunityId: 'xmatch-accept-ref', decision: 'accept', matcherVersion: 'crawler-os-xmatch' })

      await persistRun(db, memStore([]), {}, { primaryProfileId: PROFILE_ID })

      const ids = currentMatches(db).map((r) => r.opportunity_id)
      expect(ids).toContain('own-review-dir')       // own locator survives omission
      expect(ids).toContain('xmatch-accept-ref')    // an endorsed cross-match survives
      expect(ids).not.toContain('xmatch-review-dir') // a cross-profile REVIEW does not
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

  it('ACCEPT DURABILITY: an omitted awardable ACCEPT survives a later crawl that does not re-find it', async () => {
    // Google-bar failure mode: HOPE ACCEPT 100 vanishes when the next
    // registry-only crawl omits it. FAILING-FIRST on pre-fix facade.
    const db = makeDb()
    try {
      seedOpportunity(db, 'hope-accept', 'DIRECT_GRANT')
      seedMatch(db, {
        opportunityId: 'hope-accept',
        score: 100,
        decision: 'accept',
        matcherVersion: 'crawler-os',
      })
      seedOpportunity(db, 'stale-review', 'DIRECT_GRANT')
      seedMatch(db, {
        opportunityId: 'stale-review',
        score: 17,
        decision: 'review',
        matcherVersion: 'crawler-os',
      })
      seedOpportunity(db, 'fresh-accept', 'DIRECT_GRANT')

      const result = await persistRun(
        db,
        memStore([{
          profile_id: PROFILE_ID,
          opportunity_id: 'fresh-accept',
          match_score: 91,
          decision: 'accept',
          match_explain_json: '{}',
        }]),
        {},
        { primaryProfileId: PROFILE_ID },
      )

      expect(result.acceptsPreserved).toBeGreaterThanOrEqual(1)
      const ids = currentMatches(db).map((r) => r.opportunity_id)
      expect(ids).toContain('hope-accept')
      expect(ids).toContain('fresh-accept')
      expect(ids).not.toContain('stale-review')
      const hope = currentMatches(db).find((r) => r.opportunity_id === 'hope-accept')
      expect(hope.match_decision).toBe('accept')
      expect(hope.match_score).toBe(100)
    } finally {
      db.close()
    }
  })

  it('ACCEPT DURABILITY: an explicit REJECT in the current run clears a prior ACCEPT', async () => {
    const db = makeDb()
    try {
      seedOpportunity(db, 'was-accept', 'DIRECT_GRANT')
      seedMatch(db, {
        opportunityId: 'was-accept',
        score: 83,
        decision: 'accept',
        matcherVersion: 'crawler-os',
      })

      await persistRun(
        db,
        memStore([{
          profile_id: PROFILE_ID,
          opportunity_id: 'was-accept',
          match_score: 0,
          decision: 'reject',
          match_explain_json: '{}',
        }]),
        {},
        { primaryProfileId: PROFILE_ID },
      )

      expect(currentMatches(db).map((r) => r.opportunity_id)).not.toContain('was-accept')
    } finally {
      db.close()
    }
  })

  it('ACCEPT DURABILITY: pointer ACCEPTs ride the resource path, not double-write noise', async () => {
    // Directories never ACCEPT under the locator rule in live traffic, but if
    // a legacy row exists, resource restore already covers it — awardable
    // durability must not require a pointer kind.
    const db = makeDb()
    try {
      seedOpportunity(db, 'dir-legacy', 'DIRECTORY')
      seedMatch(db, {
        opportunityId: 'dir-legacy',
        score: 40,
        decision: 'review',
        matcherVersion: 'crawler-os',
      })
      await persistRun(db, memStore([]), {}, { primaryProfileId: PROFILE_ID })
      expect(currentMatches(db).map((r) => r.opportunity_id)).toContain('dir-legacy')
    } finally {
      db.close()
    }
  })
})
