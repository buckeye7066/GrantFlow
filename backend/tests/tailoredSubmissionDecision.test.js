import { describe, expect, it, vi } from 'vitest'

import { resolveTailoredSubmissionDecision } from '../services/hamilton/tailoredSubmissionDecision.js'

const PROFILE = {
  automation_preferences: { automations: { hamilton_auto_submit: true } },
}

function dependencies(overrides = {}) {
  return {
    resolveSubmissionDecision: vi.fn(async (_db, args) => ({
      allow_auto_submit: true,
      requested: true,
      authorized: true,
      require_human_review: false,
      reason: 'authorized',
      authorization_id: 'auth-1',
      task_args: args,
    })),
    isAutoSubmitGloballyEnabled: vi.fn(() => true),
    isFullAutomationEnabled: vi.fn(async () => ({ enabled: false })),
    isAutomationEnabled: vi.fn(() => true),
    reviewedPortalSubmissionExecutionAvailable: vi.fn(() => true),
    evaluateAutoSubmitGate: vi.fn(async () => ({ submit: true, reason: null, enforced: true })),
    ...overrides,
  }
}

async function decide(_deps, overrides = {}) {
  return resolveTailoredSubmissionDecision({}, {
    profileId: 'profile-1',
    fundingSourceId: 'opportunity-1',
    task: { id: 'task-1', allow_auto_submit: true },
    profile: PROFILE,
    portalUrl: 'https://apply.example.org/form',
    grantId: 'grant-1',
    opportunity: { id: 'opportunity-1' },
    grant: { id: 'grant-1' },
    _deps,
    ...overrides,
  })
}

describe('tailored card complete submission decision', () => {
  it('returns ready only when authority, task intent, global posture, portal execution, profile preference, and completeness all pass', async () => {
    const deps = dependencies()
    const result = await decide(deps)

    expect(result.allow_auto_submit).toBe(true)
    expect(result.reason).toBe('authorized')
    expect(result.portal_execution_available).toBe(true)
    expect(result.global_auto_submit_enabled).toBe(true)
    expect(deps.resolveSubmissionDecision).toHaveBeenCalledWith({}, expect.objectContaining({
      taskId: 'task-1',
      taskAllowAutoSubmit: true,
    }))
  })

  it.each([
    ['missing submission authorization', {
      resolveSubmissionDecision: vi.fn(async () => ({
        allow_auto_submit: false, requested: true, authorized: false,
        require_human_review: false, reason: 'missing_submit_authorization',
      })),
    }, 'missing_submit_authorization'],
    ['global kill switch', { isAutoSubmitGloballyEnabled: vi.fn(() => false) }, 'global_auto_submit_disabled'],
    ['unexecutable portal', { reviewedPortalSubmissionExecutionAvailable: vi.fn(() => false) }, 'portal_url_not_browser_executable'],
    ['profile preference off', { isAutomationEnabled: vi.fn(() => false) }, 'profile_auto_submit_disabled'],
    ['missing required facts', {
      evaluateAutoSubmitGate: vi.fn(async () => ({ submit: false, reason: 'missing_info', enforced: true })),
    }, 'missing_info'],
  ])('fails closed for %s', async (_label, override, expectedReason) => {
    const result = await decide(dependencies(override))
    expect(result.allow_auto_submit).toBe(false)
    expect(result.reason).toBe(expectedReason)
  })

  it('treats active full automation as the preference selection while preserving all other vetoes', async () => {
    const deps = dependencies({
      isFullAutomationEnabled: vi.fn(async () => ({ enabled: true })),
      isAutomationEnabled: vi.fn(() => false),
    })
    const result = await decide(deps, {
      profile: { automation_preferences: { automations: {} } },
    })

    expect(result.allow_auto_submit).toBe(true)
    expect(result.full_automation_enabled).toBe(true)
    expect(deps.evaluateAutoSubmitGate).toHaveBeenCalledWith({}, expect.objectContaining({
      fullAutomationEnabled: true,
    }))
  })

  it('fails closed when the tailored completeness gate throws', async () => {
    const result = await decide(dependencies({
      evaluateAutoSubmitGate: vi.fn(async () => { throw new Error('db unavailable') }),
    }))
    expect(result.allow_auto_submit).toBe(false)
    expect(result.reason).toBe('gate_error')
  })

  it.each([
    ['submitted', 'task_already_submitted'],
    ['failed', 'task_failed'],
    ['cancelled', 'task_cancelled'],
    ['canceled', 'task_cancelled'],
  ])('short-circuits the terminal %s task state', async (status, reason) => {
    const deps = dependencies()
    const result = await decide(deps, {
      task: { id: 'task-1', allow_auto_submit: true, status },
    })

    expect(result).toMatchObject({
      allow_auto_submit: false,
      reason,
      terminal_task: true,
      task_status: status === 'canceled' ? 'cancelled' : status,
      portal_execution_available: false,
    })
    expect(deps.resolveSubmissionDecision).not.toHaveBeenCalled()
    expect(deps.reviewedPortalSubmissionExecutionAvailable).not.toHaveBeenCalled()
    expect(deps.evaluateAutoSubmitGate).not.toHaveBeenCalled()
  })
})
