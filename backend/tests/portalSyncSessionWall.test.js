/**
 * A portal sync that provably never cleared the sign-in wall must EXPIRE the
 * saved session and tell the household — not fail silently.
 *
 * THE GAP (2026-08-01): three live studentaid.gov syncs in a row read nothing
 * because the saved session was not accepted (the portal answered each request
 * for a private page with its sign-in page or its public home page). Each run
 * recorded an empty read and stopped there. The session stayed marked `valid`,
 * so nothing ever told the owner the one thing that would fix it: sign in
 * side-by-side once more.
 *
 * The rule mirrors runSessionKeepAliveSweep exactly, including the distinction
 * it exists to protect:
 *   - an AUTH CHALLENGE is the session's death  -> expire + notify once
 *   - a BLOCK (datacenter/WAF refusal) is OUR reachability problem -> never
 *     burn a session that may still be perfectly good
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'a'.repeat(64)

const markSessionExpired = vi.fn(async () => ({ ok: true }))
const emitNotification = vi.fn(async () => ({ ok: true }))

vi.mock('../services/hamilton/hamiltonCredentialSessionService.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, markSessionExpired }
})
vi.mock('../services/hamilton/hamiltonNotifications.js', () => ({
  emitHamiltonNotificationToProfileAndAdmins: emitNotification,
}))

const Database = (await import('better-sqlite3')).default
const { _internal } = await import('../services/hamilton/portalSync/index.js')

const SESSION = {
  id: 'sess-1',
  profile_id: 'p1',
  user_id: 'u1',
  metadata_json: JSON.stringify({ cookie_count: 131 }),
}

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE hamilton_saved_sessions (
      id TEXT PRIMARY KEY, profile_id TEXT, user_id TEXT,
      metadata_json TEXT, updated_at TIMESTAMP
    );
  `)
  db.prepare('INSERT INTO hamilton_saved_sessions (id, profile_id, user_id, metadata_json) VALUES (?,?,?,?)')
    .run(SESSION.id, SESSION.profile_id, SESSION.user_id, SESSION.metadata_json)
})

describe('markSessionDeadAfterWall', () => {
  it('expires the session and notifies the household exactly once', async () => {
    await _internal.markSessionDeadAfterWall(db, SESSION, 'studentaid.gov')

    expect(markSessionExpired).toHaveBeenCalledTimes(1)
    expect(markSessionExpired.mock.calls[0][1]).toBe('sess-1')
    expect(emitNotification).toHaveBeenCalledTimes(1)

    const note = emitNotification.mock.calls[0][1]
    expect(note.type).toBe('hamilton_session_capture_needed')
    expect(note.title).toMatch(/sign in once to studentaid\.gov/i)
    // The message must reassure that nothing was corrupted — this run read
    // nothing and wrote nothing.
    expect(note.message).toMatch(/nothing on your profile was changed/i)
  })

  it('does NOT re-page the household on every retry (cooldown honored)', async () => {
    const recent = { ...SESSION, metadata_json: JSON.stringify({ keepalive_notified_at: new Date().toISOString() }) }
    await _internal.markSessionDeadAfterWall(db, recent, 'studentaid.gov')

    // The session is still expired (the fact is re-asserted)…
    expect(markSessionExpired).toHaveBeenCalledTimes(1)
    // …but the human is not notified again.
    expect(emitNotification).not.toHaveBeenCalled()
  })

  it('a notification failure never changes the sync outcome (best-effort)', async () => {
    emitNotification.mockRejectedValueOnce(new Error('mail down'))
    await expect(_internal.markSessionDeadAfterWall(db, SESSION, 'studentaid.gov')).resolves.toBeUndefined()
    expect(markSessionExpired).toHaveBeenCalledTimes(1)
  })
})
