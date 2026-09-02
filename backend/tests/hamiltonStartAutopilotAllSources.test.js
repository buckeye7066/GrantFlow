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
        all: async (...params) => {
          if (!/FROM grants/i.test(sql)) return []
          const rows = grantRows.map((row) => ({ ...row, profile_id: row.profile_id || 'profile-1' }))
          if (/funding_opportunity_id\s*=\s*\?/i.test(sql)) {
            const opportunityId = String(params[1] || '')
            return rows.filter((row) => String(row.funding_opportunity_id || '') === opportunityId)
          }
          return rows
        },
        get: async (...params) => {
          if (/FROM grants/i.test(sql)) {
            const id = String(params[0] || '')
            const row = grantRows.find((candidate) => String(candidate.id) === id)
            return row ? { ...row, profile_id: row.profile_id || 'profile-1' } : null
          }
          return { id: 'profile-1', user_id: 'user-1' }
        },
        run: async () => ({ changes: 1 }),
      }),
    }
    next()
  })
  app.use('/api/hamilton/automation', router)
  return app
}

const READY = [
  {
    id: 'g1',
    funding_opportunity_id: 'o1',
    title: 'Grant One',
    status: 'interested',
    g_application_url: 'https://apply.example.org/grant-one',
    opportunity_kind: 'direct_grant',
  },
  {
    id: 'g2',
    funding_opportunity_id: null,
    title: 'Grant Two',
    status: 'drafting',
    g_application_url: 'https://apply.example.org/grant-two',
    opportunity_kind: 'direct_grant',
  },
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
    const picked = [{ grant_id: 'g1', opportunity_id: 'o1', title: 'Only This', current_stage: 'drafting' }]
    const res = await request(appWith(READY))
      .post('/api/hamilton/automation/start-autopilot')
      .send({ profile_id: 'profile-1', selected_sources: picked, all_ready_sources: true })

    expect(res.status).toBe(202)
    expect(res.body.queued_count).toBe(1)
  })
})

// A pipeline mixing an applyable scholarship FORM, an SSA account portal and a
// grants.gov info page — the exact "13 runs, 1 completed application" shape.
// Deliberately in updated_at order INFO, PORTAL, FORM so the applyable-first
// sort has real teeth (the input order is the reverse of the expected output).
const MIXED = [
  { id: 'gInfo', funding_opportunity_id: 'oInfo', title: 'Federal grant listing', status: 'interested',
    fo_source_url: 'https://www.grants.gov/search-results-detail/1', opportunity_kind: 'direct' },
  { id: 'gPortal', funding_opportunity_id: 'oPortal', title: 'SSDI benefits', status: 'interested',
    g_application_url: 'https://www.ssa.gov/disability', opportunity_kind: 'benefit' },
  { id: 'gForm', funding_opportunity_id: 'oForm', title: 'Scholarship Form', status: 'interested',
    fo_application_url: 'https://cpcc.academicworks.com/opportunities/1', opportunity_kind: 'direct' },
]

describe('applyability prioritisation', () => {
  it('ready-sources exposes only direct application surfaces to Select all', async () => {
    const res = await request(appWith(MIXED)).get('/api/hamilton/automation/ready-sources?profile_id=profile-1')
    expect(res.status).toBe(200)
    expect(res.body.sources).toHaveLength(1)
    expect(res.body.sources[0]).toMatchObject({
      grant_id: 'gForm',
      applyability_tier: 'online_form',
      is_applyable: true,
    })
  })

  it('auto-submit expands to the APPLYABLE source only when some exist', async () => {
    const res = await request(appWith(MIXED))
      .post('/api/hamilton/automation/start-autopilot')
      .send({ profile_id: 'profile-1', all_ready_sources: true, options: { allow_auto_submit: true } })
    expect(res.status).toBe(202)
    // Only the online_form scholarship — never the SSA login or the grants.gov
    // info page — is handed to auto-submit.
    expect(res.body.queued_count).toBe(1)
  })

  it('returns a stated no-ready reason instead of enqueueing only hard stops', async () => {
    const noSurface = MIXED.filter((row) => row.id !== 'gForm')
    const res = await request(appWith(noSurface))
      .post('/api/hamilton/automation/start-autopilot')
      .send({ profile_id: 'profile-1', all_ready_sources: true, options: { allow_auto_submit: true } })

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('no_ready_sources')
  })

  it('rejects a spoofed opportunity-only selection when the server grant is submitted', async () => {
    const submitted = [{
      id: 'gSubmitted',
      profile_id: 'profile-1',
      funding_opportunity_id: 'oSubmitted',
      title: 'Already sent',
      status: 'submitted',
      g_application_url: 'https://apply.example.org/already-sent',
      opportunity_kind: 'direct_grant',
    }]
    const res = await request(appWith(submitted))
      .post('/api/hamilton/automation/start-autopilot')
      .send({
        profile_id: 'profile-1',
        selected_sources: [{
          opportunity_id: 'oSubmitted',
          current_stage: 'saved',
        }],
      })

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('pipeline_stage_protected')
  })
})
