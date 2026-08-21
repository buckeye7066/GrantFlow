/**
 * `POST /start-autopilot` must expand an empty selection when the caller asks
 * for `all_ready_sources`.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * The expansion was written, reviewed, committed and DEPLOYED - into the wrong
 * route. A search-and-replace matched `/preflight` first, which carries
 * near-identical guard lines, so `/start-autopilot` kept its hard
 * `selected_sources_required` 400. The owner pressed "Begin automation" in
 * production and got a 400 for a feature that appeared, by every other signal,
 * to be shipped: the helper existed, the button existed, the deployed bundle
 * really did send the flag.
 *
 * Grepping the file for `all_ready_sources` FOUND IT and proved nothing,
 * because the string was present in a route nobody was calling. So these
 * tests drive the actual handler through the router rather than inspecting
 * source - the only check that can tell "present in the file" from "reached
 * by the request".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

const AUTH_USER = { id: 'user-1', user_id: 'user-1', email: 'owner@example.org', role: 'admin' }

vi.mock('../services/hamilton/hamiltonAutomationOrchestrator.js', async (orig) => {
  const actual = await orig()
  return { ...actual, automateSelected: vi.fn(async () => ({ ok: true })) }
})

let router
beforeEach(async () => {
  vi.resetModules()
  router = (await import('../routes/hamiltonAutomation.js')).default
})
afterEach(() => { vi.restoreAllMocks() })

function appWith(grantRows) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = AUTH_USER
    // userMayAccessProfile short-circuits on the DB-backed admin context.
    req.ctx = { isAdmin: true }
    req.db = {
      prepare: (sql) => ({
        all: async () => (/FROM grants/i.test(sql) ? grantRows : []),
        get: async () => ({ id: 'profile-1', user_id: 'user-1' }),
        run: async () => ({ changes: 1 }),
      }),
    }
    next()
  })
  app.use('/api/hamilton/automation', router)
  return app
}

const READY = [
  { id: 'g1', funding_opportunity_id: 'o1', title: 'Grant One', status: 'interested' },
  { id: 'g2', funding_opportunity_id: null, title: 'Grant Two', status: 'drafting' },
]

describe('start-autopilot: all_ready_sources', () => {
  it('does NOT 400 when the caller asks for every ready source', async () => {
    // The exact production failure: this returned 400 selected_sources_required.
    const res = await request(appWith(READY))
      .post('/api/hamilton/automation/start-autopilot')
      .send({ profile_id: 'profile-1', all_ready_sources: true, options: { allow_auto_submit: true } })

    expect(res.status).toBe(202)
    expect(res.body.queued_count).toBe(READY.length)
  })

  it('an EMPTY pipeline is a stated reason, not a queued no-op', async () => {
    const res = await request(appWith([]))
      .post('/api/hamilton/automation/start-autopilot')
      .send({ profile_id: 'profile-1', all_ready_sources: true })

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('no_ready_sources')
  })

  it('STILL refuses an empty selection when the flag was not sent', async () => {
    // The opt-in guarantee: an empty selection must never silently become
    // "all of them" for callers that did not ask.
    const res = await request(appWith(READY))
      .post('/api/hamilton/automation/start-autopilot')
      .send({ profile_id: 'profile-1' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('selected_sources_required')
  })

  it('honours an EXPLICIT selection verbatim', async () => {
    const picked = [{ grant_id: 'g9', opportunity_id: 'o9', title: 'Only This', current_stage: 'drafting' }]
    const res = await request(appWith(READY))
      .post('/api/hamilton/automation/start-autopilot')
      .send({ profile_id: 'profile-1', selected_sources: picked, all_ready_sources: true })

    expect(res.status).toBe(202)
    expect(res.body.queued_count).toBe(1)
  })
})
