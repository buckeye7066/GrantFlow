/**
 * Migration 1003 removes ONLY the tombstones the 2026-09-02 strict migrations
 * wrote under the self-contradicting reason
 * `strict_pipeline:qualifies:applicant_type:pass`, their durable promotion
 * outcomes, every legacy dry-run outcome, and the nightly promotion day-marker.
 * Every other dismissal (user deletes, directory-only, real gate failures)
 * must survive untouched — a user-deleted source must stay gone.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'
import up from '../db/migrations/1003_restore_pass_verdict_pipeline_dismissals.mjs'

function makeDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE pipeline_dismissals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT, fingerprint TEXT, opportunity_id TEXT,
      source_url TEXT, title TEXT, reason TEXT, dismissed_by TEXT, dismissed_at TEXT
    );
    CREATE TABLE pipeline_promotion_outcomes (
      profile_id TEXT, opportunity_id TEXT, mode TEXT, outcome TEXT, reason TEXT, score REAL,
      attempted_at TEXT, attempts INTEGER, profile_facts_hash TEXT, policy_version TEXT, opportunity_updated_at TEXT,
      PRIMARY KEY (profile_id, opportunity_id)
    );
    CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
  `)
  const ins = raw.prepare(`INSERT INTO pipeline_dismissals (profile_id, opportunity_id, title, reason, dismissed_by, dismissed_at)
    VALUES (?, ?, ?, ?, ?, '2026-09-02T00:00:00.000Z')`)
  ins.run('anastasia', 'fo-promise', 'Tennessee Promise', 'strict_pipeline:qualifies:applicant_type:pass', 'migration:999_strict_pipeline_task_reconciliation')
  ins.run('anastasia', 'fo-gates', 'The Gates Scholarship', 'strict_pipeline:qualifies:applicant_type:pass', 'migration:1000_fail_closed_hamilton_reconciliation')
  ins.run('anastasia', 'fo-dir', 'Muncrief Family Foundation', 'strict_pipeline:relatable:directory_only', 'migration:999_strict_pipeline_task_reconciliation')
  ins.run('anastasia', 'fo-user', 'Something the user removed', 'user_deleted_from_pipeline', 'user-1')
  ins.run('robert', 'fo-mismatch', 'Institutional-only award', 'pipeline_precision:qualifies:profile_mismatch', 'system_pipeline_precision')
  const out = raw.prepare(`INSERT INTO pipeline_promotion_outcomes
    (profile_id, opportunity_id, mode, outcome, reason, score, attempted_at, attempts, profile_facts_hash, policy_version, opportunity_updated_at)
    VALUES (?, ?, ?, ?, ?, 0, '2026-09-02T00:00:00.000Z', 1, 'h', 'p', 'u')`)
  out.run('anastasia', 'fo-promise', 'live', 'tombstoned', 'strict_pipeline', )
  out.run('anastasia', 'fo-dir', 'live', 'source_excluded', 'directory', )
  out.run('robert', 'fo-legacy', 'dry_run', 'promoted', 'accepted', )
  raw.prepare(`INSERT INTO system_kv (key, value, updated_at) VALUES ('qualified_pipeline_promotion_last_run', '2026-09-05', 'x')`).run()
  raw.prepare(`INSERT INTO system_kv (key, value, updated_at) VALUES ('promotion_projection', '{"projected_rows":1}', 'x')`).run()
  raw.prepare(`INSERT INTO system_kv (key, value, updated_at) VALUES ('unrelated_key', 'keep', 'x')`).run()
  return { raw, db: wrapSqlite(raw) }
}

describe('migration 1003: restore pass-verdict pipeline dismissals', () => {
  it('removes only the applicant_type:pass tombstones, their outcomes, dry-run rows and the day marker', async () => {
    const { raw, db } = makeDb()
    await up(db)
    const reasons = raw.prepare('SELECT reason FROM pipeline_dismissals ORDER BY reason').all().map((r) => r.reason)
    expect(reasons).toEqual([
      'pipeline_precision:qualifies:profile_mismatch',
      'strict_pipeline:relatable:directory_only',
      'user_deleted_from_pipeline',
    ])
    const outcomes = raw.prepare('SELECT opportunity_id, mode FROM pipeline_promotion_outcomes ORDER BY opportunity_id').all()
    expect(outcomes).toEqual([{ opportunity_id: 'fo-dir', mode: 'live' }])
    const keys = raw.prepare('SELECT key FROM system_kv ORDER BY key').all().map((r) => r.key)
    expect(keys).toEqual(['unrelated_key'])
  })

  it('is idempotent and tolerates a database without the optional tables', async () => {
    const { raw, db } = makeDb()
    await up(db)
    await up(db)
    expect(raw.prepare('SELECT COUNT(*) AS n FROM pipeline_dismissals').get().n).toBe(3)
    const bare = new Database(':memory:')
    bare.exec(`CREATE TABLE pipeline_dismissals (profile_id TEXT, opportunity_id TEXT, reason TEXT)`)
    bare.prepare(`INSERT INTO pipeline_dismissals VALUES ('p', 'o', 'strict_pipeline:qualifies:applicant_type:pass')`).run()
    await up(wrapSqlite(bare))
    expect(bare.prepare('SELECT COUNT(*) AS n FROM pipeline_dismissals').get().n).toBe(0)
  })
})
