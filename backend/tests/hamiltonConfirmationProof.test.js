/**
 * Durable, owner-retrievable submission PROOF (2026-08-03).
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
 *   1. A submitted run persists a RETRIEVABLE artifact (a `documents` row whose
 *      bytes live in documents.file_bytes) under a DURABLE dir, not tmp.
 *   2. assessSubmissionEvidence still REFUSES to claim submitted with nothing
 *      captured (that honesty is unchanged).
 *   3. Extraction accepts the new real patterns (Confirmation #, Ref/Reference,
 *      Application ID, a submission id in the post-submit URL) and STILL rejects
 *      the known false positive ("Application designed…").
 *   4. Backfill honesty: a run whose confirmation_screenshot_path points at a
 *      now-missing file reports proof as NOT retrievable.
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
  resolveConfirmationCaptureDir,
  isEphemeralCaptureDir,
  registerConfirmationArtifact,
  assessStoredConfirmationProof,
} = await import('../services/hamilton/hamiltonConfirmationArtifacts.js')
const { ensureApplicationTask, updateApplicationTask, _resetSchemaCache } =
  await import('../services/hamilton/applicationTaskStore.js')
const { _resetAuthSchemaCache, recordAuthorizations } = await import('../services/hamilton/hamiltonAuthorizationStore.js')

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
  await db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
    .run(PROFILE, 'automation_preferences', JSON.stringify({ automations: { hamilton_auto_submit: true, hamilton_autopilot: true } }))
  await db.prepare('INSERT INTO funding_opportunities (id, title, description, application_url) VALUES (?, ?, ?, ?)')
    .run('opp-1', 'Community Ministry Grant', 'Apply through the portal.', 'https://hamilton-submit-fixture.invalid/apply')
  await db.prepare('INSERT INTO grants (id, profile_id, funding_opportunity_id, title) VALUES (?, ?, ?, ?)')
    .run('g-1', PROFILE, 'opp-1', 'Community Ministry Grant')
}

const savedEnv = {}
beforeEach(() => {
  runAutopilot.mockReset()
  savedEnv.enabled = process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION
  savedEnv.allow = process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST
  savedEnv.gate = process.env.HAMILTON_TAILORED_APPROVAL_GATE
  savedEnv.uploads = process.env.UPLOADS_DIR
  savedEnv.confdir = process.env.HAMILTON_CONFIRMATION_DIR
  savedEnv.autosubmit = process.env.HAMILTON_ALLOW_AUTOSUBMIT
  process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = 'true'
  process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = ''
  process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
  process.env.HAMILTON_ALLOW_AUTOSUBMIT = 'true'
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
  if (savedEnv.autosubmit === undefined) delete process.env.HAMILTON_ALLOW_AUTOSUBMIT
  else process.env.HAMILTON_ALLOW_AUTOSUBMIT = savedEnv.autosubmit
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

describe('assessSubmissionEvidence requires a genuinely new receipt signal', () => {
  const {
    assessSubmissionEvidence,
    detectReceiptAcknowledgement,
    mergeSubmitCapture,
    submitCaptureResult,
    submitCaptureHistoryResult,
  } = engineInternal
  it('accepts a new reference without requiring a URL change', () => {
    expect(assessSubmissionEvidence({ reference: 'CONF-1', screenshot_path: null }))
      .toEqual({ ok: true, confirmation_evidence: 'portal_reference' })
    expect(assessSubmissionEvidence(
      { reference: 'CONF-2', url: 'https://portal.example.org/apply' },
      { reference: 'CONF-1', url: 'https://portal.example.org/apply' },
    )).toEqual({ ok: true, confirmation_evidence: 'portal_reference' })
  })

  it('URL change, same reference, and screenshots remain attempt evidence', () => {
    expect(assessSubmissionEvidence(
      {
        reference: 'conf-1',
        url: 'https://portal.example.org/done',
        screenshot_path: '/tmp/s.png',
        page_html_path: '/tmp/p.html',
        received_acknowledgement: false,
      },
      {
        reference: 'CONF-1',
        url: 'https://portal.example.org/apply',
        received_acknowledgement: false,
      },
    )).toEqual({ ok: false, confirmation_evidence: 'attempt_evidence' })
    expect(assessSubmissionEvidence({ reference: null, screenshot_path: '/tmp/s.png' }))
      .toEqual({ ok: false, confirmation_evidence: 'attempt_evidence' })
    expect(assessSubmissionEvidence({
      reference: null,
      screenshot_path: '/tmp/s.png',
      received_acknowledgement: true,
    }, { received_acknowledgement: false }))
      .toEqual({ ok: true, confirmation_evidence: 'portal_acknowledgement' })
    expect(assessSubmissionEvidence({ reference: null, screenshot_path: null }))
      .toEqual({ ok: false, confirmation_evidence: 'none' })
  })

  it('a real acknowledgement that lands on a distinct confirmation URL counts even if similar text existed before (brittleness fix)', () => {
    expect(assessSubmissionEvidence(
      { received_acknowledgement: true, url: 'https://portal.example.org/confirmation/123', screenshot_path: '/tmp/s.png' },
      { received_acknowledgement: true, url: 'https://portal.example.org/apply' },
    )).toEqual({ ok: true, confirmation_evidence: 'portal_acknowledgement' })
  })

  it('a stale acknowledgement with NO url move still does NOT count (honesty floor held)', () => {
    expect(assessSubmissionEvidence(
      { received_acknowledgement: true, url: 'https://portal.example.org/apply', screenshot_path: '/tmp/s.png' },
      { received_acknowledgement: true, url: 'https://portal.example.org/apply' },
    )).toEqual({ ok: false, confirmation_evidence: 'attempt_evidence' })
  })

  it('detectReceiptAcknowledgement matches the broadened post-submit phrasings, not pre-submit text', () => {
    expect(detectReceiptAcknowledgement('Confirmation number: 84213')).toBe(true)
    expect(detectReceiptAcknowledgement('You have successfully applied.')).toBe(true)
    expect(detectReceiptAcknowledgement('Your application is now under review.')).toBe(true)
    expect(detectReceiptAcknowledgement('Please review your application before you submit.')).toBe(false)
  })

  it('retains earlier and later post-click captures while classifying the bundle honestly', () => {
    const merged = mergeSubmitCapture(
      {
        url: 'https://portal.example.org/apply', reference: 'OLD-12345',
        screenshot_path: '/captures/first.png', page_html_path: '/captures/first.html',
        page_text: 'Submitting…', received_acknowledgement: false,
      },
      {
        url: 'https://portal.example.org/done', reference: 'OLD-12345',
        screenshot_path: null, page_html_path: '/captures/final.html',
        page_text: 'Thank you for your submission', received_acknowledgement: true,
      },
    )
    expect(merged.screenshot_path).toBe('/captures/first.png')
    expect(merged.page_html_path).toBe('/captures/final.html')

    expect(submitCaptureResult(merged, {
      url: 'https://portal.example.org/apply',
      reference: 'OLD-12345',
      received_acknowledgement: false,
    })).toEqual(expect.objectContaining({
      submit_clicked: true,
      confirmation_evidence: 'portal_acknowledgement',
      submission_evidence_classification: 'confirmation_proof',
      confirmation_reference: 'OLD-12345',
      confirmation_reference_is_new: false,
      confirmation_screenshot_path: '/captures/first.png',
      confirmation_page_html_path: '/captures/final.html',
      confirmation_received_acknowledgement: true,
      confirmation_received_acknowledgement_is_new: true,
      confirmation_url_changed: true,
    }))

    const historyResult = submitCaptureHistoryResult([
      {
        url: 'https://portal.example.org/apply', reference: 'OLD-12345',
        screenshot_path: '/captures/first.png', page_html_path: '/captures/first.html',
        page_text: 'Submitting…', received_acknowledgement: false,
      },
      {
        url: 'https://portal.example.org/done', reference: 'OLD-12345',
        screenshot_path: '/captures/final.png', page_html_path: '/captures/final.html',
        page_text: 'Thank you for your submission', received_acknowledgement: true,
      },
    ], {
      url: 'https://portal.example.org/apply',
      reference: 'OLD-12345',
      received_acknowledgement: false,
    })
    expect(historyResult.submission_evidence_classification).toBe('confirmation_proof')
    expect(historyResult.confirmation_evidence).toBe('portal_acknowledgement')
    expect(historyResult.submission_attempt_captures).toHaveLength(2)
    expect(historyResult.submission_attempt_captures.map((capture) => capture.screenshot_path))
      .toEqual(['/captures/first.png', '/captures/final.png'])
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
  it('accepts Application ID:', () => {
    expect(extractConfirmationReference('Application ID: APP-99881')).toBe('APP-99881')
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

// ── captureConfirmation writes a durable screenshot AND saved page ──────────

describe('captureConfirmation saves the screenshot AND the confirmation page', () => {
  const { captureConfirmation } = engineInternal

  function fakePage({ url, bodyText, html }) {
    return {
      url: () => url,
      locator: () => ({ innerText: async () => bodyText }),
      content: async () => html,
      screenshot: async ({ path: p }) => { fs.writeFileSync(p, Buffer.from('\x89PNG-fake')) },
    }
  }

  it('captures both artifacts even when the portal prints no reference number', async () => {
    const dir = makeTmpDir('gf-cap-')
    const conf = await captureConfirmation(fakePage({
      url: 'https://portal.example.org/done',
      bodyText: 'Your application has been received. We will be in touch.',
      html: '<html><body>Your application has been received.</body></html>',
    }), dir)

    expect(conf.reference).toBeNull() // no printed reference
    expect(conf.received_acknowledgement).toBe(true)
    expect(conf.screenshot_path).toBeTruthy()
    expect(fs.existsSync(conf.screenshot_path)).toBe(true)
    expect(conf.page_html_path).toBeTruthy()
    expect(fs.readFileSync(conf.page_html_path, 'utf8')).toContain('has been received')
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
      referenceIsNew: true,
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
      confirmation_reference: 'ABC12345',
      result: {
        confirmation_document_id: artifact.screenshot_document_id,
        confirmation_reference: 'ABC12345',
        confirmation_reference_is_new: true,
        confirmation_evidence: 'portal_reference',
      },
    })
    expect(verdict.proof_retrievable).toBe(true)
    expect(verdict.source).toBe('document')

    const flagWithoutAcknowledgement = await assessStoredConfirmationProof(db, {
      confirmation_screenshot_path: shot,
      result: {
        confirmation_document_id: artifact.screenshot_document_id,
        confirmation_evidence: 'portal_acknowledgement',
        confirmation_received_acknowledgement_is_new: true,
      },
    })
    expect(flagWithoutAcknowledgement.proof_retrievable).toBe(false)
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

  it('stores acknowledgement/screenshots without a new reference as attempt evidence, never proof', async () => {
    const db = makeDb()
    await seedFixture(db)
    const dir = makeTmpDir('gf-attempt-')
    const shot = path.join(dir, 'attempt.png')
    const page = path.join(dir, 'attempt.html')
    fs.writeFileSync(shot, Buffer.from('\x89PNG-attempt'))
    fs.writeFileSync(page, '<html><body>Thank you for your submission.</body></html>', 'utf8')

    const artifact = await registerConfirmationArtifact(db, {
      profileId: PROFILE, grantId: 'g-1', opportunityId: 'opp-1', taskId: 'task-1',
      title: 'Community Ministry Grant', screenshotPath: shot, pageHtmlPath: page,
      pageText: 'Thank you for your submission.', reference: 'OLD-REFERENCE-12345',
      referenceIsNew: false,
      capturedUrl: 'https://portal.example.org/done',
    })
    expect(artifact.evidence_classification).toBe('attempt_evidence')
    const doc = await db.prepare('SELECT type, notes FROM documents WHERE id = ?')
      .get(artifact.screenshot_document_id)
    expect(doc.type).toBe('hamilton_submission_attempt_evidence')
    expect(doc.notes).toMatch(/receipt is not confirmed/i)

    const verdict = await assessStoredConfirmationProof(db, {
      confirmation_screenshot_path: shot,
      result: {
        confirmation_document_id: artifact.screenshot_document_id,
        confirmation_page_document_id: artifact.page_document_id,
        confirmation_evidence: 'attempt_evidence',
        confirmation_reference: 'OLD-REFERENCE-12345',
        confirmation_reference_is_new: false,
        confirmation_received_acknowledgement: true,
        confirmation_page_html_path: page,
      },
    })
    expect(verdict.proof_retrievable).toBe(false)
    expect(verdict.attempt_evidence_retrievable).toBe(true)
    expect(verdict.reason).toBe('attempt_evidence_is_not_confirmation_proof')
  })

  it('treats an unclassified reference as attempt evidence instead of inferring that it is new', async () => {
    const db = makeDb()
    await seedFixture(db)
    const dir = makeTmpDir('gf-unclassified-ref-')
    const shot = path.join(dir, 'attempt.png')
    fs.writeFileSync(shot, Buffer.from('\x89PNG-unclassified-reference'))

    const artifact = await registerConfirmationArtifact(db, {
      profileId: PROFILE, grantId: 'g-1', opportunityId: 'opp-1', taskId: 'task-1',
      title: 'Community Ministry Grant', screenshotPath: shot,
      reference: 'UNCLASSIFIED-12345',
    })

    expect(artifact.evidence_classification).toBe('attempt_evidence')
    const doc = await db.prepare('SELECT type FROM documents WHERE id = ?')
      .get(artifact.screenshot_document_id)
    expect(doc.type).toBe('hamilton_submission_attempt_evidence')

    const verdict = await assessStoredConfirmationProof(db, {
      confirmation_screenshot_path: shot,
      confirmation_reference: 'UNCLASSIFIED-12345',
      result: {
        confirmation_document_id: artifact.screenshot_document_id,
        confirmation_evidence: 'portal_reference',
        confirmation_reference: 'UNCLASSIFIED-12345',
      },
    })
    expect(verdict.proof_retrievable).toBe(false)
    expect(verdict.attempt_evidence_retrievable).toBe(true)
  })

  it('stores a newly appearing receipt acknowledgement as confirmation proof', async () => {
    const db = makeDb()
    await seedFixture(db)
    const dir = makeTmpDir('gf-ack-proof-')
    const shot = path.join(dir, 'acknowledgement.png')
    const page = path.join(dir, 'acknowledgement.html')
    fs.writeFileSync(shot, Buffer.from('\x89PNG-acknowledgement'))
    fs.writeFileSync(page, '<html><body>Thank you for your submission.</body></html>', 'utf8')

    const artifact = await registerConfirmationArtifact(db, {
      profileId: PROFILE, grantId: 'g-1', opportunityId: 'opp-1', taskId: 'task-1',
      title: 'Community Ministry Grant', screenshotPath: shot, pageHtmlPath: page,
      pageText: 'Thank you for your submission.', reference: null,
      referenceIsNew: false,
      receivedAcknowledgement: true,
      receivedAcknowledgementIsNew: true,
      capturedUrl: 'https://portal.example.org/done',
    })
    expect(artifact.evidence_classification).toBe('confirmation_proof')
    const doc = await db.prepare('SELECT type, notes FROM documents WHERE id = ?')
      .get(artifact.screenshot_document_id)
    expect(doc.type).toBe('hamilton_submission_confirmation')
    expect(doc.notes).toMatch(/newly appearing receipt acknowledgement/i)

    const verdict = await assessStoredConfirmationProof(db, {
      confirmation_screenshot_path: shot,
      result: {
        confirmation_document_id: artifact.screenshot_document_id,
        confirmation_page_document_id: artifact.page_document_id,
        confirmation_evidence: 'portal_acknowledgement',
        confirmation_reference: null,
        confirmation_reference_is_new: false,
        confirmation_received_acknowledgement: true,
        confirmation_received_acknowledgement_is_new: true,
        confirmation_page_html_path: page,
      },
    })
    expect(verdict.proof_retrievable).toBe(true)
    expect(verdict.source).toBe('document')
  })

  it('does not promote an acknowledgement newness flag without an actual acknowledgement', async () => {
    const db = makeDb()
    await seedFixture(db)
    const dir = makeTmpDir('gf-ack-flag-only-')
    const shot = path.join(dir, 'attempt.png')
    fs.writeFileSync(shot, Buffer.from('\x89PNG-attempt'))

    const artifact = await registerConfirmationArtifact(db, {
      profileId: PROFILE, grantId: 'g-1', opportunityId: 'opp-1', taskId: 'task-1',
      title: 'Community Ministry Grant', screenshotPath: shot,
      receivedAcknowledgement: false,
      receivedAcknowledgementIsNew: true,
    })

    expect(artifact.evidence_classification).toBe('attempt_evidence')
    const doc = await db.prepare('SELECT type FROM documents WHERE id = ?')
      .get(artifact.screenshot_document_id)
    expect(doc.type).toBe('hamilton_submission_attempt_evidence')
  })
})

// ── 1 (headline). A submitted run persists a retrievable artifact, durably ───

describe('a submitted run persists retrievable proof under a durable dir (not tmp)', () => {
  it('registers the confirmation as an owner-retrievable document on the task', async () => {
    const uploads = makeTmpDir('gf-uploads-') // stands in for the Railway volume
    process.env.UPLOADS_DIR = uploads
    const durableDir = resolveConfirmationCaptureDir()
    expect(isEphemeralCaptureDir(durableDir)).toBe(false) // NOT the ephemeral tmp fallback

    // The engine (mocked) writes its screenshot into the DURABLE dir and returns
    // the captured proof, exactly as the real engine now does.
    const shot = path.join(durableDir, `confirmation_${Date.now()}.png`)
    const pageHtml = path.join(durableDir, `confirmation_${Date.now()}.html`)
    fs.writeFileSync(shot, Buffer.from('\x89PNG-real'))
    fs.writeFileSync(pageHtml, '<html><body>Confirmation #: ZZ778812</body></html>', 'utf8')
    runAutopilot.mockImplementation(async ({ beforeSubmit }) => {
      const boundary = await beforeSubmit()
      expect(boundary.allow).toBe(true)
      return {
        status: 'submitted',
        submission_attempt_started: true,
        submit_clicked: true,
        confirmation_evidence: 'portal_reference',
        confirmation_reference: 'ZZ778812',
        confirmation_reference_is_new: true,
        confirmation_screenshot_path: shot,
        confirmation_page_html_path: pageHtml,
        confirmation_page_text: 'Confirmation #: ZZ778812',
        confirmation_url: 'https://hamilton-submit-fixture.invalid/done',
        filled_fields: [{ key: 'essay', fid: 'f1', value: 'x' }],
        pages_visited: 2, trace: [],
      }
    })

    const db = makeDb()
    await seedFixture(db)
    const task = await ensureApplicationTask(db, {
      profileId: PROFILE, opportunityId: 'opp-1', grantId: 'g-1', automationType: 'portal',
    })
    await updateApplicationTask(db, task.id, { allowAutoSubmit: true })
    await recordAuthorizations(db, {
      userId: 'user-1',
      profileId: PROFILE,
      scope: 'funding_source',
      fundingSourceIds: ['opp-1'],
      authorizationTypes: ['complete_forms', 'submit_applications'],
      authorizationText: 'Test authorization',
      authorizationVersion: 'hamilton-autopilot-test-v1',
      options: { require_human_review: false },
      replaceOmittedTypes: true,
    })

    const result = await automateSingleSource(db, {
      profileId: PROFILE, userId: 'user-1',
      source: { opportunity_id: 'opp-1', grant_id: 'g-1' },
      options: {},
    })

    // The engine was handed the durable capture dir, never tmp.
    expect(runAutopilot.mock.calls[0][0].screenshotsDir).toBe(durableDir)

    // The task now carries a retrievable proof document.
    expect(result.task.status).toBe('submitted')
    const proofId = result.task.output_document_id
    expect(proofId).toBeTruthy()

    const doc = await db.prepare('SELECT * FROM documents WHERE id = ?').get(proofId)
    expect(doc).toBeTruthy()
    expect(doc.type).toBe('hamilton_submission_confirmation')
    expect(doc.file_bytes && doc.file_bytes.length).toBeGreaterThan(0)

    // And the reader confirms the proof is genuinely retrievable.
    const verdict = await assessStoredConfirmationProof(db, {
      confirmation_screenshot_path: shot,
      confirmation_reference: 'ZZ778812',
      result: {
        confirmation_document_id: proofId,
        confirmation_reference: 'ZZ778812',
        confirmation_reference_is_new: true,
        confirmation_evidence: 'portal_reference',
      },
    })
    expect(verdict.proof_retrievable).toBe(true)
  })

  it('accepts a newly appearing acknowledgement only when its confirmation page is retained', async () => {
    const uploads = makeTmpDir('gf-ack-uploads-')
    process.env.UPLOADS_DIR = uploads
    const durableDir = resolveConfirmationCaptureDir()
    const shot = path.join(durableDir, `acknowledgement_${Date.now()}.png`)
    const pageHtml = path.join(durableDir, `acknowledgement_${Date.now()}.html`)
    fs.writeFileSync(shot, Buffer.from('\x89PNG-ack'))
    fs.writeFileSync(pageHtml, '<html><body>Thank you for your submission.</body></html>', 'utf8')
    runAutopilot.mockImplementation(async ({ beforeSubmit }) => {
      const boundary = await beforeSubmit()
      expect(boundary.allow).toBe(true)
      return {
        status: 'submitted',
        submission_attempt_started: true,
        submit_clicked: true,
        confirmation_evidence: 'portal_acknowledgement',
        confirmation_reference: null,
        confirmation_reference_is_new: false,
        confirmation_received_acknowledgement: true,
        confirmation_received_acknowledgement_is_new: true,
        confirmation_screenshot_path: shot,
        confirmation_page_html_path: pageHtml,
        confirmation_page_text: 'Thank you for your submission.',
        confirmation_url: 'https://hamilton-submit-fixture.invalid/done',
        filled_fields: [{ key: 'essay', fid: 'f1', value: 'x' }],
        pages_visited: 2,
        trace: [],
      }
    })

    const db = makeDb()
    await seedFixture(db)
    const task = await ensureApplicationTask(db, {
      profileId: PROFILE, opportunityId: 'opp-1', grantId: 'g-1', automationType: 'portal',
    })
    await updateApplicationTask(db, task.id, { allowAutoSubmit: true })
    await recordAuthorizations(db, {
      userId: 'user-1',
      profileId: PROFILE,
      scope: 'funding_source',
      fundingSourceIds: ['opp-1'],
      authorizationTypes: ['complete_forms', 'submit_applications'],
      authorizationText: 'Test authorization',
      authorizationVersion: 'hamilton-autopilot-test-v1',
      options: { require_human_review: false },
      replaceOmittedTypes: true,
    })

    const result = await automateSingleSource(db, {
      profileId: PROFILE,
      userId: 'user-1',
      source: { opportunity_id: 'opp-1', grant_id: 'g-1' },
      options: {},
    })

    expect(result.task.status).toBe('submitted')
    expect(result.autopilot_result.confirmation_evidence).toBe('portal_acknowledgement')
    expect(result.autopilot_result.confirmation_document_id).toBeTruthy()
    const doc = await db.prepare('SELECT type FROM documents WHERE id = ?')
      .get(result.autopilot_result.confirmation_document_id)
    expect(doc.type).toBe('hamilton_submission_confirmation')
  })
})
