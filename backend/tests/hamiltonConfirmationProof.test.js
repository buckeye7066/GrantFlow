/**
 * Privacy-minimized, attempt-bound submission proof.
 *
 * OWNER GOAL: an application reported "submitted externally" must leave durable,
 * retrievable evidence the owner can OPEN — not a claim, and not a path to a
 * file Railway wiped on the next deploy.
 *
 * The confirmed gap: captureConfirmation wrote the screenshot to
 * os.tmpdir() (the orchestrator never passed a screenshotsDir), so on Railway's
 * ephemeral filesystem the proof evaporated while the DB kept a dangling path.
 *
 * Pins:
 *   1. Generic browser capture keeps only typed receipt metadata + hashes; it
 *      never persists full-page screenshots/HTML containing application data.
 *   2. A receipt candidate needs a new typed receipt/reference, acknowledgement,
 *      and post-dispatch page change; Application ID alone is only draft identity.
 *   3. Legacy artifact helpers remain honest about dangling bytes, but legacy
 *      task status/artifacts never establish the v2 externally-received state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'b'.repeat(64)

vi.mock('../services/hamilton/hamiltonAutopilotEngine.js', async (importOriginal) => {
  const mod = await importOriginal()
  return { ...mod, runAutopilot: vi.fn() }
})

vi.mock('../services/hamilton/hamiltonPreflight.js', async (importOriginal) => {
  const mod = await importOriginal()
  return { ...mod, preflightSingleSource: vi.fn(async () => ({ ok: true, blockers: [], warnings: [] })) }
})

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const { runAutopilot, _internal: engineInternal } = await import('../services/hamilton/hamiltonAutopilotEngine.js')
const { automateSingleSource } = await import('../services/hamilton/hamiltonAutomationOrchestrator.js')
const {
  confirmationCaptureDirPath,
  isEphemeralCaptureDir,
  registerConfirmationArtifact,
  assessStoredConfirmationProof,
} = await import('../services/hamilton/hamiltonConfirmationArtifacts.js')
const { _resetSchemaCache } =
  await import('../services/hamilton/applicationTaskStore.js')
const { _resetAuthSchemaCache } = await import('../services/hamilton/hamiltonAuthorizationStore.js')

const PROFILE = 'profile-durable-proof'
const tmpDirs = []

function makeTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, created_by TEXT, display_name TEXT);
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, profile_id TEXT, title TEXT, description TEXT,
      application_url TEXT, source_url TEXT
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, profile_id TEXT, funding_opportunity_id TEXT, title TEXT,
      application_url TEXT, status TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      organization_id TEXT, grant_id TEXT, profile_id TEXT,
      university_application_id TEXT, university_application_name TEXT,
      name TEXT, type TEXT, file_url TEXT, file_path TEXT, file_size INTEGER,
      mime_type TEXT, file_bytes BLOB, extracted_text TEXT,
      processing_status TEXT, notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_documents (profile_id TEXT, document_id TEXT);
  `)
  const db = wrapSqlite(sqlite)
  _resetSchemaCache()
  _resetAuthSchemaCache()
  return db
}

async function seedFixture(db) {
  await db.prepare('INSERT INTO profiles (id, user_id, display_name) VALUES (?, ?, ?)')
    .run(PROFILE, 'user-1', 'Focus Forward Ministry')
  await db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
    .run(PROFILE, 'basic_information', JSON.stringify({ first_name: 'Focus', last_name: 'Forward', email: 'ffm@example.org' }))
  await db.prepare('INSERT INTO funding_opportunities (id, title, description, application_url) VALUES (?, ?, ?, ?)')
    .run('opp-1', 'Community Ministry Grant', 'Apply through the portal.', 'https://portal.example.org/apply')
  await db.prepare('INSERT INTO grants (id, profile_id, funding_opportunity_id, title) VALUES (?, ?, ?, ?)')
    .run('g-1', PROFILE, 'opp-1', 'Community Ministry Grant')
}

const AUTHORIZATIONS = {
  complete_forms: true, save_drafts: false, generate_narratives: false,
  submit_applications: true, use_saved_credentials_reference: false,
  use_saved_session: false, upload_documents: false, use_standing_attestation: false,
}

const savedEnv = {}
beforeEach(() => {
  runAutopilot.mockReset()
  savedEnv.enabled = process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION
  savedEnv.allow = process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST
  savedEnv.gate = process.env.HAMILTON_TAILORED_APPROVAL_GATE
  savedEnv.uploads = process.env.UPLOADS_DIR
  savedEnv.confdir = process.env.HAMILTON_CONFIRMATION_DIR
  process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = 'true'
  process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = ''
  process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
})
afterEach(() => {
  process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = savedEnv.enabled
  process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = savedEnv.allow
  if (savedEnv.gate === undefined) delete process.env.HAMILTON_TAILORED_APPROVAL_GATE
  else process.env.HAMILTON_TAILORED_APPROVAL_GATE = savedEnv.gate
  if (savedEnv.uploads === undefined) delete process.env.UPLOADS_DIR
  else process.env.UPLOADS_DIR = savedEnv.uploads
  if (savedEnv.confdir === undefined) delete process.env.HAMILTON_CONFIRMATION_DIR
  else process.env.HAMILTON_CONFIRMATION_DIR = savedEnv.confdir
  while (tmpDirs.length) {
    try { fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

// ── 1. Durable capture dir (never tmp in prod) ──────────────────────────────

describe('resolveConfirmationCaptureDir', () => {
  it('uses UPLOADS_DIR (the persistent volume), not tmp', () => {
    const dir = confirmationCaptureDirPath({ NODE_ENV: 'production', UPLOADS_DIR: '/data/uploads' })
    expect(dir).toBe(path.join('/data/uploads', 'hamilton-confirmations'))
    expect(isEphemeralCaptureDir(dir)).toBe(false)
  })

  it('NEVER falls back to tmp in production even with no UPLOADS_DIR', () => {
    const dir = confirmationCaptureDirPath({ NODE_ENV: 'production' })
    expect(dir).toBe(path.join('/data/uploads', 'hamilton-confirmations'))
    expect(isEphemeralCaptureDir(dir)).toBe(false)
  })

  it('an explicit HAMILTON_CONFIRMATION_DIR wins', () => {
    const dir = confirmationCaptureDirPath({ HAMILTON_CONFIRMATION_DIR: '/mnt/vol/confs', UPLOADS_DIR: '/data/uploads' })
    expect(dir).toBe(path.resolve('/mnt/vol/confs'))
  })

  it('falls back to an ephemeral tmp dir only in dev/test with no volume', () => {
    const dir = confirmationCaptureDirPath({})
    expect(isEphemeralCaptureDir(dir)).toBe(true)
  })
})

// ── 2. assessSubmissionEvidence honesty is unchanged ────────────────────────

describe('assessSubmissionEvidence requires a new typed post-click receipt', () => {
  const { assessSubmissionEvidence } = engineInternal
  it('accepts only a labelled receipt plus acknowledgement and changed page fingerprint', () => {
    const preClick = { reference: null, page_fingerprint: 'a'.repeat(64) }
    expect(assessSubmissionEvidence({
      reference: 'CONF-10001',
      reference_kind: 'confirmation',
      extraction_rule: 'explicit_label:confirmation_number',
      received_acknowledgement: true,
      page_fingerprint: 'b'.repeat(64),
    }, preClick))
      .toEqual({ ok: true, confirmation_evidence: 'portal_reference' })
    expect(assessSubmissionEvidence({
      reference: 'CONF-10001', reference_kind: 'confirmation',
      extraction_rule: 'explicit_label:confirmation_number',
      received_acknowledgement: false, page_fingerprint: 'b'.repeat(64),
    }, preClick))
      .toEqual({ ok: false, confirmation_evidence: 'none' })
    expect(assessSubmissionEvidence({ reference: null, screenshot_path: '/tmp/untrusted.png' }, preClick))
      .toEqual({ ok: false, confirmation_evidence: 'none' })
  })
})

// ── 3. Conservative extraction: new real patterns, same false-positive floor ─

describe('extractConfirmationReference — new real patterns, no fabrication', () => {
  const { extractConfirmationReference, extractConfirmationReferenceFromUrl, detectReceiptAcknowledgement } = engineInternal

  it('accepts a labelled Confirmation #', () => {
    expect(extractConfirmationReference('Confirmation #: ABC12345')).toBe('ABC12345')
  })
  it('accepts Reference:', () => {
    expect(extractConfirmationReference('Reference: REF-2026-00123')).toBe('REF-2026-00123')
  })
  it('rejects a pre-existing draft Application ID', () => {
    expect(extractConfirmationReference('Application ID: APP-99881')).toBeNull()
  })
  it('accepts an abbreviated Ref No.', () => {
    expect(extractConfirmationReference('Your application has been received. Ref No. 7781234')).toBe('7781234')
  })
  it('STILL rejects the known false positive "Application designed…"', () => {
    expect(extractConfirmationReference('Application designed to help students apply for aid')).toBeNull()
  })
  it('extracts a submission id from the post-submit URL query', () => {
    expect(extractConfirmationReferenceFromUrl('https://portal.example.org/apply/confirm?confirmationId=SUB1234567'))
      .toBe('SUB1234567')
  })
  it('extracts a submission id from a post-submit URL path segment', () => {
    expect(extractConfirmationReferenceFromUrl('https://portal.example.org/confirmation/CONF-778812'))
      .toBe('CONF-778812')
  })
  it('a too-short URL value is NOT a reference', () => {
    expect(extractConfirmationReferenceFromUrl('https://portal.example.org/apply?ref=home')).toBeNull()
  })
  it('detects a receipt acknowledgement as a boolean signal (never a reference)', () => {
    expect(detectReceiptAcknowledgement('Your application has been received.')).toBe(true)
    expect(detectReceiptAcknowledgement('Thank you for your submission!')).toBe(true)
    expect(detectReceiptAcknowledgement('Please complete every required field below.')).toBe(false)
  })
})

// ── captureConfirmation retains structured proof, never a raw page ──────────

describe('captureConfirmation minimizes sensitive confirmation-page data', () => {
  const { captureConfirmation } = engineInternal

  function fakePage({ url, bodyText, html }) {
    return {
      url: () => url,
      locator: () => ({ innerText: async () => bodyText }),
      content: async () => html,
      screenshot: async ({ path: p }) => { fs.writeFileSync(p, Buffer.from('\x89PNG-fake')) },
    }
  }

  it('keeps acknowledgement + fingerprint but writes no screenshot or HTML', async () => {
    const dir = makeTmpDir('gf-cap-')
    const secretCanary = 'SSN-123-45-6789-INCOME-90000'
    const conf = await captureConfirmation(fakePage({
      url: 'https://portal.example.org/done',
      bodyText: `Your application has been received. ${secretCanary}`,
      html: `<html><body>Your application has been received. ${secretCanary}</body></html>`,
    }), dir)

    expect(conf.reference).toBeNull() // no printed reference
    expect(conf.received_acknowledgement).toBe(true)
    expect(conf.page_fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(conf).not.toHaveProperty('screenshot_path')
    expect(conf).not.toHaveProperty('page_html_path')
    expect(conf).not.toHaveProperty('page_text')
    expect(JSON.stringify(conf)).not.toContain(secretCanary)
    expect(fs.readdirSync(dir)).toEqual([])
  })
})

// ── registerConfirmationArtifact + backfill honesty ─────────────────────────

describe('registerConfirmationArtifact makes proof retrievable, and the reader is honest', () => {
  it('registers a documents row with durable bytes, and proof survives the on-disk copy being gone', async () => {
    const db = makeDb()
    await seedFixture(db)
    const dir = makeTmpDir('gf-art-')
    const shot = path.join(dir, 'confirmation_1.png')
    const page = path.join(dir, 'confirmation_1.html')
    fs.writeFileSync(shot, Buffer.from('\x89PNG-real-bytes'))
    fs.writeFileSync(page, '<html><body>Confirmation #: ABC12345</body></html>', 'utf8')

    const artifact = await registerConfirmationArtifact(db, {
      profileId: PROFILE, grantId: 'g-1', opportunityId: 'opp-1', taskId: 'task-1',
      title: 'Community Ministry Grant', screenshotPath: shot, pageHtmlPath: page,
      pageText: 'Confirmation #: ABC12345', reference: 'ABC12345',
      capturedUrl: 'https://portal.example.org/done',
    })
    expect(artifact.screenshot_document_id).toBeTruthy()
    expect(artifact.page_document_id).toBeTruthy()

    const row = await db.prepare('SELECT * FROM documents WHERE id = ?').get(artifact.screenshot_document_id)
    expect(row.mime_type).toBe('image/png')
    expect(row.file_bytes && row.file_bytes.length).toBeGreaterThan(0)

    // The proof is retrievable purely from the DB bytes — delete the disk copy.
    fs.rmSync(shot)
    fs.rmSync(page)
    const verdict = await assessStoredConfirmationProof(db, {
      confirmation_screenshot_path: shot,
      result: { confirmation_document_id: artifact.screenshot_document_id },
    })
    expect(verdict.proof_retrievable).toBe(true)
    expect(verdict.source).toBe('document')
  })

  it('BACKFILL HONESTY: a dangling screenshot path with no document reads as NO proof', async () => {
    const db = makeDb()
    const missing = path.join(makeTmpDir('gf-missing-'), 'gone.png') // never created
    const verdict = await assessStoredConfirmationProof(db, {
      confirmation_screenshot_path: missing,
      result: {},
    })
    expect(verdict.proof_retrievable).toBe(false)
    expect(verdict.reason).toBe('screenshot_path_missing_on_disk')
  })
})

// ── Server-side profile toggle is required before any browser/proof path ─────

describe('profile automation preference defaults off', () => {
  it('does not invoke the engine or accept its mocked legacy submitted result', async () => {
    runAutopilot.mockResolvedValue({
      status: 'submitted',
      confirmation_reference: 'UNBOUND-LEGACY-RECEIPT',
    })
    const db = makeDb()
    await seedFixture(db)
    const result = await automateSingleSource(db, {
      profileId: PROFILE, userId: 'user-1',
      source: { opportunity_id: 'opp-1', grant_id: 'g-1' },
      options: { authorizations: AUTHORIZATIONS },
    })

    expect(runAutopilot).not.toHaveBeenCalled()
    expect(result.task.status).toBe('ready_to_start')
    expect(result.task.status).not.toBe('submitted')
    expect(result.task.submission_proof).toMatchObject({
      verified_external: false, state: 'not_submitted',
    })
  })
})
