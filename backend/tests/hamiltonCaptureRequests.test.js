/**
 * Unit tests for backend/services/hamilton/hamiltonSessionCaptureRequests.js
 *
 * The capture-request queue is what makes the in-app "Capture login session"
 * button work across devices, and its profile binding is the safeguard that
 * keeps two users on the same portal host (e.g. two MTSU students) separate.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  createCaptureRequest,
  listCaptureRequests,
  completeCaptureRequest,
  cancelCaptureRequest,
  getCaptureRequest,
} from '../services/hamilton/hamiltonSessionCaptureRequests.js'

function makeDb() {
  return new Database(':memory:') // service ensureSchema creates the table
}

describe('hamiltonSessionCaptureRequests', () => {
  let db
  beforeEach(() => { db = makeDb() })

  it('creates a profile-bound pending request and normalizes the host', async () => {
    const req = await createCaptureRequest(db, { profileId: 'p1', portalHost: 'https://www.MTSU.edu/pipelinemt/', label: 'MTSU' })
    expect(req.profile_id).toBe('p1')
    expect(req.portal_host).toBe('www.mtsu.edu')
    expect(req.status).toBe('pending')
  })

  it('is idempotent: a second click for the same (profile, host) reuses the open request', async () => {
    const a = await createCaptureRequest(db, { profileId: 'p1', portalHost: 'mtsu.edu' })
    const b = await createCaptureRequest(db, { profileId: 'p1', portalHost: 'mtsu.edu' })
    expect(b.id).toBe(a.id)
    const pending = await listCaptureRequests(db, { profileIds: ['p1'], status: 'pending' })
    expect(pending).toHaveLength(1)
  })

  it('keeps two profiles on the same host as separate requests', async () => {
    const s1 = await createCaptureRequest(db, { profileId: 'studentA', portalHost: 'mtsu.edu' })
    const s2 = await createCaptureRequest(db, { profileId: 'studentB', portalHost: 'mtsu.edu' })
    expect(s1.id).not.toBe(s2.id)
    const onlyA = await listCaptureRequests(db, { profileIds: ['studentA'], status: 'pending' })
    expect(onlyA.map((r) => r.profile_id)).toEqual(['studentA'])
  })

  it('completing a request links the session and drops it from pending', async () => {
    const req = await createCaptureRequest(db, { profileId: 'p1', portalHost: 'mtsu.edu' })
    await completeCaptureRequest(db, req.id, { sessionId: 'sess-123' })
    const after = await getCaptureRequest(db, req.id)
    expect(after.status).toBe('completed')
    expect(after.session_id).toBe('sess-123')
    const pending = await listCaptureRequests(db, { profileIds: ['p1'], status: 'pending' })
    expect(pending).toHaveLength(0)
  })

  it('cancelling a request removes it from pending', async () => {
    const req = await createCaptureRequest(db, { profileId: 'p1', portalHost: 'mtsu.edu' })
    await cancelCaptureRequest(db, req.id, { reason: 'changed_mind' })
    const after = await getCaptureRequest(db, req.id)
    expect(after.status).toBe('cancelled')
  })
})
