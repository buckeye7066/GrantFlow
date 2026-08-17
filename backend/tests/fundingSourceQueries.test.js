import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  FUNDING_SOURCE_QUERY_CONTRACT,
  FUNDING_SOURCES_BY_PROFILE_SQL,
  NEED_FIRST_RECONCILIATION_ROWS_SQL,
  readFundingSourceRows,
} from '../services/matching/fundingSourceQueries.js'
import { reconcileNeedFirstProfileMatches } from '../services/matching/needFirstReconciler.js'
import { stampMatchConfidenceProvenance } from '../services/matching/matchConfidenceProvenance.js'

const SQLITE_CANONICAL_MIGRATION = fs.readFileSync(
  path.resolve('backend/db/migrations/122_profile_opportunity_matches.sql'),
  'utf8',
)
const SQLITE_FORWARD_MIGRATION = fs.readFileSync(
  path.resolve('backend/db/migrations/162_profile_opportunity_match_confidence.sql'),
  'utf8',
)
const POSTGRES_CANONICAL_MIGRATION = fs.readFileSync(
  path.resolve('backend/db/postgres/migrations/0123_profile_opportunity_matches.sql'),
  'utf8',
)
const POSTGRES_FORWARD_MIGRATION = fs.readFileSync(
  path.resolve('backend/db/postgres/migrations/0166_profile_opportunity_match_confidence.sql'),
  'utf8',
)

function applySqliteMarkerMigration(db, sql) {
  const statements = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)

  for (const statement of statements) {
    try {
      db.exec(`${statement};`)
    } catch (error) {
      if (!/duplicate column name/i.test(String(error?.message || error))) throw error
    }
  }
}

function createCanonicalDb({ withDismissals = true, withMatchConfidence = true } = {}) {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      created_at TEXT,
      updated_at TEXT,
      title TEXT NOT NULL,
      sponsor TEXT,
      source TEXT,
      source_id TEXT,
      source_url TEXT,
      record_origin TEXT,
      description TEXT,
      eligibility_bullets TEXT DEFAULT '[]',
      amount_min REAL,
      amount_max REAL,
      deadline TEXT,
      deadline_type TEXT,
      application_url TEXT,
      is_national INTEGER DEFAULT 0,
      state TEXT,
      categories TEXT DEFAULT '[]',
      keywords TEXT DEFAULT '[]',
      opportunity_type TEXT,
      type TEXT,
      opportunity_kind TEXT,
      source_trust_tier TEXT,
      link_status TEXT,
      link_status_code INTEGER,
      last_verified_at TEXT,
      verification_method TEXT,
      is_active INTEGER DEFAULT 1,
      is_hidden INTEGER DEFAULT 0
    );
    CREATE TABLE profile_opportunity_matches (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      opportunity_id TEXT NOT NULL,
      match_score REAL,
      ${withMatchConfidence ? 'match_confidence REAL,' : ''}
      match_decision TEXT,
      match_explanation TEXT,
      match_reasons TEXT,
      match_explain_json TEXT,
      matcher_version TEXT,
      computed_at TEXT,
      updated_at TEXT,
      evaluated_at TEXT
    );
    ${withDismissals ? `
      CREATE TABLE pipeline_dismissals (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        opportunity_id TEXT,
        title TEXT
      );
    ` : ''}

    INSERT INTO funding_opportunities (
      id, updated_at, title, sponsor, source, source_id, source_url,
      record_origin, description, eligibility_bullets, amount_min, amount_max,
      deadline, deadline_type, application_url, is_national, state, categories,
      keywords, opportunity_type, type, opportunity_kind, source_trust_tier,
      link_status, link_status_code, last_verified_at, verification_method,
      is_active, is_hidden
    ) VALUES
      ('opp-1', CURRENT_TIMESTAMP, 'Canonical Medical Grant', 'Example Agency',
       'official', 'A-1', 'https://example.gov/info', 'curated_verified',
       'Live-table description', '["Adults in Tennessee"]', 1000, 5000,
       '2026-12-31', 'fixed', 'https://example.gov/apply', 0, 'TN',
       '["medical"]', '["treatment"]', 'grant', 'OPPORTUNITY',
       'DIRECT_GRANT', 'official_portal',
       'ok', 200, '2026-08-15T00:00:00.000Z', 'http_head', 1, 0),
      ('opp-2', CURRENT_TIMESTAMP, 'Assistance Directory', 'Example Directory',
       'official', 'D-1', 'https://example.gov/directory', 'curated_verified',
       'Directory description', '["Tennessee residents"]', NULL, NULL,
       NULL, 'rolling', 'https://example.gov/directory', 1, NULL,
       '["medical"]', '["directory"]', 'directory', 'DIRECTORY',
       'DIRECTORY', 'verified_directory',
       NULL, NULL, NULL, NULL, 1, 0),
      ('opp-dismissed', CURRENT_TIMESTAMP, 'Dismissed Grant', 'Example Agency',
       'official', 'A-2', 'https://example.gov/dismissed', 'curated_verified',
       'Should stay hidden', '[]', 100, 500, NULL, 'rolling',
       'https://example.gov/dismissed', 1, NULL, '[]', '[]', 'grant',
       'OPPORTUNITY', 'DIRECT_GRANT', 'official_portal',
       NULL, NULL, NULL, NULL, 1, 0);

    INSERT INTO profile_opportunity_matches (
      id, profile_id, opportunity_id, match_score, match_decision,
      ${withMatchConfidence ? 'match_confidence,' : ''} match_explanation, match_reasons, match_explain_json, matcher_version,
      updated_at, evaluated_at
    ) VALUES
      ('m-1', 'p-1', 'opp-1', 82, 'accept', ${withMatchConfidence ? '89,' : ''} 'Persisted direct match',
       '["medical need"]', '{"scoring_policy_version":"need-first-v2"}',
       'crawler-os', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('m-2', 'p-1', 'opp-2', 61, 'accept', ${withMatchConfidence ? '72,' : ''} 'Persisted resource match',
       '["resource"]', '{}', 'crawler-os-xmatch', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('m-3', 'p-1', 'opp-dismissed', 90, 'accept', ${withMatchConfidence ? 'NULL,' : ''} 'Dismissed',
       '[]', '{}', 'web-llm', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    ${withDismissals ? `
      INSERT INTO pipeline_dismissals (id, profile_id, opportunity_id, title)
      VALUES ('d-1', 'p-1', 'opp-dismissed', 'Dismissed Grant');
    ` : ''}
  `)
  return db
}

describe('canonical funding-source query projection', () => {
  it('owns match_confidence in canonical and forward SQLite/Postgres migrations', () => {
    const fresh = new Database(':memory:')
    applySqliteMarkerMigration(fresh, SQLITE_CANONICAL_MIGRATION)

    const columns = fresh.prepare('PRAGMA table_info(profile_opportunity_matches)').all()
    expect(columns.filter((column) => column.name === 'match_confidence')).toHaveLength(1)
    expect(columns.find((column) => column.name === 'match_confidence')?.type).toBe('REAL')
    expect(SQLITE_FORWARD_MIGRATION).toMatch(/ADD COLUMN match_confidence REAL/i)
    expect(POSTGRES_CANONICAL_MIGRATION).toMatch(/match_confidence DOUBLE PRECISION/i)
    expect(POSTGRES_FORWARD_MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS match_confidence DOUBLE PRECISION/i)
  })

  it('can migrate then read legacy matches before any Crawler OS persistence path runs', async () => {
    const db = createCanonicalDb({ withMatchConfidence: false })

    // Apply the actual forward migration directly to an already-stamped legacy
    // shape. No ensureOsTables(), persistRun(), or write-side helper runs first.
    db.exec(SQLITE_FORWARD_MIGRATION)
    const result = await readFundingSourceRows(db, 'p-1')

    expect(result.rows).toHaveLength(2)
    expect(result.rows.every((row) => row.match_confidence === null)).toBe(true)
  })

  it('uses the live PostgreSQL column contract rather than Crawler OS memory names', async () => {
    const db = createCanonicalDb()
    const result = await readFundingSourceRows(db, 'p-1')

    expect(FUNDING_SOURCE_QUERY_CONTRACT).toBe('canonical-live-funding-columns-v1')
    expect(result.dismissal_filter).toBe('enforced')
    expect(result.rows).toHaveLength(2)

    const direct = result.rows.find((row) => row.id === 'opp-1')
    expect(direct).toMatchObject({
      description: 'Live-table description',
      summary: 'Live-table description',
      eligibility: '["Adults in Tennessee"]',
      eligibility_text: '["Adults in Tennessee"]',
      eligibility_criteria: '["Adults in Tennessee"]',
      restrictions: null,
      apply_url: 'https://example.gov/apply',
      funding_type: 'grant',
      ineligibility_reasons: null,
      match_score: 82,
      match_confidence: 89,
      match_decision: 'accept',
      matcher_version: 'crawler-os',
    })

    // Verification truth reaches the primary user-facing surface: the
    // projection must carry the link-verification columns so a proven-live or
    // proven-broken link is never rendered as "not yet verified" (epic slice 2).
    expect(direct).toMatchObject({
      link_status: 'ok',
      link_status_code: 200,
      last_verified_at: '2026-08-15T00:00:00.000Z',
      verification_method: 'http_head',
    })
    const directory = result.rows.find((row) => row.id === 'opp-2')
    expect(directory).toMatchObject({ link_status: null, last_verified_at: null })

    expect(FUNDING_SOURCES_BY_PROFILE_SQL).not.toMatch(/\bfo\.summary\b/)
    expect(FUNDING_SOURCES_BY_PROFILE_SQL).not.toMatch(/\bfo\.eligibility\b/)
    expect(FUNDING_SOURCES_BY_PROFILE_SQL).not.toMatch(/\bfo\.eligibility_criteria\b/)
    expect(FUNDING_SOURCES_BY_PROFILE_SQL).not.toMatch(/\bfo\.restrictions\b/)
    expect(FUNDING_SOURCES_BY_PROFILE_SQL).not.toMatch(/\bpom\.ineligibility_reasons\b/)
  })

  it('uses the same canonical aliases for need-first reconciliation', () => {
    const db = createCanonicalDb()
    const rows = db.prepare(NEED_FIRST_RECONCILIATION_ROWS_SQL).all('p-1', 100)

    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveProperty('summary')
    expect(rows[0]).toHaveProperty('eligibility')
    expect(rows[0]).toHaveProperty('match_confidence')
    expect(rows[0]).toHaveProperty('link_status')
    expect(rows[0]).toHaveProperty('last_verified_at')
    expect(NEED_FIRST_RECONCILIATION_ROWS_SQL).not.toMatch(/\bo\.summary\b/)
    expect(NEED_FIRST_RECONCILIATION_ROWS_SQL).not.toMatch(/\bo\.eligibility\b/)
    expect(NEED_FIRST_RECONCILIATION_ROWS_SQL).not.toMatch(/\bo\.eligibility_criteria\b/)
    expect(NEED_FIRST_RECONCILIATION_ROWS_SQL).not.toMatch(/\bo\.restrictions\b/)
  })

  it('clears crawler confidence when need-first reconciliation replaces its score contract', async () => {
    const db = createCanonicalDb()

    const result = await reconcileNeedFirstProfileMatches(db, {
      profileId: 'p-1',
      profileContext: {
        profile: { applicant_type: 'individual', needs: ['medical'] },
        sections: {},
      },
    })

    expect(result.updated).toBeGreaterThan(0)
    const reconciled = db.prepare(
      `SELECT match_score, match_confidence, match_decision, match_explain_json
         FROM profile_opportunity_matches
        WHERE profile_id = ? AND opportunity_id = ?`,
    ).get('p-1', 'opp-1')
    expect(reconciled.match_score).not.toBe(82)
    expect(reconciled.match_confidence).toBeNull()
    expect(JSON.parse(reconciled.match_explain_json).scoring_policy_version).toBe('need_first_v2')
  })

  it('does not treat a current policy label as confidence provenance', async () => {
    const db = createCanonicalDb()
    db.prepare(
      `UPDATE profile_opportunity_matches
          SET match_explain_json = ?, match_confidence = ?
        WHERE profile_id = ? AND opportunity_id = ?`,
    ).run(
      JSON.stringify({ scoring_policy_version: 'need_first_v2' }),
      89,
      'p-1',
      'opp-1',
    )

    const result = await reconcileNeedFirstProfileMatches(db, {
      profileId: 'p-1',
      profileContext: {
        profile: { applicant_type: 'individual', needs: ['medical'] },
        sections: {},
      },
    })

    expect(result.already_current).toBeGreaterThan(0)
    expect(result.confidence_cleared).toBeGreaterThan(0)
    const current = db.prepare(
      `SELECT match_score, match_confidence, match_decision, match_explain_json
         FROM profile_opportunity_matches
        WHERE profile_id = ? AND opportunity_id = ?`,
    ).get('p-1', 'opp-1')
    expect(current).toMatchObject({ match_score: 82, match_confidence: null, match_decision: 'accept' })
    expect(JSON.parse(current.match_explain_json)).not.toHaveProperty('match_confidence_provenance')
  })

  it('preserves confidence only with exact persistence-time provenance', async () => {
    const db = createCanonicalDb()
    const explain = stampMatchConfidenceProvenance(
      { scoring_policy_version: 'need_first_v2' },
      { match_score: 82, match_decision: 'accept', match_confidence: 89 },
    )
    db.prepare(
      `UPDATE profile_opportunity_matches
          SET match_explain_json = ?, match_confidence = ?
        WHERE profile_id = ? AND opportunity_id = ?`,
    ).run(JSON.stringify(explain), 89, 'p-1', 'opp-1')

    const result = await reconcileNeedFirstProfileMatches(db, {
      profileId: 'p-1',
      profileContext: {
        profile: { applicant_type: 'individual', needs: ['medical'] },
        sections: {},
      },
    })

    expect(result.already_current).toBeGreaterThan(0)
    const current = db.prepare(
      `SELECT match_score, match_confidence, match_decision
         FROM profile_opportunity_matches
        WHERE profile_id = ? AND opportunity_id = ?`,
    ).get('p-1', 'opp-1')
    expect(current).toMatchObject({ match_score: 82, match_confidence: 89, match_decision: 'accept' })
  })

  it('clears confidence when a later writer changes a stamped score', async () => {
    const db = createCanonicalDb()
    const explain = stampMatchConfidenceProvenance(
      { scoring_policy_version: 'need_first_v2' },
      { match_score: 82, match_decision: 'accept', match_confidence: 89 },
    )
    db.prepare(
      `UPDATE profile_opportunity_matches
          SET match_score = ?, match_explain_json = ?, match_confidence = ?
        WHERE profile_id = ? AND opportunity_id = ?`,
    ).run(41, JSON.stringify(explain), 89, 'p-1', 'opp-1')

    const result = await reconcileNeedFirstProfileMatches(db, {
      profileId: 'p-1',
      profileContext: {
        profile: { applicant_type: 'individual', needs: ['medical'] },
        sections: {},
      },
    })

    expect(result.confidence_cleared).toBeGreaterThan(0)
    const current = db.prepare(
      `SELECT match_score, match_confidence, match_decision, match_explain_json
         FROM profile_opportunity_matches
        WHERE profile_id = ? AND opportunity_id = ?`,
    ).get('p-1', 'opp-1')
    expect(current).toMatchObject({ match_score: 41, match_confidence: null, match_decision: 'accept' })
    expect(JSON.parse(current.match_explain_json)).not.toHaveProperty('match_confidence_provenance')
  })

  it('falls back SELECT-only when the optional dismissal table is absent', async () => {
    const db = createCanonicalDb({ withDismissals: false })
    const result = await readFundingSourceRows(db, 'p-1')

    expect(result.dismissal_filter).toBe('table_absent')
    expect(result.rows).toHaveLength(3)
  })

  it('does not mask unrelated database faults as a dismissal-table fallback', async () => {
    const error = Object.assign(new Error('column fo.bogus does not exist'), { code: '42703' })
    const db = {
      prepare() {
        return {
          async all() { throw error },
        }
      },
    }

    await expect(readFundingSourceRows(db, 'p-1')).rejects.toBe(error)
  })
})
