/**
 * onboarding_sessions must exist on EVERY database the server boots against —
 * it is the first table a brand-new visitor writes (POST /api/onboarding/start).
 *
 * Measured 2026-09-12 (EVA quiet-host run evarun_dbf30a8be3811e5cc3670087,
 * finding evf_549b1260): the disposable SQLite DB held 217 tables and no
 * onboarding_sessions, because the EVA launcher never executes a manifest
 * seed_command and SMOKE_MODE opts out of MIGRATE_ON_BOOT — so the guest-quiz
 * journey 500'd on every fresh run while the route's own test (which creates
 * the table by hand) stayed green. Three guarantees, each of which failed on
 * the pre-fix tree:
 *   1. schema.sql (the base SQLite schema every fresh fixture gets) carries it;
 *   2. the unconditional boot self-heal applies migration 078/0074 when it is
 *      missing, and repairs a stamped-but-absent table;
 *   3. the real server, booted the way tests and EVA boot it (SMOKE_MODE,
 *      :memory: sqlite, no migration runner), answers 201 on /start.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import request from 'supertest'
import { describe, it, expect, beforeAll } from 'vitest'
import { ensureAgentSubsystemTables } from '../utils/ensureAgentSubsystemTables.js'
import { getAppAndDb } from './testServer.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'schema.sql')

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
}

/** Minimal dialect shim over better-sqlite3 matching what the boot helper calls. */
function shim(raw) {
  return {
    dialect: 'sqlite',
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => {
      const stmt = raw.prepare(sql)
      return {
        get: (...a) => stmt.get(...a),
        all: (...a) => stmt.all(...a),
        run: (...a) => stmt.run(...a),
      }
    },
  }
}

describe('onboarding_sessions is guaranteed at boot, not by the migration runner', () => {
  it('1. the base SQLite schema creates onboarding_sessions with the columns the route writes', () => {
    const raw = new Database(':memory:')
    try {
      raw.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
      expect(tableNames(raw)).toContain('onboarding_sessions')
      const cols = raw.prepare('PRAGMA table_info(onboarding_sessions)').all().map((c) => c.name)
      for (const c of ['id', 'status', 'current_question', 'answers', 'profile_patch', 'user_agent', 'ip_hash', 'created_at', 'updated_at']) {
        expect(cols).toContain(c)
      }
    } finally { raw.close() }
  })

  it('2. the unconditional boot self-heal applies 078 when the table is missing, stamps it, skips it next time, and repairs a lying stamp', async () => {
    const raw = new Database(':memory:')
    try {
      raw.exec(`
        CREATE TABLE users (id TEXT PRIMARY KEY);
        CREATE TABLE profiles (id TEXT PRIMARY KEY);
      `)
      const db = shim(raw)
      expect(tableNames(raw)).not.toContain('onboarding_sessions')

      const first = await ensureAgentSubsystemTables(db, { logger: { warn() {}, info() {}, error() {} } })
      expect(first.applied).toContain('078_onboarding_sessions.sql')
      expect(tableNames(raw)).toContain('onboarding_sessions')
      expect(raw.prepare("SELECT 1 AS hit FROM _migrations WHERE name = '078_onboarding_sessions.sql'").get()?.hit).toBe(1)

      const second = await ensureAgentSubsystemTables(db, { logger: { warn() {}, info() {}, error() {} } })
      expect(second.skipped).toContain('078_onboarding_sessions.sql')
      expect(second.applied).not.toContain('078_onboarding_sessions.sql')

      // A stamp that lies (table dropped after stamping) is repaired, never trusted.
      raw.exec('DROP TABLE onboarding_sessions')
      const third = await ensureAgentSubsystemTables(db, { logger: { warn() {}, info() {}, error() {} } })
      expect(third.repaired).toContain('078_onboarding_sessions.sql')
      expect(tableNames(raw)).toContain('onboarding_sessions')
    } finally { raw.close() }
  })

  describe('3. the real server, booted as tests and EVA boot it (SMOKE_MODE, no migration runner)', () => {
    let app
    beforeAll(async () => {
      ;({ app } = await getAppAndDb())
    })

    it('answers 201 with a session and the first question on POST /api/onboarding/start', async () => {
      const res = await request(app).post('/api/onboarding/start').send({})
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      expect(res.body.session_id).toBeTruthy()
      expect(res.body.status).toBe('in_progress')
      expect(res.body.question?.id).toBeTruthy()
    })
  })
})
