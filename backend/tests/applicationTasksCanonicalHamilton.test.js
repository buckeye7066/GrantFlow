import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  task: null,
  automateSingleSource: vi.fn(),
  getApplicationTask: vi.fn(),
  updateApplicationTask: vi.fn(),
  appendTaskEvent: vi.fn(),
  cancelApplicationTask: vi.fn(),
  revokeTargetAuthorizations: vi.fn(),
  cancelActiveHamiltonTaskRun: vi.fn(),
  readAuthorizations: vi.fn(),
}))

vi.mock('../services/hamilton/hamiltonAutomationOrchestrator.js', () => ({
  automateSingleSource: mocks.automateSingleSource,
}))

vi.mock('../services/hamilton/applicationTaskStore.js', () => ({
  ensureApplicationTask: vi.fn(),
  getApplicationTask: mocks.getApplicationTask,
  listApplicationTasks: vi.fn(async () => []),
  updateApplicationTask: mocks.updateApplicationTask,
  cancelApplicationTask: mocks.cancelApplicationTask,
  appendTaskEvent: mocks.appendTaskEvent,
  listMissingInfo: vi.fn(async () => []),
  resolveMissingInfoItem: vi.fn(),
  resumeTaskAfterMissingInfo: vi.fn(async () => ({ resumed: false })),
  listTaskEvents: vi.fn(async () => []),
  TASK_TERMINAL_STATUSES: ['submitted', 'failed', 'cancelled'],
}))

vi.mock('../services/hamilton/hamiltonAuthorizationStore.js', () => ({
  revokeTargetAuthorizations: mocks.revokeTargetAuthorizations,
}))

vi.mock('../services/hamilton/hamiltonRunCancellation.js', () => ({
  cancelActiveHamiltonTaskRun: mocks.cancelActiveHamiltonTaskRun,
}))

vi.mock('../services/hamilton/hamiltonPreflight.js', () => ({
  readAuthorizations: mocks.readAuthorizations,
}))

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}))

const applicationTasksRouter = (await import('../routes/applicationTasks.js')).default

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = { test: true }
    req.user = { role: 'user', userId: 'user-1' }
    req.ctx = { isAdmin: true }
    next()
  })
  app.use('/api/application-tasks', applicationTasksRouter)
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.task = {
    id: 'task-1',
    profile_id: 'profile-1',
    opportunity_id: 'opportunity-1',
    grant_id: 'grant-1',
    selected_from_stage: 'Interested',
    current_pipeline_stage: 'Application In Progress',
    status: 'ready',
  }
  mocks.getApplicationTask.mockImplementation(async () => mocks.task)
  mocks.automateSingleSource.mockResolvedValue({
    task: { ...mocks.task, status: 'waiting_for_review' },
    classification: { automation_type: 'portal' },
  })
  mocks.updateApplicationTask.mockResolvedValue(mocks.task)
  mocks.appendTaskEvent.mockResolvedValue(null)
  mocks.cancelApplicationTask.mockImplementation(async () => ({ ...mocks.task, status: 'cancelled' }))
  mocks.revokeTargetAuthorizations.mockResolvedValue(1)
  mocks.readAuthorizations.mockResolvedValue({ submit_applications: true, require_human_review: false })
})

describe('application-task Hamilton Start/Continue canonical routing', () => {
  it('routes Start through automateSingleSource with the existing task identity and stage', async () => {
    const response = await request(makeApp())
      .post('/api/application-tasks/task-1/hamilton/start')
      .send({ trigger: 'manual', allow_auto_submit: true })

    expect(response.status).toBe(200)
    expect(response.body.ok).toBe(true)
    expect(mocks.automateSingleSource).toHaveBeenCalledTimes(1)
    const [db, call] = mocks.automateSingleSource.mock.calls[0]
    expect(db).toEqual({ test: true })
    expect(call).toEqual({
      profileId: 'profile-1',
      userId: 'user-1',
      source: {
        opportunity_id: 'opportunity-1',
        grant_id: 'grant-1',
        task_id: 'task-1',
        current_stage: 'Application In Progress',
        kind: 'application_task',
      },
    })
    expect(Object.hasOwn(call, 'options')).toBe(false)
  })

  it('ignores every client submit override on Continue and preserves the stored source/stage', async () => {
    const response = await request(makeApp())
      .post('/api/application-tasks/task-1/hamilton/continue')
      .send({
        allow_auto_submit: true,
        auto_submit_enabled: true,
        options: { allow_auto_submit: true },
      })

    expect(response.status).toBe(200)
    expect(mocks.automateSingleSource).toHaveBeenCalledTimes(1)
    const call = mocks.automateSingleSource.mock.calls[0][1]
    expect(call.source).toEqual({
      opportunity_id: 'opportunity-1',
      grant_id: 'grant-1',
      task_id: 'task-1',
      current_stage: 'Application In Progress',
      kind: 'application_task',
    })
    expect(Object.hasOwn(call, 'options')).toBe(false)
    expect(JSON.stringify(call)).not.toContain('allow_auto_submit')
    expect(JSON.stringify(call)).not.toContain('auto_submit_enabled')
  })

  it('falls back to the selected stage when no current pipeline stage exists', async () => {
    mocks.task.current_pipeline_stage = null

    const response = await request(makeApp())
      .post('/api/application-tasks/task-1/hamilton/continue')

    expect(response.status).toBe(200)
    expect(mocks.automateSingleSource.mock.calls[0][1].source.current_stage).toBe('Interested')
  })
})

describe('application-task submission uncertainty', () => {
  it('refuses to re-enable auto-submit while an external attempt is unresolved', async () => {
    mocks.task.status = 'submission_verification_required'

    const response = await request(makeApp())
      .post('/api/application-tasks/task-1/approve-submit')
      .send({ enable: true })

    expect(response.status).toBe(409)
    expect(response.body.error).toBe('submission_verification_required')
    expect(response.body.message).toMatch(/check the funder portal/i)
    expect(mocks.updateApplicationTask).not.toHaveBeenCalled()
    expect(mocks.revokeTargetAuthorizations).not.toHaveBeenCalled()
  })

  it('revokes future authority but warns that an in-flight portal action was not stopped', async () => {
    mocks.task.status = 'submit_evidence_pending'

    const response = await request(makeApp())
      .post('/api/application-tasks/task-1/approve-submit')
      .send({ enable: false })

    expect(response.status).toBe(200)
    expect(response.body.warning?.code).toBe('submission_action_may_be_in_progress')
    expect(response.body.warning?.message).toMatch(/does not stop or undo/i)
    expect(mocks.updateApplicationTask).toHaveBeenCalledWith(
      expect.anything(),
      'task-1',
      { autoSubmitEnabled: false, allowAutoSubmit: false },
    )
    expect(mocks.revokeTargetAuthorizations).toHaveBeenCalledTimes(1)
    expect(mocks.appendTaskEvent.mock.calls.at(-1)[1].message).toMatch(/may already be in progress/i)
  })

  it('keeps cancellation delegated to the task store and returns its durable state', async () => {
    mocks.task.status = 'submit_attempt_started'

    const response = await request(makeApp())
      .post('/api/application-tasks/task-1/cancel')
      .send({ reason: 'owner cancelled' })

    expect(response.status).toBe(200)
    expect(mocks.cancelActiveHamiltonTaskRun).toHaveBeenCalledWith('task-1', 'owner cancelled')
    expect(mocks.cancelApplicationTask).toHaveBeenCalledWith(
      expect.anything(),
      'task-1',
      expect.objectContaining({ reason: 'owner cancelled', actorUserId: 'user-1' }),
    )
    expect(response.body.task.status).toBe('cancelled')
  })
})
