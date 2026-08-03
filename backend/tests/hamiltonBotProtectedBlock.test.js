/**
 * A full-page bot-protection dead-end (owner 2026-08-03) must:
 *   - persist a durable, visible `blocked` state on the task (not a transient toast)
 *   - notify the profile owner AND admins with the side-by-side co-browse CTA
 *   - NEVER expire the saved session — a bot-wall is OUR reachability problem
 *     (datacenter IP / fingerprint), not proof the session is dead (mirrors the
 *     portal-sync block-vs-signin-wall rule)
 *
 * handleBotProtectedBlock is the extracted, exported choke point the run-path
 * bot_protected branch calls, so these guarantees are testable directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'c'.repeat(64)

const updateApplicationTask = vi.fn(async () => ({ ok: true }))
const appendTaskEvent = vi.fn(async () => ({ ok: true }))
const emitNotification = vi.fn(async () => ['n1'])
const markSessionExpired = vi.fn(async () => ({ ok: true }))

vi.mock('../services/hamilton/applicationTaskStore.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, updateApplicationTask, appendTaskEvent }
})
vi.mock('../services/hamilton/hamiltonNotifications.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, emitHamiltonNotificationToProfileAndAdmins: emitNotification }
})
vi.mock('../services/hamilton/hamiltonCredentialSessionService.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, markSessionExpired }
})

const { handleBotProtectedBlock } = await import('../services/hamilton/hamiltonAutomationOrchestrator.js')

const TASK = { id: 't1', profile_id: 'p1', user_id: 'u1' }
const URL = 'https://www.scholarships.com/apply'

beforeEach(() => vi.clearAllMocks())

describe('handleBotProtectedBlock', () => {
  it('persists a durable blocked state with the side-by-side guidance', async () => {
    await handleBotProtectedBlock({}, {
      task: TASK, runId: 'r1', url: URL, fundingTitle: 'Future Leaders', usedSessionId: 'sess-9',
    })
    expect(updateApplicationTask).toHaveBeenCalledTimes(1)
    const [, taskId, patch] = updateApplicationTask.mock.calls[0]
    expect(taskId).toBe('t1')
    expect(patch.status).toBe('blocked')
    expect(patch.nextRetryAt).toBeNull()
    expect(patch.lastAgentMessage).toMatch(/side-by-side/i)
    expect(patch.lastAgentMessage).toMatch(/bot protection/i)
  })

  it('records a durable blocked task event marked bot_protected + session_preserved', async () => {
    await handleBotProtectedBlock({}, { task: TASK, runId: 'r1', url: URL, usedSessionId: 'sess-9' })
    expect(appendTaskEvent).toHaveBeenCalledTimes(1)
    const ev = appendTaskEvent.mock.calls[0][1]
    expect(ev.status).toBe('blocked')
    expect(ev.details.blocker_kind).toBe('bot_protected')
    expect(ev.details.session_preserved).toBe(true)
  })

  it('notifies the profile owner AND admins with the side-by-side co-browse CTA', async () => {
    await handleBotProtectedBlock({}, { task: TASK, runId: 'r1', url: URL })
    expect(emitNotification).toHaveBeenCalledTimes(1)
    const note = emitNotification.mock.calls[0][1]
    expect(note.type).toBe('hamilton_bot_protected')
    expect(note.profileId).toBe('p1')
    expect(note.profileUserId).toBe('u1')
    expect(note.message).toMatch(/side-by-side/i)
    expect(note.data.cobrowse_host).toBe('www.scholarships.com')
    expect(note.data.cobrowse_reason).toBe('bot_protected')
    expect(note.data.side_by_side_link).toContain('cobrowse=www.scholarships.com')
  })

  it('NEVER expires the saved session on a bot-wall (our reachability problem, not a dead session)', async () => {
    await handleBotProtectedBlock({}, { task: TASK, runId: 'r1', url: URL, usedSessionId: 'sess-9' })
    expect(markSessionExpired).not.toHaveBeenCalled()
  })
})
