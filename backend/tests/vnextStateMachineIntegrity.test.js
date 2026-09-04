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
import { computeMissingRequirements } from '../vnext/missingnessService.js'
import { scoreApplication } from '../vnext/scoringService.js'
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

function makeDb({ changes = 1, dialect = 'sqlite' } = {}) {
  const run = vi.fn(async () => ({ changes }))
  const db = {
    dialect,
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
  computeMissingRequirements.mockResolvedValue({
    ok: true,
    missing: { missing_fields: [], missing_docs: [] },
  })
  scoreApplication.mockResolvedValue({ ok: true })
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
    expect(sql).toContain('state IS ?')
    expect(sql).toContain('stage IS ?')
    expect(sql).not.toContain('? IS NULL')
    expect(run).toHaveBeenCalledWith(
      VNEXT_STATES.DEDUPED,
      VNEXT_STATES.DEDUPED,
      null,
      null,
      'app-1',
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
    )
  })

  it('uses typed null-safe predicates for PostgreSQL compare-and-swap claims', async () => {
    const { db, run } = makeDb({ dialect: 'postgres' })

    const result = await attemptTransition(db, 'app-1', VNEXT_STATES.DEDUPED)

    expect(result).toMatchObject({ ok: true, newState: VNEXT_STATES.DEDUPED })
    const sql = db.prepare.mock.calls[0][0]
    expect(sql).toContain('state IS NOT DISTINCT FROM ?')
    expect(sql).toContain('stage IS NOT DISTINCT FROM ?')
    expect(sql).not.toContain('? IS NULL')
    expect(run).toHaveBeenCalledWith(
      VNEXT_STATES.DEDUPED,
      VNEXT_STATES.DEDUPED,
      null,
      null,
      'app-1',
      VNEXT_STATES.DISCOVERED,
      VNEXT_STATES.DISCOVERED,
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

  it('revalidates same-state proof and blocks when resolved requirements become missing again', async () => {
    getScopedOpportunityForVnextApplication.mockResolvedValue(
      scopedFixture(VNEXT_STATES.MISSING_RESOLVED),
    )
    computeMissingRequirements.mockResolvedValueOnce({
      ok: true,
      missing: {
        missing_fields: [{ key: 'profile.email' }],
        missing_docs: [],
      },
      deferredAuditEvents: [{ action: 'missingness.recomputed' }],
    })
    const { db } = makeDb()

    const result = await attemptTransition(
      db,
      'app-1',
      VNEXT_STATES.MISSING_RESOLVED,
    )

    expect(result.ok).toBe(false)
    expect(result.blockers).toEqual([
      expect.objectContaining({ code: 'MISSING_REQUIREMENTS' }),
    ])
    expect(computeMissingRequirements).toHaveBeenCalledWith(db, expect.objectContaining({
      applicationId: 'app-1',
      deferAudit: true,
    }))
    expect(scoreApplication).not.toHaveBeenCalled()
    expect(db.prepare).not.toHaveBeenCalled()
  })

  it('reasserts same-state drafting tasks without rewriting lifecycle state', async () => {
    getScopedOpportunityForVnextApplication.mockResolvedValue(scopedFixture(VNEXT_STATES.DRAFTING))
    const { db } = makeDb()

    const result = await attemptTransition(db, 'app-1', VNEXT_STATES.DRAFTING)

    expect(result).toMatchObject({
      ok: true,
      newState: VNEXT_STATES.DRAFTING,
      idempotent: true,
    })
    const preparedSql = db.prepare.mock.calls.map(([sql]) => sql)
    expect(preparedSql.filter((sql) => sql.includes('vnext_application_tasks'))).toHaveLength(3)
    expect(preparedSql.some((sql) => sql.includes('UPDATE vnext_applications'))).toBe(false)
  })

  it('repairs boundary metadata on a same-state retry without rewriting lifecycle state', async () => {
    const fixture = scopedFixture(VNEXT_STATES.BOUNDARY_REACHED)
    fixture.application.boundary_type = 'none'
    fixture.application.boundary_url = 'https://old.example/apply'
    fixture.opportunity.application_mode = 'portal'
    fixture.opportunity.apply_url = 'https://current.example/apply'
    getScopedOpportunityForVnextApplication.mockResolvedValue(fixture)
    const { db, run } = makeDb({ dialect: 'postgres' })

    const result = await attemptTransition(
      db,
      'app-1',
      VNEXT_STATES.BOUNDARY_REACHED,
    )

    expect(result).toMatchObject({
      ok: true,
      newState: VNEXT_STATES.BOUNDARY_REACHED,
      idempotent: true,
      application: {
        state: VNEXT_STATES.BOUNDARY_REACHED,
        boundary_type: 'portal',
        boundary_url: 'https://current.example/apply',
      },
    })
    const sql = db.prepare.mock.calls[0][0]
    expect(sql).toContain('SET boundary_type = ?')
    expect(sql).not.toContain('SET state = ?')
    expect(sql.match(/IS NOT DISTINCT FROM \?/g)).toHaveLength(4)
    expect(sql).not.toContain('? IS NULL')
    expect(run).toHaveBeenCalledWith(
      'portal',
      'https://current.example/apply',
      'app-1',
      VNEXT_STATES.BOUNDARY_REACHED,
      VNEXT_STATES.BOUNDARY_REACHED,
      'none',
      'https://old.example/apply',
    )
  })

  it('commits an applied transition before attempting best-effort audit logging', async () => {
    const events = []
    const { db } = makeDb()
    db.withTransaction = vi.fn(async (fn) => {
      const result = await fn(db)
      events.push('committed')
      return result
    })
    writeAuditEvent.mockImplementationOnce(async () => {
      events.push('audited')
      throw new Error('audit table unavailable')
    })

    const result = await attemptTransition(db, 'app-1', VNEXT_STATES.DEDUPED)

    expect(result).toMatchObject({ ok: true, newState: VNEXT_STATES.DEDUPED })
    expect(events).toEqual(['committed', 'audited'])
    expect(writeAuditEvent).toHaveBeenCalledWith(db, expect.objectContaining({ action: 'transition.applied' }))
  })

  it('defers missingness and scoring audits until the state transaction commits', async () => {
    getScopedOpportunityForVnextApplication.mockResolvedValue(
      scopedFixture(VNEXT_STATES.SCHEMA_READY),
    )
    computeMissingRequirements.mockResolvedValueOnce({
      ok: true,
      missing: { missing_fields: [], missing_docs: [] },
      deferredAuditEvents: [{ action: 'missingness.recomputed', entity_id: 'app-1' }],
    })
    scoreApplication.mockResolvedValueOnce({
      ok: true,
      deferredAuditEvents: [{ action: 'scoring.recomputed', entity_id: 'app-1' }],
    })
    const events = []
    const { db } = makeDb()
    db.withTransaction = vi.fn(async (fn) => {
      const result = await fn(db)
      events.push('committed')
      return result
    })
    writeAuditEvent.mockImplementation(async (_db, event) => {
      events.push(`audited:${event.action}`)
    })

    const result = await attemptTransition(db, 'app-1', VNEXT_STATES.MAPPED)

    expect(result).toMatchObject({ ok: true, newState: VNEXT_STATES.MAPPED })
    expect(events).toEqual([
      'committed',
      'audited:missingness.recomputed',
      'audited:scoring.recomputed',
      'audited:transition.applied',
    ])
    expect(computeMissingRequirements).toHaveBeenCalledWith(db, expect.objectContaining({
      deferAudit: true,
      enrichWebsitePurpose: false,
    }))
    expect(scoreApplication).toHaveBeenCalledWith(db, expect.objectContaining({
      deferAudit: true,
      enrichWebsitePurpose: false,
    }))
  })

  it('rolls back and blocks when scoring cannot establish its invariant', async () => {
    getScopedOpportunityForVnextApplication.mockResolvedValue(
      scopedFixture(VNEXT_STATES.DEDUPED),
    )
    scoreApplication.mockResolvedValueOnce({
      ok: false,
      error: { code: 'OPPORTUNITY_NOT_FOUND', message: 'Opportunity disappeared' },
    })
    const transactionEvents = []
    const { db } = makeDb()
    db.withTransaction = vi.fn(async (fn) => {
      try {
        const result = await fn(db)
        transactionEvents.push('committed')
        return result
      } catch (error) {
        transactionEvents.push('rolled_back')
        throw error
      }
    })

    const result = await attemptTransition(db, 'app-1', VNEXT_STATES.QUALIFIED)

    expect(result.ok).toBe(false)
    expect(result.blockers).toEqual([
      expect.objectContaining({
        code: 'SCORING_FAILED',
        details: { underlying_code: 'OPPORTUNITY_NOT_FOUND' },
      }),
    ])
    expect(transactionEvents).toEqual(['rolled_back'])
    expect(writeAuditEvent).toHaveBeenCalledWith(db, expect.objectContaining({
      action: 'transition.blocked',
    }))
  })
})
