import { parseDbTimestamp } from '../../utils/dbTimestamp.js'
/**
 * hamiltonSubmissionVerifier.js — the post-submit verification pass.
 *
 * THE GAP (owner dashboard 2026-08-30, measured): a run that crossed the
 * irreversible submit boundary without durable receipt evidence parks the task
 * as `submission_verification_required` ("a submission may have gone through
 * and could not be confirmed") with `next_retry_at = NULL` — and NOTHING in
 * the product ever looked again. The scheduler has no arm for the status, the
 * retry/approve routes 409 on it, and the one person "who can settle whether
 * the application actually went through" was expected to hand-check every
 * portal (Volunteers of America, Free Clinics, Project Home, MTSU Alumni
 * Endowment, HUD — all parked forever).
 *
 * THIS SWEEP re-opens the portal (read-only — it NEVER clicks anything, so it
 * can never double-submit) with the profile's saved session where one exists,
 * looks at the pages the run itself recorded (the captured confirmation URL
 * first, then the application/portal URL), and runs the engine's OWN evidence
 * primitives over what it finds:
 *
 *   - a plausible confirmation REFERENCE (extractConfirmationReference /
 *     extractConfirmationReferenceFromUrl — the same bars, so a DOM slug or a
 *     prose word can never qualify), or
 *   - an explicit receipt ACKNOWLEDGEMENT (detectReceiptAcknowledgement) with
 *     an owner-retrievable capture registered as durable proof.
 *
 * Evidence found → the run and task are promoted to `submitted` through the
 * same artifact-registration path the live submit uses (screenshot + saved
 * page in `documents`, reference on the run row). Nothing found → the attempt
 * is recorded on the task (visible, bounded), and after MAX_ATTEMPTS the task
 * stays parked for a human with the attempts named. The quarantine's honesty
 * is never weakened: this only ever ADDS evidence; ambiguity stays parked.
 *
 * ToS floor: a host whose portal policy forbids automation is never re-opened
 * (the manual-packet posture there is deliberate product policy).
 */

import { _internal as engineInternal } from './hamiltonAutopilotEngine.js'
import {
  resolveConfirmationCaptureDir,
  registerConfirmationArtifact,
} from './hamiltonConfirmationArtifacts.js'
import { listAutopilotRuns, updateAutopilotRun } from './hamiltonAuthorizationStore.js'
import {
  updateApplicationTask,
  appendTaskEvent,
  ensureApplicationTaskSchema,
} from './applicationTaskStore.js'
import { findValidSession, getSessionStorageState, normalizeHost } from './hamiltonCredentialSessionService.js'
import { getPolicyFor } from './hamiltonPortalPolicyRegistry.js'
import { isHamiltonBrowserTargetAllowed } from './controlledBetaBrowserPolicy.js'
import { launchPortalBrowser, REALISTIC_PORTAL_UA } from './browserLaunch.js'
import { emitHamiltonNotificationToProfileAndAdmins } from './hamiltonNotifications.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:hamilton-submission-verifier')

/** Re-checks per task before the park is handed to a human for good. */
export const VERIFICATION_MAX_ATTEMPTS = 3
/** Minimum spacing between re-checks of the same task (ms). */
export const VERIFICATION_MIN_SPACING_MS = 4 * 60 * 60_000
/** Pages examined per task per pass (confirmation URL, then portal URL). */
const MAX_PAGES_PER_TASK = 2
const NAV_TIMEOUT_MS = 25_000

const RECHECK_STEP = 'submission_verification_recheck'
/**
 * A verdict of 'skipped' is NOT a check (hamilton-submit-8, 2026-09-12): it
 * used to be appended under RECHECK_STEP, so three skips that never opened a
 * portal exhausted the task ("a human must check") with zero probes performed,
 * and the unevidenced-close sweep could then cancel it. Skips are recorded
 * under their own step, never count toward VERIFICATION_MAX_ATTEMPTS, and a
 * DETERMINISTIC skip (nothing about the task will make it probeable) marks the
 * task unprobeable ONCE so it neither re-skips every tick nor occupies a probe
 * slot ahead of tasks that can be checked.
 */
const SKIP_STEP = 'submission_verification_skipped'
export const UNPROBEABLE_STEP = 'submission_verification_unprobeable'
const DETERMINISTIC_SKIP_REASONS = Object.freeze({
  no_probe_url: 'the task carries no portal or application URL to re-open',
  portal_terms_forbid_automation: 'the portal\'s terms forbid automated access, so Hamilton never re-opens it',
  unsafe_browser_target: 'the recorded URL is not a public HTTPS target Hamilton may open',
})

function firstUrlOf(...candidates) {
  const seen = new Set()
  const out = []
  for (const raw of candidates) {
    const u = String(raw || '').trim()
    if (!/^https?:\/\//i.test(u)) continue
    if (seen.has(u)) continue
    seen.add(u)
    out.push(u)
  }
  return out
}

/**
 * Prior recheck attempts recorded on the task (count + latest timestamp).
 * The ledger is the task's own event stream — durable, owner-visible.
 */
async function priorRecheckAttempts(db, taskId) {
  try {
    const row = await db.prepare(
      `SELECT COUNT(*) AS n, MAX(created_at) AS latest
         FROM application_task_events
        WHERE task_id = ? AND step = ?`,
    ).get(String(taskId), RECHECK_STEP)
    return { count: Number(row?.n) || 0, latestMs: parseDbTimestamp(row?.latest) || 0 }
  } catch {
    return { count: 0, latestMs: 0 }
  }
}

/**
 * Read one page's evidence with the ENGINE's own primitives. Never throws.
 * @returns {{ url, reference, received_acknowledgement, capture } | null}
 */
async function readEvidenceFromPage(page, targetUrl) {
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null)
  } catch {
    return null
  }
  const capture = await engineInternal.captureConfirmation(page, resolveConfirmationCaptureDir()).catch(() => null)
  if (!capture) return null
  // STRICT acknowledgement only (the phrasal RECEIPT_ACK_RX — "your
  // application has been received", "thank you for your submission"). The
  // engine's broader detector also counts an "Application ID:" LABEL, which is
  // corroborative on a post-submit page but on a re-opened portal dashboard a
  // DRAFT application prints the same label — so the verifier must not treat
  // it as an acknowledgement.
  const strictAck = engineInternal.RECEIPT_ACK_RX.test(String(capture.page_text || ''))
  return {
    url: capture.url || targetUrl,
    reference: capture.reference || null,
    received_acknowledgement: strictAck,
    capture: { ...capture, received_acknowledgement: strictAck },
  }
}

/**
 * Verify ONE parked task. `deps._openPage` is the test seam: an async
 * ({ url, storageState }) => ({ page, close }) that replaces the real browser.
 *
 * @returns {{ taskId, outcome: 'confirmed'|'still_unverified'|'skipped', reason?, evidence? }}
 */
export async function verifyOneParkedSubmission(db, task, deps = {}) {
  const taskId = task.id
  const targets = firstUrlOf(
    // The page the run last saw is the strongest read; the portal roots come after.
    ...(deps._extraUrls || []),
    task.application_url,
    task.portal_url,
  )

  // Latest run for this task — its captured confirmation URL leads the probe
  // order, and its pre-submit reference (when retained) guards "is it NEW".
  let run = null
  try {
    const runs = await listAutopilotRuns(db, { taskId, limit: 10 })
    run = (runs || []).find((r) => r.status === 'submission_verification_required')
      || (runs || [])[0] || null
  } catch { run = null }
  const runResult = run?.result || {}
  const preSubmitReference = engineInternal.normalizedReference(
    runResult?.before_submit_capture?.reference
    || runResult?.submit_capture_history?.before?.reference
    || null,
  )
  const capturedUrl = runResult?.confirmation_url || null
  const probeUrls = firstUrlOf(capturedUrl, ...targets).slice(0, MAX_PAGES_PER_TASK)
  if (probeUrls.length === 0) {
    return { taskId, outcome: 'skipped', reason: 'no_probe_url' }
  }

  // ToS floor + SSRF floor: never re-open a portal whose terms forbid
  // automation, never a non-public target.
  const host = normalizeHost(probeUrls[0])
  const policy = await getPolicyFor(db, host).catch(() => null)
  if (policy && policy.automation_allowed === false) {
    return { taskId, outcome: 'skipped', reason: 'portal_terms_forbid_automation' }
  }
  if (!probeUrls.every((u) => isHamiltonBrowserTargetAllowed(u))) {
    return { taskId, outcome: 'skipped', reason: 'unsafe_browser_target' }
  }

  // Saved session, when one exists — the dashboard-entry check usually needs it.
  let storageState = null
  try {
    const saved = await findValidSession(db, { profileId: task.profile_id, portalHost: host })
    if (saved?.has_storage_state) storageState = await getSessionStorageState(db, saved.id)
  } catch { storageState = null }

  const openPage = deps._openPage || (async ({ url, storageState: state }) => {
    const { chromium } = await import('playwright')
    const { browser } = await launchPortalBrowser(chromium, { headless: true, targetUrl: url })
    const context = await browser.newContext({
      userAgent: REALISTIC_PORTAL_UA,
      ...(state ? { storageState: state } : {}),
    })
    const page = await context.newPage()
    return {
      page,
      close: async () => {
        try { await context.close() } catch { /* ignore */ }
        try { await browser.close() } catch { /* ignore */ }
      },
    }
  })

  let evidence = null
  let handle = null
  try {
    handle = await openPage({ url: probeUrls[0], storageState })
    for (const target of probeUrls) {
      const read = await readEvidenceFromPage(handle.page, target)
      if (!read) continue
      const refNorm = engineInternal.normalizedReference(read.reference)
      const referenceIsNew = Boolean(refNorm) && refNorm !== preSubmitReference
      // EVIDENCE BAR: a bare reference qualifies only on the page the RUN
      // itself captured post-submit (the portal's own outcome page). On any
      // other page — a portal dashboard, the application URL — an
      // "Application ID: X" can belong to a DRAFT, so a reference there needs
      // the page's own receipt acknowledgement beside it. An acknowledgement
      // ("your application has been received") qualifies anywhere: portals do
      // not print it for drafts.
      const onCapturedOutcomePage = Boolean(capturedUrl) && target === capturedUrl
      const referenceQualifies = read.reference && referenceIsNew
        && (onCapturedOutcomePage || read.received_acknowledgement)
      if (referenceQualifies || read.received_acknowledgement) {
        evidence = { ...read, reference_is_new: referenceIsNew && Boolean(referenceQualifies) }
        break
      }
    }
  } catch (err) {
    log.warn('verification probe failed (non-fatal)', { task_id: taskId, err: err?.message })
  } finally {
    try { await handle?.close?.() } catch { /* ignore */ }
  }

  if (!evidence) return { taskId, outcome: 'still_unverified', reason: 'no_receipt_evidence_found' }

  // Only a QUALIFIED reference (new + found on the run's own outcome page, or
  // corroborated by an acknowledgement) is ever recorded as the confirmation.
  const qualifiedReference = evidence.reference_is_new ? evidence.reference : null

  // Durable, owner-retrievable proof through the SAME registration path the
  // live submit uses. A registration failure leaves the task parked — a claim
  // without retrievable proof is exactly what this status exists to prevent.
  let artifact = null
  try {
    artifact = await registerConfirmationArtifact(db, {
      profileId: task.profile_id,
      grantId: task.grant_id || null,
      opportunityId: task.opportunity_id || null,
      taskId,
      title: task.title || 'Application',
      screenshotPath: evidence.capture.screenshot_path || null,
      pageHtmlPath: evidence.capture.page_html_path || null,
      pageText: evidence.capture.page_text || null,
      reference: qualifiedReference,
      referenceIsNew: evidence.reference_is_new === true,
      receivedAcknowledgement: evidence.received_acknowledgement === true,
      receivedAcknowledgementIsNew: evidence.received_acknowledgement === true,
      capturedUrl: evidence.url || null,
    })
  } catch (err) {
    log.warn('confirmation artifact registration failed — task stays parked', { task_id: taskId, err: err?.message })
    return { taskId, outcome: 'still_unverified', reason: 'proof_registration_failed' }
  }
  const proofDocumentId = artifact?.screenshot_document_id || artifact?.page_document_id || null
  if (artifact?.evidence_classification !== 'confirmation_proof') {
    // The write-side authority did not classify what we found as proof (e.g.
    // a reference that fails the shape guard). Ambiguity stays parked.
    return { taskId, outcome: 'still_unverified', reason: 'evidence_not_classified_as_proof' }
  }
  if (!proofDocumentId && !evidence.reference_is_new) {
    // An acknowledgement with NO retrievable capture is not durable proof.
    return { taskId, outcome: 'still_unverified', reason: 'no_durable_proof_retained' }
  }

  const message = qualifiedReference
    ? `Post-submit verification re-opened the portal and found the submission confirmed. Confirmation: ${qualifiedReference}.`
    : 'Post-submit verification re-opened the portal and found an explicit receipt acknowledgement; the confirmation page was retained as proof.'

  if (run?.id) {
    await updateAutopilotRun(db, run.id, {
      status: 'submitted',
      blockerKind: null,
      blockerDetail: null,
      confirmationReference: qualifiedReference,
      confirmationScreenshotPath: evidence.capture.screenshot_path || null,
      result: {
        ...runResult,
        // The SAME evidence keys the live submit writes (hamilton-submit-1,
        // 2026-09-12). The read side (assessStoredConfirmationProof /
        // submissionProofPredicate) classifies proof from these keys; spreading
        // only the OLD attempt-evidence result over the promotion left every
        // verifier-confirmed task reading INTERNAL_ONLY forever.
        confirmation_evidence: artifact?.confirmed_by
          || (qualifiedReference ? 'portal_reference' : 'portal_acknowledgement'),
        confirmation_reference: qualifiedReference,
        confirmation_reference_is_new: Boolean(qualifiedReference),
        confirmation_received_acknowledgement: evidence.received_acknowledgement === true,
        confirmation_received_acknowledgement_is_new: evidence.received_acknowledgement === true,
        confirmation_url: evidence.url || null,
        confirmation_screenshot_path: evidence.capture.screenshot_path || null,
        confirmation_page_html_path: evidence.capture.page_html_path || null,
        confirmation_page_text: evidence.capture.page_text ? String(evidence.capture.page_text).slice(0, 4000) : null,
        confirmation_document_id: proofDocumentId,
        confirmation_page_document_id: artifact?.page_document_id || null,
        submission_evidence_classification: artifact?.evidence_classification || 'attempt_evidence',
        post_submit_verification: {
          verified_at: new Date().toISOString(),
          url: evidence.url,
          reference: qualifiedReference,
          received_acknowledgement: evidence.received_acknowledgement === true,
          confirmation_document_id: proofDocumentId,
        },
      },
      finishedAt: new Date().toISOString(),
    }).catch(() => {})
  }
  const promoted = await updateApplicationTask(db, taskId, {
    onlyIfStatuses: ['submission_verification_required'],
    status: 'submitted',
    submittedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    lastAgentMessage: message,
    ...(proofDocumentId ? { outputDocumentId: proofDocumentId } : {}),
  })
  if (promoted?.status !== 'submitted') {
    return { taskId, outcome: 'skipped', reason: 'task_state_changed_during_verification' }
  }
  await appendTaskEvent(db, {
    taskId,
    eventType: 'submitted',
    status: 'submitted',
    step: 'post_submit_verification',
    message,
    actorRole: 'agent',
    details: {
      autopilot_run_id: run?.id || null,
      confirmation: qualifiedReference,
      confirmation_document_id: proofDocumentId,
      verified_url: evidence.url,
      received_acknowledgement: evidence.received_acknowledgement === true,
    },
  }).catch(() => {})
  await emitHamiltonNotificationToProfileAndAdmins(db, {
    profileId: task.profile_id,
    profileUserId: task.user_id,
    type: 'hamilton_submitted',
    title: 'Submission confirmed on re-check',
    message,
    severity: 'success',
    data: { task_id: taskId, run_id: run?.id || null, confirmation: qualifiedReference, confirmation_document_id: proofDocumentId },
  }).catch(() => {})
  // Promote the linked grant so the pipeline shows the pending award.
  if (task.grant_id) {
    try {
      const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
      const dateExpr = db?.dialect === 'postgres' ? 'CURRENT_DATE' : "date('now')"
      await db.prepare(
        `UPDATE grants SET status = 'submitted', submitted_date = COALESCE(submitted_date, ${dateExpr}), updated_at = ${nowFn} WHERE id = ?`,
      ).run(String(task.grant_id))
    } catch { /* grants table may be absent in fixtures */ }
  }
  return { taskId, outcome: 'confirmed', evidence: { reference: qualifiedReference, url: evidence.url } }
}

/**
 * The recurring sweep: bounded re-verification of parked
 * `submission_verification_required` tasks. Wired into the Hamilton scheduler
 * tick beside the keep-alive sweep. Never throws.
 *
 * @returns {{ checked, confirmed, still_unverified, skipped, exhausted }}
 */
export async function runSubmissionVerificationSweep(db, { limit = 3, now = Date.now(), _openPage = null } = {}) {
  const out = { checked: 0, confirmed: 0, still_unverified: 0, skipped: 0, unprobeable: 0, exhausted: 0 }
  if (!db || typeof db.prepare !== 'function') return out
  await ensureApplicationTaskSchema(db).catch(() => {})

  let rows = []
  try {
    // Exhausted tasks are excluded IN SQL. Prod 2026-09-05: with LIMIT 3 and
    // `ORDER BY updated_at ASC`, the three oldest parked tasks (all at 3/3)
    // filled every slot on every tick and the younger ones were never
    // re-checked at all — the cap starved the queue it was meant to bound.
    // The same starvation one level down (2026-09-12): a task re-checked
    // within VERIFICATION_MIN_SPACING_MS still occupied a slot as "skipped",
    // so the spacing rule is ALSO a SQL predicate now, and a task marked
    // unprobeable (deterministic skip, see SKIP_STEP) never takes a slot.
    // Dialect note: SQLite stores CURRENT_TIMESTAMP as 'YYYY-MM-DD HH:MM:SS'
    // while back-dated fixtures write ISO strings — datetime() normalizes
    // both; Postgres compares timestamptz to the ISO cutoff directly.
    // Dialect-selected LITERAL predicate: two compile-time strings holding only
    // a bound-parameter placeholder — no user input ever reaches this fragment
    // (the cutoff is bound as `spacingCutoffIso` below), which is why the
    // safe-sql gate accepts it under the `Safe` naming convention.
    const recentEventSafeSql = db?.dialect === 'postgres'
      ? 'e2.created_at > CAST(? AS timestamptz)'
      : 'datetime(e2.created_at) > datetime(?)'
    const spacingCutoffIso = new Date(now - VERIFICATION_MIN_SPACING_MS).toISOString()
    rows = await db.prepare(
      `SELECT * FROM application_tasks
        WHERE status = 'submission_verification_required'
          AND cancelled_at IS NULL
          AND COALESCE(current_step, '') <> ?
          AND (SELECT COUNT(*) FROM application_task_events e
                WHERE e.task_id = application_tasks.id AND e.step = ?) < ?
          AND NOT EXISTS (SELECT 1 FROM application_task_events e2
                WHERE e2.task_id = application_tasks.id AND e2.step = ? AND ${recentEventSafeSql})
        ORDER BY updated_at ASC
        LIMIT ?`,
    ).all(
      UNPROBEABLE_STEP, RECHECK_STEP, VERIFICATION_MAX_ATTEMPTS, RECHECK_STEP, spacingCutoffIso,
      Math.max(1, Math.min(10, Number(limit) || 3)),
    )
    if (!Array.isArray(rows)) rows = []
    const unprobeableRow = await db.prepare(
      `SELECT COUNT(*) AS n FROM application_tasks
        WHERE status = 'submission_verification_required'
          AND cancelled_at IS NULL
          AND COALESCE(current_step, '') = ?`,
    ).get(UNPROBEABLE_STEP)
    out.unprobeable = Number(unprobeableRow?.n) || 0
    const exhaustedRow = await db.prepare(
      `SELECT COUNT(*) AS n FROM application_tasks
        WHERE status = 'submission_verification_required'
          AND cancelled_at IS NULL
          AND (SELECT COUNT(*) FROM application_task_events e
                WHERE e.task_id = application_tasks.id AND e.step = ?) >= ?`,
    ).get(RECHECK_STEP, VERIFICATION_MAX_ATTEMPTS)
    out.exhausted = Number(exhaustedRow?.n) || 0
  } catch { return out }

  for (const task of rows) {
    const attempts = await priorRecheckAttempts(db, task.id)
    if (attempts.count >= VERIFICATION_MAX_ATTEMPTS) { continue }
    if (attempts.latestMs && now - attempts.latestMs < VERIFICATION_MIN_SPACING_MS) { out.skipped += 1; continue }

    out.checked += 1
    const verdict = await verifyOneParkedSubmission(db, task, _openPage ? { _openPage } : {})
    if (verdict.outcome === 'confirmed') {
      out.confirmed += 1
      continue
    }
    if (verdict.outcome === 'skipped') {
      // A skip is not a check: it never spends a RECHECK attempt. A
      // deterministic skip is recorded ONCE (durable, owner-visible) and the
      // task is marked unprobeable so it leaves the sweep's candidate set; a
      // human has to reconcile it. A task that changed state mid-verification
      // has already left the parked set — nothing to record.
      out.skipped += 1
      const why = DETERMINISTIC_SKIP_REASONS[verdict.reason]
      if (why) {
        out.unprobeable += 1
        const message = `Post-submit verification cannot re-open this portal automatically: ${why}. No re-check attempt was spent. A human must check the funder portal and reconcile the retained evidence before this task can move.`
        await updateApplicationTask(db, task.id, {
          onlyIfStatuses: ['submission_verification_required'],
          currentStep: UNPROBEABLE_STEP,
          lastAgentMessage: message,
        }).catch(() => {})
        await appendTaskEvent(db, {
          taskId: task.id,
          eventType: 'note',
          status: 'submission_verification_required',
          step: SKIP_STEP,
          message,
          actorRole: 'agent',
          details: { reason: verdict.reason, probe_performed: false, counted_toward_attempts: false },
        }).catch(() => {})
      }
      continue
    }
    out.still_unverified += 1
    // Record the attempt DURABLY so the cap holds across restarts and the
    // owner can see the re-checks happened. The final attempt says plainly
    // that a human has to look.
    const attemptNo = attempts.count + 1
    const exhaustedNow = attemptNo >= VERIFICATION_MAX_ATTEMPTS
    await appendTaskEvent(db, {
      taskId: task.id,
      eventType: 'note',
      status: 'submission_verification_required',
      step: RECHECK_STEP,
      message: exhaustedNow
        ? `Post-submit verification re-checked the portal ${attemptNo} time(s) and found no receipt evidence either way. A human must check the funder portal before this task can move.`
        : `Post-submit verification re-checked the portal (attempt ${attemptNo}/${VERIFICATION_MAX_ATTEMPTS}) and found no receipt evidence yet; it will re-check automatically.`,
      actorRole: 'agent',
      details: { attempt: attemptNo, max_attempts: VERIFICATION_MAX_ATTEMPTS, reason: verdict.reason || null },
    }).catch(() => {})
  }
  if (out.checked > 0) log.info('submission verification sweep', out)
  return out
}

export default {
  runSubmissionVerificationSweep, verifyOneParkedSubmission,
  VERIFICATION_MAX_ATTEMPTS, VERIFICATION_MIN_SPACING_MS, UNPROBEABLE_STEP,
}
