import { VNEXT_STATES, VNEXT_STATE_ORDER, normalizeVNextState, VNEXT_BOUNDARY_TYPE, VNEXT_TASK_TYPES } from './constants.js'
import { jsonForDb, sqlNowLiteral } from './vnextUtils.js'
import { computeMissingRequirements } from './missingnessService.js'
import { scoreApplication } from './scoringService.js'
import { getFormSchema, ensureInferredSchemaForOpportunity } from './schemaService.js'
import { writeAuditEvent } from './auditEventsService.js'
import crypto from 'crypto'
import { insertIgnore } from './vnextUtils.js'
import { getScopedOpportunityForVnextApplication } from '../utils/scopedOpportunity.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('vnext.stateMachine')
const TRANSITION_AUDITS = Symbol('transitionAudits')

function resultWithAudits(result, audits) {
  const normalized = (Array.isArray(audits) ? audits : [audits]).filter(Boolean)
  if (normalized.length > 0) {
    Object.defineProperty(result, TRANSITION_AUDITS, { value: normalized })
  }
  return result
}

async function writeTransitionAudits(db, result) {
  const audits = result?.[TRANSITION_AUDITS] || []
  for (const audit of audits) {
    try {
      await writeAuditEvent(db, audit)
    } catch (error) {
      // Auditing is deliberately best effort and runs only after the state
      // transaction has committed, so it can neither poison nor undo the claim.
      log.warn('transition.audit_failed', {
        applicationId: audit.entity_id,
        action: audit.action,
        error: error?.message || String(error),
      })
    }
  }
}

class ConcurrentTransitionError extends Error {
  constructor(applicationId, expectedState, targetState) {
    super(`Application ${applicationId} changed while transitioning from ${expectedState} to ${targetState}`)
    this.name = 'ConcurrentTransitionError'
    this.code = 'CONCURRENT_TRANSITION'
    this.applicationId = String(applicationId)
    this.expectedState = expectedState
    this.targetState = targetState
  }
}

class TransitionInvariantError extends Error {
  constructor(applicationId, currentState, targetState, blocker) {
    super(blocker?.message || `Transition invariant failed for ${applicationId}`)
    this.name = 'TransitionInvariantError'
    this.code = 'TRANSITION_INVARIANT_FAILED'
    this.applicationId = String(applicationId)
    this.currentState = currentState
    this.targetState = targetState
    this.blocker = blocker
  }
}

function asState(stageOrState) {
  return normalizeVNextState(stageOrState) || VNEXT_STATES.DISCOVERED
}

function boundaryFromOpportunity(opp) {
  const mode = String(opp?.application_mode || 'unknown').toLowerCase()
  const url = String(opp?.apply_url || opp?.application_url || '').trim() || null

  if (mode === 'portal' || (url && /http/i.test(url))) {
    return { type: VNEXT_BOUNDARY_TYPE.PORTAL, url }
  }
  if (mode === 'paper') return { type: VNEXT_BOUNDARY_TYPE.PAPER, url }
  if (mode === 'unknown') {
    return { type: url ? VNEXT_BOUNDARY_TYPE.PORTAL : VNEXT_BOUNDARY_TYPE.PRINT, url }
  }
  return { type: VNEXT_BOUNDARY_TYPE.NONE, url }
}

function blockersToResult(blockers) {
  return { ok: false, blockers }
}

function changedCount(result) {
  return Number(result?.changes ?? result?.rowCount ?? 0) || 0
}

function nullSafeEquals(db, column) {
  return db?.dialect === 'postgres'
    ? `${column} IS NOT DISTINCT FROM ?`
    : `${column} IS ?`
}

async function ensureDraftingTasks(db, applicationId) {
  const tasks = [
    { key: 'draft:narrative', type: VNEXT_TASK_TYPES.WRITE_NARRATIVE, title: 'Write narrative draft' },
    { key: 'draft:budget', type: VNEXT_TASK_TYPES.BUDGET, title: 'Draft budget' },
    { key: 'draft:review', type: VNEXT_TASK_TYPES.REVIEW, title: 'Internal review pass' },
  ]

  for (const t of tasks) {
    await insertIgnore(db, {
      table: 'vnext_application_tasks',
      columns: ['id', 'application_id', 'task_key', 'type', 'title', 'status', 'payload', 'created_at', 'updated_at'],
      values: [
        crypto.randomUUID(),
        String(applicationId),
        String(t.key),
        String(t.type),
        String(t.title),
        'todo',
        jsonForDb(db, {}),
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    })
  }
}

async function transitionInTransaction(db, applicationId, target, actor) {
  // Resolve the opportunity through the application row so an arbitrary
  // opportunity id can never be injected into this state machine.
  const scoped = await getScopedOpportunityForVnextApplication(db, applicationId)
  const app = scoped.application
  if (!app) {
    log.warn('transition.application_missing', { applicationId })
    return { ok: false, blockers: [{ code: 'NOT_FOUND', message: 'Application not found' }] }
  }
  const opportunity = scoped.opportunity
  if (!opportunity) {
    log.warn('transition.opportunity_not_scoped', {
      applicationId,
      reason: scoped.reason,
    })
    return {
      ok: false,
      blockers: [
        {
          code: scoped.reason === 'OPPORTUNITY_NOT_LINKED' ? 'OPPORTUNITY_NOT_LINKED' : 'OPPORTUNITY_NOT_FOUND',
          message: 'Opportunity not found or not linked to application',
        },
      ],
    }
  }

  const rawState = app.state ?? null
  const rawStage = app.stage ?? null
  const current = asState(rawState || rawStage)
  const currentIdx = VNEXT_STATE_ORDER.indexOf(current)
  const targetIdx = VNEXT_STATE_ORDER.indexOf(target)
  const blockers = []
  const deferredAuditEvents = []
  let missingComputed = null

  if (targetIdx < currentIdx) {
    blockers.push({
      code: 'BACKWARDS_TRANSITION_FORBIDDEN',
      message: `Cannot transition backwards from ${current} to ${target}`,
      severity: 'error',
    })
  }

  // Every state owns side effects and/or proof. Skipping a state would allow a
  // later label to claim work that never happened (for example REVIEW_READY
  // without the DRAFTING tasks). Forward progress is therefore exactly one
  // state at a time. Same-state requests reassert the state's invariants and
  // idempotent side effects without rewriting the lifecycle columns.
  if (targetIdx > currentIdx + 1) {
    const requiredNextState = VNEXT_STATE_ORDER[currentIdx + 1] || null
    blockers.push({
      code: 'FORWARD_TRANSITION_SKIP_FORBIDDEN',
      message: `Cannot skip from ${current} to ${target}; transition to ${requiredNextState} first`,
      severity: 'error',
      details: { current_state: current, requested_state: target, required_next_state: requiredNextState },
    })
  }

  if (blockers.length > 0) {
    return resultWithAudits(blockersToResult(blockers), {
      actor,
      entity_type: 'vnext_application',
      entity_id: String(applicationId),
      action: 'transition.blocked',
      before: { state: current, target },
      after: { blockers },
    })
  }

  const idempotent = targetIdx === currentIdx

  // --- Guard evaluation ---
  if (targetIdx >= VNEXT_STATE_ORDER.indexOf(VNEXT_STATES.SCHEMA_READY)) {
    const schemaId = opportunity.schema_id ? String(opportunity.schema_id) : null
    if (!schemaId) {
      if (target === VNEXT_STATES.SCHEMA_READY) {
        await ensureInferredSchemaForOpportunity(db, opportunity, {
          nameHint: `Auto: ${opportunity.title || 'Opportunity'}`,
        })
      } else {
        blockers.push({
          code: 'SCHEMA_MISSING',
          message: 'Cannot proceed: schema is missing for this opportunity (transition to SCHEMA_READY first)',
          severity: 'error',
        })
      }
    }

    const rescoped = await getScopedOpportunityForVnextApplication(db, applicationId)
    const schemaIdAfter = rescoped.opportunity?.schema_id ?? opportunity.schema_id ?? null
    const schema = await getFormSchema(db, schemaIdAfter ? String(schemaIdAfter) : null)
    if (!schema) {
      blockers.push({
        code: 'SCHEMA_MISSING',
        message: 'Cannot proceed: schema is missing for this opportunity',
        severity: 'error',
      })
    }
  }

  if (targetIdx >= VNEXT_STATE_ORDER.indexOf(VNEXT_STATES.MAPPED)) {
    const res = await computeMissingRequirements(db, {
      applicationId: String(applicationId),
      actor,
      deferAudit: true,
      enrichWebsitePurpose: false,
    })
    if (Array.isArray(res?.deferredAuditEvents)) {
      deferredAuditEvents.push(...res.deferredAuditEvents)
    }
    missingComputed = res?.ok ? res : null
    if (!res?.ok) {
      blockers.push({
        code: 'MISSINGNESS_FAILED',
        message: res?.error?.message || 'Failed to compute missing requirements',
        severity: 'error',
      })
    }
  }

  if (targetIdx >= VNEXT_STATE_ORDER.indexOf(VNEXT_STATES.MISSING_RESOLVED)) {
    const missing = missingComputed?.missing || null
    const missingFields = Array.isArray(missing?.missing_fields) ? missing.missing_fields.length : 0
    const missingDocs = Array.isArray(missing?.missing_docs) ? missing.missing_docs.length : 0
    if (missingFields > 0 || missingDocs > 0) {
      blockers.push({
        code: 'MISSING_REQUIREMENTS',
        message: `Cannot proceed: ${missingFields} required fields and ${missingDocs} required docs missing`,
        severity: 'warning',
        details: { missing_fields: missingFields, missing_docs: missingDocs },
      })
    }
  }

  if (blockers.length > 0) {
    return resultWithAudits(blockersToResult(blockers), [...deferredAuditEvents, {
      actor,
      entity_type: 'vnext_application',
      entity_id: String(applicationId),
      action: 'transition.blocked',
      before: { state: current, target },
      after: { blockers },
    }])
  }

  let boundary_type = app.boundary_type || null
  let boundary_url = app.boundary_url || null
  if (target === VNEXT_STATES.BOUNDARY_REACHED) {
    const boundary = boundaryFromOpportunity(opportunity)
    boundary_type = boundary.type
    boundary_url = boundary.url
  }

  let before = null
  let after = null
  if (!idempotent) {
    before = {
      state: current,
      stage: app.stage || null,
      boundary_type: app.boundary_type || null,
      boundary_url: app.boundary_url || null,
    }
    after = { state: target, stage: target, boundary_type, boundary_url }

    // Claim the transition BEFORE applying target-state side effects. Compare the
    // exact state/stage snapshot we read, not the normalized logical state. That
    // preserves legacy lowercase rows while still detecting any concurrent write
    // to either lifecycle column. If another worker wins the race, throwing here
    // rolls this transaction back, including guard-side effects.
    const nowExpr = sqlNowLiteral(db)
    const claim = await db
      .prepare(
        `
          UPDATE vnext_applications
          SET state = ?,
              stage = ?,
              boundary_type = COALESCE(?, boundary_type),
              boundary_url = COALESCE(?, boundary_url),
              updated_at = ${nowExpr}
          WHERE id = ?
            AND ${nullSafeEquals(db, 'state')}
            AND ${nullSafeEquals(db, 'stage')}
        `,
      )
      .run(
        String(target),
        String(target),
        boundary_type,
        boundary_url,
        String(applicationId),
        rawState,
        rawStage,
      )

    if (changedCount(claim) !== 1) {
      throw new ConcurrentTransitionError(applicationId, current, target)
    }
  }

  if (targetIdx >= VNEXT_STATE_ORDER.indexOf(VNEXT_STATES.QUALIFIED)) {
    const score = await scoreApplication(db, {
      applicationId: String(applicationId),
      actor,
      deferAudit: true,
      enrichWebsitePurpose: false,
    })
    if (Array.isArray(score?.deferredAuditEvents)) {
      deferredAuditEvents.push(...score.deferredAuditEvents)
    }
    if (!score?.ok) {
      throw new TransitionInvariantError(applicationId, current, target, {
        code: 'SCORING_FAILED',
        message: score?.error?.message || 'Failed to compute the application score',
        severity: 'error',
        details: {
          underlying_code: score?.error?.code || null,
        },
      })
    }
  }

  if (target === VNEXT_STATES.DRAFTING) {
    await ensureDraftingTasks(db, String(applicationId))
  }

  if (idempotent) {
    const currentBoundaryType = app.boundary_type || null
    const currentBoundaryUrl = app.boundary_url || null
    const boundaryNeedsRepair =
      target === VNEXT_STATES.BOUNDARY_REACHED &&
      (boundary_type !== currentBoundaryType || boundary_url !== currentBoundaryUrl)

    if (boundaryNeedsRepair) {
      const nowExpr = sqlNowLiteral(db)
      const repair = await db
        .prepare(
          `
            UPDATE vnext_applications
            SET boundary_type = ?,
                boundary_url = ?,
                updated_at = ${nowExpr}
            WHERE id = ?
              AND ${nullSafeEquals(db, 'state')}
              AND ${nullSafeEquals(db, 'stage')}
              AND ${nullSafeEquals(db, 'boundary_type')}
              AND ${nullSafeEquals(db, 'boundary_url')}
          `,
        )
        .run(
          boundary_type,
          boundary_url,
          String(applicationId),
          rawState,
          rawStage,
          app.boundary_type ?? null,
          app.boundary_url ?? null,
        )

      if (changedCount(repair) !== 1) {
        throw new ConcurrentTransitionError(applicationId, current, target)
      }
    } else {
      // Bind same-state invariant/task side effects to the exact lifecycle
      // snapshot that authorized them. A concurrent transition makes this
      // no-op CAS match zero rows and rolls the transaction back.
      const claim = await db
        .prepare(
          `
            UPDATE vnext_applications
            SET updated_at = updated_at
            WHERE id = ?
              AND ${nullSafeEquals(db, 'state')}
              AND ${nullSafeEquals(db, 'stage')}
          `,
        )
        .run(String(applicationId), rawState, rawStage)

      if (changedCount(claim) !== 1) {
        throw new ConcurrentTransitionError(applicationId, current, target)
      }
    }

    return resultWithAudits(
      {
        ok: true,
        newState: current,
        application: boundaryNeedsRepair
          ? { ...app, boundary_type, boundary_url }
          : app,
        idempotent: true,
      },
      deferredAuditEvents,
    )
  }

  return resultWithAudits(
    { ok: true, newState: target, application: { ...app, ...after } },
    [...deferredAuditEvents, {
      actor,
      entity_type: 'vnext_application',
      entity_id: String(applicationId),
      action: 'transition.applied',
      before,
      after,
    }],
  )
}

export async function attemptTransition(db, applicationId, targetStateRaw, actor = null) {
  const target = normalizeVNextState(targetStateRaw)
  if (!target) {
    return { ok: false, blockers: [{ code: 'INVALID_TARGET_STATE', message: 'Invalid targetState' }] }
  }

  const run = async (handle) => transitionInTransaction(handle, applicationId, target, actor)

  try {
    if (typeof db?.withTransaction === 'function') {
      const result = await db.withTransaction(run)
      await writeTransitionAudits(db, result)
      return result
    }
    const result = await run(db)
    await writeTransitionAudits(db, result)
    return result
  } catch (error) {
    if (error instanceof ConcurrentTransitionError || error?.code === 'CONCURRENT_TRANSITION') {
      log.warn('transition.concurrent_change', {
        applicationId,
        expectedState: error.expectedState,
        targetState: error.targetState,
      })
      return {
        ok: false,
        blockers: [{
          code: 'CONCURRENT_TRANSITION',
          message: 'Application state changed during this transition. Reload and retry from the current state.',
          severity: 'error',
        }],
      }
    }
    if (error instanceof TransitionInvariantError || error?.code === 'TRANSITION_INVARIANT_FAILED') {
      const blockers = [error.blocker || {
        code: 'TRANSITION_INVARIANT_FAILED',
        message: 'A required transition invariant could not be established.',
        severity: 'error',
      }]
      const result = resultWithAudits(blockersToResult(blockers), {
        actor,
        entity_type: 'vnext_application',
        entity_id: String(applicationId),
        action: 'transition.blocked',
        before: { state: error.currentState ?? null, target },
        after: { blockers },
      })
      await writeTransitionAudits(db, result)
      return result
    }
    throw error
  }
}
