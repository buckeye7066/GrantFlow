import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'd'.repeat(64)

vi.mock('../services/hamilton/hamiltonAutomationOrchestrator.js', () => ({
  automateSelected: vi.fn(async () => ({})),
  automateSingleSource: vi.fn(async () => ({})),
}))

const { SqliteDb } = await import('../db/index.js')
const migrateManualReceipts = (
  await import('../db/migrations/165_hamilton_manual_submission_receipts.mjs')
).default
const hamiltonRouter = (await import('../routes/hamiltonAutomation.js')).default
const documentsRouter = (await import('../routes/documents.js')).default
const grantApplicationsRouter = (await import('../routes/grantApplications.js')).default
const {
  ensureApplicationTask,
  ensureApplicationTaskSchema,
  getApplicationTask,
  updateApplicationTask,
  _resetSchemaCache,
} = await import('../services/hamilton/applicationTaskStore.js')
const {
  MANUAL_RECEIPT_ATTESTATION_VERSION,
  MAX_MANUAL_RECEIPT_BYTES,
  _internal: manualReceiptInternal,
  validateManualReceiptFile,
} = await import('../services/hamilton/manualSubmissionReceiptStore.js')

const PDF_RECEIPT = Buffer.from('%PDF-1.7\nowner portal confirmation\n%%EOF')
let nextTestClientIp = 10

function createApp(db, user, {
  isAdmin = false,
  identityResolved = true,
  accessibleProfileIds = ['profile-1'],
} = {}) {
  const app = express()
  const testClientIp = `198.51.100.${nextTestClientIp++}`
  app.use(express.json())
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { configurable: true, value: testClientIp })
    req.db = db
    req.user = user
    req.ctx = {
      userId: user?.userId ?? null,
      isAdmin,
      identityResolved,
      accessibleProfileIds: new Set(accessibleProfileIds),
    }
    next()
  })
  app.use('/api/hamilton/automation', hamiltonRouter)
  app.use('/api/documents', documentsRouter)
  app.use('/api/grant-applications', grantApplicationsRouter)
  return app
}

async function makeDb({ migrate = true } = {}) {
  const db = new SqliteDb(':memory:')
  await db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      primary_email TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      created_by TEXT,
      display_name TEXT
    );
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      grant_id TEXT,
      profile_id TEXT,
      university_application_id TEXT,
      university_application_name TEXT,
      name TEXT NOT NULL,
      type TEXT,
      file_url TEXT,
      file_path TEXT,
      file_size INTEGER,
      mime_type TEXT,
      extracted_text TEXT,
      extracted_structured TEXT,
      ai_summary TEXT,
      ai_sections TEXT,
      processing_status TEXT,
      processing_error TEXT,
      status TEXT,
      version INTEGER DEFAULT 1,
      vnext_application_id TEXT,
      storage_uri TEXT,
      content_hash TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE hamilton_autopilot_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      profile_id TEXT,
      status TEXT,
      confirmation_reference TEXT,
      confirmation_screenshot_path TEXT,
      result_json TEXT DEFAULT '{}'
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT,
      sponsor TEXT
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      title TEXT,
      funder TEXT
    );
    CREATE TABLE grant_applications (
      id TEXT PRIMARY KEY
    );
  `)
  _resetSchemaCache()
  await ensureApplicationTaskSchema(db)
  if (migrate) await migrateManualReceipts(db)
  return db
}

async function seedTask(db, {
  ownerId = 'owner-1',
  profileId = 'profile-1',
  taskStatus = 'ready_to_submit',
  outputDocumentId = 'packet-1',
  portalUrl = 'https://apply.grants.gov/application/123',
} = {}) {
  await db.prepare('INSERT INTO users (id, primary_email, is_admin) VALUES (?, ?, ?)')
    .run(ownerId, `${ownerId}@example.org`, false)
  await db.prepare('INSERT INTO profiles (id, user_id, display_name) VALUES (?, ?, ?)')
    .run(profileId, ownerId, 'Synthetic Test Applicant')
  await db.prepare(
    `INSERT INTO documents
       (id, profile_id, name, type, file_size, mime_type, processing_status, status, content_hash)
     VALUES (?, ?, 'Application packet', 'hamilton_generated_application', 6,
             'application/pdf', 'completed', 'final', 'packet-hash')`,
  ).run(outputDocumentId, profileId)
  const task = await ensureApplicationTask(db, {
    profileId,
    userId: ownerId,
    grantId: `grant-${profileId}`,
    automationType: 'portal',
    initialStatus: taskStatus,
  })
  await updateApplicationTask(db, task.id, {
    portalUrl,
    outputDocumentId,
    allowAutoSubmit: true,
    autoSubmitEnabled: true,
  })
  return getApplicationTask(db, task.id)
}

function uploadReceipt(app, taskId, {
  idempotencyKey = 'receipt-request-0001',
  bytes = PDF_RECEIPT,
  contentType = 'application/pdf',
  submittedAt = new Date(Date.now() - 60_000).toISOString(),
  reference = 'PORTAL-CONF-123',
  attested = 'true',
  version = MANUAL_RECEIPT_ATTESTATION_VERSION,
} = {}) {
  return request(app)
    .post(`/api/hamilton/automation/tasks/${taskId}/manual-submission-receipt`)
    .set('Idempotency-Key', idempotencyKey)
    .field('submitted_at', submittedAt)
    .field('confirmation_reference', reference)
    .field('attestation_version', version)
    .field('attested', attested)
    .attach('receipt', bytes, { filename: 'confirmation.pdf', contentType })
}

let db
beforeEach(async () => { db = await makeDb() })
afterEach(async () => { await db?.close() })

describe('manual portal submission receipts', () => {
  it('upgrades the legacy application-task shape before installing receipt triggers', async () => {
    const legacyDb = new SqliteDb(':memory:')
    try {
      await legacyDb.exec(`
        CREATE TABLE profiles (id TEXT PRIMARY KEY);
        CREATE TABLE documents (
          id TEXT PRIMARY KEY,
          content_hash TEXT
        );
        CREATE TABLE application_tasks (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          profile_id TEXT,
          opportunity_id TEXT,
          grant_id TEXT,
          status TEXT,
          current_step TEXT,
          submitted_at DATETIME,
          completed_at DATETIME,
          portal_url TEXT,
          application_url TEXT,
          portal_id TEXT,
          application_id TEXT,
          university_application_id TEXT,
          automation_type TEXT,
          output_document_id TEXT,
          output_pdf_document_id TEXT,
          output_docx_document_id TEXT,
          auto_submit_enabled INTEGER NOT NULL DEFAULT 0,
          allow_auto_submit INTEGER NOT NULL DEFAULT 0
        );
      `)

      await expect(migrateManualReceipts(legacyDb)).resolves.toBeUndefined()
      const taskColumns = await legacyDb.prepare('PRAGMA table_info(application_tasks)').all()
      expect(taskColumns.map((column) => column.name)).toContain('output_proposal_document_id')

      // SQLite recompiles dependent triggers during ALTER TABLE. This is the
      // exact operation that failed when the trigger named a missing column.
      expect(() => legacyDb.exec(
        'ALTER TABLE application_tasks ADD COLUMN later_schema_field TEXT',
      )).not.toThrow()
    } finally {
      await legacyDb.close()
    }
  })

  it('keeps the additive SQLite migration idempotent', async () => {
    await expect(migrateManualReceipts(db)).resolves.toBeUndefined()
    const columns = await db.prepare('PRAGMA table_info(hamilton_manual_submission_receipts)').all()
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'task_id',
      'profile_id',
      'document_id',
      'portal_target_sha256',
      'task_identity_sha256',
      'receipt_sha256',
      'status',
    ]))
    const triggers = await db.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name LIKE 'trg_hamilton_manual_receipt_%'`,
    ).all()
    expect(triggers.map((trigger) => trigger.name)).toEqual(expect.arrayContaining([
      'trg_hamilton_manual_receipt_document_immutable',
      'trg_hamilton_manual_receipt_no_delete',
      'trg_hamilton_manual_receipt_monotonic_revoke',
      'trg_hamilton_manual_receipt_task_identity',
    ]))
  })

  it('atomically binds immutable evidence, preserves packet output, and is exactly idempotent', async () => {
    const task = await seedTask(db)
    const app = createApp(db, { role: 'user', userId: 'owner-1' })
    const submittedAt = new Date(Date.now() - 60_000).toISOString()

    const created = await uploadReceipt(app, task.id, { submittedAt })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    expect(created.body.receipt).toMatchObject({
      task_id: task.id,
      profile_id: 'profile-1',
      channel: 'portal_manual',
      portal_origin: 'https://apply.grants.gov',
      status: 'active',
      idempotent: false,
    })
    for (const privateField of [
      'portal_target_sha256',
      'task_identity_sha256',
      'idempotency_key',
      'request_fingerprint',
    ]) expect(created.body.receipt).not.toHaveProperty(privateField)
    expect(created.body.task).toMatchObject({
      status: 'submitted',
      output_document_id: 'packet-1',
      submission_proof: {
        verified_external: true,
        source: 'owner_attested_manual_receipt',
        evidence_authority: 'owner_attestation',
        independently_verified: false,
      },
    })

    const binding = await db.prepare('SELECT * FROM hamilton_manual_submission_receipts').get()
    expect(binding.portal_target_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(binding.task_identity_sha256).toMatch(/^[a-f0-9]{64}$/)
    const document = await db.prepare(
      'SELECT * FROM documents WHERE id = ? AND profile_id = ?',
    ).get(binding.document_id, 'profile-1')
    expect(document.type).toBe('hamilton_submission_confirmation')
    expect(document.file_bytes).toEqual(PDF_RECEIPT)
    expect(document.file_size).toBe(PDF_RECEIPT.length)
    expect(document.content_hash).toBe(binding.receipt_sha256)

    expect(() => db.prepare('UPDATE documents SET file_bytes = ? WHERE id = ? AND profile_id = ?')
      .run(Buffer.from('%PDF-mutated'), document.id, 'profile-1')).toThrow(/immutable/i)
    expect(() => db.prepare('DELETE FROM documents WHERE id = ? AND profile_id = ?')
      .run(document.id, 'profile-1')).toThrow(/foreign key/i)

    const replay = await uploadReceipt(app, task.id, { submittedAt })
    expect(replay.status).toBe(200)
    expect(replay.body.receipt.id).toBe(binding.id)
    expect(replay.body.receipt.idempotent).toBe(true)
    for (const privateField of [
      'portal_target_sha256',
      'task_identity_sha256',
      'idempotency_key',
      'request_fingerprint',
    ]) expect(replay.body.receipt).not.toHaveProperty(privateField)
    expect((await db.prepare('SELECT COUNT(*) AS count FROM hamilton_manual_submission_receipts').get()).count).toBe(1)
    expect((await db.prepare("SELECT COUNT(*) AS count FROM documents WHERE type = 'hamilton_submission_confirmation'").get()).count).toBe(1)
  })

  it('locks a receipt-bound task against generic, channel, cancel, tracker, and packet rewrites', async () => {
    const task = await seedTask(db)
    const app = createApp(db, { role: 'user', userId: 'owner-1' })
    const submittedAt = new Date(Date.now() - 60_000).toISOString()
    const created = await uploadReceipt(app, task.id, {
      idempotencyKey: 'receipt-identity-lock-1',
      submittedAt,
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)

    const before = await db.prepare('SELECT * FROM application_tasks WHERE id = ?').get(task.id)
    const eventCountBefore = (await db.prepare(
      'SELECT COUNT(*) AS count FROM application_task_events WHERE task_id = ?',
    ).get(task.id)).count
    const documentCountBefore = (await db.prepare('SELECT COUNT(*) AS count FROM documents').get()).count

    await expect(updateApplicationTask(db, task.id, {
      portalUrl: 'https://apply.grants.gov/application/999',
    })).rejects.toMatchObject({ code: 'manual_submission_receipt_active', statusCode: 409 })

    for (const [column, value] of [
      ['status', 'submission_verification_required'],
      ['portal_url', 'https://apply.grants.gov/application/999'],
      ['submitted_at', new Date(Date.now() - 120_000).toISOString()],
      ['output_document_id', 'different-packet'],
      ['grant_id', 'different-grant'],
    ]) {
      expect(() => db.prepare(`UPDATE application_tasks SET ${column} = ? WHERE id = ?`)
        .run(value, task.id)).toThrow(/locks task identity/i)
    }

    for (const endpoint of [
      `/api/hamilton/automation/tasks/${task.id}/mark-mailed`,
      `/api/hamilton/automation/tasks/${task.id}/cancel`,
      `/api/hamilton/automation/tasks/${task.id}/regenerate`,
    ]) {
      const response = await request(app).post(endpoint).send({ reason: 'test conflict' })
      expect(response.status, `${endpoint}: ${JSON.stringify(response.body)}`).toBe(409)
      expect(response.body.error).toBe('manual_submission_receipt_active')
    }

    const trackerReplay = await request(app)
      .post(`/api/grant-applications/${task.id}/submit`)
      .send({})
    expect(trackerReplay.status, JSON.stringify(trackerReplay.body)).toBe(200)
    expect(trackerReplay.body.status).toBe('submitted')

    const after = await db.prepare('SELECT * FROM application_tasks WHERE id = ?').get(task.id)
    expect(after).toMatchObject({
      status: before.status,
      current_step: before.current_step,
      portal_url: before.portal_url,
      submitted_at: before.submitted_at,
      completed_at: before.completed_at,
      output_document_id: before.output_document_id,
      grant_id: before.grant_id,
    })
    expect((await db.prepare(
      'SELECT COUNT(*) AS count FROM application_task_events WHERE task_id = ?',
    ).get(task.id)).count).toBe(eventCountBefore)
    expect((await db.prepare('SELECT COUNT(*) AS count FROM documents').get()).count)
      .toBe(documentCountBefore)
    expect((await getApplicationTask(db, task.id)).submission_proof.verified_external).toBe(true)
    expect((await db.prepare("SELECT COUNT(*) AS count FROM documents WHERE type = 'hamilton_submission_confirmation'").get()).count).toBe(1)
  })

  it('fails proof closed on pre-trigger identity drift and lets explicit revocation quarantine it', async () => {
    const task = await seedTask(db)
    const app = createApp(db, { role: 'user', userId: 'owner-1' })
    const submittedAt = new Date(Date.now() - 60_000).toISOString()
    const created = await uploadReceipt(app, task.id, {
      idempotencyKey: 'receipt-drift-quarantine-1',
      submittedAt,
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)

    // Simulate an older/pre-migration direct writer. Runtime proof must still
    // fail closed even if the DB trigger is absent or temporarily disabled.
    await db.exec('DROP TRIGGER trg_hamilton_manual_receipt_task_identity')
    await db.prepare('UPDATE application_tasks SET portal_url = ? WHERE id = ?')
      .run('https://apply.grants.gov/application/999', task.id)
    expect((await getApplicationTask(db, task.id)).submission_proof.verified_external).toBe(false)

    await db.prepare('UPDATE application_tasks SET portal_url = ?, submitted_at = ?, grant_id = ? WHERE id = ?')
      .run(
        'https://apply.grants.gov/application/123',
        new Date(Date.now() - 120_000).toISOString(),
        'different-grant',
        task.id,
      )
    expect((await getApplicationTask(db, task.id)).submission_proof.verified_external).toBe(false)

    const replay = await uploadReceipt(app, task.id, {
      idempotencyKey: 'receipt-drift-quarantine-1',
      submittedAt,
    })
    expect(replay.status).toBe(409)

    const revoked = await request(app)
      .post(`/api/hamilton/automation/tasks/${task.id}/manual-submission-receipts/${created.body.receipt.id}/revoke`)
      .send({ reason: 'Task identity drifted; quarantine the retained receipt.' })
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200)
    expect(revoked.body.receipt.status).toBe('revoked')
    expect(revoked.body.task).toMatchObject({
      status: 'submission_verification_required',
      submission_proof: { verified_external: false },
    })
  })

  it('reconciles a legacy submitted-without-proof row with explicit owner evidence', async () => {
    const task = await seedTask(db, { taskStatus: 'submitted' })
    expect(task.submission_proof).toMatchObject({ verified_external: false })

    const created = await uploadReceipt(
      createApp(db, { role: 'user', userId: 'owner-1' }),
      task.id,
      { idempotencyKey: 'receipt-submitted-legacy-1' },
    )

    expect(created.status, JSON.stringify(created.body)).toBe(201)
    expect(created.body.task).toMatchObject({
      status: 'submitted',
      submission_proof: {
        verified_external: true,
        source: 'owner_attested_manual_receipt',
        evidence_authority: 'owner_attestation',
        independently_verified: false,
      },
    })
  })

  it('keeps receipt bytes private and the bound document immutable while active and revoked', async () => {
    const task = await seedTask(db)
    const ownerApp = createApp(db, { role: 'user', userId: 'owner-1' })
    const created = await uploadReceipt(ownerApp, task.id, {
      idempotencyKey: 'receipt-document-guard-1',
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const documentId = created.body.receipt.document_id

    const assertProtected = async () => {
      const metadata = await request(ownerApp).get(`/api/documents/${documentId}`)
      expect(metadata.status, JSON.stringify(metadata.body)).toBe(200)
      expect(metadata.body).not.toHaveProperty('file_bytes')
      expect(metadata.body.download_url).toBe(`/api/documents/${documentId}/download`)

      const list = await request(ownerApp).get('/api/documents?profile_id=profile-1')
      expect(list.status, JSON.stringify(list.body)).toBe(200)
      const listedReceipt = list.body.find((document) => document.id === documentId)
      expect(listedReceipt).toBeTruthy()
      expect(listedReceipt).not.toHaveProperty('file_bytes')
      expect(listedReceipt.download_url).toBe(`/api/documents/${documentId}/download`)

      const download = await request(ownerApp).get(`/api/documents/${documentId}/download`)
      expect(download.status, JSON.stringify(download.body)).toBe(200)
      expect(download.headers['cache-control']).toBe('private, no-store')
      expect(download.headers.pragma).toBe('no-cache')
      expect(download.headers['x-content-type-options']).toBe('nosniff')
      expect(download.body).toEqual(PDF_RECEIPT)

      const mutation = await request(ownerApp)
        .put(`/api/documents/${documentId}`)
        .send({ name: 'Reclassified receipt' })
      expect(mutation.status).toBe(409)
      expect(mutation.body.error).toBe('manual_submission_receipt_immutable')

      const deletion = await request(ownerApp).delete(`/api/documents/${documentId}`)
      expect(deletion.status).toBe(409)
      expect(deletion.body.error).toBe('manual_submission_receipt_immutable')
    }

    await assertProtected()

    const outsiderApp = createApp(
      db,
      { role: 'user', userId: 'other-user' },
      { accessibleProfileIds: [] },
    )
    expect((await request(outsiderApp).get(`/api/documents/${documentId}`)).status).toBe(403)
    expect((await request(outsiderApp).get(`/api/documents/${documentId}/download`)).status).toBe(403)

    const revoked = await request(ownerApp)
      .post(`/api/hamilton/automation/tasks/${task.id}/manual-submission-receipts/${created.body.receipt.id}/revoke`)
      .send({ reason: 'Wrong portal confirmation; retain for audit.' })
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200)
    expect(revoked.body.receipt.status).toBe('revoked')

    await assertProtected()
    expect((await db.prepare('SELECT file_bytes FROM documents WHERE id = ?').get(documentId)).file_bytes)
      .toEqual(PDF_RECEIPT)
  })

  it('requires an exact owner but permits a DB-resolved human admin', async () => {
    const task = await seedTask(db)
    await db.prepare('INSERT INTO users (id, primary_email, is_admin) VALUES (?, ?, ?)')
      .run('collaborator-1', 'collaborator@example.org', false)
    await db.prepare('INSERT INTO users (id, primary_email, is_admin) VALUES (?, ?, ?)')
      .run('human-admin-1', 'admin@example.org', true)

    const collaborator = await uploadReceipt(
      createApp(db, { role: 'user', userId: 'collaborator-1' }),
      task.id,
      { idempotencyKey: 'receipt-collaborator-1' },
    )
    expect(collaborator.status).toBe(403)
    expect(collaborator.body.error).toBe('human_owner_required')

    const admin = await uploadReceipt(
      createApp(db, { role: 'admin', userId: 'human-admin-1' }, { isAdmin: true }),
      task.id,
      { idempotencyKey: 'receipt-human-admin-1' },
    )
    expect(admin.status).toBe(201)
    expect(admin.body.receipt.attested_by_user_id).toBe('human-admin-1')
  })

  it.each([
    [{ role: 'admin', is_admin: true, serviceToken: true, userId: 'system_admin_token' }, 'service token'],
    [{ role: 'user', profileTokenAuth: true, userId: 'owner-1', profileId: 'profile-1' }, 'legacy profile token'],
    [{ role: 'user', userId: 'system_admin_token' }, 'reserved synthetic identity'],
  ])('denies %s from making a human attestation (%s)', async (user) => {
    const task = await seedTask(db)
    const response = await uploadReceipt(
      createApp(db, user, { isAdmin: user.serviceToken === true }),
      task.id,
      { idempotencyKey: 'receipt-nonhuman-0001' },
    )
    expect(response.status).toBe(403)
    expect(response.body.error).toBe('human_owner_required')
  })

  it('rejects MIME/signature mismatches and enforces the 10 MiB bound', async () => {
    const task = await seedTask(db)
    const app = createApp(db, { role: 'user', userId: 'owner-1' })

    const mismatch = await uploadReceipt(app, task.id, {
      idempotencyKey: 'receipt-bad-magic-01',
      bytes: Buffer.from('not really a PDF'),
    })
    expect(mismatch.status).toBe(415)
    expect(mismatch.body.error).toBe('receipt_file_signature_mismatch')

    expect(() => validateManualReceiptFile({
      mimetype: 'application/pdf',
      buffer: Buffer.alloc(MAX_MANUAL_RECEIPT_BYTES + 1, 0x25),
    })).toThrow(/10 MiB or smaller/)
    expect(validateManualReceiptFile({
      mimetype: 'image/png',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
    }).mimeType).toBe('image/png')
    expect(validateManualReceiptFile({
      mimetype: 'image/jpeg',
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01]),
    }).mimeType).toBe('image/jpeg')
    expect((await db.prepare('SELECT COUNT(*) AS count FROM hamilton_manual_submission_receipts').get()).count).toBe(0)
  })

  it('does not turn the controlled-beta browser fixture into external proof', async () => {
    const task = await seedTask(db, {
      portalUrl: 'https://hamilton-submit-fixture.invalid/application/123',
    })
    const response = await uploadReceipt(
      createApp(db, { role: 'user', userId: 'owner-1' }),
      task.id,
      { idempotencyKey: 'receipt-fixture-denied' },
    )
    expect(response.status).toBe(422)
    expect(response.body.error).toBe('portal_origin_not_external')
    expect((await getApplicationTask(db, task.id)).submission_proof.verified_external).toBe(false)
  })

  it('rejects canonical placeholder domains, including example.* subdomains', async () => {
    const placeholderUrls = [
      'https://example.com/application/123',
      'https://portal.example.com/application/123',
      'https://example.org/application/123',
      'https://funding.example.org/application/123',
      'https://example.net/application/123',
      'https://portal.example.net/application/123',
      'https://example.gov/application/123',
      'https://portal.example.gov/application/123',
      'https://placeholder.org/application/123',
      'https://test.com/application/123',
    ]
    for (const portalUrl of placeholderUrls) {
      expect(() => manualReceiptInternal.deriveTaskPortalBinding({ portal_url: portalUrl }))
        .toThrow(/real server-recorded HTTPS portal/i)
    }

    const task = await seedTask(db, { portalUrl: 'https://funding.example.org/application/123' })
    const response = await uploadReceipt(
      createApp(db, { role: 'user', userId: 'owner-1' }),
      task.id,
      { idempotencyKey: 'receipt-placeholder-denied' },
    )
    expect(response.status, JSON.stringify(response.body)).toBe(422)
    expect(response.body.error).toBe('portal_origin_not_external')
    expect((await db.prepare('SELECT COUNT(*) AS count FROM hamilton_manual_submission_receipts').get()).count).toBe(0)
    expect((await db.prepare("SELECT COUNT(*) AS count FROM documents WHERE type = 'hamilton_submission_confirmation'").get()).count).toBe(0)
    expect(await getApplicationTask(db, task.id)).toMatchObject({
      status: 'ready_to_submit',
      submission_proof: { verified_external: false },
    })
  })

  it('revokes append-only, invalidates proof, and preserves output/evidence', async () => {
    const task = await seedTask(db)
    const app = createApp(db, { role: 'user', userId: 'owner-1' })
    const created = await uploadReceipt(app, task.id, { idempotencyKey: 'receipt-revoke-0001' })
    expect(created.status).toBe(201)

    const revoked = await request(app)
      .post(`/api/hamilton/automation/tasks/${task.id}/manual-submission-receipts/${created.body.receipt.id}/revoke`)
      .send({ reason: 'The owner uploaded the wrong portal confirmation.' })
    expect(revoked.status).toBe(200)
    expect(revoked.body.receipt.status).toBe('revoked')
    expect(revoked.body.task).toMatchObject({
      status: 'submission_verification_required',
      output_document_id: 'packet-1',
      submission_proof: { verified_external: false },
    })
    expect((await db.prepare('SELECT COUNT(*) AS count FROM hamilton_manual_submission_receipts').get()).count).toBe(1)
    expect((await db.prepare("SELECT COUNT(*) AS count FROM documents WHERE type = 'hamilton_submission_confirmation'").get()).count).toBe(1)
    expect(() => db.prepare('DELETE FROM hamilton_manual_submission_receipts WHERE id = ?')
      .run(created.body.receipt.id)).toThrow(/append-only/i)
    expect(() => db.prepare("UPDATE hamilton_manual_submission_receipts SET status = 'active' WHERE id = ?")
      .run(created.body.receipt.id)).toThrow(/append-only/i)

    const replay = await request(app)
      .post(`/api/hamilton/automation/tasks/${task.id}/manual-submission-receipts/${created.body.receipt.id}/revoke`)
      .send({ reason: 'The owner uploaded the wrong portal confirmation.' })
    expect(replay.status).toBe(200)
    expect(replay.body.receipt.idempotent).toBe(true)
  })

  it('fails closed when the rolling migration is missing', async () => {
    await db.close()
    db = await makeDb({ migrate: false })
    const task = await seedTask(db)
    const app = createApp(db, { role: 'user', userId: 'owner-1' })

    const response = await uploadReceipt(app, task.id, { idempotencyKey: 'receipt-rolling-db-1' })
    expect(response.status).toBe(503)
    expect(response.body.error).toBe('manual_receipt_schema_unavailable')
    expect(await getApplicationTask(db, task.id)).toMatchObject({
      status: 'ready_to_submit',
      submission_proof: { verified_external: false },
    })
  })
})
