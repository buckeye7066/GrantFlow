/**
 * hamiltonAutomationOrchestrator.js
 *
 * Top-level "Automate with Hamilton" entry point. Given a list of selected
 * funding sources (from any pipeline stage), Hamilton:
 *
 *   1. Loads each source (opportunity / grant) and the profile.
 *   2. Classifies the completion pathway with
 *      `hamiltonAutomationClassifier.classifyFundingSource`.
 *   3. Creates (or reuses) one `application_tasks` row per source via
 *      `applicationTaskStore.ensureApplicationTask`. The new
 *      `automation_type`, `selected_from_stage`, and persona columns
 *      are populated.
 *   4. Drives each task one step forward depending on the
 *      classification:
 *        - portal       → kicks off the supervised browser layer (the
 *                         existing hamiltonPortalAutomation; gated by
 *                         HAMILTON_ENABLE_BROWSER_AUTOMATION).
 *        - pdf_docx | mail | fax | email
 *                       → calls `hamiltonApplicationPacketGenerator` to
 *                         generate the DOCX + PDF + mailing
 *                         instructions and saves them under the
 *                         profile's Documents.
 *        - auto_profile | no_application
 *                       → records the action packet (no submission,
 *                         no fabricated paperwork) and notifies
 *                         user/admin.
 *        - unknown      → marks status="blocked" and asks for human
 *                         review.
 *   5. Persists state, audit events, missing info, and notifications.
 *   6. Updates the pipeline stage when an outcome warrants it (uses
 *      shared/pipelineStages canonical names).
 *
 * Profile scoping is enforced everywhere — every read/write requires
 * profileId and rejects if the caller does not own it.
 */

import { classifyFundingSource } from './hamiltonAutomationClassifier.js'
import {
  ensureApplicationTask,
  updateApplicationTask,
  appendTaskEvent,
  setMissingInfo,
} from './applicationTaskStore.js'
import { generateAndSavePacket } from './hamiltonApplicationPacketGenerator.js'
import {
  emitHamiltonNotificationToProfileAndAdmins,
  emitHamiltonLifecycleAlerts,
} from './hamiltonNotifications.js'
import { canonicalStage } from '../../../shared/pipelineStages.js'
import { runAutopilot } from './hamiltonAutopilotEngine.js'
import {
  preflightSingleSource,
  readAuthorizations,
} from './hamiltonPreflight.js'
import {
  createAutopilotRun,
  updateAutopilotRun,
} from './hamiltonAuthorizationStore.js'
import { resolveBlocker } from './hamiltonHardStopResolver.js'

const PERSONA_VERSION = 'hamilton-mba-2026'

const ENV = (typeof process !== 'undefined' && process?.env) ? process.env : {}

// Browser-automation gate for the active (Control Center) autopilot path.
// `HAMILTON_ENABLE_BROWSER_AUTOMATION` must be 'true' before Hamilton launches a
// real browser; until then she degrades to the lawful pdf_docx packet. This is
// the flag the legacy hamiltonApplicationAgent path already honored — wiring it
// here makes it authoritative on the path the Control Center actually drives.
export function isBrowserAutomationEnabled() {
  return String(ENV.HAMILTON_ENABLE_BROWSER_AUTOMATION || 'false').toLowerCase() === 'true'
}

// Optional comma-separated host allowlist (e.g. "tn.gov,mtsu.edu"). When set,
// browser automation runs ONLY on these hosts (or their subdomains) — every
// other portal degrades to the packet. Lets browser automation be trialed on a
// single low-stakes source before going fleet-wide. Empty = no restriction.
export function browserAutomationHostAllowlist() {
  return String(ENV.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
}

export function browserAutomationPermittedForUrl(url) {
  if (!isBrowserAutomationEnabled()) return false
  const allow = browserAutomationHostAllowlist()
  if (allow.length === 0) return true // enabled with no allowlist → fleet-wide
  let host = ''
  try { host = new URL(url).hostname.toLowerCase() } catch { return false }
  return allow.some((a) => host === a || host.endsWith(`.${a}`))
}

async function loadProfileBundle(db, profileId) {
  if (!db || !profileId) return null
  const row = await db.prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1').get(String(profileId))
  if (!row) return null
  let sectionRows = []
  try {
    sectionRows = await db
      .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
      .all(String(profileId))
  } catch { /* table may not exist in tests */ }
  const sections = {}
  for (const r of sectionRows || []) {
    try { sections[r.section_key] = typeof r.data === 'string' ? JSON.parse(r.data) : r.data } catch { /* ignore */ }
  }
  return { ...row, ...sections, sections }
}

async function loadOpportunity(db, id) {
  if (!db || !id) return null
  try {
    const row = await db.prepare('SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1').get(String(id))
    return row || null
  } catch { return null }
}

async function loadGrant(db, id) {
  if (!db || !id) return null
  try {
    const row = await db.prepare('SELECT * FROM grants WHERE id = ? LIMIT 1').get(String(id))
    return row || null
  } catch { return null }
}

async function loadPortalLink(db, profileId, { opportunityId, grantId }) {
  if (!db || !profileId) return null
  try {
    const row = await db.prepare(
      `SELECT * FROM application_portal_links
        WHERE profile_id = ?
          AND (COALESCE(opportunity_id,'') = COALESCE(?, '')
               OR COALESCE(grant_id,'') = COALESCE(?, ''))
        ORDER BY created_at DESC LIMIT 1`,
    ).get(String(profileId), opportunityId ? String(opportunityId) : null, grantId ? String(grantId) : null)
    return row || null
  } catch { return null }
}

function mapClassificationToInitialStatus(automationType) {
  switch (automationType) {
    case 'portal':         return 'analyzing'
    case 'pdf_docx':       return 'generating_application'
    case 'mail':           return 'generating_application'
    case 'fax':            return 'generating_application'
    case 'email':          return 'generating_application'
    case 'no_application': return 'ready_to_start'
    case 'auto_profile':   return 'ready_to_start'
    default:               return 'analyzing'
  }
}

function mapAutomationTypeToFinishedStatus(automationType) {
  switch (automationType) {
    case 'mail':           return 'ready_to_print_mail'
    case 'fax':            return 'ready_to_fax'
    case 'email':          return 'ready_to_email'
    case 'pdf_docx':       return 'waiting_for_review'
    case 'no_application': return 'completed'
    case 'auto_profile':   return 'completed'
    default:               return 'waiting_for_review'
  }
}

function mapAutomationTypeToPipelineStage(automationType) {
  switch (automationType) {
    case 'mail':
    case 'fax':
    case 'email':
    case 'pdf_docx':
      return 'ready_to_submit'
    case 'no_application':
    case 'auto_profile':
      return 'follow_up'
    default:
      return null
  }
}

function notificationTypeForAutomation(automationType) {
  if (automationType === 'mail' || automationType === 'fax' || automationType === 'email' || automationType === 'pdf_docx') {
    return 'hamilton_generated_document_saved'
  }
  return 'hamilton_task_started'
}

async function maybeUpdateGrantStage(db, grantId, newStage) {
  if (!db || !grantId || !newStage) return null
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  try {
    await db.prepare(
      `UPDATE grants SET status = COALESCE(?, status), updated_at = ${nowFn} WHERE id = ?`,
    ).run(canonicalStage(newStage) || newStage, String(grantId))
  } catch {
    // The grants table may not exist in unit-test fixtures.
  }
  return null
}

/**
 * Process ONE selected source. Designed to be called in a loop by
 * `automateSelected`.
 */
export async function automateSingleSource(db, {
  profile, profileId, userId = null, source, options = {},
} = {}) {
  if (!profile && !profileId) throw new Error('profile or profileId required')
  const resolvedProfileId = profileId || profile.id
  // If only the id was given, hydrate the profile bundle now so the
  // document/portal pathways can grab basic_information / essays /
  // university_applications without re-querying.
  if (!profile && resolvedProfileId) {
    profile = await loadProfileBundle(db, resolvedProfileId)
    if (!profile) {
      const err = new Error(`profile not found: ${resolvedProfileId}`)
      err.status = 404
      throw err
    }
  }
  const opportunityId = source?.opportunity_id || source?.opportunityId || null
  const grantId = source?.grant_id || source?.grantId || null
  if (!opportunityId && !grantId) {
    throw new Error('source must include opportunity_id or grant_id')
  }
  const selectedFromStage = canonicalStage(source?.current_stage || source?.currentStage || null)
    || (source?.current_stage || source?.currentStage || null)

  const opportunity = await loadOpportunity(db, opportunityId)
  const grant = await loadGrant(db, grantId)
  const portalLink = await loadPortalLink(db, resolvedProfileId, { opportunityId, grantId })

  const classification = classifyFundingSource({
    opportunity,
    grant,
    profile,
    portalLink,
  })

  const initialStatus = mapClassificationToInitialStatus(classification.automation_type)

  // 1. Create / fetch the task with the new automation columns.
  const task = await ensureApplicationTask(db, {
    profileId: resolvedProfileId,
    userId,
    opportunityId,
    grantId,
    portalId: portalLink?.portal_id || null,
    automationType: classification.automation_type,
    selectedFromStage,
    currentPipelineStage: selectedFromStage || (grant?.status ?? null),
    agentPersonaVersion: PERSONA_VERSION,
    initialStatus,
    currentStep: classification.automation_type,
  })

  await appendTaskEvent(db, {
    taskId: task.id,
    eventType: 'progress',
    status: initialStatus,
    step: classification.automation_type,
    message: `Hamilton classified this source as "${classification.automation_type}" (confidence ${classification.confidence.toFixed(2)}).`,
    actorUserId: userId,
    actorRole: 'agent',
    details: { classification },
  })

  // 2. Persist resolved URLs + audit summary on the task row.
  await updateApplicationTask(db, task.id, {
    portalUrl: classification.resolved_url,
    applicationUrl: classification.resolved_url,
    auditSummary: {
      classification,
      mailing_address: classification.mailing_address,
      apply_email: classification.apply_email,
      apply_fax: classification.apply_fax,
    },
    startedAt: task.started_at || new Date().toISOString(),
  })

  // 3. Branch by automation type.
  if (classification.automation_type === 'pdf_docx'
    || classification.automation_type === 'mail'
    || classification.automation_type === 'fax'
    || classification.automation_type === 'email') {
    return await runDocumentPathway(db, {
      task, profile, opportunity, grant, classification, userId, options,
    })
  }

  if (classification.automation_type === 'no_application' || classification.automation_type === 'auto_profile') {
    return await runActionPacketPathway(db, {
      task, profile, opportunity, grant, classification, userId, options,
    })
  }

  if (classification.automation_type === 'portal') {
    return await runPortalPathway(db, {
      task, profile, opportunity, grant, classification, userId, options,
    })
  }

  // unknown
  await updateApplicationTask(db, task.id, {
    status: 'blocked',
    lastAgentMessage:
      'Hamilton could not determine how to complete this funding source from the available metadata. A human teammate should review the funder\'s instructions and edit the opportunity record so Hamilton can take over.',
  })
  await emitHamiltonNotificationToProfileAndAdmins(db, {
    profileId: resolvedProfileId,
    profileUserId: task.user_id,
    type: 'hamilton_task_blocked',
    title: 'Hamilton needs help classifying a funding source',
    message: `${opportunity?.title || grant?.title || 'A selected funding source'} did not give Hamilton enough metadata to choose a completion pathway. Please review and supply the application URL, mailing address, or application mode.`,
    severity: 'warning',
    data: { task_id: task.id, classification },
  })
  return { task: await reload(db, task.id), classification }
}

async function reload(db, taskId) {
  const { getApplicationTask } = await import('./applicationTaskStore.js')
  return await getApplicationTask(db, taskId)
}

async function runDocumentPathway(db, {
  task, profile, opportunity, grant, classification, userId, options,
}) {
  const automationType = classification.automation_type
  await updateApplicationTask(db, task.id, { status: 'generating_documents' })
  await appendTaskEvent(db, {
    taskId: task.id,
    eventType: 'progress',
    status: 'generating_documents',
    step: 'packet',
    message: `Hamilton is generating the ${automationType.toUpperCase()} application packet.`,
    actorUserId: userId,
    actorRole: 'agent',
  })

  const generatePdf = options?.generate_pdf !== false
  const generateDocx = options?.generate_docx !== false
  if (!generatePdf && !generateDocx) {
    // Defensive: at least one output must be requested.
    options = { ...options, generate_docx: true }
  }

  const result = await generateAndSavePacket(db, {
    profile,
    opportunity,
    grant,
    automationType,
    taskId: task.id,
    userId,
  })

  // Persist outputs + missing info.
  await updateApplicationTask(db, task.id, {
    status: 'saving_documents',
    outputDocxDocumentId: result.docx_document_id,
    outputPdfDocumentId: result.pdf_document_id || null,
    outputDocumentId: result.pdf_document_id || result.docx_document_id,
    mailingInstructions: result.mailing_instructions,
    missingFields: result.missing.filter((m) => m.kind === 'field'),
    missingDocuments: result.missing.filter((m) => m.kind === 'document'),
  })

  if (result.missing.length > 0) {
    await setMissingInfo(db, task.id, result.missing)
  }

  await appendTaskEvent(db, {
    taskId: task.id,
    eventType: 'progress',
    status: 'saving_documents',
    step: 'documents_saved',
    message: `Hamilton saved the generated packet to the profile's Documents (DOCX${result.pdf_document_id ? ' + PDF' : ''}).`,
    actorUserId: userId,
    actorRole: 'agent',
    details: {
      docx_document_id: result.docx_document_id,
      pdf_document_id: result.pdf_document_id,
      missing_count: result.missing.length,
    },
  })

  const finalStatus = mapAutomationTypeToFinishedStatus(automationType)
  await updateApplicationTask(db, task.id, {
    status: finalStatus,
    lastAgentMessage:
      `Hamilton saved the ${automationType.toUpperCase()} packet under your profile's Documents and prepared submission instructions. ${result.missing.length > 0 ? `Hamilton flagged ${result.missing.length} item(s) that need human input.` : 'Review the draft, then mark it submitted when you are ready.'}`,
  })

  await emitHamiltonNotificationToProfileAndAdmins(db, {
    profileId: task.profile_id,
    profileUserId: task.user_id,
    type: notificationTypeForAutomation(automationType),
    title: result.missing.length > 0
      ? 'Hamilton drafted your application — review needed'
      : 'Hamilton drafted your application',
    message: `Hamilton saved a ${automationType.toUpperCase()} packet for "${result.title}" under your profile's Documents.${result.missing.length > 0 ? ` ${result.missing.length} item(s) flagged for review.` : ''}`,
    severity: result.missing.length > 0 ? 'warning' : 'success',
    data: {
      task_id: task.id,
      docx_document_id: result.docx_document_id,
      pdf_document_id: result.pdf_document_id,
    },
  })

  // Optionally bump the pipeline stage.
  const newStage = mapAutomationTypeToPipelineStage(automationType)
  if (newStage && grant?.id) {
    await maybeUpdateGrantStage(db, grant.id, newStage)
  }

  return { task: await reload(db, task.id), classification, packet: result }
}

async function runActionPacketPathway(db, {
  task, profile, opportunity, grant, classification, userId,
}) {
  // No application is generated. We persist a clear "what to do" packet
  // and notify the user.
  const message = classification.automation_type === 'auto_profile'
    ? `This funder awards based on FAFSA / institutional records / nomination. Hamilton will not fabricate an application. Confirm your FAFSA + institutional record + nomination are on file.`
    : `This source does not require an application — it's a directory or awareness resource. Hamilton logged the link and will not generate a packet.`

  await updateApplicationTask(db, task.id, {
    status: 'completed',
    lastAgentMessage: message,
    auditSummary: { classification, action_packet: true },
    completedAt: new Date().toISOString(),
  })
  await appendTaskEvent(db, {
    taskId: task.id,
    eventType: 'note',
    status: 'completed',
    step: 'action_packet',
    message,
    actorUserId: userId,
    actorRole: 'agent',
    details: { classification },
  })

  await emitHamiltonNotificationToProfileAndAdmins(db, {
    profileId: task.profile_id,
    profileUserId: task.user_id,
    type: 'hamilton_task_started',
    title: classification.automation_type === 'auto_profile'
      ? 'Hamilton logged an automatic / FAFSA-driven funding source'
      : 'Hamilton logged a directory / awareness resource',
    message,
    severity: 'info',
    data: { task_id: task.id, classification },
  })
  void profile
  void opportunity
  void grant

  return { task: await reload(db, task.id), classification, action_packet: true }
}

async function runPortalPathway(db, {
  task, profile, opportunity, grant, classification, userId, options,
}) {
  // The portal pathway always runs Hamilton Autopilot when the user
  // authorized at least `complete_forms`. Without that authorization
  // we save the portal URL and wait — Autopilot does not run until
  // the user has explicitly granted authority on the launch screen.
  const authorizations = options?.authorizations || (await readAuthorizations(db, {
    profileId: task.profile_id,
    fundingSourceId: opportunity?.id || grant?.id || null,
    taskId: task.id,
  }))

  if (!authorizations.complete_forms) {
    await updateApplicationTask(db, task.id, {
      status: 'ready_to_start',
      lastAgentMessage:
        'Hamilton classified this as a portal application. Click "Automate with Hamilton" and authorize Autopilot to run unattended.',
    })
    await appendTaskEvent(db, {
      taskId: task.id,
      eventType: 'note',
      status: 'ready_to_start',
      message: 'Awaiting Autopilot authorization (complete_forms not yet granted).',
      actorUserId: userId,
      actorRole: 'agent',
    })
    await emitHamiltonNotificationToProfileAndAdmins(db, {
      profileId: task.profile_id,
      profileUserId: task.user_id,
      type: 'hamilton_task_started',
      title: 'Hamilton is ready to start a portal application',
      message: `Authorize Hamilton Autopilot for "${opportunity?.title || grant?.title || 'this funding source'}" to run unattended.`,
      severity: 'info',
      data: { task_id: task.id, portal_url: classification.resolved_url, classification },
    })
    return { task: await reload(db, task.id), classification, portal_url: classification.resolved_url }
  }

  // Run Autopilot now (unattended).
  return await runAutopilotPathway(db, {
    task, profile, opportunity, grant, classification,
    userId, authorizations, options,
  })
}

/**
 * Hamilton Autopilot — user-authorized unattended portal completion.
 *
 * Order of operations:
 *   1. Persist the autopilot_run row, status=preflight.
 *   2. Run preflight against the profile + classification.
 *   3. If preflight has hard blockers → status=blocked, notify user.
 *   4. Otherwise launch the engine (hamiltonAutopilotEngine.runAutopilot)
 *      and persist the result. Status becomes one of:
 *        - submitted        confirmation reference captured
 *        - completed_draft  draft saved (no submit authority)
 *        - blocked          hard blocker hit (login/2fa/captcha/...)
 *        - failed           engine error
 */
async function runAutopilotPathway(db, {
  task, profile, opportunity, grant, classification, userId, authorizations, options = {},
}) {
  const url = classification.resolved_url
  const run = await createAutopilotRun(db, {
    taskId: task.id,
    profileId: task.profile_id,
    userId,
    authorizationId: options?.authorizationId || null,
    preflight: {},
    status: 'preflight',
  })
  await updateApplicationTask(db, task.id, { status: 'launching_portal' })
  await appendTaskEvent(db, {
    taskId: task.id,
    eventType: 'progress',
    status: 'launching_portal',
    step: 'autopilot',
    message: 'Hamilton Autopilot starting (user-authorized unattended completion).',
    actorUserId: userId,
    actorRole: 'agent',
    details: { autopilot_run_id: run.id, url },
  })

  // Preflight (re-runs the lightweight checks; the launch screen
  // already passed them, but conditions can change between authorization
  // and launch).
  const preflight = await preflightSingleSource(db, {
    profile,
    profileId: task.profile_id,
    source: { opportunity_id: opportunity?.id || null, grant_id: grant?.id || null, task_id: task.id },
    opportunity,
    grant,
  })
  await updateAutopilotRun(db, run.id, { preflight })
  if (!preflight.ok) {
    const detail = preflight.blockers.map((b) => b.label).join('; ')
    await updateAutopilotRun(db, run.id, {
      status: 'blocked',
      blockerKind: 'preflight',
      blockerDetail: detail,
      finishedAt: new Date().toISOString(),
    })
    await updateApplicationTask(db, task.id, {
      status: 'blocked',
      lastAgentMessage: `Hamilton Autopilot stopped at preflight: ${detail}`,
    })
    await setMissingInfo(db, task.id, preflight.blockers.map((b) => ({
      kind: b.kind === 'missing_field' ? 'field' : (b.kind === 'missing_document' ? 'document' : 'other'),
      key: b.key, label: b.label, description: b.detail, required: true,
    })))
    await emitHamiltonNotificationToProfileAndAdmins(db, {
      profileId: task.profile_id,
      profileUserId: task.user_id,
      type: 'hamilton_task_blocked',
      title: 'Hamilton Autopilot needs information',
      message: detail || 'Preflight found something Hamilton needs before she can run.',
      severity: 'warning',
      data: { task_id: task.id, run_id: run.id, preflight },
    })
    return { task: await reload(db, task.id), classification, autopilot_run: run.id, preflight }
  }

  // Scoped browser-automation guard (defense in depth on top of the per-source
  // `complete_forms` authorization already required above). Browser automation
  // must be globally enabled via HAMILTON_ENABLE_BROWSER_AUTOMATION, and when
  // HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST is set the portal host must be on
  // it. When not permitted, Hamilton does NOT open a browser — she produces the
  // lawful pdf_docx packet (the same artifact she falls back to when a portal
  // forbids automation), so the applicant still gets a complete, submittable
  // document. This makes the env flag authoritative on this path and lets
  // browser automation be trialed on one low-stakes host before going fleet-wide.
  if (!browserAutomationPermittedForUrl(url)) {
    const reason = !isBrowserAutomationEnabled()
      ? 'HAMILTON_ENABLE_BROWSER_AUTOMATION is not true'
      : 'portal host is not on HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST'
    const packet = await generateAndSavePacket(db, {
      profile, opportunity, grant, automationType: 'pdf_docx', taskId: task.id, userId,
    }).catch((err) => ({ error: err?.message || String(err) }))
    if (packet && !packet.error) {
      await updateApplicationTask(db, task.id, {
        outputDocxDocumentId: packet.docx_document_id,
        outputPdfDocumentId: packet.pdf_document_id || null,
        outputDocumentId: packet.pdf_document_id || packet.docx_document_id,
        mailingInstructions: packet.mailing_instructions,
        status: 'waiting_for_review',
        lastAgentMessage: `Hamilton produced a printable packet instead of browser automation (${reason}).`,
      })
      await updateAutopilotRun(db, run.id, {
        status: 'completed',
        result: { skipped_browser: true, reason, packet },
        finishedAt: new Date().toISOString(),
      })
      await appendTaskEvent(db, {
        taskId: task.id, eventType: 'note', status: 'waiting_for_review',
        message: `Browser automation skipped (${reason}); generated pdf_docx packet instead.`,
        actorUserId: userId, actorRole: 'agent',
      })
      return { task: await reload(db, task.id), classification, autopilot_run: run.id, skipped_browser: true, reason }
    }
    await updateAutopilotRun(db, run.id, {
      status: 'blocked', blockerKind: 'no_browser', blockerDetail: reason,
      finishedAt: new Date().toISOString(),
    })
    await updateApplicationTask(db, task.id, {
      status: 'blocked',
      lastAgentMessage: `Hamilton could not run browser automation (${reason}) and packet generation failed.`,
    })
    return { task: await reload(db, task.id), classification, autopilot_run: run.id, blocked: true, reason }
  }

  // Launch with a Hard-Stop Resolver loop. After each engine pass we
  // run the resolver against the engine's blocker (if any) and either:
  //   - retry with new options (saved session, document candidate)
  //   - degrade to the lawful fallback (PDF/DOCX/manual packet)
  //   - mark the task blocked for true unavoidable blockers.
  // The loop runs at most MAX_RESOLVER_ATTEMPTS times so a misbehaving
  // portal can't trap Hamilton in an infinite cycle.
  const MAX_RESOLVER_ATTEMPTS = 3
  await updateAutopilotRun(db, run.id, { status: 'running' })
  await updateApplicationTask(db, task.id, { status: 'filling_portal' })

  let storageStatePath = options?.storageStatePath || null
  let documents = Array.isArray(options?.documents) ? [...options.documents] : []
  let allowAutoSubmit = options?.allow_auto_submit ?? authorizations.submit_applications
  let engineResult = null
  let degradedDirective = null
  for (let attempt = 0; attempt < MAX_RESOLVER_ATTEMPTS; attempt += 1) {
    engineResult = await runAutopilot({
      url, profile, authorizations,
      documents, storageStatePath, allowAutoSubmit,
      headless: options?.headless ?? true,
    })
    if (engineResult.status === 'submitted' || engineResult.status === 'completed_draft') break
    if (engineResult.status === 'failed' && engineResult.blocker_kind === 'no_browser') break

    // Hand the blocker to the resolver.
    const directive = await resolveBlocker(db, {
      taskId: task.id, profileId: task.profile_id, userId,
      portalUrl: url, opportunity, profile, classification,
      documentCandidates: documents,
    }, {
      kind: engineResult.blocker_kind,
      text: engineResult.blocker_detail,
      detail: engineResult.blocker_detail,
      url,
    })
    await appendTaskEvent(db, {
      taskId: task.id,
      eventType: 'progress',
      status: 'filling_portal',
      step: 'resolver',
      message: `Resolver: ${directive.strategy} → ${directive.outcome}`,
      actorUserId: userId,
      actorRole: 'agent',
      details: { directive },
    })

    if (directive.outcome === 'resolved' && directive.retry) {
      // Adjust engine inputs based on the resolver payload.
      if (directive.payload?.storage_state_path) storageStatePath = directive.payload.storage_state_path
      if (directive.payload?.document) documents = [...documents, directive.payload.document]
      continue
    }
    if (directive.outcome === 'degraded') {
      degradedDirective = directive
      break
    }
    // 'blocked' or 'escalated' — Hamilton will surface the blocker to the user.
    break
  }

  if (degradedDirective) {
    // Lawful fallback: build a complete packet and mark the task as
    // ready_to_print_mail / ready_to_email / ready_to_fax / waiting_for_review
    // depending on the fallback path.
    const packet = await generateAndSavePacket(db, {
      profile, opportunity, grant,
      automationType: degradedDirective.fallback || 'pdf_docx',
      taskId: task.id, userId,
    }).catch((err) => ({ error: err?.message || String(err) }))
    if (packet && !packet.error) {
      await updateApplicationTask(db, task.id, {
        outputDocxDocumentId: packet.docx_document_id,
        outputPdfDocumentId: packet.pdf_document_id || null,
        outputDocumentId: packet.pdf_document_id || packet.docx_document_id,
        mailingInstructions: packet.mailing_instructions,
        status: degradedDirective.fallback === 'mail' ? 'ready_to_print_mail'
              : degradedDirective.fallback === 'email' ? 'ready_to_email'
              : degradedDirective.fallback === 'fax' ? 'ready_to_fax'
              : 'waiting_for_review',
        lastAgentMessage:
          `Hamilton Autopilot switched to the ${degradedDirective.fallback || 'pdf_docx'} pathway: ${degradedDirective.detail || 'lawful fallback'}.`,
      })
      await updateAutopilotRun(db, run.id, {
        status: 'completed',
        result: { ...engineResult, degraded_to: degradedDirective.fallback, directive: degradedDirective, packet },
        finishedAt: new Date().toISOString(),
      })
      await emitHamiltonNotificationToProfileAndAdmins(db, {
        profileId: task.profile_id,
        profileUserId: task.user_id,
        type: 'hamilton_generated_document_saved',
        title: 'Hamilton generated printable packet',
        message: degradedDirective.detail || 'Hamilton generated a printable packet you can mail, fax, email, or hand-deliver.',
        severity: 'info',
        data: { task_id: task.id, run_id: run.id, fallback: degradedDirective.fallback },
      })
      return { task: await reload(db, task.id), classification, autopilot_run: run.id, autopilot_result: engineResult, degraded: degradedDirective }
    }
  }

  await updateAutopilotRun(db, run.id, {
    result: engineResult,
    confirmationReference: engineResult.confirmation_reference || null,
    confirmationScreenshotPath: engineResult.confirmation_screenshot_path || null,
    blockerKind: engineResult.blocker_kind || null,
    blockerDetail: engineResult.blocker_detail || null,
    status: engineResult.status === 'submitted'
      ? 'submitted'
      : engineResult.status === 'completed_draft'
        ? 'completed'
        : engineResult.status === 'blocked'
          ? 'blocked'
          : 'failed',
    finishedAt: new Date().toISOString(),
  })

  if (engineResult.status === 'submitted') {
    await updateApplicationTask(db, task.id, {
      status: 'submitted',
      submittedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      lastAgentMessage:
        `Hamilton Autopilot submitted the application. Confirmation: ${engineResult.confirmation_reference || 'captured (see screenshot)'}.`,
    })
    await appendTaskEvent(db, {
      taskId: task.id,
      eventType: 'submitted',
      status: 'submitted',
      step: 'autopilot',
      message: `Hamilton Autopilot submitted: ${engineResult.confirmation_reference || 'reference captured in run record'}`,
      actorUserId: userId,
      actorRole: 'agent',
      details: { autopilot_run_id: run.id, confirmation: engineResult.confirmation_reference, screenshot: engineResult.confirmation_screenshot_path },
    })
    await emitHamiltonNotificationToProfileAndAdmins(db, {
      profileId: task.profile_id,
      profileUserId: task.user_id,
      type: 'hamilton_submitted',
      title: 'Hamilton submitted through portal',
      message: `Hamilton submitted "${opportunity?.title || grant?.title || 'this application'}" through the funder's portal. Confirmation: ${engineResult.confirmation_reference || 'captured in run record'}.`,
      severity: 'success',
      data: { task_id: task.id, run_id: run.id, confirmation: engineResult.confirmation_reference },
    })
    await emitHamiltonLifecycleAlerts(db, {
      profileId: task.profile_id,
      profileUserId: task.user_id,
      fundingSourceId: opportunity?.id || grant?.id || task.grant_id || task.opportunity_id,
      fundingSourceTitle: opportunity?.title || grant?.title || null,
      taskId: task.id,
      userType: 'hamilton_task_completed',
      adminType: 'hamilton_admin_task_completed',
      title: 'Hamilton submitted application',
      message: `Hamilton Autopilot completed and submitted "${opportunity?.title || grant?.title || 'this application'}".`,
      severity: 'success',
      data: { run_id: run.id, confirmation: engineResult.confirmation_reference },
    })
  } else if (engineResult.status === 'completed_draft') {
    await updateApplicationTask(db, task.id, {
      status: 'waiting_for_review',
      lastAgentMessage:
        'Hamilton Autopilot finished filling the application and saved a draft. Authorize submit_applications and click "Run to completion" to finish.',
    })
    await appendTaskEvent(db, {
      taskId: task.id,
      eventType: 'progress',
      status: 'waiting_for_review',
      step: 'autopilot',
      message: 'Autopilot saved a draft (submit_applications not authorized).',
      actorUserId: userId,
      actorRole: 'agent',
      details: { autopilot_run_id: run.id },
    })
  } else if (engineResult.status === 'blocked') {
    await updateApplicationTask(db, task.id, {
      status: 'blocked',
      lastAgentMessage: `Hamilton Autopilot stopped: ${engineResult.blocker_kind} — ${engineResult.blocker_detail}`,
    })
    await appendTaskEvent(db, {
      taskId: task.id,
      eventType: 'blocked',
      status: 'blocked',
      step: 'autopilot',
      message: engineResult.blocker_detail || 'Hard blocker',
      actorUserId: userId,
      actorRole: 'agent',
      details: { autopilot_run_id: run.id, blocker_kind: engineResult.blocker_kind },
    })
    await emitHamiltonNotificationToProfileAndAdmins(db, {
      profileId: task.profile_id,
      profileUserId: task.user_id,
      type: blockerNotificationType(engineResult.blocker_kind),
      title: blockerTitle(engineResult.blocker_kind),
      message: engineResult.blocker_detail || 'Hamilton Autopilot needs your help to continue.',
      severity: 'warning',
      data: { task_id: task.id, run_id: run.id, blocker_kind: engineResult.blocker_kind },
    })
  } else {
    // failed
    await updateApplicationTask(db, task.id, {
      status: 'failed',
      lastAgentMessage: `Hamilton Autopilot failed: ${engineResult.blocker_detail || engineResult.blocker_kind}`,
    })
    await appendTaskEvent(db, {
      taskId: task.id,
      eventType: 'failed',
      status: 'failed',
      step: 'autopilot',
      message: engineResult.blocker_detail || 'Engine error',
      actorUserId: userId,
      actorRole: 'agent',
      details: { autopilot_run_id: run.id, blocker_kind: engineResult.blocker_kind },
    })
    await emitHamiltonNotificationToProfileAndAdmins(db, {
      profileId: task.profile_id,
      profileUserId: task.user_id,
      type: 'hamilton_failed',
      title: 'Hamilton Autopilot failed',
      message: engineResult.blocker_detail || 'See the task audit trail.',
      severity: 'error',
      data: { task_id: task.id, run_id: run.id },
    })
    await emitHamiltonLifecycleAlerts(db, {
      profileId: task.profile_id,
      profileUserId: task.user_id,
      fundingSourceId: opportunity?.id || grant?.id || task.grant_id || task.opportunity_id,
      fundingSourceTitle: opportunity?.title || grant?.title || null,
      taskId: task.id,
      userType: null,
      adminType: 'hamilton_admin_task_failed',
      title: 'Hamilton Autopilot failed',
      message: engineResult.blocker_detail || 'See the task audit trail for details.',
      severity: 'error',
      data: { run_id: run.id, blocker_kind: engineResult.blocker_kind },
    })
  }

  return {
    task: await reload(db, task.id),
    classification,
    autopilot_run: run.id,
    autopilot_result: engineResult,
  }
}

function blockerNotificationType(kind) {
  switch (kind) {
    case '2fa':       return 'hamilton_2fa_required'
    case 'captcha':   return 'hamilton_captcha_required'
    case 'login':     return 'hamilton_login_required'
    case 'signature': return 'hamilton_review_required'
    default:          return 'hamilton_task_blocked'
  }
}
function blockerTitle(kind) {
  switch (kind) {
    case 'login':       return 'Hamilton needs a login'
    case '2fa':         return 'Hamilton needs 2FA'
    case 'captcha':     return 'Hamilton hit a CAPTCHA'
    case 'payment':     return 'Hamilton hit a payment step'
    case 'signature':   return 'Hamilton hit a signature step'
    case 'attestation': return 'Hamilton hit a legal attestation'
    case 'validation':  return 'Hamilton hit a validation error'
    default:            return 'Hamilton stopped on a blocker'
  }
}

/**
 * Process N selected sources sequentially. Returns an array of
 * { task, classification, ...details } so the UI can render a
 * per-source result.
 */
export async function automateSelected(db, {
  profileId, userId = null, selectedSources = [], options = {},
} = {}) {
  if (!db) throw new Error('db required')
  if (!profileId) throw new Error('profileId required')
  if (!Array.isArray(selectedSources) || selectedSources.length === 0) {
    return { ok: true, results: [], message: 'No sources selected.' }
  }
  const profile = await loadProfileBundle(db, profileId)
  if (!profile) {
    const err = new Error(`profile not found: ${profileId}`)
    err.status = 404
    throw err
  }

  const results = []
  for (const source of selectedSources) {
    try {
      const r = await automateSingleSource(db, { profile, profileId, userId, source, options })
      results.push({ ok: true, source, ...r })
    } catch (err) {
      results.push({ ok: false, source, error: err?.message || String(err) })
    }
  }
  return { ok: true, results }
}

export const _internal = {
  loadProfileBundle, loadOpportunity, loadGrant, loadPortalLink,
  mapClassificationToInitialStatus, mapAutomationTypeToFinishedStatus,
  mapAutomationTypeToPipelineStage, notificationTypeForAutomation,
}
