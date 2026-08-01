/**
 * The `admin.db.query` read-only guard — the 2026-07-29 "Anya tool failure
 * rate 44%" defect.
 *
 * Anya's 2026-08-01 owner report classified `admin_tool_integrity`: "44% of
 * Anya's last 200 tool calls failed. Top failing: admin.db.query (87)".
 *
 * Read-only from prod `anya_tool_usage` on 2026-08-01, every `admin.db.query`
 * failure ever recorded carried ONE error string — "Query contains forbidden
 * keywords" (90 all-time, 87 inside the reported 200-call window) — and
 * replaying the shipped guard over the stored `parameters` showed **90 of 90**
 * were rejected on a SUBSTRING of a column identifier, with **0** containing a
 * forbidden keyword at a word boundary:
 *
 *   86 × `updated_at`  ⊃ "update"
 *    7 × `created_at` / `created_by` ⊃ "create"
 *
 * The eight distinct statements below are those exact prod queries, verbatim.
 * They are legitimate, read-only diagnostic SELECTs. Every one of them throws
 * on the pre-fix `dangerousKeywords.some((k) => trimmedSql.includes(k))`.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import {
  adminDbQuery,
  assertReadOnlyDiagnosticSql,
  findForbiddenSqlKeyword,
  READ_ONLY_SQL_FORBIDDEN_KEYWORDS,
} from '../services/anyaAdminTools.js'
import { invokeTool } from '../services/anyaToolRegistry.js'
import { getCheckById } from '../services/sam/samRegistry.js'

/** The 8 distinct SQL strings prod rejected, copied out of anya_tool_usage.parameters. */
const PROD_REJECTED_SQL = [
  // x83 — one statement re-issued 83 times in 30 minutes (see "amplification" below)
  "SELECT key, value, updated_at FROM system_kv WHERE key IN ('web_parity_benchmark', 'web_parity_gap_queue')",
  `SELECT id, event_type, status, severity, title, description, entity_id, profile_id, created_at
         FROM agent_activity_events
        WHERE agent_name = 'amy'
          AND created_at >= '2026-07-30T00:20:14.765Z'
        ORDER BY created_at DESC`,
  `SELECT id, title, sponsor, source, source_id, application_url, source_url, final_url,
  link_status, link_status_code, verification_error, last_verified_at, verified_by,
  is_hidden, is_active, opportunity_kind, result_kind, type, opportunity_type,
  record_origin, updated_at, created_at, canonical_opportunity_key FROM funding_opportunities WHERE
  COALESCE(opportunity_kind, 'direct') IN ('direct','benefit')
  AND link_status = 'broken'
  AND COALESCE(is_hidden, FALSE) = FALSE
  AND COALESCE(is_active, TRUE) = TRUE ORDER BY last_verified_at DESC NULLS FIRST LIMIT 100`,
  `SELECT id, title, sponsor, source, source_id, application_url, source_url, final_url,
  link_status, link_status_code, verification_error, last_verified_at, verified_by,
  is_hidden, is_active, opportunity_kind, result_kind, type, opportunity_type,
  record_origin, updated_at, created_at, canonical_opportunity_key FROM funding_opportunities WHERE
  COALESCE(opportunity_kind, 'direct') IN ('direct','benefit')
  AND link_status = 'broken'
  AND (COALESCE(is_hidden, FALSE) = TRUE OR COALESCE(is_active, TRUE) = FALSE) ORDER BY last_verified_at DESC NULLS FIRST LIMIT 500 OFFSET 0`,
  `SELECT id, title, sponsor, source, source_id, application_url, source_url, final_url,
  link_status, link_status_code, verification_error, last_verified_at, verified_by,
  is_hidden, is_active, opportunity_kind, result_kind, type, opportunity_type,
  record_origin, updated_at, created_at, canonical_opportunity_key FROM funding_opportunities WHERE
  COALESCE(opportunity_kind, 'direct') IN ('direct','benefit')
  AND link_status = 'broken'
  AND (COALESCE(is_hidden, FALSE) = TRUE OR COALESCE(is_active, TRUE) = FALSE) ORDER BY last_verified_at DESC NULLS FIRST LIMIT 500 OFFSET 500`,
  `SELECT p.id, p.created_at, p.last_discovery_at, ps.data
              FROM profiles p
              JOIN profile_sections ps ON ps.profile_id = p.id
             WHERE p.created_by = 'agent:amy'
               AND ps.section_key = 'amy_metadata'
               AND CAST(ps.data AS TEXT) LIKE '%amy-2026-07-30T00-20-14-765Z-8ddfa979%'
             ORDER BY p.created_at ASC`,
  `SELECT id, display_name, created_at, last_discovery_at
         FROM profiles
        WHERE created_by = 'agent:amy'
          AND created_at >= '2026-07-30T00:20:14.765Z'
        ORDER BY created_at ASC`,
  `SELECT p.id, p.created_at, p.last_discovery_at, ps.data
         FROM profiles p
         JOIN profile_sections ps ON ps.profile_id = p.id
        WHERE p.created_by = 'agent:amy'
          AND ps.section_key = 'amy_metadata'
          AND CAST(ps.data AS TEXT) LIKE '%amy-2026-07-30T00-20-14-765Z-8ddfa979%'
        ORDER BY p.created_at ASC`,
]

/** The pre-fix rule, kept verbatim so the A/B below is a real comparison. */
const PRE_FIX_REJECTS = (sql) =>
  READ_ONLY_SQL_FORBIDDEN_KEYWORDS.some((k) => sql.trim().toLowerCase().includes(k))

/** A genuine statement for each forbidden keyword — the true positives. */
const REAL_KEYWORD_STATEMENTS = {
  drop: 'SELECT 1 FROM x WHERE y = 1 DROP TABLE grants',
  delete: 'SELECT 1 FROM x WHERE y = 1 DELETE FROM grants',
  update: 'SELECT 1 FROM x WHERE y = 1 UPDATE grants SET a = 1',
  insert: 'SELECT 1 FROM x WHERE y = 1 INSERT INTO grants VALUES (1)',
  alter: 'SELECT 1 FROM x WHERE y = 1 ALTER TABLE grants ADD c INT',
  create: 'SELECT 1 FROM x WHERE y = 1 CREATE TABLE evil (a INT)',
  truncate: 'SELECT 1 FROM x WHERE y = 1 TRUNCATE TABLE grants',
  union: "SELECT id FROM grants UNION ALL VALUES ('x')",
  into: 'SELECT * INTO exfiltrated FROM users',
  exec: "SELECT 1 FROM x WHERE y = 1 EXEC ('sp_who')",
  execute: "SELECT 1 FROM x WHERE y = 1 EXECUTE ('sp_who')",
  grant: 'SELECT 1 FROM x WHERE y = 1 GRANT ALL ON grants TO anon',
  revoke: 'SELECT 1 FROM x WHERE y = 1 REVOKE ALL ON grants FROM anon',
}

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, title TEXT, status TEXT,
      created_at TEXT, updated_at TEXT, deleted_at TEXT
    );
    CREATE TABLE anya_tool_usage (
      id TEXT PRIMARY KEY, tool_name TEXT, session_id TEXT, user_id TEXT, profile_id TEXT,
      parameters TEXT, success INTEGER, error_message TEXT, execution_time_ms INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `)
  const ins = db.prepare(
    'INSERT INTO grants (id, title, status, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  for (let i = 0; i < 12; i++) ins.run(`g${i}`, `Grant ${i}`, 'discovered', '2026-07-01', '2026-07-02', null)
  db.dialect = 'sqlite'
  return db
}

describe('admin.db.query — the 90 prod rejections were 90 false positives', () => {
  it('A/B: every one of the 8 distinct prod statements was rejected by the OLD substring rule', () => {
    // If this ever stops holding, the prod corpus below is no longer a
    // regression fixture and the tests under it prove nothing.
    for (const sql of PROD_REJECTED_SQL) {
      expect(PRE_FIX_REJECTS(sql), `pre-fix rule should have rejected: ${sql.slice(0, 60)}`).toBe(true)
    }
    expect(PROD_REJECTED_SQL).toHaveLength(8)
  })

  it('accepts every real prod statement — none of them uses a forbidden KEYWORD', () => {
    for (const sql of PROD_REJECTED_SQL) {
      expect(() => assertReadOnlyDiagnosticSql(sql), sql.slice(0, 70)).not.toThrow()
      expect(findForbiddenSqlKeyword(sql.toLowerCase())).toBeNull()
    }
  })

  it('a column whose NAME contains a keyword is not a statement (the whole defect class)', () => {
    const identifiers = [
      'SELECT created_at FROM grants',
      'SELECT updated_at FROM grants',
      'SELECT deleted_at FROM grants',
      'SELECT created_by, updated_by FROM grants',
      'SELECT inserted_at FROM grants',
      'SELECT execution_time_ms FROM anya_tool_usage',
      // The table this entire product is named after was unqueryable: "grants" ⊃ "grant".
      'SELECT id, title FROM grants',
      'SELECT * FROM grants g JOIN grant_reports r ON r.grant_id = g.id',
      // alternate/dropout/interval-style identifiers
      'SELECT alternate_contact FROM grants',
      'SELECT dropout_risk FROM grants',
    ]
    for (const sql of identifiers) {
      expect(() => assertReadOnlyDiagnosticSql(sql), sql).not.toThrow()
    }
  })
})

describe('the guard is MORE precise, not weaker', () => {
  it('TOTALITY: every keyword in the registry still rejects a real statement using it', () => {
    // Registry + totality: a keyword added to READ_ONLY_SQL_FORBIDDEN_KEYWORDS
    // with no covering statement here fails this test rather than shipping
    // untested.
    const covered = Object.keys(REAL_KEYWORD_STATEMENTS).sort()
    expect(covered).toEqual([...READ_ONLY_SQL_FORBIDDEN_KEYWORDS].sort())

    for (const keyword of READ_ONLY_SQL_FORBIDDEN_KEYWORDS) {
      const sql = REAL_KEYWORD_STATEMENTS[keyword]
      expect(() => assertReadOnlyDiagnosticSql(sql), `${keyword}: ${sql}`).toThrow(/forbidden keyword/i)
      expect(findForbiddenSqlKeyword(sql.toLowerCase()), keyword).toBeTruthy()
    }
  })

  it('keeps the read-only perimeter: non-SELECT, multi-statement and subqueries', () => {
    expect(() => assertReadOnlyDiagnosticSql('UPDATE users SET name = 1')).toThrow(/Only SELECT/)
    expect(() => assertReadOnlyDiagnosticSql('  \n WITH x AS (SELECT 1) SELECT * FROM x')).toThrow(/Only SELECT/)
    expect(() => assertReadOnlyDiagnosticSql('SELECT 1; DROP TABLE grants')).toThrow(/forbidden characters/)
    expect(() => assertReadOnlyDiagnosticSql('SELECT 1;')).toThrow(/forbidden characters/)
    expect(() => assertReadOnlyDiagnosticSql('SELECT (SELECT 1) AS a FROM grants')).toThrow(/Subqueries/)
    expect(() => assertReadOnlyDiagnosticSql('')).toThrow(/SQL query is required/)
    expect(() => assertReadOnlyDiagnosticSql(null)).toThrow(/SQL query is required/)
  })

  it('names the offending keyword so a model caller can correct itself', () => {
    // Prod amplification: ONE rejected statement was re-issued 83 times in 30
    // minutes — 83 of the 87 failures in the reported window. "Query contains
    // forbidden keywords" told the caller nothing actionable.
    expect(() => assertReadOnlyDiagnosticSql('SELECT * INTO evil FROM users'))
      .toThrow(/forbidden keyword "INTO"/)
    expect(() => assertReadOnlyDiagnosticSql('SELECT * INTO evil FROM users'))
      .toThrow(/re-sending the same statement will not help/)
  })
})

describe('the row-limit clamp is a token test too', () => {
  it('clamps a query whose only "limit" is inside a string literal', async () => {
    const db = makeDb()
    try {
      // Pre-fix `trimmedSql.includes('limit')` saw the literal and ran this
      // UNBOUNDED. 12 rows exist; the clamp must cut it to 3.
      const res = await adminDbQuery(
        { sql: "SELECT id FROM grants WHERE title NOT LIKE '%limit%'", limit: 3 },
        { db },
      )
      expect(res.rows_returned).toBe(3)
    } finally { db.close() }
  })

  it('does not double-append when the query states its own LIMIT', async () => {
    const db = makeDb()
    try {
      const res = await adminDbQuery({ sql: 'SELECT id FROM grants LIMIT 5', limit: 100 }, { db })
      expect(res.rows_returned).toBe(5)
    } finally { db.close() }
  })

  it('runs a real prod-shaped query end to end (created_at/updated_at columns)', async () => {
    const db = makeDb()
    try {
      const res = await adminDbQuery(
        { sql: 'SELECT id, created_at, updated_at FROM grants ORDER BY created_at DESC', limit: 4 },
        { db },
      )
      expect(res.rows_returned).toBe(4)
      expect(res.results[0]).toHaveProperty('updated_at')
    } finally { db.close() }
  })
})

describe('telemetry: a regression still reddens Anya`s report', () => {
  it('records the failure row that feeds anya_tool_usage', async () => {
    const db = makeDb()
    try {
      await expect(
        invokeTool(
          'admin.db.query',
          { sql: 'SELECT * INTO evil FROM grants' },
          { db, ctx: { isAdmin: true }, user: { id: 'u1', role: 'admin' } },
        ),
      ).rejects.toThrow(/forbidden keyword/i)

      const row = db.prepare("SELECT tool_name, success, error_message FROM anya_tool_usage WHERE tool_name = 'admin.db.query'").get()
      expect(row).toBeTruthy()
      expect(row.success).toBe(0)
      expect(row.error_message).toMatch(/forbidden keyword/i)
    } finally { db.close() }
  })

  it('a burst of these rejections FAILS Sam`s agent.anya.toolFailures check', async () => {
    // The metric was NOT lying — it reported a real defect. Prove it still has
    // teeth for exactly this shape, so a re-introduction reddens the owner
    // report instead of returning quietly.
    const check = getCheckById('agent.anya.toolFailures')
    expect(check).toBeTruthy()

    const db = new Database(':memory:')
    try {
      db.exec(`CREATE TABLE anya_tool_usage (
        id TEXT PRIMARY KEY, tool_name TEXT, success INTEGER, error_message TEXT, created_at TEXT
      )`)
      const ins = db.prepare('INSERT INTO anya_tool_usage (id, tool_name, success, error_message, created_at) VALUES (?, ?, ?, ?, ?)')
      // The real prod mix: 87 rejected admin.db.query + 113 healthy calls.
      for (let i = 0; i < 87; i++) {
        ins.run(`f${i}`, 'admin.db.query', 0, 'Query contains forbidden keywords', new Date(Date.now() - i * 1000).toISOString())
      }
      for (let i = 0; i < 113; i++) {
        ins.run(`s${i}`, 'admin.health.check', 1, null, new Date(Date.now() - (200 + i) * 1000).toISOString())
      }
      const res = await check.run({ db })
      expect(res.ok).toBe(false)
      expect(res.summary).toMatch(/admin\.db\.query/)
      expect(res.evidence.failed).toBe(87)

      // A check that cannot go green proves nothing about the red: with the
      // false rejections gone (same 200 calls, all succeeding) it must return
      // ok — otherwise the assertion above is vacuous.
      db.exec('UPDATE anya_tool_usage SET success = 1, error_message = NULL')
      const green = await check.run({ db })
      expect(green.ok).toBe(true)
      expect(green.evidence.failed).toBe(0)
    } finally { db.close() }
  })
})
