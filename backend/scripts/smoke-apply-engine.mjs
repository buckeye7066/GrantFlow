import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'

import {
  compileApplicationPackage,
  exportApplicationPackage,
  markSubmitted,
  prepareApplication,
  setChecklistItem,
  upsertSection,
  validateApplication,
} from '../apply/applyEngine.js'

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
        try {
          db.exec('ROLLBACK')
        } catch {
          // ignore
        }
        throw e
      }
    },
  }
}

function assert(condition, message) {
  if (!condition) {
    const err = new Error(message || 'assertion failed')
    err.code = 'ASSERTION_FAILED'
    throw err
  }
}

async function main() {
  // Isolate artifacts in temp dir.
  const tmpDir = path.join(os.tmpdir(), `grantflow-apply-smoke-${crypto.randomUUID().slice(0, 8)}`)
  process.env.APPLY_STORAGE_DIR = tmpDir

  const raw = new Database(':memory:')
  const db = makeSqliteWrapper(raw)

  // Minimal schema for smoke test.
  db.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      title TEXT NOT NULL,
      funder TEXT,
      status TEXT DEFAULT 'discovered',
      application_url TEXT,
      portal_url TEXT,
      application_method TEXT,
      application_steps TEXT,
      contact_name TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE milestones (
      id TEXT PRIMARY KEY,
      grant_id TEXT,
      organization_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      due_date DATE,
      completed BOOLEAN DEFAULT 0,
      completed_date DATE,
      type TEXT,
      reminder_days INTEGER DEFAULT 7,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE applications (
      id TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      submission_method TEXT,
      submitted_at DATETIME,
      exported_at DATETIME,
      portal_url TEXT,
      snapshot_json TEXT,
      artifact_uri TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(grant_id, organization_id)
    );

    CREATE TABLE application_sections (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      title TEXT,
      content TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(application_id, section_key)
    );

    CREATE TABLE application_checklist_items (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      key TEXT NOT NULL,
      label TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(application_id, key)
    );

    CREATE TABLE application_artifacts (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      format TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)

  const orgId = crypto.randomUUID()
  const grantId = crypto.randomUUID()

  db.prepare('INSERT INTO organizations (id, name) VALUES (?, ?)').run(orgId, 'Smoke Org')
  db.prepare('INSERT INTO grants (id, organization_id, title, funder, status, application_url) VALUES (?, ?, ?, ?, ?, ?)').run(
    grantId,
    orgId,
    'Smoke Grant',
    'Smoke Funder',
    'drafting',
    'https://example.com/apply',
  )

  const app = await prepareApplication({ db, grantId, organizationId: orgId, userId: 'smoke-user' })
  assert(app?.id, 'prepareApplication should return application id')

  await upsertSection({
    db,
    applicationId: app.id,
    sectionKey: 'project_narrative',
    title: 'Project Narrative',
    content: 'This is a smoke-test narrative.',
  })

  await setChecklistItem({ db, applicationId: app.id, key: 'confirm_deadline', label: 'Confirm deadline', status: 'done' })
  await setChecklistItem({ db, applicationId: app.id, key: 'confirm_eligibility', label: 'Confirm eligibility', status: 'done' })

  const validation = await validateApplication({ db, applicationId: app.id })
  assert(validation?.ok === true, 'validateApplication should return ok')

  const compiled = await compileApplicationPackage({ db, applicationId: app.id })
  assert(compiled?.ok === true, 'compileApplicationPackage should return ok')
  assert(Array.isArray(compiled.sections) && compiled.sections.length >= 1, 'compiled should include sections')

  const exportedZip = await exportApplicationPackage({ db, applicationId: app.id, format: 'zip' })
  assert(exportedZip?.ok === true, 'zip export should return ok')
  assert(exportedZip?.artifact?.download_url, 'zip export should return download_url')

  const exportedDocx = await exportApplicationPackage({ db, applicationId: app.id, format: 'docx' })
  assert(exportedDocx?.ok === true, 'docx export should return ok')
  assert(exportedDocx?.artifact?.download_url, 'docx export should return download_url')

  const artifacts = db.prepare('SELECT * FROM application_artifacts WHERE application_id = ?').all(app.id)
  assert(artifacts.length === 2, 'should persist 2 artifacts')
  for (const a of artifacts) {
    assert(fs.existsSync(a.storage_path), `artifact file missing on disk: ${a.storage_path}`)
  }

  const submitted = await markSubmitted({
    db,
    applicationId: app.id,
    method: 'download',
    metadata: { confirmed: true },
  })
  assert(String(submitted?.status || '').toLowerCase() === 'submitted', 'markSubmitted should set status=submitted')

  console.log('[smoke-apply-engine] OK', {
    applicationId: app.id,
    artifacts: artifacts.map((a) => ({ id: a.id, format: a.format })),
    storageDir: tmpDir,
  })
}

main().catch((err) => {
  console.error('[smoke-apply-engine] FAILED', err)
  process.exit(1)
})

