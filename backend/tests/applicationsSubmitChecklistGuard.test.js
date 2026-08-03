/**
 * Bug #4 — "Mark submitted" was a silent one-click status flip past
 * "Checklist: 0/6 done" (live walkthrough 2026-08-03).
 *
 * Guard: applyEngine.markSubmitted now refuses (409 CHECKLIST_INCOMPLETE,
 * naming the incomplete items) unless the caller explicitly acknowledges via
 * `confirmIncomplete` — wired to the UI's hard-confirm step. Hamilton's
 * autopilot mirror (`metadata.submitted_by === 'hamilton'`) stays exempt BY
 * DESIGN: it records a submission that already happened on the real portal,
 * gated by its own evidence rules (PRs #1105/#1107) — semantics unchanged.
 * The HTTP route additionally strips a client-supplied 'hamilton' provenance
 * claim (an HTTP caller must not fake autopilot provenance to skip the
 * confirm).
 */

import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

const Database = (await import('better-sqlite3')).default
const { markSubmitted, setChecklistItem } = await import('../apply/applyEngine.js')
const applicationsRouter = (await import('../routes/applications.js')).default

function makeSqliteWrapper(db) {
  return {
    dialect: 'sqlite',
    prepare(sql) {
      const stmt = db.prepare(sql)
      return {
        get: (...args) => stmt.get(...args),
        all: (...args) => stmt.all(...args),
        run: (...args) => stmt.run(...args),
      }
    },
    exec(sql) {
      return db.exec(sql)
    },
    async withTransaction(fn) {
      db.exec('BEGIN')
      try {
        const result = await fn(this)
        db.exec('COMMIT')
        return result
      } catch (e) {
        try { db.exec('ROLLBACK') } catch { /* ignore */ }
        throw e
      }
    },
  }
}

function makeDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, organization_id TEXT, profile_id TEXT, title TEXT, funder TEXT,
      status TEXT DEFAULT 'in_progress', url TEXT, application_url TEXT, portal_url TEXT,
      application_method TEXT, submitted_date TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE milestones (
      id TEXT PRIMARY KEY, grant_id TEXT, organization_id TEXT, title TEXT, description TEXT,
      due_date DATE, completed BOOLEAN DEFAULT 0, completed_date DATE, type TEXT,
      reminder_days INTEGER DEFAULT 7,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE applications (
      id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, organization_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft', submission_method TEXT, submitted_at DATETIME,
      exported_at DATETIME, portal_url TEXT, snapshot_json TEXT, artifact_uri TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(grant_id, organization_id)
    );
    CREATE TABLE application_sections (
      id TEXT PRIMARY KEY, application_id TEXT NOT NULL, section_key TEXT NOT NULL,
      title TEXT, content TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(application_id, section_key)
    );
    CREATE TABLE application_checklist_items (
      id TEXT PRIMARY KEY, application_id TEXT NOT NULL, key TEXT NOT NULL,
      label TEXT, status TEXT NOT NULL DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(application_id, key)
    );
    CREATE TABLE application_artifacts (
      id TEXT PRIMARY KEY, application_id TEXT NOT NULL, format TEXT NOT NULL,
      uri TEXT, byte_size INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(application_id, format)
    );
    INSERT INTO organizations (id, name) VALUES ('o-1', 'Org One');
    INSERT INTO grants (id, organization_id, title, funder, status)
      VALUES ('g-1', 'o-1', 'TMEF Medical Education Scholarship', 'TMEF', 'in_progress');
    INSERT INTO applications (id, grant_id, organization_id, status)
      VALUES ('app-1', 'g-1', 'o-1', 'draft');
  `)
  return makeSqliteWrapper(raw)
}

async function seedChecklist(db, statuses) {
  for (const [key, status] of Object.entries(statuses)) {
    await setChecklistItem({ db, applicationId: 'app-1', key, label: `Item ${key}`, status })
  }
}

describe('markSubmitted checklist guard (engine)', () => {
  let db
  beforeEach(() => {
    db = makeDb()
  })

  it('REFUSES with 409 CHECKLIST_INCOMPLETE when items are pending and nothing was confirmed', async () => {
    await seedChecklist(db, { confirm_deadline: 'pending', final_review: 'pending', submit_application: 'pending' })
    let thrown = null
    try {
      await markSubmitted({ db, applicationId: 'app-1', method: 'portal' })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeTruthy()
    expect(thrown.status).toBe(409)
    expect(thrown.code).toBe('CHECKLIST_INCOMPLETE')
    expect(thrown.details.incomplete_checklist.map((i) => i.key).sort()).toEqual([
      'confirm_deadline', 'final_review', 'submit_application',
    ])
    const app = await db.prepare('SELECT status FROM applications WHERE id = ?').get('app-1')
    expect(app.status).toBe('draft') // nothing recorded
  })

  it("a 'blocked' item counts as incomplete, not done", async () => {
    await seedChecklist(db, { gather_required_docs: 'blocked' })
    await expect(markSubmitted({ db, applicationId: 'app-1', method: 'portal' })).rejects.toMatchObject({
      code: 'CHECKLIST_INCOMPLETE',
    })
  })

  it('records the submission once the caller explicitly confirms the incomplete items', async () => {
    await seedChecklist(db, { confirm_deadline: 'pending' })
    const updated = await markSubmitted({ db, applicationId: 'app-1', method: 'portal', confirmIncomplete: true })
    expect(String(updated.status).toLowerCase()).toBe('submitted')
    expect(updated.submitted_at).toBeTruthy()
  })

  it('records normally when every checklist item is done', async () => {
    await seedChecklist(db, { confirm_deadline: 'done', final_review: 'done' })
    const updated = await markSubmitted({ db, applicationId: 'app-1', method: 'download' })
    expect(String(updated.status).toLowerCase()).toBe('submitted')
  })

  it("Hamilton's evidence-backed mirror stays exempt (autopilot semantics unchanged)", async () => {
    await seedChecklist(db, { confirm_deadline: 'pending' })
    const updated = await markSubmitted({
      db,
      applicationId: 'app-1',
      method: 'portal',
      metadata: { submitted_by: 'hamilton', submission_reference: 'conf-123', task_id: 't-1' },
    })
    expect(String(updated.status).toLowerCase()).toBe('submitted')
  })
})

describe('POST /api/applications/:id/submit (route)', () => {
  let db
  beforeEach(() => {
    db = makeDb()
  })

  function appWith(user = { role: 'admin', userId: 'u-1' }) {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.db = db
      req.user = user
      req.ctx = { isAdmin: true, userId: user.userId, accessibleOrgIds: null, accessibleProfileIds: new Set() }
      next()
    })
    app.use('/api/applications', applicationsRouter)
    // Mirror the app's central error handler contract minimally.
    app.use((err, _req, res, _next) => {
      res.status(err?.status || 500).json({ error: err?.code || 'INTERNAL', message: err?.message })
    })
    return app
  }

  it('409s with the named incomplete items — the walkthrough click no longer silently records', async () => {
    await seedChecklist(db, { confirm_deadline: 'pending', final_review: 'pending' })
    const res = await request(appWith()).post('/api/applications/app-1/submit').send({ method: 'portal' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('CHECKLIST_INCOMPLETE')
    expect(res.body.incomplete_checklist.length).toBe(2)
    const app = await db.prepare('SELECT status FROM applications WHERE id = ?').get('app-1')
    expect(app.status).toBe('draft')
  })

  it('200s when the client sends confirm_incomplete: true (the hard-confirm step)', async () => {
    await seedChecklist(db, { confirm_deadline: 'pending' })
    const res = await request(appWith())
      .post('/api/applications/app-1/submit')
      .send({ method: 'portal', confirm_incomplete: true })
    expect(res.status).toBe(200)
    expect(String(res.body.application.status).toLowerCase()).toBe('submitted')
  })

  it("an HTTP client cannot fake Hamilton provenance to skip the confirm", async () => {
    await seedChecklist(db, { confirm_deadline: 'pending' })
    const res = await request(appWith())
      .post('/api/applications/app-1/submit')
      .send({ method: 'portal', metadata: { submitted_by: 'hamilton' } })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('CHECKLIST_INCOMPLETE')
  })

  it('a complete checklist submits without any confirm flag', async () => {
    await seedChecklist(db, { confirm_deadline: 'done' })
    const res = await request(appWith()).post('/api/applications/app-1/submit').send({ method: 'download' })
    expect(res.status).toBe(200)
    expect(String(res.body.application.status).toLowerCase()).toBe('submitted')
  })
})
