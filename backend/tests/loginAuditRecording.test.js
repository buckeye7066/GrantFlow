/**
 * Guard for the admin login tracker's durable source.
 *
 * Regression context: client_sign_in audit rows had drifted a week behind
 * user_sessions (3 audits vs 100+ sessions) because sign-in recording was
 * scattered across login handlers — inconsistently admin-gated and entirely
 * MISSING from the password-login path — and fired fire-and-forget. The fix
 * records once at the session-mint choke point (createSessionAndTokens).
 *
 * This test pins the durable contract the tracker depends on: recordClientSignInEvent
 * with a db actually PERSISTS a client_sign_in audit row, and the admin read
 * path (queryAuditLogs by action) surfaces it with its identifier + method.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { recordClientSignInEvent } from '../services/adminLoginEventStore.js'
import { queryAuditLogs } from '../services/auditService.js'

describe('login audit recording (durable sink)', () => {
  it('persists a client_sign_in audit row that the admin read path surfaces', async () => {
    const db = new Database(':memory:')
    // dialect tag drives logAuditEvent's JSON handling; default sqlite path.
    db.dialect = 'sqlite'
    try {
      await recordClientSignInEvent({
        db,
        identifier: 'client@example.com',
        method: 'password',
        userId: 'user-1',
        profileId: 'profile-1',
        ip: '203.0.113.7',
        userAgent: 'vitest',
      })

      // Read exactly as GET /api/admin/login-events does: by the unique action.
      const res = await queryAuditLogs(db, { action: 'client_sign_in', limit: 50 })
      expect(res.logs).toHaveLength(1)
      const row = res.logs[0]
      expect(row.action).toBe('client_sign_in')
      expect(row.user_id).toBe('user-1')
      expect(row.details).toMatchObject({ identifier: 'client@example.com', method: 'password' })
    } finally {
      db.close()
    }
  })

  it('records each call (one durable row per login)', async () => {
    const db = new Database(':memory:')
    db.dialect = 'sqlite'
    try {
      await recordClientSignInEvent({ db, identifier: 'a@x.com', method: 'email', userId: 'u-a' })
      await recordClientSignInEvent({ db, identifier: 'b@x.com', method: 'oauth:google', userId: 'u-b' })
      const res = await queryAuditLogs(db, { action: 'client_sign_in', limit: 50 })
      expect(res.logs).toHaveLength(2)
      expect(res.logs.map((r) => r.details?.method).sort()).toEqual(['email', 'oauth:google'])
    } finally {
      db.close()
    }
  })
})
