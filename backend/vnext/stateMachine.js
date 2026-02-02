import { VNEXT_STATES, VNEXT_STATE_ORDER, normalizeVNextState, VNEXT_BOUNDARY_TYPE, VNEXT_TASK_TYPES } from './constants.js'
import { safeJsonParse, jsonForDb, sqlNowLiteral } from './vnextUtils.js'
import { computeMissingRequirements } from './missingnessService.js'
import { scoreApplication } from './scoringService.js'
import { getFormSchema, ensureInferredSchemaForOpportunity } from './schemaService.js'
import { writeAuditEvent } from './auditEventsService.js'
import crypto from 'crypto'
import { insertIgnore } from './vnextUtils.js'

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
    // If there's no URL, treat as print packet boundary.
    return { type: url ? VNEXT_BOUNDARY_TYPE.PORTAL : VNEXT_BOUNDARY_TYPE.PRINT, url }
  }
  return { type: VNEXT_BOUNDARY_TYPE.NONE, url }
}

function blockersToResult(blockers) {
  return { ok: false, blockers }
}

async function ensureDraftingTasks(db, applicationId) {
  // Idempotently create baseline drafting tasks.
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

export async function attemptTransition(db, applicationId, targetStateRaw, actor = null) {
  const target = normalizeVNextState(targetStateRaw)
  if (!target) {
    return { ok: false, blockers: [{ code: 'INVALID_TARGET_STATE', message: 'Invalid targetState' }] }
  }

  const app = await db.prepare('SELECT * FROM vnext_applications WHERE id = ?').get(String(applicationId))
  if (!app) return { ok: false, blockers: [{ code: 'NOT_FOUND', message: 'Application not found' }] }

  const opportunity = await db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(String(app.opportunity_id))
  if (!opportunity) return { ok: false, blockers: [{ code: 'OPPORTUNITY_NOT_FOUND', message: 'Opportunity not found' }] }

  const current = asState(app.state || app.stage)
  const currentIdx = VNEXT_STATE_ORDER.indexOf(current)
  const targetIdx = VNEXT_STATE_ORDER.indexOf(target)

  const blockers = []
  let missingComputed = null

  // Determinism rule: do not allow jumping backwards; allow idempotent same-state.
  if (targetIdx < currentIdx) {
    blockers.push({
      code: 'BACKWARDS_TRANSITION_FORBIDDEN',
      message: `Cannot transition backwards from ${current} to ${target}`,
      severity: 'error',
    })
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

  // --- Guard evaluation (minimum required by spec) ---
  // SCHEMA_READY is the ONLY transition allowed to create (infer) a schema.
  // For later states, schema must already exist (forces deterministic progression).
  if (targetIdx >= VNEXT_STATE_ORDER.indexOf(VNEXT_STATES.SCHEMA_READY)) {
    const schemaId = opportunity.schema_id ? String(opportunity.schema_id) : null
    if (!schemaId) {
      if (target === VNEXT_STATES.SCHEMA_READY) {
        // Auto-infer schema (deterministic heuristic) and persist. Reversible by clearing schema_id.
        await ensureInferredSchemaForOpportunity(db, opportunity, { nameHint: `Auto: ${opportunity.title || 'Opportunity'}` })
      } else {
        blockers.push({
          code: 'SCHEMA_MISSING',
          message: 'Cannot proceed: schema is missing for this opportunity (transition to SCHEMA_READY first)',
          severity: 'error',
        })
      }
    }

    const schemaIdAfter = (await db.prepare('SELECT schema_id FROM funding_opportunities WHERE id = ?').get(String(opportunity.id)))?.schema_id
    const schema = await getFormSchema(db, schemaIdAfter ? String(schemaIdAfter) : null)
    if (!schema) {
      blockers.push({
        code: 'SCHEMA_MISSING',
        message: 'Cannot proceed: schema is missing for this opportunity',
        severity: 'error',
      })
    }
  }

  // MAPPED requires schema present (covered above).
  if (target === VNEXT_STATES.MAPPED || targetIdx >= VNEXT_STATE_ORDER.indexOf(VNEXT_STATES.MAPPED)) {
    // Ensure missingness is computed and stored (authoritative)
    const res = await computeMissingRequirements(db, { applicationId: String(applicationId), actor })
    missingComputed = res?.ok ? res : null
    if (!res.ok) {
      blockers.push({
        code: 'MISSINGNESS_FAILED',
        message: res?.error?.message || 'Failed to compute missing requirements',
        severity: 'error',
      })
    }
  }

  // MISSING_RESOLVED requires no missing required items.
  if (target === VNEXT_STATES.MISSING_RESOLVED || targetIdx >= VNEXT_STATE_ORDER.indexOf(VNEXT_STATES.MISSING_RESOLVED)) {
    const missing =
      missingComputed?.missing ||
      (await computeMissingRequirements(db, { applicationId: String(applicationId), actor })).missing ||
      null
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

  // DRAFTING requires missing resolved.
  if (target === VNEXT_STATES.DRAFTING || targetIdx >= VNEXT_STATE_ORDER.indexOf(VNEXT_STATES.DRAFTING)) {
    if (asState(app.state) !== VNEXT_STATES.MISSING_RESOLVED && target !== VNEXT_STATES.MISSING_RESOLVED) {
      // If we are moving forward in a single call, the missing-resolved check above would block anyway.
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

  // Success path: apply transition (and any side-effects) deterministically.
  const nowExpr = sqlNowLiteral(db)

  // Score recompute can happen at QUALIFIED and later (always deterministic).
  if (targetIdx >= VNEXT_STATE_ORDER.indexOf(VNEXT_STATES.QUALIFIED)) {
    await scoreApplication(db, { applicationId: String(applicationId), actor })
  }

  if (target === VNEXT_STATES.DRAFTING) {
    await ensureDraftingTasks(db, String(applicationId))
  }

  let boundary_type = app.boundary_type || null
  let boundary_url = app.boundary_url || null
  if (target === VNEXT_STATES.BOUNDARY_REACHED) {
    const boundary = boundaryFromOpportunity(opportunity)
    boundary_type = boundary.type
    boundary_url = boundary.url
  }

  const before = { state: current, stage: app.stage || null, boundary_type: app.boundary_type || null, boundary_url: app.boundary_url || null }

  await db
    .prepare(
      `
        UPDATE vnext_applications
        SET state = ?,
            stage = ?,
            boundary_type = COALESCE(?, boundary_type),
            boundary_url = COALESCE(?, boundary_url),
            updated_at = ${nowExpr}
        WHERE id = ?
      `,
    )
    .run(String(target), String(target), boundary_type, boundary_url, String(applicationId))

  const after = { state: target, stage: target, boundary_type, boundary_url }

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

