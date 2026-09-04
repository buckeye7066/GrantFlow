import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../utils/scopedOpportunity.js', () => ({
  getScopedOpportunityForVnextApplication: vi.fn(),
}))

vi.mock('../vnext/auditEventsService.js', () => ({
  writeAuditEvent: vi.fn(async () => ({ ok: true })),
}))

vi.mock('../vnext/missingnessService.js', () => ({
  computeMissingRequirements: vi.fn(async () => ({ ok: true, missing: { missing_fields: [], missing_docs: [] } })),
}))

vi.mock('../vnext/scoringService.js', () => ({
  scoreApplication: vi.fn(async () => ({ ok: true })),
}))

vi.mock('../vnext/schemaService.js', () => ({
  getFormSchema: vi.fn(async () => ({ id: 'schema-1' })),
  ensureInferredSchemaForOpportunity: vi.fn(async () => ({ id: 'schema-1' })),
}))

import { getScopedOpportunityForVnextApplication } from '../utils/scopedOpportunity.js'
import { writeAuditEvent } from '../vnext/auditEventsService.js'
import { attemptTransition } from '../vnext/stateMachine.js'
import { VNEXT_STATES } from '../vnext/constants.js'

function scopedFixture(state = VNEXT_STATES.DISCOVERED, stage = state) {
  return {
    application: {
      id: 'app-1',
      state,
      stage,
      boundary_type: null,
      boundary_url: null,
    },
    opportunity: {
      id: 'opp-1',
      profile_id: 'profile-1',
      schema_id: 'schema-1',
      title: 'Test opportunity',
    },
  }
}

function makeDb({ changes = 1 } = {}) {
  const run = vi.fn(async () => ({ changes }))
  const db = {
    dialect: 'sqlite',
    prepare: vi.fn(() => ({ run })),
    async withTransaction(fn) {
      return fn(db)
    },
  }
  return { db, run }
}

beforeEach(() => {
  vi.clearAllMocks()
  getScopedOpportunityForVnextApplication.mockResolvedValue(scopedFixture())
})

describe('VNext transition integrity', () => {
  it('forbids skipping forward across a state with its own invariants', async () => {
    const { db } = makeDb()

    const result = await attemptTransition(
      db,
      'app-1',
      VNEXT_STATES.QUALIFIED,
      { user_id: 'user-1' },
    )

    expect(result.ok).toBe(false)
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'FORWARD_TRANSITION_SKIP_FORBIDDEN',
        details: expect.objectContaining({
          current_state: VNEXT_STATES.DISCOVERED,
          requested_state: VNEXT_STATES.QUALIFIED,
          required_next_state: VNEXT_STATES.DEDUPED,
        }),
      }),
    ]))
    expect(db.prepare).not.toHaveBeenCalled()
    expect(writeAuditEvent).toHaveBeenCalledWith(db, expect.objectContaining({ action: 'transition.blocked' }))
  })

  it('claims a one-step transition with compare-and-swap on the exact stored state snapshot', async () => {
    const { db, run } = makeDb({ changes: 1 })

    const result = await attemptTransition(db, 'app-1', VNEXT_STATES.DEDUPED)

    expect(result).toMatchObject({ ok: true, newState: VNEXT_STATES.DEDUPED })
    expect(db.prepare).toHaveBeenCalledTimes(1)
    const sql = db.prepare.mock.calls[0][0]
    expect(sql).toContain('((state = ?) OR (state IS NULL AND ? IS NULL))')
    expect(sql).toContain('((stage = ?) OR (stage IS NULL AND ? IS NULL))')
    expect(run).toHaveBeenCalledWith(
      VNEXT_STATES.DEDUPED,
      VNEXT_STATES.DEDUPED,
      null,
      null,
      'app-1',
      VNEXT_STATES.DISCOVERED,
      VNEXT_STATES.DISCOVERED,
      VNEXT_STATES.DISCOVERED,
      VNEXT_STATES.DISCOVERED,
    )
  })

  it('preserves a legacy lowercase stored state while normalizing its logical transition', async () => {
    getScopedOpportunityForVnextApplication.mockResolvedValue(scopedFixture('discovered', 'discovered'))
    const { db, run } = makeDb({ changes: 1 })

    const result = await attemptTransition(db, 'app-1', VNEXT_STATES.DEDUPED)

    expect(result).toMatchObject({ ok: true, newState: VNEXT_STATES.DEDUPED })
    expect(run).toHaveBeenCalledWith(
      VNEXT_STATES.DEDUPED,
      VNEXT_STATES.DEDUPED,
      null,
      null,
      'app-1',
      'discovered',
      'discovered',
      'discovered',
      'discovered',
    )
  })

  it('reports a concurrent transition instead of overwriting another worker', async () => {
    const { db } = makeDb({ changes: 0 })

    const result = await attemptTransition(db, 'app-1', VNEXT_STATES.DEDUPED)

    expect(result.ok).toBe(false)
    expect(result.blockers).toEqual([
      expect.objectContaining({ code: 'CONCURRENT_TRANSITION' }),
    ])
  })

  it('treats a same-state request as idempotent and does not rewrite state', async () => {
    getScopedOpportunityForVnextApplication.mockResolvedValue(scopedFixture(VNEXT_STATES.DEDUPED))
    const { db } = makeDb()

    const result = await attemptTransition(db, 'app-1', VNEXT_STATES.DEDUPED)

    expect(result).toMatchObject({
      ok: true,
      newState: VNEXT_STATES.DEDUPED,
      idempotent: true,
    })
    expect(db.prepare).not.toHaveBeenCalled()
  })
})
