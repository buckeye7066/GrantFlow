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

  const current = asState(app.state || app.stage)
  const currentIdx = VNEXT_STATE_ORDER.indexOf(current)
  const targetIdx = VNEXT_STATE_ORDER.indexOf(target)
  const blockers = []
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
  // state at a time. Same-state requests are idempotent reads.
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
    await writeAuditEvent(db, {
      actor,
      entity_type: 'vnext_application',
      entity_id: String(applicationId),
      action: 'transition.blocked',
      before: { state: current, target },
      after: { blockers },
    })
    return blockersToResult(blockers)
  }

  if (targetIdx === currentIdx) {
    return { ok: true, newState: current, application: app, idempotent: true }
  }

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
    const res = await computeMissingRequirements(db, { applicationId: String(applicationId), actor })
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
    await writeAuditEvent(db, {
      actor,
      entity_type: 'vnext_application',
      entity_id: String(applicationId),
      action: 'transition.blocked',
      before: { state: current, target },
      after: { blockers },
    })
    return blockersToResult(blockers)
  }

  let boundary_type = app.boundary_type || null
  let boundary_url = app.boundary_url || null
  if (target === VNEXT_STATES.BOUNDARY_REACHED) {
    const boundary = boundaryFromOpportunity(opportunity)
    boundary_type = boundary.type
    boundary_url = boundary.url
  }

  const before = {
    state: current,
    stage: app.stage || null,
    boundary_type: app.boundary_type || null,
    boundary_url: app.boundary_url || null,
  }
  const after = { state: target, stage: target, boundary_type, boundary_url }

  // Claim the transition BEFORE applying target-state side effects. This is a
  // compare-and-swap on the logical current state. If another worker wins the
  // race, throwing here rolls this transaction back, including schema or
  // missingness writes performed during guard evaluation.
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
          AND COALESCE(state, stage, 'DISCOVERED') = ?
      `,
    )
    .run(String(target), String(target), boundary_type, boundary_url, String(applicationId), String(current))

  if (changedCount(claim) !== 1) {
    throw new ConcurrentTransitionError(applicationId, current, target)
  }

  if (targetIdx >= VNEXT_STATE_ORDER.indexOf(VNEXT_STATES.QUALIFIED)) {
    await scoreApplication(db, { applicationId: String(applicationId), actor })
  }

  if (target === VNEXT_STATES.DRAFTING) {
    await ensureDraftingTasks(db, String(applicationId))
  }

  await writeAuditEvent(db, {
    actor,
    entity_type: 'vnext_application',
    entity_id: String(applicationId),
    action: 'transition.applied',
    before,
    after,
  })

  return { ok: true, newState: target, application: { ...app, ...after } }
}

export async function attemptTransition(db, applicationId, targetStateRaw, actor = null) {
  const target = normalizeVNextState(targetStateRaw)
  if (!target) {
    return { ok: false, blockers: [{ code: 'INVALID_TARGET_STATE', message: 'Invalid targetState' }] }
  }

  const run = async (handle) => transitionInTransaction(handle, applicationId, target, actor)

  try {
    if (typeof db?.withTransaction === 'function') {
      return await db.withTransaction(run)
    }
    return await run(db)
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
    throw error
  }
}
