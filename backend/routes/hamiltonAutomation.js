/**
 * /api/hamilton/automation/*
 *
 * Top-level "Automate with Hamilton" surface. Adds the bulk select-many
 * entry point and channel-specific submission acks (mark-mailed,
 * mark-emailed, mark-faxed) on top of the existing
 * /api/application-tasks endpoints.
 *
 * Endpoints:
 *   POST   /api/hamilton/automation/start                       — bulk start automation for selected sources
 *   POST   /api/hamilton/automation/tasks/:taskId/regenerate    — regenerate the packet (e.g. after profile edits)
 *   POST   /api/hamilton/automation/tasks/:taskId/mark-mailed   — record physical mail submission
 *   POST   /api/hamilton/automation/tasks/:taskId/mark-emailed  — record email submission
 *   POST   /api/hamilton/automation/tasks/:taskId/mark-faxed    — record fax submission
 *   POST   /api/hamilton/automation/tasks/:taskId/manual-submission-receipt — bind owner-uploaded portal proof
 *   POST   /api/hamilton/automation/tasks/:taskId/manual-submission-receipts/:receiptId/revoke — revoke binding
 *   POST   /api/hamilton/automation/tasks/:taskId/approve       — explicit user approval to submit
 *   GET    /api/hamilton/automation/tasks                       — list automation tasks scoped to caller
 *   GET    /api/hamilton/automation/tasks/:taskId               — fetch one with classification + outputs
 *
 * All routes require the caller to be authenticated. Mutations require
 * the caller to own (or be an admin for) the target profile.
 */

import express from 'express'
import rateLimit from 'express-rate-limit'
import multer from 'multer'
import {
  requireAuthenticatedUser,
  requireResolvedIdentity,
  getAccessibleProfileIds,
  getAuthUserId,
  isProfileOwner,
} from '../utils/accessControl.js'
import { isReservedSyntheticUserId } from '../middleware/syntheticServiceTokens.js'
import {
  getApplicationTask,
  listApplicationTasks,
  updateApplicationTask,
  cancelApplicationTask,
  appendTaskEvent,
  listTaskEvents,
  listMissingInfo,
} from '../services/hamilton/applicationTaskStore.js'
import { listScopedHamiltonTasks } from '../services/hamilton/hamiltonTaskListing.js'
import { cancelActiveHamiltonTaskRun } from '../services/hamilton/hamiltonRunCancellation.js'
import {
  automateSelected,
  automateSingleSource,
} from '../services/hamilton/hamiltonAutomationOrchestrator.js'
import { generateAndSavePacket } from '../services/hamilton/hamiltonApplicationPacketGenerator.js'
import { emitHamiltonNotificationToProfileAndAdmins } from '../services/hamilton/hamiltonNotifications.js'
import {
  recordAuthorizations,
  revokeAuthorization,
  getAuthorizationById,
  listActiveAuthorizations,
  HAMILTON_AUTHORIZATION_TYPES,
  listAutopilotRuns,
} from '../services/hamilton/hamiltonAuthorizationStore.js'
import {
  preflightSelected,
  readAuthorizations,
} from '../services/hamilton/hamiltonPreflight.js'
import { preflightAndResolveSelected } from '../services/hamilton/hamiltonPreflightResolver.js'
import { getHamiltonReadiness, computeHamiltonCalendarEvents, emitSessionCaptureReminders, emitPortalSyncReminders } from '../services/hamilton/hamiltonScheduleService.js'
import { deriveNamePartsIntoBasicInfo } from '../../shared/nameParsing.js'
import { listPortalProviders } from '../services/hamilton/hamiltonPortalProviders.js'
import {
  authorizePayment,
  canPayFor,
  revokePaymentAuthorization,
  getPaymentAuthorizationById,
  listPaymentAuthorizations,
  PAYMENT_CATEGORIES,
} from '../services/hamilton/hamiltonPaymentAuthorizationService.js'
import {
  importSession,
  listSessionsForProfile,
  getSessionById,
  revokeSession,
  markSessionExpired,
} from '../services/hamilton/hamiltonCredentialSessionService.js'
import {
  CAPTURE_DISCLAIMER,
  createCaptureRequest,
  listCaptureRequests,
  getCaptureRequest,
  completeCaptureRequest,
  cancelCaptureRequest,
  markLaunched,
} from '../services/hamilton/hamiltonSessionCaptureRequests.js'
import {
  isCloudLoginConfigured,
  startCloudLogin,
  getCloudLoginMeta,
  getCloudLoginSession,
  registerCloudLoginViewer,
  startScreencast,
  dispatchInput,
  captureCloudLoginState,
  releaseCloudLoginCompletion,
  finalizeCloudLogin,
  cancelCloudLogin,
  cloudLoginStatus,
} from '../services/hamilton/hamiltonCloudLogin.js'
import {
  CONTROLLED_BETA_SYNTHETIC_BROWSER_HOST,
  controlledBetaBrowserRefusal,
  isControlledBetaSyntheticBrowserUrl,
} from '../services/hamilton/controlledBetaBrowserPolicy.js'
import {
  saveCredential,
  saveGeneratedCredential,
  listCredentialsForProfile,
  getCredentialById,
  deleteCredential,
  revealPasswordOnceById,
  listManagedCredentials,
  moveManagedCredential,
  copyManagedCredentialToProfile,
  deleteManagedCredential,
} from '../services/hamilton/hamiltonPortalCredentialService.js'
import { importCredentialsFromCsv } from '../services/hamilton/hamiltonCredentialCsvImport.js'
import { suggestPortalLogin } from '../services/hamilton/hamiltonPortalLoginSuggester.js'
import { getAuthWatchSummary } from '../services/hamilton/hamiltonAuthWatchService.js'
import { flagMissingPortalCredential } from '../services/hamilton/hamiltonMissingCredential.js'
import {
  authorizeAttestation,
  revokeAttestation,
  getAttestationById,
  listActiveAttestations,
  ATTESTATION_CATEGORIES,
} from '../services/hamilton/hamiltonAttestationStore.js'
import {
  getPolicyFor,
  upsertPolicy,
  listPolicies,
  getPortalWallStatus,
  recordPortalWallObservation,
} from '../services/hamilton/hamiltonPortalPolicyRegistry.js'
import { classifyBlocker, isServerWallSignal } from '../services/hamilton/hamiltonBlockerClassifier.js'
import {
  saveResolvedField,
  listResolvedFields,
} from '../services/hamilton/hamiltonResolvedFieldStore.js'
import {
  listBlockersForTask,
  listOpenAdminBlockers,
  resolveOpenBlockersForTask,
  resolveBlockerById,
  getBlocker,
} from '../services/hamilton/hamiltonBlockerStore.js'
import { buildHamiltonProfileSummary } from '../services/hamilton/hamiltonProfileSummary.js'
import { resolveBlocker } from '../services/hamilton/hamiltonHardStopResolver.js'
import { resolveProfileFieldTarget, inlineFieldForBlocker } from '../services/hamilton/profileFieldTargets.js'
import { setProfileSectionField } from '../services/profileFieldWriter.js'
import { HAMILTON_ADMIN_EMAIL } from '../services/hamilton/hamiltonAdminAccount.js'
import { markNotificationsResolved } from '../services/hamilton/hamiltonNotifications.js'
import {
  MANUAL_RECEIPT_ATTESTATION_VERSION,
  MAX_MANUAL_RECEIPT_BYTES,
  ManualSubmissionReceiptError,
  recordManualSubmissionReceipt,
  revokeManualSubmissionReceipt,
} from '../services/hamilton/manualSubmissionReceiptStore.js'
import { createLogger } from '../utils/logger.js'

export const HAMILTON_AUTOPILOT_AUTHORIZATION_TEXT = (
  'Hamilton will prepare the selected application(s) using the profile information '
  + 'and authorized documents on file. Hamilton may open portals, fill forms, upload '
  + 'documents, generate narratives, and save drafts. Final portal Submit and portal '
  + 'account creation remain visible human handoffs. Hamilton never bypasses login, '
  + 'CAPTCHA, 2FA, payment, signatures, attestations, or owner approval.'
)
export const HAMILTON_AUTOPILOT_AUTHORIZATION_VERSION = 'hamilton-autopilot-v1'

const log = createLogger('route:hamilton-automation')

const SUBMISSION_MAY_BE_IN_FLIGHT_STATUSES = new Set([
  'submit_attempt_started',
  'submit_evidence_pending',
  'submission_verification_required',
])

export function resolveConfiguredHamiltonFrontendOrigin(env = process.env) {
  const candidates = [
    env.AUTH_FRONTEND_URL,
    env.FRONTEND_BASE_URL,
    env.PUBLIC_APP_URL,
    env.GRANTFLOW_APP_BASE_URL,
  ]
  for (const raw of candidates) {
    const value = String(raw || '').trim()
    if (!value) continue
    try {
      const parsed = new URL(value)
      if (!['http:', 'https:'].includes(parsed.protocol)) continue
      if (parsed.username || parsed.password) continue
      return parsed.origin
    } catch {
      // Ignore malformed optional configuration and fail closed below.
    }
  }
  return null
}

const router = express.Router()

const startLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', retry_after_ms: 60_000 },
})

const manualReceiptLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', retry_after_ms: 15 * 60_000 },
})

// Evidence is held only in bounded process memory until the atomic DB write.
// Multer's disk storage and caller-supplied filesystem paths are never used.
const manualReceiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_MANUAL_RECEIPT_BYTES,
    files: 1,
    fields: 5,
    parts: 6,
    fieldSize: 4096,
  },
})

function parseManualReceipt(req, res, next) {
  manualReceiptUpload.single('receipt')(req, res, (error) => {
    if (!error) return next()
    if (error?.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'receipt_file_too_large', message: 'The receipt must be 10 MiB or smaller.' })
    }
    if (error instanceof multer.MulterError) {
      return res.status(400).json({ error: 'invalid_receipt_upload', message: 'Invalid receipt upload.' })
    }
    return res.status(400).json({ error: 'invalid_receipt_upload', message: 'Invalid receipt upload.' })
  })
}

function sendManualReceiptError(res, error) {
  if (error instanceof ManualSubmissionReceiptError) {
    return res.status(error.statusCode || error.status || 400).json({
      error: error.code,
      message: error.message,
    })
  }
  // Never log uploaded evidence, filenames, receipt references, or multipart
  // parser objects. An unexpected failure is deliberately opaque to callers.
  return res.status(500).json({ error: 'manual_receipt_failed' })
}

/**
 * Resolve the exact task/profile human authority before accepting multipart
 * bytes. Shared-access collaborators, legacy profile tokens, service tokens,
 * and reserved synthetic identities cannot attest an external submission.
 */
async function requireHumanOwnedReceiptTask(req, res, next) {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  if (!requireResolvedIdentity(req, res)) return
  const actorUserId = getAuthUserId(user)
  if (
    !actorUserId
    || user?.serviceToken === true
    || user?.profileTokenAuth === true
    || isReservedSyntheticUserId(actorUserId)
  ) {
    return res.status(403).json({ error: 'human_owner_required' })
  }

  try {
    const task = await getApplicationTask(req.db, String(req.params.taskId))
    if (!task) return res.status(404).json({ error: 'task_not_found' })
    if (!(await isProfileOwner(req.db, user, task.profile_id))) {
      return res.status(403).json({ error: 'human_owner_required' })
    }
    req.hamiltonManualReceiptContext = {
      user,
      task,
      actorUserId: String(actorUserId),
    }
    return next()
  } catch (error) {
    return sendManualReceiptError(res, error)
  }
}

async function userMayAccessProfile(req, user, profileId) {
  if (!profileId) return false
  // DB-backed admin only. The previous `user?.role === 'admin'` shortcut trusted
  // the raw JWT role claim, so a real user demoted in users.is_admin but holding
  // an unexpired role:'admin' token bypassed the DB-backed context and got
  // cross-profile access to every caller of this helper (Hamilton start,
  // payment/session/attestation/resolved-field reads, revoke/expire).
  if (req.ctx?.isAdmin === true) return true
  const accessible = await getAccessibleProfileIds(req.db, user)
  if (accessible === null) return true // DB-backed admin (isAdminUserWithDb) => global access
  return accessible.has(String(profileId))
}

// Load the FULL profile — the base row PLUS every profile_sections blob nested
// under its section_key — so preflight and automation can "parse the whole
// profile" instead of only seeing the bare profiles columns. This used to
// return just `SELECT * FROM profiles`, which left profile.basic_information
// (and every other section) undefined; preflight then raised false "missing
// first name / last name / email / school" hard stops for data that was sitting
// right there in profile_sections. Mirrors loadProfileBundle (orchestrator) and
// hamiltonApplicationAgent.loadProfile, including the read-time name-derivation
// safety net so a profile carrying only full_name/display_name still resolves
// first_name/last_name.
async function loadProfile(db, profileId) {
  if (!db || !profileId) return null
  try {
    const row = await db.prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1').get(String(profileId))
    if (!row) return null
    let sectionRows = []
    try {
      sectionRows = await db
        .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
        .all(String(profileId))
    } catch { sectionRows = [] }
    const sections = {}
    for (const r of sectionRows || []) {
      try { sections[r.section_key] = typeof r.data === 'string' ? JSON.parse(r.data) : r.data } catch { /* ignore */ }
    }
    // Read-time safety net: derive first/last from full_name or the profile's
    // display_name so preflight never false-flags names the backfill migration
    // has not split yet.
    try {
      const derived = deriveNamePartsIntoBasicInfo(sections.basic_information || {}, row.display_name)
      if (derived.changed) sections.basic_information = derived.data
    } catch { /* non-fatal */ }
    return { ...row, sections, ...sections }
  } catch { return null }
}

// Run a long-running automation orchestration detached from the HTTP request so
// the response returns immediately (browser automation routinely exceeds the
// gateway timeout). The orchestrator writes task state to the DB as it goes, so
// progress is observable via GET /tasks. Errors are logged, never thrown into a
// already-sent response. The db handle (pool/singleton) stays valid after the
// response is flushed, so the closure can keep using req.db.
function runAutomationInBackground(label, work) {
  Promise.resolve()
    .then(work)
    .catch((err) => log.error('background_automation_failed', { label, err: err?.message }))
}

async function loadTaskAndAuthorise(req, res, taskId) {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return null
  const task = await getApplicationTask(req.db, String(taskId))
  if (!task) {
    res.status(404).json({ error: 'task_not_found' })
    return null
  }
  if (!(await userMayAccessProfile(req, user, task.profile_id))) {
    res.status(403).json({ error: 'forbidden' })
    return null
  }
  return { user, task }
}

// Auth + profile-scope guard for routes that take an explicit profileId from
// the request (query or body). Sends 401 / 400 / 403 and returns null on
// failure; otherwise returns the authenticated user. Centralizing this closes
// the gap where the payment / session / attestation / resolved-field surfaces
// trusted a caller-supplied profileId without verifying access (cross-profile
// bleed).
async function requireProfileScope(req, res, profileId) {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return null
  const pid = String(profileId || '').trim()
  if (!pid) {
    res.status(400).json({ error: 'profileId required' })
    return null
  }
  if (!(await userMayAccessProfile(req, user, pid))) {
    res.status(403).json({ error: 'forbidden' })
    return null
  }
  return user
}

// Admin-only guard for the admin vault management surface. Canonical admin
// truth is DB-backed (req.ctx.isAdmin); we also accept the admin-token flow
// (req.user.is_admin) so the in-app admin panel and the import tooling both work.
function requireAdmin(req, res) {
  // DB-backed admin only (req.ctx.isAdmin). The admin-token flow is admitted
  // because buildRequestContext resolves ctx.isAdmin=true for the admin/anya
  // tokens; a raw req.user.role/is_admin JWT claim must NOT gate this.
  if (req.ctx?.isAdmin === true) return true
  res.status(403).json({ error: 'admin_required' })
  return false
}

// Provenance for a newly-saved credential: an admin acting in the app marks it
// 'admin' (visible/movable from the admin vault); a profile user marks it 'user'
// (private to that profile, never surfaced to the admin vault).
function actorManagedBy(req) {
  return req.ctx?.isAdmin === true ? 'admin' : 'user'
}

// Auth + ownership guard for :id routes on profile-scoped records. Loads the
// owning row via loader(db, id), 404s if missing, then verifies the caller may
// access the row's profile before any mutation (revoke / expire). Returns
// { user, row } or null after the response has been sent.
async function requireRecordOwnership(req, res, id, loader) {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return null
  const row = await loader(req.db, String(id))
  if (!row) {
    res.status(404).json({ error: 'not_found' })
    return null
  }
  if (!(await userMayAccessProfile(req, user, row.profile_id))) {
    res.status(403).json({ error: 'forbidden' })
    return null
  }
  return { user, row }
}

router.post('/start', startLimiter, async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const profileId = String(req.body?.profile_id || req.body?.profileId || '').trim()
  const selectedSources = Array.isArray(req.body?.selected_sources) ? req.body.selected_sources
    : Array.isArray(req.body?.selectedSources) ? req.body.selectedSources
    : []
  if (!profileId) return res.status(400).json({ error: 'profile_id_required' })
  if (selectedSources.length === 0) return res.status(400).json({ error: 'selected_sources_required' })
  if (!(await userMayAccessProfile(req, user, profileId))) {
    return res.status(403).json({ error: 'forbidden' })
  }

  // Kick off the automation OFF the request path and return immediately.
  // Portal/browser automation can take minutes (Playwright nav timeouts × pages
  // × resolver retries), far exceeding the gateway's ~30-60s limit — running it
  // inline produced "server is taking too long to respond". The orchestrator
  // persists each task's state to the DB as it works, so the client polls
  // GET /tasks for live progress. See runAutomationInBackground.
  runAutomationInBackground('automate_selected', () => automateSelected(req.db, {
    profileId,
    userId: getAuthUserId(user),
    selectedSources,
    options: {
      generate_pdf: req.body?.options?.generate_pdf !== false,
      generate_docx: req.body?.options?.generate_docx !== false,
      portal_automation: req.body?.options?.portal_automation !== false,
    },
  }))
  return res.status(202).json({
    ok: true,
    queued: true,
    queued_count: selectedSources.length,
    message: 'Hamilton is working in the background. Watch the Automation tab for progress.',
  })
})

router.get('/tasks', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const status = req.query.status ? String(req.query.status) : null
  const automationType = req.query.automation_type ? String(req.query.automation_type) : null
  const profileIdParam = req.query.profile_id || req.query.profileId || null

  try {
    const accessibleProfileIds = req.ctx?.isAdmin === true
      ? null
      : await getAccessibleProfileIds(req.db, user)

    const scoped = await listScopedHamiltonTasks({
      isAdmin: req.ctx?.isAdmin === true,
      requestedProfileId: profileIdParam,
      accessibleProfileIds,
      status,
      limit: 200,
      listTasks: (opts) => listApplicationTasks(req.db, opts),
    })

    if (scoped.forbidden) {
      return res.status(403).json({ error: 'forbidden' })
    }

    let tasks = scoped.tasks
    if (automationType) {
      tasks = (tasks || []).filter((t) => t.automation_type === automationType)
    }
    return res.json({ ok: true, tasks })
  } catch (err) {
    log.error('list_tasks_failed', { err: err?.message })
    return res.status(500).json({ error: 'list_failed' })
  }
})

router.get('/tasks/:taskId', async (req, res) => {
  const ctx = await loadTaskAndAuthorise(req, res, req.params.taskId)
  if (!ctx) return
  try {
    const events = await listTaskEvents(req.db, ctx.task.id, { limit: 500 })
    const missing = await listMissingInfo(req.db, ctx.task.id, { includeResolved: true })
    return res.json({ ok: true, task: ctx.task, events, missing })
  } catch (err) {
    log.error('get_task_failed', { taskId: ctx.task.id, err: err?.message })
    return res.status(500).json({ error: 'get_failed' })
  }
})

router.post(
  '/tasks/:taskId/manual-submission-receipt',
  manualReceiptLimiter,
  requireHumanOwnedReceiptTask,
  parseManualReceipt,
  async (req, res) => {
    const ctx = req.hamiltonManualReceiptContext
    if (String(req.body?.attested || '').trim().toLowerCase() !== 'true') {
      if (req.file) req.file.buffer = null
      return res.status(400).json({
        error: 'attestation_required',
        message: 'Explicit manual-submission attestation is required.',
      })
    }
    // Existing system-captured proof cannot be replaced or reclassified by an
    // owner upload. A retry of this dedicated manual path is allowed through so
    // the store can enforce exact idempotency.
    if (
      ctx.task.submission_proof?.verified_external === true
      && ctx.task.submission_proof?.source !== 'owner_attested_manual_receipt'
    ) {
      if (req.file) req.file.buffer = null
      return res.status(409).json({
        error: 'external_submission_already_verified',
        message: 'This task already has captured external-submission proof.',
      })
    }

    try {
      const receipt = await recordManualSubmissionReceipt(req.db, {
        taskId: ctx.task.id,
        profileId: ctx.task.profile_id,
        file: req.file,
        submittedAt: req.body?.submitted_at,
        confirmationReference: req.body?.confirmation_reference,
        attestationVersion: req.body?.attestation_version,
        idempotencyKey: req.get('Idempotency-Key'),
        actorUserId: ctx.actorUserId,
      })
      const task = await getApplicationTask(req.db, ctx.task.id, { profileId: ctx.task.profile_id })
      return res.status(receipt.idempotent ? 200 : 201).json({ ok: true, receipt, task })
    } catch (error) {
      return sendManualReceiptError(res, error)
    } finally {
      // Drop the request's reference to the in-memory evidence as soon as the
      // transaction completes. No evidence bytes are retained in logs/events.
      if (req.file) req.file.buffer = null
    }
  },
)

router.post(
  '/tasks/:taskId/manual-submission-receipts/:receiptId/revoke',
  manualReceiptLimiter,
  requireHumanOwnedReceiptTask,
  async (req, res) => {
    const ctx = req.hamiltonManualReceiptContext
    try {
      const receipt = await revokeManualSubmissionReceipt(req.db, {
        taskId: ctx.task.id,
        profileId: ctx.task.profile_id,
        receiptId: req.params.receiptId,
        reason: req.body?.reason,
        actorUserId: ctx.actorUserId,
      })
      const task = await getApplicationTask(req.db, ctx.task.id, { profileId: ctx.task.profile_id })
      return res.json({ ok: true, receipt, task })
    } catch (error) {
      return sendManualReceiptError(res, error)
    }
  },
)

router.post('/tasks/:taskId/regenerate', async (req, res) => {
  const ctx = await loadTaskAndAuthorise(req, res, req.params.taskId)
  if (!ctx) return
  if (ctx.task.submission_proof?.source === 'owner_attested_manual_receipt') {
    return res.status(409).json({
      error: 'manual_submission_receipt_active',
      message: 'Revoke the active portal receipt before regenerating the submitted packet.',
    })
  }
  try {
    const profile = await loadProfile(req.db, ctx.task.profile_id)
    if (!profile) return res.status(404).json({ error: 'profile_not_found' })
    const opportunity = ctx.task.opportunity_id
      ? await req.db.prepare('SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1').get(String(ctx.task.opportunity_id)).catch(() => null)
      : null
    const grant = ctx.task.grant_id
      ? await req.db.prepare('SELECT * FROM grants WHERE id = ? LIMIT 1').get(String(ctx.task.grant_id)).catch(() => null)
      : null

    const result = await generateAndSavePacket(req.db, {
      profile,
      opportunity,
      grant,
      automationType: ctx.task.automation_type || 'pdf_docx',
      taskId: ctx.task.id,
      userId: getAuthUserId(ctx.user),
    })
    await updateApplicationTask(req.db, ctx.task.id, {
      outputDocxDocumentId: result.docx_document_id,
      outputPdfDocumentId: result.pdf_document_id || null,
      outputDocumentId: result.pdf_document_id || result.docx_document_id,
      mailingInstructions: result.mailing_instructions,
    })
    await appendTaskEvent(req.db, {
      taskId: ctx.task.id,
      eventType: 'progress',
      step: 'regenerate',
      message: 'Packet regenerated by user request.',
      actorUserId: getAuthUserId(ctx.user),
      actorRole: req.ctx?.isAdmin === true ? 'admin' : 'user',
      details: { docx_document_id: result.docx_document_id, pdf_document_id: result.pdf_document_id },
    })
    return res.json({ ok: true, packet: result })
  } catch (err) {
    log.error('regenerate_failed', { err: err?.message })
    if (err?.code === 'manual_submission_receipt_active') {
      return res.status(409).json({ error: err.code, message: err.message })
    }
    return res.status(500).json({ error: 'regenerate_failed', detail: err?.message })
  }
})

async function markChannelSubmitted(req, res, channel) {
  const ctx = await loadTaskAndAuthorise(req, res, req.params.taskId)
  if (!ctx) return
  if (ctx.task.submission_proof?.source === 'owner_attested_manual_receipt') {
    return res.status(409).json({
      error: 'manual_submission_receipt_active',
      message: 'Revoke the active portal receipt before recording a different submission channel.',
    })
  }
  const recordedAt = new Date().toISOString()
  const note = String(req.body?.note || '').slice(0, 1000)
    || `User recorded a ${channel} dispatch; external receipt is not yet verified.`
  try {
    await updateApplicationTask(req.db, ctx.task.id, {
      status: 'submission_verification_required',
      currentStep: 'submission_verification_required',
      submittedAt: null,
      completedAt: null,
      allowAutoSubmit: false,
      autoSubmitEnabled: false,
      lastAgentMessage: note,
    })
    await appendTaskEvent(req.db, {
      taskId: ctx.task.id,
      eventType: 'note',
      status: 'submission_verification_required',
      step: 'manual_dispatch_recorded',
      message: note,
      actorUserId: getAuthUserId(ctx.user),
      actorRole: req.ctx?.isAdmin === true ? 'admin' : 'user',
      details: { channel, manual_dispatch_recorded_at: recordedAt, external_receipt_verified: false },
    })
    await emitHamiltonNotificationToProfileAndAdmins(req.db, {
      profileId: ctx.task.profile_id,
      profileUserId: ctx.task.user_id,
      type: 'hamilton_task_blocked',
      title: `${channel.toUpperCase()} dispatch needs receipt verification`,
      message: `${note} GrantFlow will not count it as externally received until a carrier or funder receipt is retained.`,
      severity: 'warning',
      data: {
        task_id: ctx.task.id,
        channel,
        manual_dispatch_recorded_at: recordedAt,
        external_receipt_verified: false,
      },
    })
    return res.json({ ok: true, task: await getApplicationTask(req.db, ctx.task.id) })
  } catch (err) {
    log.error('mark_channel_failed', { channel, err: err?.message })
    if (err?.code === 'manual_submission_receipt_active') {
      return res.status(409).json({ error: err.code, message: err.message })
    }
    return res.status(500).json({ error: 'mark_failed', detail: err?.message })
  }
}

router.post('/tasks/:taskId/mark-mailed', (req, res) => markChannelSubmitted(req, res, 'mail'))
router.post('/tasks/:taskId/mark-emailed', (req, res) => markChannelSubmitted(req, res, 'email'))
router.post('/tasks/:taskId/mark-faxed', (req, res) => markChannelSubmitted(req, res, 'fax'))

router.post('/tasks/:taskId/approve', async (req, res) => {
  const ctx = await loadTaskAndAuthorise(req, res, req.params.taskId)
  if (!ctx) return
  try {
    if (SUBMISSION_MAY_BE_IN_FLIGHT_STATUSES.has(ctx.task.status)) {
      return res.status(409).json({
        error: 'submission_verification_required',
        message: 'Auto-submit cannot be re-enabled while an external submission attempt is unresolved. Check the funder portal and reconcile the confirmation evidence first.',
      })
    }
    const authorization = await readAuthorizations(req.db, {
      profileId: ctx.task.profile_id,
      fundingSourceId: ctx.task.opportunity_id || ctx.task.grant_id || null,
      taskId: ctx.task.id,
    })
    if (!authorization.submit_applications || authorization.require_human_review) {
      return res.status(409).json({
        error: authorization.require_human_review ? 'human_review_required' : 'submit_authorization_required',
        message: authorization.require_human_review
          ? 'Final human review is required for this application.'
          : 'Authorize submit_applications before approving auto-submission.',
      })
    }
    await updateApplicationTask(req.db, ctx.task.id, {
      allowAutoSubmit: true,
      autoSubmitEnabled: true,
    })
    await appendTaskEvent(req.db, {
      taskId: ctx.task.id,
      eventType: 'note',
      step: 'approve_submit',
      message: 'User explicitly approved auto-submission.',
      actorUserId: getAuthUserId(ctx.user),
      actorRole: req.ctx?.isAdmin === true ? 'admin' : 'user',
    })
    return res.json({ ok: true, task: await getApplicationTask(req.db, ctx.task.id) })
  } catch (err) {
    log.error('approve_failed', { err: err?.message })
    return res.status(500).json({ error: 'approve_failed' })
  }
})

router.post('/tasks/:taskId/retry', async (req, res) => {
  const ctx = await loadTaskAndAuthorise(req, res, req.params.taskId)
  if (!ctx) return
  if (SUBMISSION_MAY_BE_IN_FLIGHT_STATUSES.has(ctx.task.status)) {
    return res.status(409).json({
      error: 'submission_verification_required',
      message: 'This application may already have crossed the external submit boundary. Check the funder portal and reconcile confirmation evidence before any retry.',
    })
  }
  // Re-run the orchestrator on this single source — in the background so the
  // request doesn't hang on browser automation.
  try {
    const profile = await loadProfile(req.db, ctx.task.profile_id)
    if (!profile) return res.status(404).json({ error: 'profile_not_found' })
    // Truthful backoff accounting: every manual retry counts. Without this the
    // task's retry_count stayed 0 across admin retries (the orchestrator only
    // increments it on the auth-backoff path), so "how many times has this been
    // re-attempted" read as never. Record it BEFORE the background re-run so a
    // re-run that fails again still shows the attempt.
    const retryCount = (Number(ctx.task.retry_count) || 0) + 1
    await updateApplicationTask(req.db, ctx.task.id, { retryCount })
    await appendTaskEvent(req.db, {
      taskId: ctx.task.id,
      eventType: 'note',
      step: 'manual_retry',
      message: `Manual retry #${retryCount} requested — Hamilton is re-running this application.`,
      actorUserId: getAuthUserId(ctx.user),
      actorRole: req.ctx?.isAdmin === true ? 'admin' : 'user',
      details: { retry_count: retryCount },
    })
    runAutomationInBackground('retry_single', () => automateSingleSource(req.db, {
      profile,
      profileId: ctx.task.profile_id,
      userId: getAuthUserId(ctx.user),
      source: {
        opportunity_id: ctx.task.opportunity_id,
        grant_id: ctx.task.grant_id,
        current_stage: ctx.task.current_pipeline_stage || ctx.task.selected_from_stage,
      },
    }))
    return res.status(202).json({ ok: true, queued: true, task_id: ctx.task.id, message: 'Hamilton is re-running this application in the background.' })
  } catch (err) {
    log.error('retry_failed', { err: err?.message })
    return res.status(500).json({ error: 'retry_failed', detail: err?.message })
  }
})

// ── Phase A — Hamilton Autopilot authorization ─────────────────────────

router.post('/authorize', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const userId = getAuthUserId(user)
  const profileId = String(req.body?.profile_id || req.body?.profileId || '').trim()
  const scope = String(req.body?.scope || 'task')
  const fundingSourceIds = Array.isArray(req.body?.funding_source_ids) ? req.body.funding_source_ids : []
  const taskIds = Array.isArray(req.body?.task_ids) ? req.body.task_ids : []
  const authorizationTypesIn = Array.isArray(req.body?.authorization_types) ? req.body.authorization_types : []
  const options = req.body?.options || {}
  const authorizationText = String(req.body?.authorization_text || HAMILTON_AUTOPILOT_AUTHORIZATION_TEXT)
  const authorizationVersion = String(req.body?.authorization_version || HAMILTON_AUTOPILOT_AUTHORIZATION_VERSION)

  if (!profileId) return res.status(400).json({ error: 'profile_id_required', message: 'profile_id is required' })
  // Defense-in-depth: requireAuthenticatedUser already gated this, but the auth
  // middleware writes the canonical id as `user.userId` (JWT) — never `user.id`.
  // Older code paths that read `user.id` silently produced "userId required"
  // errors inside recordAuthorizations and surfaced as raw "authorize_failed"
  // tokens in the modal. Resolve via getAuthUserId() and fail early with a
  // friendly message if the auth middleware didn't supply an id.
  if (!userId) {
    log.error('authorize_failed', { reason: 'missing_user_id_from_auth' })
    return res.status(401).json({
      error: 'session_invalid',
      message: 'Your session does not carry a user id. Please sign out and sign in again.',
    })
  }

  try {
    // Access check is inside the try so a DB hiccup here returns a clean,
    // logged error instead of an unhandled 500 with an empty body.
    if (!(await userMayAccessProfile(req, user, profileId))) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'You do not have access to this profile.',
      })
    }
    const types = authorizationTypesIn.filter((t) => HAMILTON_AUTHORIZATION_TYPES.includes(t))
    if (types.length === 0) {
      return res.status(400).json({
        error: 'authorization_types_required',
        message: 'Tick at least one capability so Hamilton has something to do.',
      })
    }
    if (types.includes('submit_applications')
        && options?.allow_auto_submit === true
        && options?.require_human_review === true) {
      return res.status(400).json({
        error: 'contradictory_submission_controls',
        message: 'Choose either automatic submission or final human review, not both.',
      })
    }

    const ids = await recordAuthorizations(req.db, {
      userId,
      profileId,
      scope,
      fundingSourceIds,
      taskIds,
      authorizationTypes: types,
      authorizationText,
      authorizationVersion,
      options,
      replaceOmittedTypes: true,
      metadata: {
        ip: req.ip || req.headers['x-forwarded-for'] || null,
        user_agent: req.headers['user-agent'] || null,
        accepted_at: new Date().toISOString(),
      },
    })
    return res.json({ ok: true, authorization_ids: ids, authorization_text: authorizationText, authorization_version: authorizationVersion })
  } catch (err) {
    const detail = err?.message || String(err)
    log.error('authorize_failed', { err: detail, profileId, scope })
    // Surface a human-readable `message` alongside the machine-readable `error`
    // so the modal doesn't display the raw "authorize_failed" token. The API
    // client picks `message` first, falling back to `error`.
    return res.status(500).json({
      error: 'authorize_failed',
      message: `Hamilton couldn't save your authorization: ${detail}`,
      detail,
    })
  }
})

router.get('/authorizations', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const profileId = String(req.query?.profile_id || req.query?.profileId || '').trim()
  if (!profileId) return res.status(400).json({ error: 'profile_id_required' })
  if (!(await userMayAccessProfile(req, user, profileId))) {
    return res.status(403).json({ error: 'forbidden' })
  }
  const fundingSourceId = req.query?.funding_source_id ? String(req.query.funding_source_id) : null
  const taskId = req.query?.task_id ? String(req.query.task_id) : null
  try {
    const list = await listActiveAuthorizations(req.db, { profileId, fundingSourceId, taskId })
    const flags = await readAuthorizations(req.db, { profileId, fundingSourceId, taskId })
    return res.json({ ok: true, active: list, flags })
  } catch (err) {
    log.error('list_auth_failed', { err: err?.message })
    return res.status(500).json({ error: 'list_failed' })
  }
})

router.post('/authorizations/:id/revoke', async (req, res) => {
  const ctx = await requireRecordOwnership(req, res, req.params.id, getAuthorizationById)
  if (!ctx) return
  try {
    const row = await revokeAuthorization(req.db, { id: req.params.id, reason: req.body?.reason || null })
    return res.json({ ok: true, authorization: row })
  } catch (err) {
    log.error('revoke_failed', { err: err?.message })
    return res.status(500).json({ error: 'revoke_failed' })
  }
})

// ── Phase B — Preflight (gather missing inputs before launch) ──────

router.post('/preflight', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const profileId = String(req.body?.profile_id || req.body?.profileId || '').trim()
  const selectedSources = Array.isArray(req.body?.selected_sources) ? req.body.selected_sources : []
  if (!profileId) return res.status(400).json({ error: 'profile_id_required' })
  if (selectedSources.length === 0) return res.status(400).json({ error: 'selected_sources_required' })
  if (!(await userMayAccessProfile(req, user, profileId))) return res.status(403).json({ error: 'forbidden' })
  try {
    const profile = await loadProfile(req.db, profileId)
    if (!profile) return res.status(404).json({ error: 'profile_not_found' })
    const report = await preflightSelected(req.db, { profile, profileId, selectedSources })
    return res.json({ ok: true, ...report })
  } catch (err) {
    log.error('preflight_failed', { err: err?.message })
    return res.status(500).json({ error: 'preflight_failed', detail: err?.message })
  }
})

// ── Phase C — Start Autopilot (preflight → unattended run) ─────────

router.post('/start-autopilot', startLimiter, async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const profileId = String(req.body?.profile_id || req.body?.profileId || '').trim()
  const selectedSources = Array.isArray(req.body?.selected_sources) ? req.body.selected_sources : []
  if (!profileId) return res.status(400).json({ error: 'profile_id_required' })
  if (selectedSources.length === 0) return res.status(400).json({ error: 'selected_sources_required' })
  if (!(await userMayAccessProfile(req, user, profileId))) return res.status(403).json({ error: 'forbidden' })
  // Web callers may reference saved sessions/documents only by opaque,
  // profile-owned identifiers. Raw server paths would let an authenticated
  // caller make Playwright read or upload arbitrary files from the host.
  if (req.body?.options?.storage_state_path !== undefined || req.body?.options?.documents !== undefined) {
    return res.status(400).json({
      error: 'server_paths_not_accepted',
      message: 'Use saved profile documents and sessions; raw server file paths are not accepted.',
    })
  }
  // Background: autopilot drives real portals and can run for minutes.
  runAutomationInBackground('start_autopilot', () => automateSelected(req.db, {
    profileId,
    userId: getAuthUserId(user),
    selectedSources,
    options: {
      autopilot: true,
      // Per-application authorization is an OPT-IN: an absent flag means the
      // caller never chose auto-submit, so it must not read as consent
      // (2026-08-03; was `!== false`, which defaulted every launch to true).
      allow_auto_submit: req.body?.options?.allow_auto_submit === true,
      headless: req.body?.options?.headless !== false,
    },
  }))
  return res.status(202).json({
    ok: true,
    queued: true,
    queued_count: selectedSources.length,
    message: 'Hamilton autopilot is running in the background. Watch the Automation tab for progress.',
  })
})

// ── Phase D — Resolve a hard blocker and continue ───────────────────

router.post('/tasks/:taskId/resolve-blocker', async (req, res) => {
  const ctx = await loadTaskAndAuthorise(req, res, req.params.taskId)
  if (!ctx) return
  const note = String(req.body?.note || '').slice(0, 1000)
  try {
    // 1. Mark every open blocker for this task as resolved + write
    //    audit row(s) + clear the related persistent notifications so
    //    the bell stops nagging.
    const resolvedBlockers = await resolveOpenBlockersForTask(req.db, {
      taskId: ctx.task.id,
      strategy: 'user_action',
      detail: note || null,
      resolvedByUserId: getAuthUserId(ctx.user),
    })
    for (const b of resolvedBlockers) {
      const ids = []
      if (b.user_notification_id) ids.push(b.user_notification_id)
      ids.push(...(b.admin_notification_ids || []))
      if (ids.length > 0) await markNotificationsResolved(req.db, ids)
    }
    await appendTaskEvent(req.db, {
      taskId: ctx.task.id,
      eventType: 'note',
      step: 'resolve_blocker',
      message: note || 'User indicated the blocker is resolved. Re-running Hamilton Autopilot.',
      actorUserId: getAuthUserId(ctx.user),
      actorRole: req.ctx?.isAdmin === true ? 'admin' : 'user',
      details: { resolved_blocker_ids: resolvedBlockers.map((b) => b.id) },
    })
    const profile = await loadProfile(req.db, ctx.task.profile_id)
    if (!profile) return res.status(404).json({ error: 'profile_not_found' })
    // Resume in the background so clearing a blocker doesn't hang on the re-run.
    runAutomationInBackground('resolve_blocker_resume', () => automateSingleSource(req.db, {
      profile,
      profileId: ctx.task.profile_id,
      userId: getAuthUserId(ctx.user),
      source: {
        opportunity_id: ctx.task.opportunity_id,
        grant_id: ctx.task.grant_id,
        task_id: ctx.task.id,
        current_stage: ctx.task.current_pipeline_stage || ctx.task.selected_from_stage,
      },
      // No allow_auto_submit here: resuming after a blocker keeps the TASK's
      // stored per-application authorization (automateSingleSource leaves the
      // column untouched when the option is absent). Hardcoding true here let
      // a blocker-resume grant itself submission authority (2026-08-03).
      options: { autopilot: true },
    }))
    return res.status(202).json({ ok: true, queued: true, resolved_blockers: resolvedBlockers, task_id: ctx.task.id, message: 'Blocker cleared. Hamilton is resuming in the background.' })
  } catch (err) {
    log.error('resolve_blocker_failed', { err: err?.message })
    return res.status(500).json({ error: 'resolve_failed', detail: err?.message })
  }
})

// ── Phase F — Provider catalogue ───────────────────────────────────

router.get('/providers', async (_req, res) => {
  try {
    const providers = await listPortalProviders()
    return res.json({ ok: true, providers })
  } catch (err) {
    log.error('list_providers_failed', { err: err?.message })
    return res.status(500).json({ error: 'list_failed' })
  }
})

// Autopilot-run history per task.
router.get('/tasks/:taskId/autopilot-runs', async (req, res) => {
  const ctx = await loadTaskAndAuthorise(req, res, req.params.taskId)
  if (!ctx) return
  try {
    const runs = await listAutopilotRuns(req.db, { taskId: ctx.task.id, limit: 50 })
    return res.json({ ok: true, runs })
  } catch (err) {
    log.error('list_runs_failed', { err: err?.message })
    return res.status(500).json({ error: 'list_failed' })
  }
})

// ── Hard-Stop Resolver routes ─────────────────────────────────────

// Extended resolver-aware preflight. Returns full readiness readout
// per source plus the resolutions Hamilton already applied.
router.post('/preflight-resolve', async (req, res) => {
  const { profileId, selectedSources = [] } = req.body || {}
  const user = await requireProfileScope(req, res, profileId)
  if (!user) return
  try {
    const profile = await loadProfile(req.db, profileId)
    if (!profile) return res.status(404).json({ error: 'profile_not_found' })
    const result = await preflightAndResolveSelected(req.db, {
      profile, profileId, selectedSources, userId: getAuthUserId(user),
    })
    return res.json(result)
  } catch (err) {
    log.error('preflight_resolve_failed', { err: err?.message })
    return res.status(500).json({ error: 'preflight_resolve_failed', detail: err?.message })
  }
})

// Payment authorizations. Token/reference-only — these stores never hold raw
// card data — but they are still profile-scoped secrets, so every read and
// write verifies the caller may access the target profile.
router.get('/payment-authorizations', async (req, res) => {
  const user = await requireProfileScope(req, res, req.query.profileId)
  if (!user) return
  try {
    const list = await listPaymentAuthorizations(req.db, req.query.profileId)
    return res.json({ ok: true, payment_categories: PAYMENT_CATEGORIES, authorizations: list })
  } catch (err) {
    return res.status(500).json({ error: 'list_failed', detail: err?.message })
  }
})
router.post('/payment-authorizations', async (req, res) => {
  const user = await requireProfileScope(req, res, req.body?.profileId)
  if (!user) return
  try {
    const auth = await authorizePayment(req.db, { ...req.body, userId: getAuthUserId(user) })
    return res.json({ ok: true, authorization: auth })
  } catch (err) {
    return res.status(400).json({ error: 'authorize_failed', detail: err?.message })
  }
})
router.post('/payment-authorizations/:id/revoke', async (req, res) => {
  const ctx = await requireRecordOwnership(req, res, req.params.id, getPaymentAuthorizationById)
  if (!ctx) return
  const auth = await revokePaymentAuthorization(req.db, req.params.id, req.body?.reason || null)
  return res.json({ ok: true, authorization: auth })
})
router.get('/payment-authorizations/can-pay', async (req, res) => {
  const { profileId, category, amountCents, portalHost } = req.query
  const user = await requireProfileScope(req, res, profileId)
  if (!user) return
  if (!category) return res.status(400).json({ error: 'category required' })
  const decision = await canPayFor(req.db, {
    profileId, category, amountCents: Number(amountCents || 0), portalHost: portalHost || null,
  })
  return res.json(decision)
})

// Saved sessions. Storage stores only Playwright storage-state references /
// paths — never plaintext credentials — and is profile-scoped.
router.get('/sessions', async (req, res) => {
  const user = await requireProfileScope(req, res, req.query.profileId)
  if (!user) return
  const list = await listSessionsForProfile(req.db, req.query.profileId)
  return res.json({ ok: true, sessions: list })
})
router.post('/sessions', async (req, res) => {
  const user = await requireProfileScope(req, res, req.body?.profileId)
  if (!user) return
  return res.status(400).json({
    error: 'session_pointer_not_accepted',
    message: 'Raw storage-state paths and external references are not accepted. Import an owner-established encrypted storage state or use the session-capture flow.',
  })
})
// Import a session the user established themselves (logged in + cleared 2FA in
// their own browser) by posting the exported Playwright storageState. Stored
// AES-256-GCM-encrypted so Hamilton can reuse it to act inside the real portal.
// The ciphertext is never echoed back. Used by tools/hamilton-session-capture.
router.post('/sessions/import', async (req, res) => {
  const user = await requireProfileScope(req, res, req.body?.profileId)
  if (!user) return
  try {
    // Record the owner's consent for Hamilton to act inside their real portal
    // account as an auditable part of the session (who authorized, when, from
    // where). Legal hygiene: a captured session is permission to act on the
    // owner's behalf, so we never store one without an attached consent record.
    const consent = {
      consented_by_user_id: getAuthUserId(user),
      consented_by_email: user?.email || user?.primary_email || null,
      consented_at: new Date().toISOString(),
      consent_text: 'Owner authorized Hamilton to reuse this saved session to act inside the portal on their behalf.',
      source_ip: req.ip || req.headers?.['x-forwarded-for'] || null,
    }
    // Profile-binding safeguard: if this upload fulfills a capture request,
    // the request MUST belong to the same profile we're importing into. This
    // is what prevents a session from being filed under the wrong profile when
    // two users share a portal host (e.g. two MTSU students). We also confirm
    // the caller may access the request's profile before completing it.
    const captureRequestId = req.body?.capture_request_id || req.body?.captureRequestId || null
    let captureRequest = null
    if (captureRequestId) {
      captureRequest = await getCaptureRequest(req.db, captureRequestId)
      if (!captureRequest) {
        return res.status(404).json({ error: 'capture_request_not_found' })
      }
      if (String(captureRequest.profile_id) !== String(req.body?.profileId)) {
        return res.status(409).json({
          error: 'profile_mismatch',
          message: 'This capture request belongs to a different profile. Refusing to file the session under the wrong profile.',
        })
      }
    }

    const session = await importSession(req.db, {
      userId: getAuthUserId(user),
      profileId: req.body?.profileId,
      portalHost: req.body?.portal_host || req.body?.portalHost || req.body?.portal_url || captureRequest?.portal_host,
      storageState: req.body?.storage_state || req.body?.storageState,
      label: req.body?.label || captureRequest?.label || null,
      authenticationStrategy: req.body?.authentication_strategy || req.body?.authenticationStrategy || null,
      expiresAt: req.body?.expires_at || req.body?.expiresAt || null,
      metadata: { ...(req.body?.metadata || {}), consent, capture_request_id: captureRequestId || undefined },
    })
    if (captureRequest) {
      await completeCaptureRequest(req.db, captureRequest.id, { sessionId: session?.id || null }).catch(() => {})
    }
    return res.json({ ok: true, session })
  } catch (err) {
    return res.status(400).json({ error: 'import_failed', detail: err?.message })
  }
})
router.post('/sessions/:id/revoke', async (req, res) => {
  const ctx = await requireRecordOwnership(req, res, req.params.id, getSessionById)
  if (!ctx) return
  const session = await revokeSession(req.db, req.params.id, req.body?.reason || null)
  return res.json({ ok: true, session })
})
router.post('/sessions/:id/expire', async (req, res) => {
  const ctx = await requireRecordOwnership(req, res, req.params.id, getSessionById)
  if (!ctx) return
  const session = await markSessionExpired(req.db, req.params.id, req.body?.reason || null)
  return res.json({ ok: true, session })
})

// Retired fail-closed endpoint. Reflecting a caller's access token into a JSON
// response defeats the browser's in-memory/httpOnly credential boundary and a
// request Host header is not a trustworthy API authority. The owner-scoped
// capture-request and cloud-login flows remain available without exporting a
// reusable GrantFlow credential.
router.post('/sessions/capture-token', async (req, res) => {
  const profileId = String(req.body?.profileId || req.body?.profile_id || '').trim()
  const user = await requireProfileScope(req, res, profileId)
  if (!user) return
  return res.status(410).json({
    error: 'capture_token_disabled',
    message: 'GrantFlow no longer exports access tokens to session-capture commands. Use the owner-scoped capture-request or cloud interactive-login flow.',
  })
})

// ── Capture requests ────────────────────────────────────────────────────────
// The in-app "Capture login session" button creates a profile-bound request
// here; the owner's local laptop-connector polls pending requests, opens the
// login page so the human can clear 2FA, captures the session, and uploads it.
// Phone users (who can't run the connector) can still create a request for the
// owner to fulfill on a computer, or use the Saved Login path instead.

// Create a capture request (owner of the target profile).
router.post('/sessions/capture-requests', async (req, res) => {
  const profileId = String(req.body?.profileId || req.body?.profile_id || '').trim()
  const user = await requireProfileScope(req, res, profileId)
  if (!user) return
  try {
    const request = await createCaptureRequest(req.db, {
      userId: getAuthUserId(user),
      profileId,
      portalHost: req.body?.portal_host || req.body?.portalHost,
      loginUrl: req.body?.login_url || req.body?.loginUrl || null,
      label: req.body?.label || null,
      requestedByEmail: user?.email || user?.primary_email || null,
    })
    return res.json({ ok: true, request, disclaimer: CAPTURE_DISCLAIMER })
  } catch (err) {
    return res.status(400).json({ error: 'capture_request_failed', detail: err?.message })
  }
})

// List capture requests. The connector polls this scoped to the profiles the
// authenticated operator can access — so it never sees another operator's work.
router.get('/sessions/capture-requests', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : 'pending'
    // If a specific profile is requested, scope+authorize to it; otherwise list
    // across every profile this operator can access (the connector's poll).
    let profileIds
    if (req.query.profileId) {
      const scoped = await requireProfileScope(req, res, req.query.profileId)
      if (!scoped) return
      profileIds = [String(req.query.profileId)]
    } else {
      // null = admin (no restriction → all pending); otherwise the operator's
      // own profiles only, so the connector never sees another operator's work.
      const accessible = await getAccessibleProfileIds(req.db, user)
      profileIds = accessible === null ? null : [...accessible].map(String)
    }
    const requests = await listCaptureRequests(req.db, { profileIds, status })
    return res.json({ ok: true, requests, disclaimer: CAPTURE_DISCLAIMER })
  } catch (err) {
    return res.status(500).json({ error: 'capture_requests_failed', detail: err?.message })
  }
})

// Mark a request as launched (connector opened the browser) — optional UX nicety.
router.post('/sessions/capture-requests/:id/launched', async (req, res) => {
  const request = await getCaptureRequest(req.db, req.params.id)
  if (!request) return res.status(404).json({ error: 'not_found' })
  const user = await requireProfileScope(req, res, request.profile_id)
  if (!user) return
  const updated = await markLaunched(req.db, req.params.id)
  return res.json({ ok: true, request: updated })
})

// Cancel a request (owner of the request's profile).
router.post('/sessions/capture-requests/:id/cancel', async (req, res) => {
  const request = await getCaptureRequest(req.db, req.params.id)
  if (!request) return res.status(404).json({ error: 'not_found' })
  const user = await requireProfileScope(req, res, request.profile_id)
  if (!user) return
  const updated = await cancelCaptureRequest(req.db, req.params.id, { reason: req.body?.reason || 'cancelled_by_user' })
  return res.json({ ok: true, request: updated })
})

// ── Cloud interactive login (Option B) ──────────────────────────────────────
// Controlled beta: the interactive browser remains available only for the
// reserved synthetic fixture. Real portals always use a visible manual/external
// handoff and never reach Playwright from this route.

router.get('/sessions/cloud-login/status', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  return res.json({ ok: true, ...cloudLoginStatus(), disclaimer: CAPTURE_DISCLAIMER })
})

router.post('/sessions/cloud-login/start', async (req, res) => {
  const profileId = String(req.body?.profileId || req.body?.profile_id || '').trim()
  const user = await requireProfileScope(req, res, profileId)
  if (!user) return
  if (!isCloudLoginConfigured()) {
    return res.status(501).json({ error: 'cloud_login_not_configured', ...cloudLoginStatus() })
  }
  const portalHost = req.body?.portal_host || req.body?.portalHost
  const loginUrl = req.body?.login_url || req.body?.loginUrl || (portalHost ? `https://${portalHost}/` : null)
  const normalizedPortalHost = String(portalHost || '').trim().toLowerCase().replace(/^www\./, '')
  if (!isControlledBetaSyntheticBrowserUrl(loginUrl)
      || normalizedPortalHost !== CONTROLLED_BETA_SYNTHETIC_BROWSER_HOST) {
    const refusal = controlledBetaBrowserRefusal()
    return res.status(409).json({
      error: 'cloud_login_start_failed',
      reason: refusal.code,
      detail: refusal.message,
      requires_human_handoff: true,
    })
  }

  // ADAPT: if this portal has already taught us it blocks our datacenter browser
  // (a stable anti-bot / IP-reputation wall the engine upgrade can't beat), do
  // NOT launch the doomed server browser again — that's the "only hit the wall
  // once" rule. Tell the caller to route the user to a non-datacenter path
  // (open on their own browser/IP, or capture from the laptop connector).
  try {
    const wall = await getPortalWallStatus(req.db, portalHost)
    if (wall.blocked) {
      log.info('cloud_login_wall_short_circuit', { portalHost, block: wall.block })
      return res.status(409).json({
        error: 'cloud_login_start_failed',
        reason: 'datacenter_blocked',
        adapt: 'laptop_capture',
        portalHost,
        learned_at: wall.block?.first_seen_at || null,
        message: 'This portal blocks GrantFlow\'s servers. Hamilton learned this already, so instead of failing again it will open the portal on your own device — sign in there, and (if you want Hamilton to reuse it) capture the session from your laptop.',
      })
    }
  } catch (err) {
    // Never let the wall check itself break a login start — fall through to the
    // normal attempt if the policy read fails.
    log.warn('cloud_login_wall_check_failed', { portalHost, error: err?.message })
  }

  const result = await startCloudLogin({
    userId: getAuthUserId(user),
    profileId,
    portalHost,
    loginUrl,
    label: req.body?.label || null,
    captureRequestId: req.body?.capture_request_id || null,
    // Never derive a credential-bearing/self URL from request Host. A validated
    // configured frontend origin is used when present; otherwise the service
    // returns a relative live URL and the frontend anchors it to its own origin.
    origin: resolveConfiguredHamiltonFrontendOrigin(),
    // REQUIRED for session seeding: with the db the live context is seeded from
    // the profile's existing valid saved session for this portal, so a watched
    // side-by-side open lands SIGNED IN and "Done" refreshes that session
    // instead of overwriting it with a signed-out cookie jar (which is what
    // took the portal offline for Hamilton — see loadSeedSession in
    // hamiltonCloudLogin.js). Omitting db silently reverts to cold starts.
    db: req.db,
  })
  if (!result.ok) {
    // LEARN: a navigation failure that classifies as a STABLE anti-bot wall
    // (Akamai/DataDome/"access denied"/ERR_HTTP2_PROTOCOL_ERROR) is recorded so
    // the short-circuit above fires next time. A transient failure
    // (portal_unreachable: timeout/DNS/5xx) is deliberately NOT learned — the
    // site may just be down, and retiring a working portal would be worse.
    if (result.reason === 'navigation_failed' && portalHost) {
      try {
        const { category } = classifyBlocker({ text: result.detail, detail: result.detail })
        // Learn when EITHER the classifier calls it anti-bot OR the detail is a
        // stable server-wall signature the classifier files under
        // portal_unreachable (WAF connection reset, 403/429 — see
        // isServerWallSignal). Transient outages are excluded there.
        if (category === 'portal_anti_bot_block' || isServerWallSignal(result.detail)) {
          const block = await recordPortalWallObservation(req.db, {
            portalHost,
            category: 'portal_anti_bot_block',
            signal: result.detail || null,
            engine: result.engine || null,
          })
          log.info('cloud_login_wall_learned', { portalHost, block })
        }
      } catch (err) {
        log.warn('cloud_login_wall_record_failed', { portalHost, error: err?.message })
      }
    }
    return res.status(400).json({ error: 'cloud_login_start_failed', ...result })
  }
  return res.json({ ok: true, ...result, disclaimer: CAPTURE_DISCLAIMER })
})

// Shared auth + profile-access guard for the live-view stream/input endpoints.
// SECURITY: a liveSessionId alone MUST NOT grant control — every frame stream
// and every input event re-verifies the authenticated caller may access the
// live session's profile (admin bypass allowed via userMayAccessProfile). The
// live session record carries the profileId it was started for.
async function requireCloudLoginSessionAccess(req, res) {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return null
  const liveSessionId = String(req.params.liveSessionId || '')
  const session = getCloudLoginSession(liveSessionId)
  if (!session) {
    log.warn('cloud_login_access_denied', { reason: 'not_found_or_expired', liveSessionId })
    res.status(404).json({ error: 'not_found_or_expired' })
    return null
  }
  if (!(await userMayAccessProfile(req, user, session.meta?.profileId))) {
    log.warn('cloud_login_access_denied', { reason: 'forbidden', liveSessionId, profileId: session.meta?.profileId })
    res.status(403).json({ error: 'forbidden' })
    return null
  }
  return { user, liveSessionId, session }
}

// Live screen stream (SSE). Mirrors the live login page to the user's browser
// frame-by-frame via CDP Page.startScreencast. Single-port + proxy-friendly:
// it's a plain text/event-stream over the app's own public port (no extra ports,
// no devtools exposure). The frontend /HamiltonLiveLogin page consumes this.
router.get('/sessions/cloud-login/:liveSessionId/stream', async (req, res) => {
  const ctx = await requireCloudLoginSessionAccess(req, res)
  if (!ctx) return

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable proxy buffering so frames flush live
  })
  res.write('retry: 3000\n\n')

  let stop = null
  let closed = false
  // Heartbeat comment so intermediary proxies don't time the idle SSE out.
  const heartbeat = setInterval(() => {
    if (!closed) {
      try { res.write(': ping\n\n') } catch { /* ignore */ }
    }
  }, 15_000)

  let unregisterViewer = null
  const cleanup = () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    if (typeof unregisterViewer === 'function') { try { unregisterViewer() } catch { /* ignore */ } }
    if (typeof stop === 'function') { stop().catch(() => {}) }
    try { res.end() } catch { /* ignore */ }
  }

  req.on('close', cleanup)
  req.on('error', cleanup)

  // When the live session is torn down (complete / cancel / TTL sweep), END
  // this stream with a terminal event. Without this the SSE stayed open on
  // heartbeats over a DEAD session: the window read "Live" over the last
  // painted frame while every click 404'd silently.
  unregisterViewer = registerCloudLoginViewer(ctx.liveSessionId, (code) => {
    if (closed) return
    try { res.write(`event: error\ndata: ${JSON.stringify({ error: code || 'session_closed' })}\n\n`) } catch { /* ignore */ }
    cleanup()
  })

  try {
    stop = await startScreencast(ctx.liveSessionId, (frame) => {
      if (closed) return
      try {
        res.write(`data: ${JSON.stringify(frame)}\n\n`)
      } catch {
        cleanup()
      }
    })
    if (!stop) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'stream_unavailable' })}\n\n`)
      cleanup()
    }
  } catch (err) {
    log.error('cloud_login_stream_failed', { err: err?.message })
    try { res.write(`event: error\ndata: ${JSON.stringify({ error: 'stream_failed' })}\n\n`) } catch { /* ignore */ }
    cleanup()
  }
})

// Live input relay. One normalized event per POST → CDP Input.* on the live
// page. Coordinates arrive as 0..1 fractions of the displayed image and are
// scaled server-side by the latest frame's device size. Same auth + profile
// gate as the stream — the liveSessionId never grants control on its own.
router.post('/sessions/cloud-login/:liveSessionId/input', async (req, res) => {
  const ctx = await requireCloudLoginSessionAccess(req, res)
  if (!ctx) return
  const result = await dispatchInput(ctx.liveSessionId, req.body || {})
  if (!result.ok) return res.status(400).json({ error: 'input_failed', ...result })
  return res.json({ ok: true })
})

// Finish: capture the authenticated session and import it (profile-bound). The
// live session already carries the profile it was started for; we re-verify the
// caller may access that profile before storing anything.
//
// LOSSLESS ORDER: capture (browser stays ALIVE) → importSession (the DB write)
// → completeCaptureRequest → finalize (teardown) ONLY after the DB write
// succeeded. The old flow captured-then-closed BEFORE importing, so an import
// failure permanently lost the live login; now it releases the completion mark
// and returns a retryable 500 so the user can just click Done again.
//
// `force: true` in the body skips the visible-password-field heuristic (the
// "did you actually log in?" check — a heuristic, not proof; see
// captureCloudLoginState).
router.post('/sessions/cloud-login/:liveSessionId/complete', async (req, res) => {
  const meta = getCloudLoginMeta(req.params.liveSessionId)
  if (!meta) return res.status(404).json({ error: 'not_found_or_expired' })
  const user = await requireProfileScope(req, res, meta.profileId)
  if (!user) return
  const result = await captureCloudLoginState(req.params.liveSessionId, { force: req.body?.force === true })
  if (!result.ok) return res.status(400).json({ error: 'cloud_login_complete_failed', ...result })
  try {
    const consent = {
      consented_by_user_id: getAuthUserId(user),
      consented_by_email: user?.email || user?.primary_email || null,
      consented_at: new Date().toISOString(),
      consent_text: 'User authorized Hamilton to reuse this saved session to act inside the portal on their behalf (captured via cloud interactive login).',
      source_ip: req.ip || req.headers?.['x-forwarded-for'] || null,
    }
    const session = await importSession(req.db, {
      userId: getAuthUserId(user),
      profileId: meta.profileId,
      portalHost: meta.portalHost,
      storageState: result.storageState,
      label: meta.label || `${meta.portalHost} session`,
      authenticationStrategy: 'imported_session',
      expiresAt: req.body?.expires_at || new Date(Date.now() + 14 * 86400_000).toISOString(),
      metadata: {
        imported_via: 'cloud_interactive_login',
        consent,
        capture_request_id: meta.captureRequestId || undefined,
        // Provenance: when the live context was seeded from an existing saved
        // session, this capture is a REFRESH of that session (the seeded jar +
        // whatever the portal reissued), not a from-scratch login.
        refreshed_from_session_id: meta.seededFromSessionId || undefined,
      },
    })
    if (meta.captureRequestId) {
      await completeCaptureRequest(req.db, meta.captureRequestId, { sessionId: session?.id || null }).catch(() => {})
    }
    // The session row is durably written — NOW it is safe to tear the live
    // browser down.
    await finalizeCloudLogin(req.params.liveSessionId)

    // SYNC WHILE WARM. This is the single moment a portal session is PROVABLY
    // authenticated: a human just completed login + 2FA seconds ago. For a
    // short-lived host that is the only reliable moment — measured 2026-08-01,
    // a studentaid.gov session was authenticated at T+30s and refused at
    // T+~20min, so anything that waits for a scheduled run finds it dead.
    //
    // Fire-and-forget: a portal sync launches a browser and can outlive the
    // HTTP edge timeout, and the capture itself has already succeeded — making
    // the user wait (or fail) on the sync would throw away a good session.
    // runPortalSync owns its own in-flight guard, so a double-click cannot run
    // the same portal twice. Off via HAMILTON_SYNC_ON_CAPTURE=0.
    const syncOnCapture = !/^(0|false|no|off)$/i.test(String(process.env.HAMILTON_SYNC_ON_CAPTURE ?? '').trim())
    if (syncOnCapture) {
      const actorUserId = getAuthUserId(user)
      import('../services/hamilton/portalSync/index.js')
        .then(({ runPortalSync }) => runPortalSync(req.db, {
          profileId: meta.profileId,
          portalHost: meta.portalHost,
          direction: 'read',
          actorUserId,
        }))
        .then((r) => log.info('cloud_login_warm_sync', {
          host: meta.portalHost, ok: r?.ok === true, runId: r?.runId || null, error: r?.error || null,
        }))
        .catch((err) => log.warn('cloud_login_warm_sync_failed', { host: meta.portalHost, err: err?.message }))
    }
    return res.json({ ok: true, session, warm_sync_started: syncOnCapture })
  } catch (err) {
    // The DB write failed but the live login is still alive — release the
    // completion mark so the user can retry Done without logging in again.
    releaseCloudLoginCompletion(req.params.liveSessionId)
    log.error('cloud_login_import_failed', { liveSessionId: req.params.liveSessionId, err: err?.message })
    return res.status(500).json({ error: 'import_failed', retryable: true, detail: err?.message })
  }
})

router.post('/sessions/cloud-login/:liveSessionId/cancel', async (req, res) => {
  const meta = getCloudLoginMeta(req.params.liveSessionId)
  if (!meta) return res.json({ ok: true, already: true })
  const user = await requireProfileScope(req, res, meta.profileId)
  if (!user) return
  const result = await cancelCloudLogin(req.params.liveSessionId)
  return res.json({ ok: true, ...result })
})

// Login-time readiness: is a schedule set, which portals still need a session
// captured (so the owner can clear 2FA), and when does Hamilton next run.
// Powers the login reminder banner.
router.get('/readiness', async (req, res) => {
  const user = await requireProfileScope(req, res, req.query.profileId)
  if (!user) return
  try {
    const readiness = await getHamiltonReadiness(req.db, { profileId: req.query.profileId })
    // Fire-and-forget: ensure a (deduped) reminder notification exists for any
    // portal still needing a captured session, so the owner is nudged even when
    // they aren't looking at the calendar.
    emitSessionCaptureReminders(req.db, { profileId: req.query.profileId }).catch(() => {})
    // Login-time sync prompt for the SAME profile the caller is scoped to.
    // requireProfileScope above 400s without a profileId, so an admin who is not
    // working inside a profile never reaches this and never gets a digest.
    emitPortalSyncReminders(req.db, { profileId: req.query.profileId }).catch(() => {})
    return res.json({ ok: true, readiness })
  } catch (err) {
    log.error('hamilton_readiness_failed', { err: err?.message })
    return res.status(500).json({ error: 'readiness_failed', detail: err?.message })
  }
})

// Hamilton's scheduled application runs as calendar events for a month, each
// flagged requires_presence when a portal it touches lacks a valid session.
router.get('/calendar', async (req, res) => {
  const user = await requireProfileScope(req, res, req.query.profileId)
  if (!user) return
  try {
    const month = String(req.query.month || '') // YYYY-MM
    let rangeStart
    let rangeEnd
    if (/^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split('-').map(Number)
      rangeStart = new Date(Date.UTC(y, m - 1, 1)).toISOString()
      rangeEnd = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1) - 1).toISOString()
    } else {
      const now = new Date()
      rangeStart = now.toISOString()
      rangeEnd = new Date(now.getTime() + 90 * 86400_000).toISOString()
    }
    const events = await computeHamiltonCalendarEvents(req.db, { profileId: req.query.profileId, rangeStart, rangeEnd })
    return res.json({ ok: true, count: events.length, events })
  } catch (err) {
    log.error('hamilton_calendar_failed', { err: err?.message })
    return res.status(500).json({ error: 'calendar_failed', detail: err?.message })
  }
})

// Saved portal LOGINS (username + encrypted password) Hamilton uses to
// authenticate. Profile-scoped. The plaintext password is NEVER returned —
// list responses are masked; only the server-side engine decrypts.
router.get('/credentials', async (req, res) => {
  const user = await requireProfileScope(req, res, req.query.profileId)
  if (!user) return
  try {
    const credentials = await listCredentialsForProfile(req.db, req.query.profileId)
    return res.json({ ok: true, credentials })
  } catch (err) {
    return res.status(500).json({ error: 'list_failed', detail: err?.message })
  }
})
router.post('/credentials', async (req, res) => {
  const user = await requireProfileScope(req, res, req.body?.profileId)
  if (!user) return
  try {
    const credential = await saveCredential(req.db, {
      userId: getAuthUserId(user),
      profileId: req.body?.profileId,
      portalHost: req.body?.portalHost || req.body?.portal_host || req.body?.login_url,
      username: req.body?.username,
      password: req.body?.password,
      label: req.body?.label || null,
      loginUrl: req.body?.login_url || req.body?.loginUrl || null,
      managedBy: actorManagedBy(req),
      // TOTP seed storage is disabled by Hamilton policy. Passing this field
      // now produces a clear validation error from the credential service.
      totpSecret: req.body?.totp_secret || req.body?.totpSecret || null,
    })
    return res.json({ ok: true, credential })
  } catch (err) {
    return res.status(400).json({ error: 'save_failed', detail: err?.message })
  }
})
// Powers the "✨ Auto-fill with Hamilton" button on the add-login / generate-login
// dialogs and the cloud-login form. Returns best-effort
// { portalHost, loginUrl, username, label, source } so the user only has to type
// their password (+ optional 2FA). Resolution is deterministic first
// (opportunity → typed partial → registered connector), with the AI client used
// ONLY as a last resort to resolve a portal NAME to a canonical login URL; it
// degrades gracefully to whatever it can fill (often just the username).
router.post('/portal-login/suggest', async (req, res) => {
  const profileId = String(req.body?.profileId || req.body?.profile_id || '').trim()
  const user = await requireProfileScope(req, res, profileId)
  if (!user) return
  try {
    const suggestion = await suggestPortalLogin({
      db: req.db,
      profileId,
      portalHost: req.body?.portalHost || req.body?.portal_host || '',
      opportunityId: req.body?.opportunityId || req.body?.opportunity_id || '',
      context: req.body?.context || '',
      // The AI fallback is on by default but callers can disable it.
      allowAi: req.body?.allowAi !== false && req.body?.allow_ai !== false,
    })
    return res.json({ ok: true, ...suggestion })
  } catch (err) {
    return res.status(500).json({ error: 'suggest_failed', detail: err?.message })
  }
})

router.delete('/credentials/:id', async (req, res) => {
  const ctx = await requireRecordOwnership(req, res, req.params.id, getCredentialById)
  if (!ctx) return
  const deleted = await deleteCredential(req.db, req.params.id)
  return res.json({ ok: true, deleted })
})

// Hamilton creates a new portal account on the user's behalf when no saved
// login exists. The server picks a strong password, encrypts it, and returns
// it ONCE so the user can also keep a copy. Subsequent reads see only the
// masked row — Hamilton uses the decrypted form server-side via
// getDecryptedCredential during autopilot.
router.post('/credentials/generate', async (req, res) => {
  const user = await requireProfileScope(req, res, req.body?.profileId)
  if (!user) return
  try {
    const result = await saveGeneratedCredential(req.db, {
      userId: getAuthUserId(user),
      profileId: req.body?.profileId,
      portalHost: req.body?.portalHost || req.body?.portal_host || req.body?.login_url,
      username: req.body?.username,
      label: req.body?.label || null,
      loginUrl: req.body?.login_url || req.body?.loginUrl || null,
      reason: req.body?.reason || 'user_requested',
      generatedBy: req.body?.generated_by === 'hamilton' || !req.body?.generated_by ? 'hamilton' : String(req.body.generated_by).slice(0, 32),
      passwordLength: Number(req.body?.password_length) || 28,
    })
    return res.json({
      ok: true,
      credential: result.credential,
      already_existed: Boolean(result.already_existed),
      // Plaintext is returned ONCE. The frontend MUST surface this to the
      // user immediately and never persist it. After this response the
      // password is only readable server-side via getDecryptedCredential.
      password_one_time_view: result.password_one_time_view,
      generated: true,
    })
  } catch (err) {
    return res.status(400).json({ error: 'generate_failed', detail: err?.message })
  }
})

// One-shot reveal of an existing credential's password. Only succeeds the
// FIRST time it's called for a row — every subsequent call returns
// already_revealed:true with no password. This lets the frontend recover
// from a "user closed the dialog before copying" scenario without leaving
// a permanent reveal endpoint open.
router.post('/credentials/:id/reveal-once', async (req, res) => {
  const ctx = await requireRecordOwnership(req, res, req.params.id, getCredentialById)
  if (!ctx) return
  try {
    const result = await revealPasswordOnceById(req.db, req.params.id)
    if (!result) return res.status(404).json({ error: 'credential_not_found' })
    if (result.already_revealed) {
      return res.json({ ok: true, already_revealed: true, password: null })
    }
    return res.json({ ok: true, already_revealed: false, password: result.password })
  } catch (err) {
    return res.status(500).json({ error: 'reveal_failed', detail: err?.message })
  }
})

// Bulk import a Chrome / Edge / Brave / Firefox / 1Password / LastPass CSV
// password export into a profile's vault. The plaintext CSV is sent as a
// JSON `csv_text` field (or pasted into the textarea on the UI dialog) so
// we don't need multipart parsing on this route. The server-side import
// service:
//   - encrypts every password at rest immediately,
//   - is idempotent on (profile_id, portal_host) so re-importing the same
//     export is safe,
//   - returns a structured summary that NEVER echoes any password back.
// Express's default 100 KB json limit is too small for a real Chrome CSV
// (≈30 KB per 200 entries with notes); the route bumps it to 5 MB inline.
router.post('/credentials/import-csv', express.json({ limit: '5mb' }), async (req, res) => {
  const user = await requireProfileScope(req, res, req.body?.profileId)
  if (!user) return
  const csvText = typeof req.body?.csv_text === 'string'
    ? req.body.csv_text
    : typeof req.body?.csvText === 'string'
      ? req.body.csvText
      : null
  if (!csvText || !csvText.trim()) {
    return res.status(400).json({
      error: 'csv_required',
      message: 'Send the CSV contents in the `csv_text` field.',
    })
  }
  const source = String(req.body?.source || 'CSV import').slice(0, 32)
  try {
    const result = await importCredentialsFromCsv(req.db, {
      userId: getAuthUserId(user),
      profileId: req.body.profileId,
      csvText,
      source,
      managedBy: actorManagedBy(req),
    })
    return res.json({ ok: true, ...result })
  } catch (err) {
    return res.status(400).json({ error: 'import_failed', detail: err?.message, message: err?.message })
  }
})

// Login-priming summary: what authentication help Hamilton needs from the
// current user right now. Drives the post-login toast so the user knows to
// watch for verification requests. Any authenticated user; scoped to their own
// notifications + their profiles' waiting tasks.
router.get('/auth-watch', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  // This drives a non-critical login-priming toast. It must never hang long
  // enough to hit the gateway's 504 — if the summary can't be produced quickly
  // (slow query, contention), degrade to "nothing waiting" so the page proceeds.
  const empty = { has_any: false, pending_notifications: 0, waiting_tasks: 0, items: [] }
  try {
    const summary = await Promise.race([
      getAuthWatchSummary(req.db, { userId: getAuthUserId(user) }),
      new Promise((resolve) => setTimeout(() => resolve({ ...empty, timed_out: true }), 8000)),
    ])
    return res.json({ ok: true, ...summary })
  } catch (err) {
    // Degrade rather than 500 — the toast is optional, the page is not.
    return res.json({ ok: true, ...empty, error: 'auth_watch_failed', detail: err?.message })
  }
})

// --- Admin vault management ----------------------------------------------
// Admin-only surface for the credentials the admin placed (managed_by='admin').
// These let the admin move/copy logins in and out of profiles and remove them.
// They NEVER touch credentials a profile user entered themselves or that
// Hamilton generated — those stay private to the profile.

// List everything the admin manages, optionally scoped to one profile.
router.get('/admin/credentials', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const credentials = await listManagedCredentials(req.db, {
      managedBy: 'admin',
      profileId: req.query.profileId ? String(req.query.profileId) : null,
    })
    return res.json({ ok: true, credentials })
  } catch (err) {
    return res.status(500).json({ error: 'list_failed', detail: err?.message })
  }
})

// Proactively flag a missing portal login for a profile (student + admins get a
// notification with a jump-to-add link). No-op if a credential already exists.
router.post('/admin/flag-missing-credential', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const { profileId, portalHost, loginUrl, fundingTitle } = req.body || {}
  if (!profileId || !portalHost) {
    return res.status(400).json({ error: 'profileId and portalHost are required' })
  }
  try {
    const result = await flagMissingPortalCredential(req.db, {
      profileId: String(profileId),
      portalHost: String(portalHost),
      loginUrl: loginUrl ? String(loginUrl) : null,
      fundingTitle: fundingTitle ? String(fundingTitle) : null,
    })
    return res.json({ ok: true, ...result })
  } catch (err) {
    return res.status(500).json({ error: 'flag_failed', detail: err?.message })
  }
})

// Move an admin-managed login OUT of its current profile and INTO another.
router.post('/admin/credentials/:id/move', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const toProfileId = req.body?.toProfileId || req.body?.profileId
  if (!toProfileId) return res.status(400).json({ error: 'toProfileId required' })
  try {
    const result = await moveManagedCredential(req.db, { id: req.params.id, toProfileId })
    if (!result.moved) {
      const code = result.reason === 'not_found' ? 404 : result.reason === 'not_admin_managed' ? 403 : 400
      return res.status(code).json({ ok: false, error: result.reason, credential: result.credential || null })
    }
    return res.json({ ok: true, ...result })
  } catch (err) {
    return res.status(400).json({ error: 'move_failed', detail: err?.message })
  }
})

// Copy an admin-managed login INTO a profile, leaving the original in place
// (e.g. keep it in the admin vault and also grant it to a profile).
router.post('/admin/credentials/:id/copy', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const toProfileId = req.body?.toProfileId || req.body?.profileId
  if (!toProfileId) return res.status(400).json({ error: 'toProfileId required' })
  try {
    const result = await copyManagedCredentialToProfile(req.db, {
      id: req.params.id, toProfileId, actorUserId: getAuthUserId(req.user),
    })
    if (!result.copied) {
      const code = result.reason === 'not_found' ? 404 : result.reason === 'not_admin_managed' ? 403 : 400
      return res.status(code).json({ ok: false, error: result.reason })
    }
    return res.json({ ok: true, ...result })
  } catch (err) {
    return res.status(400).json({ error: 'copy_failed', detail: err?.message })
  }
})

// Remove an admin-managed login (only admin-placed rows can be deleted here).
router.delete('/admin/credentials/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const result = await deleteManagedCredential(req.db, req.params.id)
    if (!result.deleted) {
      const code = result.reason === 'not_found' ? 404 : result.reason === 'not_admin_managed' ? 403 : 400
      return res.status(code).json({ ok: false, error: result.reason })
    }
    return res.json({ ok: true, deleted: true })
  } catch (err) {
    return res.status(400).json({ error: 'delete_failed', detail: err?.message })
  }
})

// Bulk-remove admin-managed logins in one action ("Delete N marked" on the
// vault triage worklist). Each id is deleted best-effort with the same per-id
// guard as the single delete (only admin-placed rows can go); one bad row does
// not abort the sweep. Returns how many of the requested ids were deleted.
router.post('/admin/credentials/bulk-delete', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : []
  const ids = [...new Set(rawIds.map((id) => String(id || '')).filter(Boolean))]
  if (ids.length === 0) return res.status(400).json({ error: 'ids_required' })
  let deleted = 0
  for (const id of ids) {
    try {
      const result = await deleteManagedCredential(req.db, id)
      if (result?.deleted) deleted += 1
    } catch (err) {
      // Keep going so one bad row never aborts the whole clean-up sweep.
      log.warn('admin_credential_bulk_delete_row_failed', { id, err: err?.message })
    }
  }
  return res.json({ ok: true, deleted, total: ids.length })
})

// Standing attestations.
router.get('/attestations', async (req, res) => {
  const user = await requireProfileScope(req, res, req.query.profileId)
  if (!user) return
  const list = await listActiveAttestations(req.db, req.query.profileId)
  return res.json({ ok: true, categories: ATTESTATION_CATEGORIES, attestations: list })
})
router.post('/attestations', async (req, res) => {
  const user = await requireProfileScope(req, res, req.body?.profileId)
  if (!user) return
  try {
    const auth = await authorizeAttestation(req.db, { ...req.body, userId: getAuthUserId(user) })
    return res.json({ ok: true, attestation: auth })
  } catch (err) {
    return res.status(400).json({ error: 'authorize_failed', detail: err?.message })
  }
})
router.post('/attestations/:id/revoke', async (req, res) => {
  const ctx = await requireRecordOwnership(req, res, req.params.id, getAttestationById)
  if (!ctx) return
  const auth = await revokeAttestation(req.db, req.params.id, req.body?.reason || null)
  return res.json({ ok: true, attestation: auth })
})

// Portal policies govern what Hamilton is *allowed* to do on a given portal
// host (a legal/safety control), so writes are restricted to the canonical
// admin and reads require authentication.
router.get('/portal-policies', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  if (req.query.host) {
    const policy = await getPolicyFor(req.db, req.query.host)
    return res.json({ ok: true, policy })
  }
  const list = await listPolicies(req.db)
  return res.json({ ok: true, policies: list })
})
router.post('/portal-policies', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  if (req.ctx?.isAdmin !== true) return res.status(403).json({ error: 'forbidden_admin_only' })
  try {
    const policy = await upsertPolicy(req.db, req.body || {})
    return res.json({ ok: true, policy })
  } catch (err) {
    return res.status(400).json({ error: 'upsert_failed', detail: err?.message })
  }
})

// Resolved fields.
router.get('/resolved-fields', async (req, res) => {
  const user = await requireProfileScope(req, res, req.query.profileId)
  if (!user) return
  const list = await listResolvedFields(req.db, req.query.profileId)
  return res.json({ ok: true, fields: list })
})
router.post('/resolved-fields', async (req, res) => {
  const user = await requireProfileScope(req, res, req.body?.profileId)
  if (!user) return
  try {
    const field = await saveResolvedField(req.db, { ...req.body, userId: getAuthUserId(user) })
    return res.json({ ok: true, field })
  } catch (err) {
    return res.status(400).json({ error: 'save_failed', detail: err?.message })
  }
})

// Admin: dashboard list of every open hard stop in the system. Restricted to
// the configured Hamilton operator. Multi-admin routing is *not* the primary
// path — this endpoint accepts is_admin=1 OR an email that matches the
// configured admin email.
router.get('/admin/hard-stops', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  if (req.ctx?.isAdmin !== true) return res.status(403).json({ error: 'forbidden_admin_only' })
  try {
    const limit = Math.max(1, Math.min(500, Number.parseInt(req.query.limit || '200', 10) || 200))
    // Optional ?profile_id= narrows the checklist to one profile's stops (the
    // dashboard default remains "every profile").
    const profileId = String(req.query.profile_id || req.query.profileId || '').trim() || null
    const rawBlockers = await listOpenAdminBlockers(req.db, { limit, profileId })
    // Annotate each stop with its inline-fix descriptor (or null) so the UI only
    // renders a "type the value here" input for stops the save endpoint accepts.
    const blockers = (rawBlockers || []).map((b) => ({ ...b, inline_field: inlineFieldForBlocker(b) }))
    return res.json({ ok: true, blockers, admin_email: HAMILTON_ADMIN_EMAIL })
  } catch (err) {
    log.error('admin_hard_stops_failed', { err: err?.message })
    return res.status(500).json({ error: 'list_failed' })
  }
})

// Admin: resolve ONE hard stop from the operator checklist. Marks just this
// blocker resolved (not its siblings on the same task) and clears the
// persistent notifications it raised so the bell + toast list stay in sync.
// This is what powers "once the hard stop is taken care of, take it off the
// list" on the Hamilton processing window.
router.post('/admin/hard-stops/:blockerId/resolve', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  if (req.ctx?.isAdmin !== true) return res.status(403).json({ error: 'forbidden_admin_only' })
  const blockerId = String(req.params.blockerId || '')
  if (!blockerId) return res.status(400).json({ error: 'blocker_id_required' })
  try {
    const existing = await getBlocker(req.db, blockerId)
    if (!existing) return res.status(404).json({ error: 'blocker_not_found' })

    const note = String(req.body?.note || '').slice(0, 500) || 'Resolved from Hamilton processing checklist.'
    const resolved = await resolveBlockerById(req.db, {
      blockerId,
      strategy: 'user_action',
      detail: note,
      resolvedByUserId: getAuthUserId(user),
    })

    // Clear the persistent notifications tied to this blocker so the bell and
    // the toast list stop surfacing a stop the operator already handled.
    const notifIds = [
      resolved?.user_notification_id,
      ...((resolved?.admin_notification_ids) || []),
    ].filter(Boolean)
    if (notifIds.length > 0) await markNotificationsResolved(req.db, notifIds)

    if (resolved?.task_id) {
      await appendTaskEvent(req.db, {
        taskId: resolved.task_id,
        eventType: 'blocker_resolved',
        step: 'admin_checklist',
        message: `Hard stop "${resolved.blocker_type}" cleared from the processing checklist.`,
        actorUserId: getAuthUserId(user),
        actorRole: 'admin',
      })
    }

    return res.json({ ok: true, blocker: resolved })
  } catch (err) {
    log.error('admin_hard_stop_resolve_failed', { err: err?.message, blockerId })
    return res.status(500).json({ error: 'resolve_failed', detail: err?.message })
  }
})

// Admin: clear EVERY open hard stop in one action ("Delete all" on the
// operator dashboard). Each blocker is soft-resolved with strategy
// 'dismissed' (audit row written, not a hard delete) and its user/admin
// notifications are cleared so the bell + toast list stay in sync. This does
// NOT resume Hamilton on the affected tasks — dismissing a hard stop just
// takes it off the list; the operator re-runs processing when ready.
router.post('/admin/hard-stops/dismiss-all', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  if (req.ctx?.isAdmin !== true) return res.status(403).json({ error: 'forbidden_admin_only' })
  const note = String(req.body?.note || '').slice(0, 500) || 'Bulk-dismissed from the Hamilton operator dashboard.'
  // Optional: scope the clear to a single profile (the per-profile "Process
  // with Hamilton" page passes this so it only empties that profile's list).
  const scopeProfileId = req.body?.profileId ? String(req.body.profileId) : null
  try {
    const all = await listOpenAdminBlockers(req.db, { limit: 500 })
    const open = scopeProfileId
      ? all.filter((b) => String(b.profile_id) === scopeProfileId)
      : all
    let dismissed = 0
    const notifIds = []
    for (const b of open) {
      try {
        const resolved = await resolveBlockerById(req.db, {
          blockerId: b.id,
          strategy: 'dismissed',
          detail: note,
          resolvedByUserId: getAuthUserId(user),
        })
        if (resolved) {
          dismissed += 1
          notifIds.push(resolved.user_notification_id, ...((resolved.admin_notification_ids) || []))
          if (resolved.task_id) {
            await appendTaskEvent(req.db, {
              taskId: resolved.task_id,
              eventType: 'blocker_resolved',
              step: 'admin_checklist',
              message: `Hard stop "${resolved.blocker_type}" dismissed in bulk clear.`,
              actorUserId: getAuthUserId(user),
              actorRole: 'admin',
            })
          }
        }
      } catch (innerErr) {
        // Don't let one bad row abort the whole sweep — log and keep going.
        log.warn('admin_hard_stop_dismiss_all_row_failed', { blockerId: b?.id, err: innerErr?.message })
      }
    }
    const cleanNotifIds = notifIds.filter(Boolean)
    if (cleanNotifIds.length > 0) await markNotificationsResolved(req.db, cleanNotifIds)
    return res.json({ ok: true, dismissed, total: open.length })
  } catch (err) {
    log.error('admin_hard_stops_dismiss_all_failed', { err: err?.message })
    return res.status(500).json({ error: 'dismiss_all_failed', detail: err?.message })
  }
})

// The field key a missing/ambiguous-info blocker points at, if any. Mirrors
// blockerFieldKey() in src/config/hamiltonHardStopTargets.js.
function blockerFieldKey(blocker) {
  const m = blocker?.metadata || {}
  return m.field || m.key || m.missing_info_key || m.missing_field || null
}

// Admin: resolve a missing/ambiguous-field hard stop INLINE — the operator types
// the value right in the hard-stop banner and we (1) write it back into the
// profile section it was missing from, (2) cache it as a resolved field so
// Hamilton reuses it on this and every future portal, (3) mark the blocker
// resolved + clear its notifications, and (4) re-run Hamilton so she continues
// from where she stopped. This is the "bring the fix to the banner" path.
router.post('/admin/hard-stops/:blockerId/resolve-field', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  if (req.ctx?.isAdmin !== true) return res.status(403).json({ error: 'forbidden_admin_only' })

  const blockerId = String(req.params.blockerId || '')
  if (!blockerId) return res.status(400).json({ error: 'blocker_id_required' })

  const rawValue = req.body?.value
  const value = typeof rawValue === 'string' ? rawValue.trim() : rawValue
  if (value === undefined || value === null || String(value).trim() === '') {
    return res.status(400).json({ error: 'value_required', message: 'Enter a value to save.' })
  }
  if (String(value).length > 2000) {
    return res.status(400).json({ error: 'value_too_long', message: 'Value is too long (max 2000 characters).' })
  }

  try {
    const blocker = await getBlocker(req.db, blockerId)
    if (!blocker) return res.status(404).json({ error: 'blocker_not_found' })

    // Only missing/ambiguous-field stops are inline-fixable. Anything else
    // (login, document, payment, signature) is handled on its own surface.
    const inlineTypes = new Set(['missing_required_information', 'ambiguous_required_field'])
    if (!inlineTypes.has(blocker.blocker_type)) {
      return res.status(409).json({ error: 'not_inline_fixable', message: 'This hard stop is not a missing-field stop.' })
    }

    const fieldKey = blockerFieldKey(blocker)
    const target = fieldKey ? resolveProfileFieldTarget(fieldKey) : null
    if (!target) {
      return res.status(422).json({
        error: 'field_not_mappable',
        message: `Hamilton could not map "${fieldKey || 'this field'}" to an editable profile field. Fix it on the profile instead.`,
      })
    }

    const profileId = blocker.profile_id
    if (!profileId) return res.status(422).json({ error: 'blocker_has_no_profile' })

    // 1. Write the value back into the profile section it was missing from.
    let saveResult
    try {
      saveResult = await setProfileSectionField(req.db, {
        profileId,
        sectionKey: target.section,
        field: target.field,
        value,
        updatedBy: getAuthUserId(user),
      })
    } catch (saveErr) {
      if (saveErr?.code === 'field_rejected') {
        return res.status(422).json({ error: 'field_rejected', message: saveErr.message, rejected: saveErr.rejected })
      }
      throw saveErr
    }

    // 2. Cache it for Hamilton's reuse (so she never re-asks for this field).
    await saveResolvedField(req.db, {
      profileId,
      userId: getAuthUserId(user),
      fieldKey: target.key,
      fieldValue: String(value),
      source: 'user',
      confidence: 1.0,
    }).catch(() => {})

    // 3. Mark this blocker resolved + clear the notifications it raised.
    const resolved = await resolveBlockerById(req.db, {
      blockerId,
      strategy: 'inline_field_fix',
      detail: `Operator supplied "${target.label}" inline; saved to ${target.section}.${target.field}.`,
      resolvedByUserId: getAuthUserId(user),
    })
    const notifIds = [resolved?.user_notification_id, ...((resolved?.admin_notification_ids) || [])].filter(Boolean)
    if (notifIds.length > 0) await markNotificationsResolved(req.db, notifIds)

    // 4. Resume Hamilton from where she stopped (automation is king).
    //
    // CRITICAL: everything below is best-effort and must NEVER 500 the request.
    // The field write (step 1) and blocker resolution (step 3) are the
    // user-visible result and have already committed. Two classes of blocker
    // carry a task_id that is NOT a real application_tasks row:
    //   - preflight-synthetic blockers ("preflight_<profileId>_<oppId>"), and
    //   - orphaned blockers whose task the 2026-06-19 pipeline prune deleted.
    // Logging a task event or resuming against either FK-violates
    // application_task_events and previously surfaced as a 500 even though the
    // value saved fine. So we resolve the task FIRST and only log + resume when
    // it genuinely exists, wrapping the whole step so any failure is swallowed.
    let rerun = null
    if (resolved?.task_id) {
      try {
        const task = await getApplicationTask(req.db, resolved.task_id)
        if (task) {
          await appendTaskEvent(req.db, {
            taskId: task.id,
            eventType: 'blocker_resolved',
            step: 'inline_field_fix',
            message: `"${target.label}" supplied inline and saved to the profile. Re-running Hamilton.`,
            actorUserId: getAuthUserId(user),
            actorRole: 'admin',
            details: { field_key: target.key, section: target.section, field: target.field },
          })
          const profile = await loadProfile(req.db, task.profile_id)
          if (profile) {
            // Resume in the BACKGROUND — the field is already saved; never make
            // the operator's inline fix wait on (or time out against) a full
            // browser re-run.
            rerun = { task_id: task.id, queued: true }
            runAutomationInBackground('inline_field_fix_resume', () => automateSingleSource(req.db, {
              profile,
              profileId: task.profile_id,
              userId: getAuthUserId(user),
              source: {
                opportunity_id: task.opportunity_id,
                grant_id: task.grant_id,
                task_id: task.id,
                current_stage: task.current_pipeline_stage || task.selected_from_stage,
              },
              // Same rule as resolve-blocker: an inline field fix restores the
              // task's own stored authorization, it never grants a new one.
              options: { autopilot: true },
            }))
          }
        }
      } catch (rerunErr) {
        // The field is saved and the blocker is cleared regardless; a failed
        // auto-resume is non-fatal (the operator can re-run from the dashboard).
        log.warn('inline_field_fix_rerun_failed', { err: rerunErr?.message, taskId: resolved.task_id })
      }
    }

    return res.json({
      ok: true,
      blocker: resolved,
      saved_field: { key: target.key, section: target.section, field: target.field, label: target.label },
      rejected: saveResult.rejected,
      rerun: rerun ? { task_id: rerun.task_id, status: 'queued' } : null,
    })
  } catch (err) {
    log.error('admin_hard_stop_resolve_field_failed', { err: err?.message, blockerId })
    return res.status(500).json({ error: 'resolve_field_failed', detail: err?.message })
  }
})

// Admin: aggregated counts + recent task list for the canonical admin
// dashboard. Used by AdminHamiltonHardStops to render the four columns
// (pending hard stops / active / failed / completed) with a single
// round-trip.
router.get('/admin/tasks', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  if (req.ctx?.isAdmin !== true) return res.status(403).json({ error: 'forbidden_admin_only' })
  try {
    const status = String(req.query.status || 'all').toLowerCase()
    const allowed = new Set(['all', 'active', 'blocked', 'failed', 'completed'])
    const filter = allowed.has(status) ? status : 'all'
    const limit = Math.max(1, Math.min(500, Number.parseInt(req.query.limit || '100', 10) || 100))

    let where = ''
    const params = []
    if (filter === 'active') {
      where = "WHERE status IN ('queued','running','waiting_for_review','in_progress')"
    } else if (filter === 'blocked') {
      where = "WHERE status = 'blocked'"
    } else if (filter === 'failed') {
      where = "WHERE status = 'failed'"
    } else if (filter === 'completed') {
      where = "WHERE status IN ('submitted','completed','completed_draft')"
    }
    const rows = await req.db.prepare(
      `SELECT id, profile_id, user_id, opportunity_id, grant_id, status,
              automation_type, last_agent_message, updated_at, created_at
         FROM application_tasks
         ${where}
         ORDER BY updated_at DESC
         LIMIT ?`,
    ).all(...params, limit)
    return res.json({ ok: true, tasks: rows || [], filter, admin_email: HAMILTON_ADMIN_EMAIL })
  } catch (err) {
    log.error('admin_tasks_failed', { err: err?.message })
    return res.status(500).json({ error: 'list_failed' })
  }
})

// Cancel a Hamilton task. Resolves all open blockers and stops automation.
router.post('/tasks/:taskId/cancel', async (req, res) => {
  const ctx = await loadTaskAndAuthorise(req, res, req.params.taskId)
  if (!ctx) return
  if (ctx.task.submission_proof?.source === 'owner_attested_manual_receipt') {
    return res.status(409).json({
      error: 'manual_submission_receipt_active',
      message: 'Revoke the active portal receipt before cancelling this submitted task.',
    })
  }
  const reason = String(req.body?.reason || '').slice(0, 500) || 'cancelled_by_user'
  try {
    cancelActiveHamiltonTaskRun(ctx.task.id, reason)
    const task = await cancelApplicationTask(req.db, ctx.task.id, {
      actorUserId: getAuthUserId(ctx.user),
      actorRole: req.ctx?.isAdmin === true ? 'admin' : 'user',
      reason,
    })
    const resolvedBlockers = await resolveOpenBlockersForTask(req.db, {
      taskId: ctx.task.id,
      strategy: 'cancelled',
      detail: reason,
      resolvedByUserId: getAuthUserId(ctx.user),
    })
    for (const b of resolvedBlockers) {
      const ids = [b.user_notification_id, ...(b.admin_notification_ids || [])].filter(Boolean)
      if (ids.length > 0) await markNotificationsResolved(req.db, ids)
    }
    const warning = task?.status === 'submission_verification_required'
      ? {
          code: 'submission_action_may_be_in_progress',
          message: 'Hamilton had already reached the portal submission boundary. Automation is stopped, but the external action may already have occurred; check the portal before retrying.',
        }
      : null
    return res.json({
      ok: true,
      task,
      resolved_blockers: resolvedBlockers,
      ...(warning ? { warning } : {}),
    })
  } catch (err) {
    log.error('cancel_task_failed', { err: err?.message })
    if (err?.code === 'manual_submission_receipt_active') {
      return res.status(409).json({ error: err.code, message: err.message })
    }
    return res.status(500).json({ error: 'cancel_failed', detail: err?.message })
  }
})

// Blockers.
router.get('/tasks/:taskId/blockers', async (req, res) => {
  const ctx = await loadTaskAndAuthorise(req, res, req.params.taskId)
  if (!ctx) return
  const onlyOpen = String(req.query.onlyOpen || 'false').toLowerCase() === 'true'
  const list = await listBlockersForTask(req.db, ctx.task.id, { onlyOpen })
  return res.json({ ok: true, blockers: list })
})
router.post('/tasks/:taskId/resolve-blocker-input', async (req, res) => {
  const ctx = await loadTaskAndAuthorise(req, res, req.params.taskId)
  if (!ctx) return
  try {
    const directive = await resolveBlocker(req.db, {
      taskId: ctx.task.id,
      profileId: ctx.task.profile_id,
      userId: req.user?.id || null,
      portalUrl: ctx.task.portal_url || ctx.task.application_url || null,
      classification: { automation_type: ctx.task.automation_type },
    }, req.body || {})
    return res.json({ ok: true, directive })
  } catch (err) {
    return res.status(400).json({ error: 'resolve_failed', detail: err?.message })
  }
})

// ── Profile work summary ──────────────────────────────────────────────────────
// One read-only, profile-access-scoped view powering the profile-page "Hamilton"
// button: WHAT he is working on right now + EVERYWHERE the owner must add
// information for him to finish. The aggregation itself lives in
// services/hamilton/hamiltonProfileSummary.js so the SAME needs list also feeds
// the Profile Action Plan (/api/ai/profile-todo) — change it there, not here.
router.get('/profile-summary', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const profileId = String(req.query.profileId || req.query.profile_id || '').trim()
  if (!profileId) return res.status(400).json({ error: 'profileId_required' })
  if (!(await userMayAccessProfile(req, user, profileId))) {
    return res.status(403).json({ error: 'forbidden' })
  }

  const summary = await buildHamiltonProfileSummary(req.db, profileId)

  return res.json({
    ok: true,
    profile_id: profileId,
    working_on: summary.working_on,
    needs_you: summary.needs_you,
    next_run_at: summary.next_run_at,
    counts: { working: summary.working_on.length, needs: summary.needs_you.length },
  })
})

export default router
