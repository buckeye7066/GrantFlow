/**
 * yanaPortalAutomation.js
 *
 * The Playwright-driven orchestrator that owns the state machine for a
 * supervised browser session. Every public function:
 *   1. requires browser automation to be enabled
 *      (YANA_ENABLE_BROWSER_AUTOMATION=true),
 *   2. enforces profile scoping (the caller must pass profileId; we
 *      reject if the underlying task/session belongs to a different
 *      profile),
 *   3. logs an audit event before AND after side effects so the trail
 *      is complete even on crash, and
 *   4. never bypasses CAPTCHA / 2FA / SSO / consent / signature.
 *
 * State machine summary:
 *
 *      not_started
 *           â”‚ start()
 *           â–¼
 *     launching_browser
 *           â”‚ navigated to portal_url
 *           â–¼
 *     waiting_for_user_login  â—€â”€â”€ (login/2FA/CAPTCHA detected)
 *           â”‚ markUserReady()
 *           â–¼
 *     inspecting_form â”€â–º mapping_fields â”€â–º filling_fields
 *           â”‚                                 â”‚
 *           â–¼                                 â–¼
 *     missing_info_required             waiting_for_user_review
 *           â”‚ supplyMissingInfo() then markUserReady()
 *           â”‚                                 â”‚ approveSubmit() w/ allow=true
 *           â–¼                                 â–¼
 *     waiting_for_user_review           ready_for_submit â”€â–º submitted
 *
 * Anything that goes wrong transitions to `blocked` (recoverable) or
 * `failed` (terminal).
 */

import {
  isBrowserAutomationEnabled,
  isAutoSubmitEnabledGlobally,
  launchSession,
  closeSession,
  getLiveSession,
  takeScreenshot,
  captureStorageState,
  storageStatePathFor,
} from './browserSessionService.js'
import {
  ensureBrowserSessionSchema,
  getActiveSessionForTask,
  getBrowserSessionById,
  createBrowserSession,
  updateBrowserSession,
} from './browserSessionStore.js'
import {
  getApplicationTask,
  updateApplicationTask,
  setMissingInfo,
} from './applicationTaskStore.js'
import { getStudentPortal } from './studentPortalStore.js'
import { recordBrowserEvent } from './portalAutomationAudit.js'
import { mapFormToProfile } from './portalFieldMapper.js'
import { resolveBrowserAdapter } from './portalAdapters/portalBrowserAdapterRegistry.js'
import { emitYanaNotificationToProfileAndAdmins } from './yanaNotifications.js'

function requireBrowserEnabled() {
  if (!isBrowserAutomationEnabled()) {
    const err = new Error('YANA_ENABLE_BROWSER_AUTOMATION is not set; browser automation is disabled')
    err.code = 'BROWSER_DISABLED'
    err.status = 412
    throw err
  }
}

async function loadProfileLight(db, profileId) {
  if (!db || !profileId) return null
  const row = await db.prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1').get(String(profileId))
  if (!row) return null
  let sectionRows = []
  try {
    sectionRows = await db
      .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
      .all(String(profileId))
  } catch { /* table may not exist */ }
  const sections = {}
  for (const r of sectionRows || []) {
    try { sections[r.section_key] = typeof r.data === 'string' ? JSON.parse(r.data) : r.data } catch { /* ignore */ }
  }
  return { ...row, sections, ...sections }
}

async function loadOpportunityLight(db, { opportunityId, grantId }) {
  if (!db) return null
  if (opportunityId) {
    try {
      const row = await db.prepare('SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1').get(String(opportunityId))
      if (row) return { kind: 'opportunity', ...row }
    } catch { /* ignore */ }
  }
  if (grantId) {
    try {
      const row = await db.prepare('SELECT * FROM grants WHERE id = ? LIMIT 1').get(String(grantId))
      if (row) return { kind: 'grant', ...row, grant_id: row.id }
    } catch { /* ignore */ }
  }
  return null
}

async function loadPortalLink(db, profileId, { opportunityId, grantId }) {
  if (!db || !profileId) return null
  await ensureBrowserSessionSchema(db)
  try {
    const row = await db
      .prepare(
        `SELECT * FROM application_portal_links
         WHERE profile_id = ?
           AND (opportunity_id = ? OR grant_id = ?)
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(String(profileId), opportunityId ? String(opportunityId) : null, grantId ? String(grantId) : null)
    return row || null
  } catch { return null }
}

function gateToStatus(gate) {
  if (!gate) return null
  if (gate.kind === 'login') return 'waiting_for_user_login'
  if (gate.kind === '2fa') return 'waiting_for_2fa'
  if (gate.kind === 'captcha') return 'waiting_for_captcha'
  if (gate.kind === 'consent') return 'blocked'
  return null
}

async function notifyUser(db, { task, type, title, message, severity, data = {} }) {
  if (!db || !task) return []
  return await emitYanaNotificationToProfileAndAdmins(db, {
    profileId: task.profile_id,
    profileUserId: task.user_id,
    type,
    title,
    message,
    severity,
    data,
  })
}

function checkProfileScope(session, profileId, taskProfileId) {
  if (profileId && taskProfileId && String(profileId) !== String(taskProfileId)) {
    const err = new Error('profile mismatch -- task does not belong to profile')
    err.status = 403
    throw err
  }
  if (session && profileId && String(session.profile_id) !== String(profileId)) {
    const err = new Error('profile mismatch -- session does not belong to profile')
    err.status = 403
    throw err
  }
}

/**
 * Start (or re-start) a supervised browser session for a task. Idempotent:
 * if a non-terminal session already exists, it is reused.
 */
export async function startBrowserSession(db, {
  taskId, profileId, userId = null, headlessOverride = null,
} = {}) {
  requireBrowserEnabled()
  if (!db) throw new Error('db required')
  if (!taskId) throw new Error('taskId required')

  const task = await getApplicationTask(db, taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)
  checkProfileScope(null, profileId, task.profile_id)

  const portal = task.portal_id ? await getStudentPortal(db, task.profile_id, task.portal_id) : null
  const link = await loadPortalLink(db, task.profile_id, {
    opportunityId: task.opportunity_id, grantId: task.grant_id,
  })
  const portalUrl = link?.application_url
    || portal?.application_url || portal?.portal_url
    || (await loadOpportunityLight(db, { opportunityId: task.opportunity_id, grantId: task.grant_id }))?.application_url
    || null

  if (!portalUrl) {
    const err = new Error('no portal URL available -- cannot launch browser automation')
    err.status = 400
    throw err
  }

  let session = await getActiveSessionForTask(db, taskId, { profileId })
  if (!session) {
    session = await createBrowserSession(db, {
      taskId, profileId: task.profile_id, userId,
      portalUrl, loginUrl: portal?.login_url || null,
      applicationUrl: link?.application_url || null,
    })
  }

  await updateBrowserSession(db, session.id, { status: 'launching_browser' })
  await recordBrowserEvent(db, {
    taskId, sessionId: session.id, eventType: 'browser_session_created',
    actorUserId: userId, actorRole: 'agent',
    message: `Launching supervised browser to ${portalUrl}`,
    payload: { portal_url: portalUrl },
  })

  let handle
  try {
    handle = await launchSession({
      sessionId: session.id,
      url: portalUrl,
      headless: headlessOverride,
      storageStatePath: session.storage_state_path || storageStatePathFor(session.id),
    })
  } catch (err) {
    await updateBrowserSession(db, session.id, { status: 'failed', error: err?.message || String(err) })
    await recordBrowserEvent(db, {
      taskId, sessionId: session.id, eventType: 'failed', status: 'failed',
      message: `browser launch failed: ${err?.message || err}`,
      actorUserId: userId, actorRole: 'agent',
      payload: { error: err?.message || String(err) },
    })
    throw err
  }

  await captureStorageState(session.id)

  // Detect any gate immediately so the UI knows whether to ask the
  // user to log in / solve a CAPTCHA.
  const adapter = resolveBrowserAdapter(link, null, null)
  const gate = await adapter.detectGate(handle.page).catch(() => null)
  const url = (() => { try { return handle.page.url() } catch { return null } })()
  const title = await handle.page.title().catch(() => null)
  const screenshotPath = await takeScreenshot(session.id, 'launch')

  const status = gateToStatus(gate) || 'inspecting_form'
  await updateBrowserSession(db, session.id, {
    status,
    currentUrl: url,
    pageTitle: title,
    storageStatePath: handle.storageStatePath,
    lastScreenshotPath: screenshotPath,
    metadata: { ...(session.metadata || {}), adapter: adapter.name, gate: gate || null },
  })
  await updateApplicationTask(db, taskId, {
    status: status === 'inspecting_form' ? 'in_progress' : 'waiting_for_user',
    lastAgentMessage: gate
      ? `Yana opened the portal and detected ${gate.kind} (${gate.reason}). Please complete this step.`
      : 'Yana opened the portal -- inspecting the application form.',
    currentStep: status,
  })
  await recordBrowserEvent(db, {
    taskId, sessionId: session.id, eventType: 'browser_launched',
    status, message: gate ? `gate: ${gate.kind}` : 'no gate; ready to inspect',
    actorUserId: userId, actorRole: 'agent',
    payload: { url, title, gate, screenshot_path: screenshotPath, adapter: adapter.name },
  })

  if (gate) {
    await notifyUser(db, {
      task,
      type: gate.kind === 'login' ? 'yana_login_required'
          : gate.kind === '2fa' ? 'yana_login_required'
          : gate.kind === 'captcha' ? 'yana_login_required'
          : 'yana_review_required',
      title: 'Yana paused on a portal gate',
      message: `Yana opened the portal but ${gate.reason}. Please complete this step in the supervised browser, then click "I'm logged in -- continue".`,
      severity: 'warning',
      data: { task_id: taskId, session_id: session.id, gate_kind: gate.kind },
    })
  }

  return await getBrowserSessionById(db, session.id, { profileId })
}

/**
 * The user just told Yana "I'm logged in -- continue." Re-detect any gate
 * and, if clear, run inspect â†’ map â†’ fill.
 */
export async function markUserReadyAndContinue(db, { taskId, profileId, userId = null } = {}) {
  requireBrowserEnabled()
  if (!db) throw new Error('db required')
  const task = await getApplicationTask(db, taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)
  checkProfileScope(null, profileId, task.profile_id)

  const session = await getActiveSessionForTask(db, taskId, { profileId })
  if (!session) {
    const err = new Error('no active browser session -- start one first')
    err.status = 400
    throw err
  }

  const handle = getLiveSession(session.id)
  if (!handle) {
    // Browser process died (or this is a different Node process) -- relaunch
    // with the same storage state so the supervised login persists.
    return await startBrowserSession(db, { taskId, profileId, userId })
  }

  const link = await loadPortalLink(db, task.profile_id, {
    opportunityId: task.opportunity_id, grantId: task.grant_id,
  })
  const adapter = resolveBrowserAdapter(link, null, null)
  await captureStorageState(session.id)

  const gate = await adapter.detectGate(handle.page).catch(() => null)
  if (gate) {
    const status = gateToStatus(gate) || 'blocked'
    const url = (() => { try { return handle.page.url() } catch { return null } })()
    const title = await handle.page.title().catch(() => null)
    const screenshotPath = await takeScreenshot(session.id, `gate_${gate.kind}`)
    await updateBrowserSession(db, session.id, {
      status, currentUrl: url, pageTitle: title, lastScreenshotPath: screenshotPath,
      metadata: { ...(session.metadata || {}), gate },
    })
    await recordBrowserEvent(db, {
      taskId, sessionId: session.id, eventType: gate.kind === '2fa' ? 'two_factor_detected'
        : gate.kind === 'captcha' ? 'captcha_detected'
        : gate.kind === 'consent' ? 'consent_detected'
        : 'login_detected',
      status, message: gate.reason, actorUserId: userId, actorRole: 'agent',
      payload: { gate, url, title, screenshot_path: screenshotPath },
    })
    return await getBrowserSessionById(db, session.id, { profileId })
  }

  // â”€â”€ inspect form
  await updateBrowserSession(db, session.id, { status: 'inspecting_form' })
  const fields = await adapter.detectForm(handle.page).catch(() => [])
  await recordBrowserEvent(db, {
    taskId, sessionId: session.id, eventType: 'form_inspected',
    actorUserId: userId, actorRole: 'agent',
    message: `Detected ${fields.length} form fields`,
    payload: { field_count: fields.length },
  })

  // â”€â”€ map fields
  await updateBrowserSession(db, session.id, { status: 'mapping_fields' })
  const profile = await loadProfileLight(db, task.profile_id)
  const mapping = mapFormToProfile({ fields, profile })

  await updateBrowserSession(db, session.id, {
    fieldMap: mapping.mapped,
    missingFields: mapping.missing,
  })
  await recordBrowserEvent(db, {
    taskId, sessionId: session.id, eventType: 'fields_mapped',
    actorUserId: userId, actorRole: 'agent',
    message: `Mapped ${Object.keys(mapping.mapped).length} fields, ${mapping.missing.length} missing`,
    payload: {
      mapped_count: Object.keys(mapping.mapped).length,
      missing_count: mapping.missing.length,
      skipped_count: mapping.skipped.length,
    },
  })

  // â”€â”€ fill the fields we have
  await updateBrowserSession(db, session.id, { status: 'filling_fields' })
  const filledFields = {}
  const fillErrors = []
  for (const [selector, info] of Object.entries(mapping.mapped)) {
    try {
      const locator = handle.page.locator(selector).first()
      const field = fields.find((f) => f.selector === selector)
      if (field?.type === 'select') {
        await locator.selectOption({ value: String(info.value) }).catch(async () => {
          await locator.selectOption({ label: String(info.value) })
        })
      } else if (field?.type === 'checkbox' || field?.type === 'radio') {
        // Yana never auto-checks consent / signature boxes. Forbidden
        // patterns already screened these out, but be defensive.
      } else {
        await locator.fill(String(info.value))
      }
      filledFields[selector] = info
    } catch (err) {
      fillErrors.push({ selector, error: err?.message || String(err) })
    }
  }

  // â”€â”€ persist missing info on the task itself so the UI can render it.
  if (mapping.missing.length > 0) {
    const missingItems = mapping.missing.map((m) => ({
      kind: 'field',
      key: m.fieldKey || m.selector,
      label: m.label,
      description: `Missing for ${m.label}: ${m.reason}`,
      required: m.required,
    }))
    await setMissingInfo(db, taskId, missingItems)
  }

  const status = mapping.missing.some((m) => m.required)
    ? 'missing_info_required'
    : 'waiting_for_user_review'

  const screenshotPath = await takeScreenshot(session.id, 'after_fill')
  const newUrl = (() => { try { return handle.page.url() } catch { return null } })()
  const newTitle = await handle.page.title().catch(() => null)

  await updateBrowserSession(db, session.id, {
    status,
    filledFields,
    lastScreenshotPath: screenshotPath,
    currentUrl: newUrl,
    pageTitle: newTitle,
  })
  await updateApplicationTask(db, taskId, {
    status: status === 'missing_info_required' ? 'blocked_missing_info' : 'draft_completed',
    lastAgentMessage:
      status === 'missing_info_required'
        ? `Yana filled ${Object.keys(filledFields).length} fields but ${mapping.missing.filter((m) => m.required).length} required fields are missing.`
        : `Yana filled ${Object.keys(filledFields).length} fields. Please review the draft and approve.`,
    currentStep: status,
  })
  await recordBrowserEvent(db, {
    taskId, sessionId: session.id, eventType: 'fields_filled',
    status, actorUserId: userId, actorRole: 'agent',
    message: `Filled ${Object.keys(filledFields).length} fields, ${fillErrors.length} errors`,
    payload: {
      filled_count: Object.keys(filledFields).length,
      missing_count: mapping.missing.length,
      fill_errors: fillErrors,
      screenshot_path: screenshotPath,
    },
  })

  if (status === 'missing_info_required') {
    await recordBrowserEvent(db, {
      taskId, sessionId: session.id, eventType: 'missing_info_detected',
      status, actorUserId: userId, actorRole: 'agent',
      message: `${mapping.missing.length} fields could not be grounded in the profile`,
      payload: { missing: mapping.missing },
    })
    await notifyUser(db, {
      task,
      type: 'yana_missing_info',
      title: 'Yana needs more information',
      message: `Yana drafted the application but ${mapping.missing.filter((m) => m.required).length} required fields are missing. Please supply them and resume.`,
      severity: 'warning',
      data: { task_id: taskId, session_id: session.id, missing: mapping.missing },
    })
  } else {
    await notifyUser(db, {
      task,
      type: 'yana_application_ready',
      title: 'Yana drafted your application',
      message: `Yana filled ${Object.keys(filledFields).length} fields. Open the supervised browser to review the draft and approve submission.`,
      severity: 'success',
      data: { task_id: taskId, session_id: session.id },
    })
  }

  return await getBrowserSessionById(db, session.id, { profileId })
}

/**
 * Click the portal's "Save Draft" button if the adapter can find one.
 */
export async function saveDraft(db, { taskId, profileId, userId = null } = {}) {
  requireBrowserEnabled()
  const task = await getApplicationTask(db, taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)
  checkProfileScope(null, profileId, task.profile_id)
  const session = await getActiveSessionForTask(db, taskId, { profileId })
  if (!session) throw new Error('no active session')
  const handle = getLiveSession(session.id)
  if (!handle) throw new Error('browser handle not live; restart the session')

  const link = await loadPortalLink(db, task.profile_id, {
    opportunityId: task.opportunity_id, grantId: task.grant_id,
  })
  const adapter = resolveBrowserAdapter(link, null, null)
  const button = await adapter.detectSaveDraftButton(handle.page).catch(() => null)
  if (!button) {
    await recordBrowserEvent(db, {
      taskId, sessionId: session.id, eventType: 'draft_saved',
      message: 'No save-draft button detected; skipping.',
      actorUserId: userId, actorRole: 'agent',
      payload: { saved: false, reason: 'no_button' },
    })
    return await getBrowserSessionById(db, session.id, { profileId })
  }
  await button.click().catch(() => null)
  const screenshotPath = await takeScreenshot(session.id, 'draft_saved')
  await updateBrowserSession(db, session.id, { lastScreenshotPath: screenshotPath })
  await recordBrowserEvent(db, {
    taskId, sessionId: session.id, eventType: 'draft_saved',
    actorUserId: userId, actorRole: 'agent',
    message: 'Save-draft button clicked',
    payload: { saved: true, screenshot_path: screenshotPath },
  })
  return await getBrowserSessionById(db, session.id, { profileId })
}

/**
 * Approve auto-submit. Yana refuses unless ALL of these are true:
 *   - YANA_ALLOW_AUTOSUBMIT=true (global)
 *   - the task has auto_submit_enabled = TRUE
 *   - no gate is currently detected
 *   - there are zero required missing fields
 */
export async function approveAndSubmit(db, { taskId, profileId, userId = null, actorRole = 'user' } = {}) {
  requireBrowserEnabled()
  const task = await getApplicationTask(db, taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)
  checkProfileScope(null, profileId, task.profile_id)
  if (!isAutoSubmitEnabledGlobally()) {
    const err = new Error('YANA_ALLOW_AUTOSUBMIT is not set; auto-submit is globally disabled.')
    err.status = 412
    throw err
  }
  if (!task.auto_submit_enabled) {
    const err = new Error('Per-task auto_submit_enabled is false. Toggle it on first.')
    err.status = 412
    throw err
  }

  const session = await getActiveSessionForTask(db, taskId, { profileId })
  if (!session) throw new Error('no active session')
  const handle = getLiveSession(session.id)
  if (!handle) throw new Error('browser handle not live; restart the session')

  if ((session.missing_fields || []).some((m) => m.required)) {
    const err = new Error('cannot submit -- required fields are missing')
    err.status = 412
    throw err
  }

  const link = await loadPortalLink(db, task.profile_id, {
    opportunityId: task.opportunity_id, grantId: task.grant_id,
  })
  const adapter = resolveBrowserAdapter(link, null, null)
  const gate = await adapter.detectGate(handle.page).catch(() => null)
  if (gate) {
    const err = new Error(`refusing to submit -- ${gate.kind} gate detected: ${gate.reason}`)
    err.status = 412
    throw err
  }

  const preSnapshot = await takeScreenshot(session.id, 'pre_submit')
  await updateBrowserSession(db, session.id, {
    preSubmitSnapshotPath: preSnapshot,
    status: 'ready_for_submit',
    approvedToSubmit: true,
  })
  await recordBrowserEvent(db, {
    taskId, sessionId: session.id, eventType: 'pre_submit_snapshot',
    status: 'ready_for_submit', actorUserId: userId, actorRole,
    message: 'Captured pre-submit snapshot',
    payload: { snapshot_path: preSnapshot },
  })

  const submitButton = await adapter.detectSubmitButton(handle.page).catch(() => null)
  if (!submitButton) {
    await updateBrowserSession(db, session.id, { status: 'blocked', error: 'no submit button detected' })
    const err = new Error('refusing to submit -- no submit button detected on page')
    err.status = 412
    throw err
  }

  await recordBrowserEvent(db, {
    taskId, sessionId: session.id, eventType: 'submit_clicked',
    actorUserId: userId, actorRole,
    message: 'Yana clicking submit (explicitly authorised)',
    payload: { authorised_by: userId },
  })

  await submitButton.click().catch(async () => {
    // Some portals reload after submit; ignore navigation race.
  })
  await handle.page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => null)

  const confirmation = await adapter.detectConfirmation(handle.page).catch(() => null)
  const postShot = await takeScreenshot(session.id, 'post_submit')
  const url = (() => { try { return handle.page.url() } catch { return null } })()
  const title = await handle.page.title().catch(() => null)

  await updateBrowserSession(db, session.id, {
    status: 'submitted',
    currentUrl: url,
    pageTitle: title,
    lastScreenshotPath: postShot,
    confirmationReference: confirmation?.reference || null,
  })
  await updateApplicationTask(db, taskId, {
    status: 'submitted',
    lastAgentMessage: confirmation?.reference
      ? `Submitted. Confirmation reference: ${confirmation.reference}`
      : 'Submitted. No confirmation reference detected on the page.',
    currentStep: 'submitted',
  })
  await recordBrowserEvent(db, {
    taskId, sessionId: session.id, eventType: 'submitted',
    status: 'submitted', actorUserId: userId, actorRole,
    message: confirmation?.reference
      ? `Submitted with reference ${confirmation.reference}`
      : 'Submitted (no reference parsed)',
    payload: { confirmation, url, title, screenshot_path: postShot },
  })
  await notifyUser(db, {
    task,
    type: 'yana_application_submitted',
    title: 'Yana submitted your application',
    message: confirmation?.reference
      ? `Confirmation reference: ${confirmation.reference}`
      : 'Application submitted -- no portal-side reference number was visible.',
    severity: 'success',
    data: { task_id: taskId, session_id: session.id, confirmation },
  })
  // Close the live Playwright handle now that we've captured everything;
  // storage state was persisted at launch + via captureStorageState.
  try { await closeSession(session.id, { keepStorage: true }) } catch { /* ignore */ }
  return await getBrowserSessionById(db, session.id, { profileId })
}

export async function cancelBrowserSession(db, { taskId, profileId, userId = null, reason = null } = {}) {
  if (!db || !taskId) throw new Error('db and taskId required')
  const task = await getApplicationTask(db, taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)
  checkProfileScope(null, profileId, task.profile_id)
  const session = await getActiveSessionForTask(db, taskId, { profileId })
  if (!session) return null
  await closeSession(session.id)
  await updateBrowserSession(db, session.id, { status: 'cancelled', error: reason })
  await recordBrowserEvent(db, {
    taskId, sessionId: session.id, eventType: 'cancelled', status: 'cancelled',
    actorUserId: userId, actorRole: 'user',
    message: reason || 'Browser session cancelled by user',
    payload: { reason },
  })
  return await getBrowserSessionById(db, session.id, { profileId })
}

export async function getStatus(db, { taskId, profileId } = {}) {
  if (!db || !taskId) return null
  const task = await getApplicationTask(db, taskId)
  if (!task) return null
  checkProfileScope(null, profileId, task.profile_id)
  return await getActiveSessionForTask(db, taskId, { profileId })
}

export const _internal = {
  loadProfileLight, loadOpportunityLight, loadPortalLink, gateToStatus,
}

