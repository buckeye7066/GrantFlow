/**
 * applicationWorkflow.js
 *
 * Phase 7 mission rule: every saved opportunity generates an action plan
 * (next_steps + documents_needed) and a discovered opportunity can become
 * a saved item, application plan, document checklist, deadline tracker,
 * Anya-guided workflow.
 *
 * This module is the single canonical entry point for that workflow:
 *   - generateActionPlan(opportunity, profileContext)  pure planner
 *   - createApplicationFromOpportunity(db, ...)        persists the plan
 *   - addStep / completeStep / addDocument             step+document ops
 *   - recordDeadlineEvent / recordSubmissionEvent      audit-trail ops
 *
 * The pure planner is unit-tested by tests/mission/mission-application-workflow.test.mjs.
 * The DB-touching helpers are kept tiny and idempotent so any route or
 * Anya tool can call them without re-implementing the SQL.
 */

import { randomUUID } from 'crypto'
import { OPPORTUNITY_KINDS } from './opportunityRealityGate.js'
import { PIPELINE_STAGES } from '../../shared/pipelineStages.js'
import { linkApplicationLifecycle } from './applicationLifecycleReadModel.js'
import { loadLatestRequirementsForApplication } from './groundedDrafting.js'

// `grant_applications` is an application record, not the `grants` pipeline.
// Its DB/UI contract deliberately includes application-specific states such as
// in_progress, under_review, denied, and withdrawn. Reusing the grants pipeline
// enum here made valid UI actions fail while also advertising values rejected
// by the grant_applications CHECK constraint.
const APPLICATION_STATES = Object.freeze([
  'draft',
  'in_progress',
  'submitted',
  'under_review',
  'awarded',
  'denied',
  'withdrawn',
  'closed',
])
const APPLICATION_STATE_SET = new Set(APPLICATION_STATES)

const DEFAULT_DOCUMENTS_BY_TYPE = Object.freeze({
  nonprofit: ['IRS 501(c)(3) determination letter', 'Most recent Form 990', 'Annual budget', 'Board roster'],
  church: ['Statement of faith / mission', 'Board roster', 'Recent budget', 'Letter of incorporation'],
  ministry: ['Statement of mission', 'Board roster', 'Recent budget'],
  school: ['School profile / fact sheet', 'Most recent annual report', 'Board roster', 'Leader resume/CV'],
  business: ['EIN documentation', 'Recent tax returns (2 years)', 'Business plan summary', 'Bank statements (3 mo)'],
  minority_owned_business: ['Minority-owned certification', 'EIN documentation', 'Recent tax returns'],
  women_owned_business: ['WOSB / WBE certification', 'EIN documentation', 'Recent tax returns'],
  volunteer_fire: ['Department roster', 'Equipment inventory', 'Most recent budget', 'Run report summary'],
  volunteer_fire_department: ['Department roster', 'Equipment inventory', 'Most recent budget', 'Run report summary'],
  student: ['FAFSA confirmation', 'Most recent transcript', 'Acceptance letter', 'Letter(s) of recommendation'],
  individual: ['Government-issued photo ID', 'Proof of address', 'Recent income documentation'],
  family: ['Government-issued photo ID', 'Proof of address', 'Household income documentation'],
})

const DEFAULT_STEPS_BY_KIND = Object.freeze({
  direct: [
    { title: 'Confirm eligibility' },
    { title: 'Gather required documents' },
    { title: 'Draft application narrative / LOI' },
    { title: 'Submit application' },
    { title: 'Follow up on submission' },
  ],
  benefit: [
    { title: 'Confirm program eligibility' },
    { title: 'Locate and contact local administering agency' },
    { title: 'Gather required documents' },
    { title: 'Submit application' },
    { title: 'Follow up on enrollment' },
  ],
  directory: [
    { title: 'Search the directory for nearest provider' },
    { title: 'Contact provider to confirm services' },
    { title: 'Gather any documents the provider requires' },
  ],
  referral: [
    { title: 'Reach out using the referral contact info' },
    { title: 'Confirm services and eligibility' },
  ],
  school_portal: [
    { title: 'Sign in to the school portal' },
    { title: 'Locate financial aid section' },
    { title: 'Submit any school-required documents' },
    { title: 'Follow up with financial aid office' },
  ],
})

/**
 * Generate an action plan for one opportunity given a profile.
 *
 * Pure / synchronous / no I/O. Returns an object the caller can either
 * display or persist via createApplicationFromOpportunity().
 */
export function generateActionPlan(opportunity, profileContext = {}) {
  if (!opportunity) {
    return {
      next_steps: [],
      documents_needed: [],
      deadlines: [],
      notes: ['Opportunity is missing — nothing to plan.'],
    }
  }
  const profile = profileContext?.profile ?? profileContext ?? {}

  const kind = String(opportunity.kind || opportunity.opportunity_kind || OPPORTUNITY_KINDS.DIRECT).toLowerCase()
  const baseSteps = DEFAULT_STEPS_BY_KIND[kind] ?? DEFAULT_STEPS_BY_KIND.direct
  const next_steps = baseSteps.map((s, idx) => ({
    step_order: idx,
    title: s.title,
    status: 'pending',
  }))

  const profileType = String(
    profile?.primary_type || profile?.applicant_type || profile?.organization_type || 'individual',
  ).toLowerCase()
  const documents_needed = DEFAULT_DOCUMENTS_BY_TYPE[profileType] ?? DEFAULT_DOCUMENTS_BY_TYPE.individual

  const deadlines = []
  if (opportunity.deadline) {
    deadlines.push({
      event_type: 'application_deadline',
      due_at: opportunity.deadline,
      notes: `Application due ${opportunity.deadline}`,
    })
    // 7-day reminder
    try {
      const due = new Date(opportunity.deadline)
      if (!Number.isNaN(due.valueOf())) {
        const remind = new Date(due.valueOf() - 7 * 24 * 60 * 60 * 1000)
        deadlines.push({
          event_type: 'reminder',
          due_at: remind.toISOString(),
          notes: 'One week reminder before application deadline',
        })
      }
    } catch { /* date parse failed; skip the auto-reminder */ }
  }

  const notes = []
  if (kind === 'directory' || kind === 'referral') {
    notes.push('This is a directory / referral, not a direct grant. The action plan focuses on contacting the provider.')
  }
  if (!opportunity.application_url && !opportunity.source_url) {
    notes.push('No application URL on file — call or contact the funder directly.')
  }

  return {
    opportunity_id: opportunity.id,
    opportunity_kind: kind,
    profile_type: profileType,
    next_steps,
    documents_needed,
    deadlines,
    notes,
  }
}

async function runWorkflowCreationTransaction(db, work) {
  if (typeof db?.withTransaction === 'function') return db.withTransaction(work)

  // Focused migration/tests sometimes pass a raw better-sqlite3 connection
  // rather than the production SqliteDb adapter. Preserve atomicity for that
  // narrow compatibility shape; both production adapters take the
  // withTransaction branch above.
  if (db?.dialect === 'sqlite' && typeof db?.exec === 'function') {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = await work(db)
      db.exec('COMMIT')
      return result
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* preserve the original failure */ }
      throw error
    }
  }

  const error = new Error('Application workflow creation requires an atomic database transaction')
  error.code = 'APPLICATION_WORKFLOW_TRANSACTION_UNAVAILABLE'
  error.status = 503
  throw error
}

async function materializeDefaultPlan(db, applicationId, plan) {
  for (const step of plan.next_steps) {
    const existing = await db.prepare(
      `SELECT id FROM application_steps
        WHERE application_id = ? AND step_order = ? AND title = ? LIMIT 1`,
    ).get(applicationId, step.step_order, step.title)
    if (!existing) {
      await db
        .prepare(
          `INSERT INTO application_steps (id, application_id, step_order, title, status)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(randomUUID(), applicationId, step.step_order, step.title, step.status)
    }
  }

  for (const event of plan.deadlines) {
    const existing = await db.prepare(
      `SELECT id FROM deadline_events
        WHERE application_id = ? AND event_type = ? AND due_at = ? LIMIT 1`,
    ).get(applicationId, event.event_type, event.due_at)
    if (!existing) {
      await db
        .prepare(
          `INSERT INTO deadline_events (id, application_id, event_type, due_at, notes)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(randomUUID(), applicationId, event.event_type, event.due_at, event.notes ?? null)
    }
  }
}

/**
 * Persist an action plan as a new application + steps + deadline rows.
 * Idempotent on (profile_id, opportunity_id) — calling twice for the same
 * pair is safe and returns the existing application id.
 */
export async function createApplicationFromOpportunity(db, {
  profileId,
  userId,
  opportunity,
  pipelineGrantId = null,
  profileContext = {},
} = {}) {
  if (!db || typeof db.prepare !== 'function') throw new Error('db is required')
  if (!profileId) throw new Error('profileId is required')
  if (!opportunity) throw new Error('opportunity is required')

  const opportunityId = String(opportunity.id ?? '').trim()
  if (!opportunityId) {
    const error = new Error('A canonical opportunity id is required')
    error.code = 'OPPORTUNITY_ID_REQUIRED'
    error.status = 400
    throw error
  }

  return runWorkflowCreationTransaction(db, async (tx) => {
    const canonicalOpportunity = await tx.prepare(
      'SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1',
    ).get(opportunityId)
    if (
      !canonicalOpportunity
      || canonicalOpportunity.is_active === false
      || canonicalOpportunity.is_active === 0
      || canonicalOpportunity.is_hidden === true
      || canonicalOpportunity.is_hidden === 1
    ) {
      const error = new Error('Visible catalog opportunity not found')
      error.code = 'OPPORTUNITY_NOT_FOUND'
      error.status = 404
      throw error
    }

    let pipelineGrant = null
    if (pipelineGrantId) {
      pipelineGrant = await tx.prepare(
        'SELECT id, profile_id, funding_opportunity_id FROM grants WHERE id = ? LIMIT 1',
      ).get(String(pipelineGrantId))
      if (!pipelineGrant) {
        const error = new Error('Pipeline grant not found')
        error.code = 'PIPELINE_GRANT_NOT_FOUND'
        error.status = 404
        throw error
      }
      if (!pipelineGrant.profile_id || String(pipelineGrant.profile_id) !== String(profileId)) {
        const error = new Error('Pipeline grant does not belong to this application profile')
        error.code = 'PIPELINE_GRANT_PROFILE_MISMATCH'
        error.status = 403
        throw error
      }
      if (
        pipelineGrant.funding_opportunity_id
        && String(pipelineGrant.funding_opportunity_id) !== opportunityId
      ) {
        const error = new Error('Pipeline grant does not belong to this opportunity')
        error.code = 'PIPELINE_GRANT_OPPORTUNITY_MISMATCH'
        error.status = 409
        throw error
      }
    }

    const plan = generateActionPlan(canonicalOpportunity, profileContext)
    let application = await tx
      .prepare(
        'SELECT id, pipeline_grant_id FROM grant_applications WHERE profile_id = ? AND opportunity_id = ? LIMIT 1',
      )
      .get(profileId, opportunityId)
    let created = false

    if (application?.id) {
      if (
        pipelineGrant
        && application.pipeline_grant_id
        && String(application.pipeline_grant_id) !== String(pipelineGrant.id)
      ) {
        const error = new Error('Application is already linked to a different pipeline grant')
        error.code = 'APPLICATION_PIPELINE_GRANT_CONFLICT'
        error.status = 409
        throw error
      }
      if (pipelineGrant && !application.pipeline_grant_id) {
        await tx.prepare(
          `UPDATE grant_applications
              SET pipeline_grant_id = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND profile_id = ? AND pipeline_grant_id IS NULL`,
        ).run(String(pipelineGrant.id), application.id, profileId)
        application = { ...application, pipeline_grant_id: String(pipelineGrant.id) }
      }
    } else {
      application = { id: randomUUID(), pipeline_grant_id: pipelineGrant ? String(pipelineGrant.id) : null }
      await tx
        .prepare(
          `INSERT INTO grant_applications
            (id, profile_id, opportunity_id, pipeline_grant_id, user_id, status, grant_name, funder_name, deadline_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          application.id,
          profileId,
          opportunityId,
          application.pipeline_grant_id,
          userId ?? 'system',
          'draft',
          String(canonicalOpportunity.title ?? 'Untitled opportunity').slice(0, 240),
          canonicalOpportunity.sponsor ?? null,
          canonicalOpportunity.deadline ?? null,
        )
      created = true
    }

    // Always reconcile the deterministic rows. This repairs applications left
    // incomplete by older non-atomic releases without duplicating successful
    // work, so the idempotent path cannot bless a partial workflow.
    await materializeDefaultPlan(tx, application.id, plan)
    const integration = await wireApplicationLifecycleRequirements(tx, application.id, { strict: true })
    return { id: application.id, created, plan, integration }
  })
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}

function requirementStepTitle(requirement) {
  const label = String(requirement.title || requirement.requirement_text || 'Requirement')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)
  return `${requirement.mandatory === true || requirement.mandatory === 1 ? 'Required' : 'Optional'}: ${label}`
}

/**
 * Wire an application into the lifecycle aggregate and materialize the latest
 * structured requirements as deterministic workflow steps/deadlines. This is
 * idempotent and reports rolling-migration failures instead of hiding them.
 * Creation calls use strict mode inside their outer transaction so any
 * integration failure rolls the complete workflow back.
 */
export async function wireApplicationLifecycleRequirements(db, applicationId, { strict = false } = {}) {
  const result = { linked: false, requirement_steps_created: 0, deadlines_created: 0, warnings: [] }
  try {
    await linkApplicationLifecycle(db, { applicationId })
    result.linked = true
  } catch (error) {
    if (strict) throw error
    result.warnings.push({ code: 'lifecycle_link_failed', message: error?.message || String(error) })
    return result
  }

  try {
    const stored = await loadLatestRequirementsForApplication(db, applicationId)
    for (const requirement of stored.requirements || []) {
      const marker = `[solicitation-requirement:${requirement.id}]`
      const existing = await db.prepare(
        `SELECT id FROM application_steps
          WHERE application_id = ? AND description LIKE ? LIMIT 1`,
      ).get(applicationId, `%${marker}%`)
      if (!existing) {
        await db.prepare(
          `INSERT INTO application_steps
            (id, application_id, step_order, title, description, status, due_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        ).run(
          randomUUID(),
          applicationId,
          1000 + result.requirement_steps_created,
          requirementStepTitle(requirement),
          `${requirement.requirement_text}\n\n${marker}`,
          null,
        )
        result.requirement_steps_created += 1
      }

      if (requirement.requirement_type === 'deadline') {
        const normalized = parseJson(requirement.normalized_value_json, {})
        const dueAt = normalized.due_at || normalized.deadline || null
        if (dueAt) {
          const deadlineExists = await db.prepare(
            `SELECT id FROM deadline_events
              WHERE application_id = ? AND event_type = 'solicitation_deadline'
                AND due_at = ? LIMIT 1`,
          ).get(applicationId, dueAt)
          if (!deadlineExists) {
            await db.prepare(
              `INSERT INTO deadline_events
                (id, application_id, event_type, due_at, notes)
               VALUES (?, ?, 'solicitation_deadline', ?, ?)`,
            ).run(randomUUID(), applicationId, dueAt, `${requirement.requirement_text}\n${marker}`)
            result.deadlines_created += 1
          }
        }
      }
    }
  } catch (error) {
    if (strict) throw error
    result.warnings.push({ code: 'requirement_materialization_failed', message: error?.message || String(error) })
  }
  return result
}

export async function addApplicationStep(db, applicationId, { title, description = null, dueAt = null } = {}) {
  if (!applicationId || !title) throw new Error('applicationId and title required')
  const id = randomUUID()
  const last = await db
    .prepare('SELECT MAX(step_order) AS n FROM application_steps WHERE application_id = ?')
    .get(applicationId)
  const order = (Number(last?.n) || 0) + 1
  await db
    .prepare(
      `INSERT INTO application_steps (id, application_id, step_order, title, description, status, due_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(id, applicationId, order, title, description, dueAt)
  return id
}

export async function completeApplicationStep(db, stepId) {
  if (!stepId) throw new Error('stepId required')
  await db
    .prepare(
      `UPDATE application_steps
         SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .run(stepId)
}

export async function addApplicationDocument(db, applicationId, { filename, documentType = null, storageUrl = null, sizeBytes = null, stepId = null, uploadedBy = null } = {}) {
  if (!applicationId || !filename) throw new Error('applicationId and filename required')
  if (stepId) {
    const step = await db.prepare(
      'SELECT id FROM application_steps WHERE id = ? AND application_id = ? LIMIT 1',
    ).get(String(stepId), String(applicationId))
    if (!step) {
      const error = new Error('Document step does not belong to this application')
      error.code = 'APPLICATION_DOCUMENT_STEP_SCOPE_MISMATCH'
      error.status = 409
      throw error
    }
  }
  const id = randomUUID()
  await db
    .prepare(
      `INSERT INTO application_documents
        (id, application_id, step_id, filename, document_type, storage_url, size_bytes, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, applicationId, stepId, filename, documentType, storageUrl, sizeBytes, uploadedBy)
  return id
}

export async function recordSubmissionEvent(db, applicationId, { eventType, notes = null, outcome = null, recordedBy = null } = {}) {
  if (!applicationId || !eventType) throw new Error('applicationId and eventType required')
  const id = randomUUID()
  await db
    .prepare(
      `INSERT INTO submission_events (id, application_id, event_type, notes, outcome, recorded_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, applicationId, eventType, notes, outcome, recordedBy)
  return id
}

export async function setApplicationStatus(db, applicationId, status) {
  if (!applicationId || !status) throw new Error('applicationId and status required')
  if (!APPLICATION_STATE_SET.has(status)) {
    throw new Error(`Invalid application status: ${status}. Allowed: ${APPLICATION_STATES.join(', ')}`)
  }
  await db
    .prepare('UPDATE grant_applications SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(status, applicationId)

  // Non-blocking: a workflow application reaching 'submitted' or 'awarded' is
  // a conversion moment for the PromoPilot attribution bridge. Fire-and-forget
  // by contract — the service never throws and no-ops without env config or a
  // stored promo touch, so this can never affect the status update.
  if (status === 'submitted' || status === 'awarded') {
    ;(async () => {
      try {
        const row = await db
          .prepare('SELECT profile_id FROM grant_applications WHERE id = ? LIMIT 1')
          .get(String(applicationId))
        if (!row?.profile_id) return
        const { reportGrantConversion } = await import('./promoAttribution.js')
        await reportGrantConversion(db, {
          grantId: applicationId,
          profileId: row.profile_id,
          eventClass: status,
        })
      } catch {
        // Attribution never affects the workflow status update.
      }
    })()
  }
}

export { APPLICATION_STATES, PIPELINE_STAGES }

export default {
  APPLICATION_STATES,
  generateActionPlan,
  createApplicationFromOpportunity,
  wireApplicationLifecycleRequirements,
  addApplicationStep,
  completeApplicationStep,
  addApplicationDocument,
  recordSubmissionEvent,
  setApplicationStatus,
}
