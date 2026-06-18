/**
 * Shared in-memory SQLite harness for agent telemetry tests.
 *
 * Mirrors the production db wrapper just enough that the telemetry store
 * and aggregator can run unmodified: it exposes `.dialect = 'sqlite'`,
 * `prepare(sql)` returning `{ get, all, run }`, and `exec(sql)`.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, '..', '..')

function loadMigration(relPath) {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf8')
}

const TELEMETRY_MIGRATION = loadMigration('backend/db/migrations/084_agent_telemetry.sql')

/**
 * Per-agent table DDL we may opt into during a test. We re-declare
 * minimal-but-realistic versions here so the aggregator's table-exists
 * branches can be exercised without depending on every other agent's
 * migrations being merged. Production schemas may have more columns;
 * the aggregator only reads the ones we declare.
 *
 * IMPORTANT: column NAMES here MUST match the real migrations, or these
 * tests give false confidence. A prior version timestamped the run tables
 * (sam_runs, robert_runs, yana_runs, john_runs) with `created_at`, but the
 * canonical schema uses `started_at` — so the aggregator's `WHERE created_at
 * >= ?` queries passed in tests yet threw `column "created_at" does not
 * exist` on Postgres, taking down the entire Mission Control health endpoint
 * and rendering every agent as "Not installed". Run tables timestamp with
 * `started_at`; event/candidate/lead/draft tables use `created_at`.
 */
export const AGENT_TABLE_DDL = {
  anya_runs: `
    CREATE TABLE anya_runs (
      id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT,
      mode TEXT,
      tool_name TEXT,
      user_id TEXT,
      profile_id TEXT
    );
  `,
  anya_sessions: `
    CREATE TABLE anya_sessions (
      id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      user_id TEXT,
      profile_id TEXT
    );
  `,
  anya_messages: `
    CREATE TABLE anya_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      role TEXT,
      content TEXT
    );
  `,
  anya_tool_usage: `
    CREATE TABLE anya_tool_usage (
      id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      tool_name TEXT,
      session_id TEXT,
      user_id TEXT,
      profile_id TEXT
    );
  `,
  john_email_drafts: `
    CREATE TABLE john_email_drafts (
      id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      draft_status TEXT,
      block_reason TEXT,
      organization_name TEXT,
      recipient_email TEXT
    );
  `,
  john_alias_checks: `
    CREATE TABLE john_alias_checks (
      id TEXT PRIMARY KEY,
      checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      alias_status TEXT
    );
  `,
  john_suppression_list: `
    CREATE TABLE john_suppression_list (
      id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      type TEXT,
      value TEXT
    );
  `,
  john_runs: `
    CREATE TABLE john_runs (
      id TEXT PRIMARY KEY,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      status TEXT
    );
  `,
  john_email_audit: `
    CREATE TABLE john_email_audit (
      id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `,
  yana_runs: `
    CREATE TABLE yana_runs (
      id TEXT PRIMARY KEY,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      status TEXT,
      urls_fetched INTEGER DEFAULT 0,
      leads_found INTEGER DEFAULT 0
    );
  `,
  yana_lead_candidates: `
    CREATE TABLE yana_lead_candidates (
      id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      qualification_status TEXT,
      pushed_to_john INTEGER DEFAULT 0,
      rejection_reason TEXT
    );
  `,
  yana_john_queue: `
    CREATE TABLE yana_john_queue (
      id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      lead_id TEXT,
      queue_status TEXT
    );
  `,
  robert_runs: `
    CREATE TABLE robert_runs (
      id TEXT PRIMARY KEY,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      status TEXT,
      sources_considered INTEGER DEFAULT 0,
      candidates_found INTEGER DEFAULT 0
    );
  `,
  robert_opportunity_candidates: `
    CREATE TABLE robert_opportunity_candidates (
      id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      verification_status TEXT,
      ingested_opportunity_id TEXT,
      policy_rejection_reason TEXT,
      title TEXT,
      category TEXT,
      state TEXT,
      city TEXT,
      latitude REAL,
      longitude REAL
    );
  `,
  robert_profile_recommendations: `
    CREATE TABLE robert_profile_recommendations (
      id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      recommendation_status TEXT,
      profile_id TEXT,
      ingested_opportunity_id TEXT
    );
  `,
  sam_runs: `
    CREATE TABLE sam_runs (
      id TEXT PRIMARY KEY,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      status TEXT
    );
  `,
  sam_findings: `
    CREATE TABLE sam_findings (
      id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      severity TEXT,
      status TEXT,
      title TEXT,
      file_path TEXT,
      event_type TEXT,
      details_json TEXT
    );
  `,
}

/**
 * Build a fresh in-memory db with the unified telemetry tables already
 * applied. Pass `installAgents: ['anya_runs', ...]` to also create
 * specific per-agent tables. This lets each test choose how partial
 * the agent install should be.
 */
export function makeTelemetryDb({ installAgents = [] } = {}) {
  const raw = new Database(':memory:')
  raw.pragma('journal_mode = MEMORY')
  raw.exec(TELEMETRY_MIGRATION)
  for (const name of installAgents) {
    const ddl = AGENT_TABLE_DDL[name]
    if (!ddl) throw new Error(`Unknown agent table fixture: ${name}`)
    raw.exec(ddl)
  }
  return wrap(raw)
}

function wrap(raw) {
  return {
    dialect: 'sqlite',
    _raw: raw,
    prepare(sql) {
      const stmt = raw.prepare(sql)
      return {
        get: (...args) => stmt.get(...flat(args)),
        all: (...args) => stmt.all(...flat(args)),
        run: (...args) => stmt.run(...flat(args)),
      }
    },
    exec: (sql) => raw.exec(sql),
    close: () => raw.close(),
  }
}

function flat(args) {
  if (args.length === 1 && Array.isArray(args[0])) return args[0]
  return args
}

let SEED = 0
export function nextId(prefix = 'id') {
  SEED += 1
  return `${prefix}_${Date.now()}_${SEED}_${Math.random().toString(36).slice(2, 8)}`
}

export function isoMinutesAgo(min) {
  return new Date(Date.now() - min * 60 * 1000).toISOString()
}
