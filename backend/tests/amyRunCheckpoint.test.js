import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { readAmyRunCheckpoint, writeAmyRunCheckpoint, clearAmyRunCheckpoint, hasCompletedCheckpointCleanup } from '../services/amy/amyRunCheckpoint.js'
import { createAmyProfile } from '../services/amy/amyProfileStore.js'

const value = () => ({ version: 1, run_id: 'amy-resume-test', started_at: '2026-09-21T00:00:00.000Z', options: {}, plan: { scenarios: [{ scenario_id: 'one' }] }, members: [{ scenario_id: 'one', profile_id: 'synthetic-one' }] })

function profileDb() {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE profiles (id TEXT PRIMARY KEY, display_name TEXT, primary_type TEXT, status TEXT, tags TEXT, created_by TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT, updated_by TEXT, created_at TEXT, updated_at TEXT, UNIQUE(profile_id, section_key));`)
  return db
}

describe('recoverable synthetic creation', () => {
  it('reuses the assigned member after interruption between the profile and sections', async () => {
    const db = profileDb()
    const scenario = { scenario_id: 'one', primary_type: 'individual', sections: {} }
    const opts = { runId: 'amy-resume-test', profileId: 'assigned-synthetic' }
    let interrupted = false
    const failing = { prepare(sql) {
      if (!interrupted && /INSERT INTO profile_sections/.test(sql)) {
        interrupted = true
        throw new Error('simulated restart')
      }
      return db.prepare(sql)
    } }
    try {
      await expect(createAmyProfile(failing, scenario, opts)).rejects.toThrow('simulated restart')
      const resumed = await createAmyProfile(db, scenario, opts)
      expect(resumed.profileId).toBe('assigned-synthetic')
      expect(db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n).toBe(1)
      const metadata = db.prepare("SELECT data FROM profile_sections WHERE section_key = 'amy_metadata'").get()
      expect(JSON.parse(metadata.data).amy_run_id).toBe(opts.runId)
    } finally { db.close() }
  })
  it('cannot reuse a real or different-run profile', async () => {
    const db = profileDb()
    try {
      db.prepare('INSERT INTO profiles (id, created_by, display_name, tags) VALUES (?, ?, ?, ?)').run('real-person', 'owner', 'Preserve me', '[]')
      await expect(createAmyProfile(db, { scenario_id: 'one' }, { runId: 'amy-resume-test', profileId: 'real-person' })).rejects.toThrow(/belong/)
      expect(db.prepare('SELECT display_name FROM profiles WHERE id = ?').get('real-person').display_name).toBe('Preserve me')
    } finally { db.close() }
  })
})

describe('durable Amy run checkpoint', () => {
  it('retains progress when deletion evidence is unreadable or a current member failed deletion', () => {
    expect(hasCompletedCheckpointCleanup({ deletion_proof: { verdict: 'unknown' } })).toBe(false)
    expect(hasCompletedCheckpointCleanup({ deletion_proof: { verdict: 'proven' }, cleanup: {
      skipped_ids: [{ reasons: ['delete_error:failure'] }],
    } })).toBe(false)
    expect(hasCompletedCheckpointCleanup({ deletion_proof: { verdict: 'proven' }, cleanup_expired: { error: 'database unavailable' } })).toBe(false)
    expect(hasCompletedCheckpointCleanup({ deletion_proof: { verdict: 'proven' } })).toBe(true)
    expect(hasCompletedCheckpointCleanup({ deletion_proof: { verdict: 'grace_held' } })).toBe(true)
    expect(hasCompletedCheckpointCleanup({ deletion_proof: { verdict: 'unknown' } }, true)).toBe(true)
  })
  it('retains the same plan and completed evaluation through a new reader', async () => {
    const db = new Database(':memory:')
    try {
      const first = await writeAmyRunCheckpoint(db, null, value())
      const next = structuredClone(first.value)
      next.members[0].evaluation = { status: 'ok', findings: [] }
      await writeAmyRunCheckpoint(db, first, next)
      const resumed = await readAmyRunCheckpoint(db)
      expect(resumed.value.run_id).toBe('amy-resume-test')
      expect(resumed.value.members[0].evaluation.status).toBe('ok')
      await clearAmyRunCheckpoint(db, resumed)
      expect(await readAmyRunCheckpoint(db)).toBeNull()
    } finally { db.close() }
  })
  it('refuses stale writers and stale completion instead of losing another update', async () => {
    const db = new Database(':memory:')
    try {
      const first = await writeAmyRunCheckpoint(db, null, value())
      const next = { ...first.value, progress: 1 }
      await writeAmyRunCheckpoint(db, first, next)
      await expect(writeAmyRunCheckpoint(db, first, { ...value(), progress: 2 })).rejects.toThrow(/changed/)
      await expect(clearAmyRunCheckpoint(db, first)).rejects.toThrow(/changed/)
      expect((await readAmyRunCheckpoint(db)).value.progress).toBe(1)
    } finally { db.close() }
  })
  it('fails closed on corrupt persistence', async () => {
    const db = new Database(':memory:')
    try {
      await writeAmyRunCheckpoint(db, null, value())
      db.prepare('UPDATE system_kv SET value = ?').run('{broken')
      await expect(readAmyRunCheckpoint(db)).rejects.toThrow()
    } finally { db.close() }
  })
})
