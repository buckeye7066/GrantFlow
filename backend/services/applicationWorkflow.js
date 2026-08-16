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
import {
  PIPELINE_STAGES,
  PIPELINE_STAGE_ALL,
  isAcceptedStage,
} from '../../shared/pipelineStages.js'

// Canonical lifecycle for a grant application. RC-13: one canonical enum
// shared with the pipeline UI, the API status validator, and the DB CHECK
// constraint. We accept legacy values too (PIPELINE_STAGE_ALL = canonical ∪
// legacy aliases) so historical data isn't rejected by the workflow API.
//
// Pre-RC-13 this list had 9 ad-hoc values (`in_progress`, `denied`,
// `withdrawn`) that didn't match either the UI columns or the grants.status
// CHECK. Those legacy strings are now mapped via PIPELINE_STAGE_ALIASES.
const APPLICATION_STATES = Object.freeze([...PIPELINE_STAGE_ALL])

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

/**
 * Persist an action plan as a new application + steps + deadline rows.
 * Idempotent on (profile_id, opportunity_id) — calling twice for the same
 * pair is safe and returns the existing application id.
 */
export async function createApplicationFromOpportunity(db, {
  profileId,
  userId,
  opportunity,
  profileContext = {},
} = {}) {
  if (!db || typeof db.prepare !== 'function') throw new Error('db is required')
  if (!profileId) throw new Error('profileId is required')
  if (!opportunity) throw new Error('opportunity is required')

  // Idempotency check
  try {
    const existing = await db
      .prepare(
        'SELECT id FROM grant_applications WHERE profile_id = ? AND opportunity_id = ? LIMIT 1',
      )
      .get(profileId, String(opportunity.id ?? ''))
    if (existing?.id) {
      return { id: existing.id, created: false, plan: generateActionPlan(opportunity, profileContext) }
    }
  } catch { /* table may not exist in test/in-memory DBs — fall through */ }

  const plan = generateActionPlan(opportunity, profileContext)
  const id = randomUUID()
  const grantName = String(opportunity.title ?? 'Untitled opportunity').slice(0, 240)
  const funderName = opportunity.sponsor ?? null
  const deadline = opportunity.deadline ?? null
  const userIdSafe = userId ?? 'system'

  await db
    .prepare(
      `INSERT INTO grant_applications
        (id, profile_id, opportunity_id, user_id, status, grant_name, funder_name, deadline_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, profileId, String(opportunity.id ?? ''), userIdSafe, 'discovered', grantName, funderName, deadline)

  for (const step of plan.next_steps) {
    await db
      .prepare(
        `INSERT INTO application_steps (id, application_id, step_order, title, status)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), id, step.step_order, step.title, step.status)
  }

  for (const ev of plan.deadlines) {
    await db
      .prepare(
        `INSERT INTO deadline_events (id, application_id, event_type, due_at, notes)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), id, ev.event_type, ev.due_at, ev.notes ?? null)
  }

  return { id, created: true, plan }
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
  // Accept canonical OR legacy-alias names. The DB CHECK accepts both, so
  // rejecting them at the service boundary would create a fake mismatch.
  if (!isAcceptedStage(status)) {
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
  addApplicationStep,
  completeApplicationStep,
  addApplicationDocument,
  recordSubmissionEvent,
  setApplicationStatus,
}
