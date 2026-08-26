/**
 * Project the canonical irreversible-submit decision onto a tailored-
 * application card. This composes the same independent vetoes enforced at the
 * browser click boundary; the UI must never infer readiness from the tailored
 * narrative gate alone.
 */

import { isAutomationEnabled } from '../../../shared/automationPreferences.js'

const TERMINAL_TASK_STATUSES = new Set(['submitted', 'failed', 'cancelled', 'canceled'])

async function defaultAuthorizationDecision(db, options) {
  const { resolveSubmissionDecision } = await import('./hamiltonAuthorizationStore.js')
  return resolveSubmissionDecision(db, options)
}

async function defaultFullAutomationCheck(db, profileId) {
  const { isFullAutomationEnabled } = await import('./hamiltonFullAutomationMode.js')
  return isFullAutomationEnabled(db, profileId)
}

async function defaultTailoredGateCheck(db, options) {
  const { evaluateAutoSubmitGate } = await import('./tailoredNarrative.js')
  return evaluateAutoSubmitGate(db, options)
}

async function defaultPortalExecutionCheck(url, options) {
  const { reviewedPortalSubmissionExecutionAvailable } = await import('./hamiltonAutomationOrchestrator.js')
  return reviewedPortalSubmissionExecutionAvailable(url, options)
}

async function defaultGlobalAutoSubmitCheck() {
  const { isAutoSubmitGloballyEnabled } = await import('../hamiltonApplicationAgent.js')
  return isAutoSubmitGloballyEnabled()
}

/**
 * Return the complete current decision for a card without mutating task state.
 * Optional dependency injection keeps the decision matrix hermetic in tests.
 */
export async function resolveTailoredSubmissionDecision(db, {
  profileId,
  fundingSourceId = null,
  task = null,
  profile = null,
  portalUrl = null,
  grantId = null,
  opportunity = null,
  grant = null,
  _deps = null,
} = {}) {
  const deps = {
    resolveSubmissionDecision: defaultAuthorizationDecision,
    isAutoSubmitGloballyEnabled: defaultGlobalAutoSubmitCheck,
    isFullAutomationEnabled: defaultFullAutomationCheck,
    isAutomationEnabled,
    evaluateAutoSubmitGate: defaultTailoredGateCheck,
    reviewedPortalSubmissionExecutionAvailable: defaultPortalExecutionCheck,
    ...(_deps || {}),
  }

  const taskStatus = String(task?.status || '').trim().toLowerCase()
  if (TERMINAL_TASK_STATUSES.has(taskStatus)) {
    const canonicalStatus = taskStatus === 'canceled' ? 'cancelled' : taskStatus
    return {
      allow_auto_submit: false,
      requested: Boolean(task?.allow_auto_submit === true || task?.allow_auto_submit === 1),
      authorized: false,
      require_human_review: false,
      reason: canonicalStatus === 'submitted' ? 'task_already_submitted' : `task_${canonicalStatus}`,
      authorization_id: null,
      task_status: canonicalStatus,
      terminal_task: true,
      full_automation_enabled: false,
      global_auto_submit_enabled: false,
      portal_execution_available: false,
      portal_url: portalUrl || null,
      tailored_gate: null,
    }
  }

  let decision = await deps.resolveSubmissionDecision(db, {
    profileId,
    fundingSourceId,
    taskId: task?.id || null,
    taskAllowAutoSubmit: task?.allow_auto_submit === true || task?.allow_auto_submit === 1,
  })

  let fullAutomationEnabled = false
  try {
    fullAutomationEnabled = Boolean((await deps.isFullAutomationEnabled(db, profileId))?.enabled)
  } catch {
    fullAutomationEnabled = false
  }

  let globalAutoSubmitEnabled = false
  try {
    globalAutoSubmitEnabled = Boolean(await deps.isAutoSubmitGloballyEnabled())
  } catch {
    globalAutoSubmitEnabled = false
  }
  let portalExecutionAvailable = false
  try {
    portalExecutionAvailable = Boolean(await deps.reviewedPortalSubmissionExecutionAvailable(
      portalUrl,
      { fullAutomation: fullAutomationEnabled },
    ))
  } catch {
    portalExecutionAvailable = false
  }

  let allowAutoSubmit = Boolean(decision.allow_auto_submit)
  if (allowAutoSubmit && !globalAutoSubmitEnabled) {
    allowAutoSubmit = false
    decision = { ...decision, allow_auto_submit: false, reason: 'global_auto_submit_disabled' }
  }
  if (allowAutoSubmit && !portalExecutionAvailable) {
    allowAutoSubmit = false
    decision = {
      ...decision,
      allow_auto_submit: false,
      reason: 'portal_url_not_browser_executable',
      execution_channel: 'human_handoff',
    }
  }

  const preferences = profile?.automation_preferences
    || profile?.sections?.automation_preferences
    || {}
  if (
    allowAutoSubmit
    && !fullAutomationEnabled
    && !deps.isAutomationEnabled(preferences, 'hamilton_auto_submit')
  ) {
    allowAutoSubmit = false
    decision = { ...decision, allow_auto_submit: false, reason: 'profile_auto_submit_disabled' }
  }

  let tailoredGate = null
  if (allowAutoSubmit && grantId) {
    try {
      tailoredGate = await deps.evaluateAutoSubmitGate(db, {
        profileId,
        grantId,
        profile,
        opportunity,
        grant,
        fullAutomationEnabled,
      })
    } catch (error) {
      tailoredGate = {
        submit: false,
        reason: 'gate_error',
        enforced: true,
        error: String(error?.message || error),
      }
    }
    if (tailoredGate?.enforced && !tailoredGate.submit) {
      allowAutoSubmit = false
      decision = {
        ...decision,
        allow_auto_submit: false,
        reason: tailoredGate.reason || 'tailored_gate_blocked',
      }
    }
  }

  return {
    ...decision,
    allow_auto_submit: allowAutoSubmit,
    full_automation_enabled: fullAutomationEnabled,
    global_auto_submit_enabled: globalAutoSubmitEnabled,
    portal_execution_available: portalExecutionAvailable,
    portal_url: portalUrl || null,
    tailored_gate: tailoredGate,
  }
}

export default resolveTailoredSubmissionDecision
