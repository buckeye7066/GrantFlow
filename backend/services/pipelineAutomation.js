import { buildPipelineAutomationPrompt, PIPELINE_ALLOWED_STATUSES } from '../prompts/pipelineAutomation.js'
import { extractCompletionText } from '../utils/openai.js'

const STATUS_ORDER = [
  'discovered',
  'interested',
  'drafting',
  'app_prep',
  'revision',
  'submitted',
  'under_review',
  'awarded',
  'rejected',
  'closed',
  'archived',
]

function normalizeStatus(status) {
  if (!status || typeof status !== 'string') return null
  const normalized = status.trim().toLowerCase()
  return PIPELINE_ALLOWED_STATUSES.includes(normalized) ? normalized : null
}

function compareStatuses(current, next) {
  const currentIndex = STATUS_ORDER.indexOf(current)
  const nextIndex = STATUS_ORDER.indexOf(next)
  if (currentIndex === -1 || nextIndex === -1) return 0
  return nextIndex - currentIndex
}

function capAdvance(current, suggested) {
  const delta = compareStatuses(current, suggested)
  if (delta <= 0) return current
  if (delta === 1) return suggested

  const currentIndex = STATUS_ORDER.indexOf(current)
  if (currentIndex === -1) return suggested
  const cappedIndex = Math.min(currentIndex + 2, STATUS_ORDER.length - 1)
  return STATUS_ORDER[cappedIndex]
}

function fetchGrantContext(db, grantId) {
  const grant = db
    .prepare(
      `
        SELECT *
        FROM grants
        WHERE id = ?
      `,
    )
    .get(grantId)

  if (!grant) {
    throw new Error(`Grant ${grantId} not found`)
  }

  const organization = grant.organization_id
    ? db
        .prepare(
          `
            SELECT *
            FROM organizations
            WHERE id = ?
          `,
        )
        .get(grant.organization_id)
    : null

  const milestones = db
    .prepare(
      `
        SELECT id, title, due_date, completed, completed_date, type
        FROM milestones
        WHERE grant_id = ?
        ORDER BY due_date ASC
      `,
    )
    .all(grantId)

  const documents = db
    .prepare(
      `
        SELECT id, name, type, status, ai_summary, processing_status, created_at
        FROM documents
        WHERE grant_id = ?
        ORDER BY created_at DESC
        LIMIT 12
      `,
    )
    .all(grantId)

  const drafts = db
    .prepare(
      `
        SELECT id, section_name, status, updated_at
        FROM application_drafts
        WHERE grant_id = ?
        ORDER BY section_order ASC
      `,
    )
    .all(grantId)

  const expenses = db
    .prepare(
      `
        SELECT id, amount, description, date
        FROM expenses
        WHERE grant_id = ?
        ORDER BY date DESC
        LIMIT 6
      `,
    )
    .all(grantId)

  return { grant, organization, milestones, documents, drafts, expenses }
}

function buildProfileSummary(profileContext) {
  if (!profileContext?.profile) return null
  const { profile, sections } = profileContext
  const summary = {
    profile: {
      id: profile.id,
      display_name: profile.display_name,
      primary_type: profile.primary_type,
      tags: profile.tags,
    },
    signals: profileContext.signals
      ? {
          demographics: Array.from(profileContext.signals.demographics ?? []),
          interests: Array.from(profileContext.signals.interests ?? []),
          location: profileContext.signals.location ?? null,
          academics: profileContext.signals.academics ?? null,
        }
      : null,
    sections: {},
  }

  const includeKeys = ['basic_information', 'organization_details', 'financial_information']
  includeKeys.forEach((key) => {
    if (sections && sections[key]) {
      summary.sections[key] = sections[key]
    }
  })

  return summary
}

function recordAutomationEvent(db, payload) {
  db.prepare(
    `
      INSERT INTO grant_pipeline_events (
        grant_id,
        job_id,
        previous_status,
        suggested_status,
        applied_status,
        confidence,
        handoff_required,
        handoff_reason,
        recommended_actions,
        ai_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    payload.grantId,
    payload.jobId ?? null,
    payload.previousStatus ?? null,
    payload.suggestedStatus ?? null,
    payload.appliedStatus ?? null,
    payload.confidence ?? null,
    payload.handoffRequired ? 1 : 0,
    payload.handoffReason ?? null,
    payload.recommendedActions ? JSON.stringify(payload.recommendedActions) : null,
    payload.aiSummary ?? null,
  )
}

export async function processPipelineAutomationJob({ db, job, profileContext, getOpenAI }) {
  const parameters = job.parameters ?? {}
  const grantId = parameters.grant_id
  const organizationId = parameters.organization_id

  let grants = []

  if (grantId) {
    const context = fetchGrantContext(db, grantId)
    grants.push(context)
  } else if (organizationId) {
    const rows = db
      .prepare(
        `
          SELECT id
          FROM grants
          WHERE organization_id = ?
            AND status IN ('discovered', 'interested', 'drafting', 'app_prep', 'revision')
        `,
      )
      .all(organizationId)

    grants = rows.map((row) => fetchGrantContext(db, row.id))
  } else {
    const rows = db
      .prepare(
        `
          SELECT id
          FROM grants
          WHERE status IN ('discovered', 'interested', 'drafting', 'app_prep', 'revision')
          ORDER BY deadline IS NULL, deadline ASC
          LIMIT ?
        `,
      )
      .all(parameters.limit ?? 10)

    grants = rows.map((row) => fetchGrantContext(db, row.id))
  }

  if (grants.length === 0) {
    return {
      evaluated: 0,
      advanced: 0,
      handoffs: 0,
    }
  }

  const profileSummary = buildProfileSummary(profileContext)
  const openai = getOpenAI()

  let advanced = 0
  let handoffs = 0
  const grantLogs = []

  for (const context of grants) {
    const { grant, organization, milestones, documents, drafts, expenses } = context
    const prompt = buildPipelineAutomationPrompt({
      grant,
      organization,
      milestones,
      documents,
      drafts,
      expenses,
      profileSummary,
    })

    let aiResponse = null
    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'You are Anya, the GrantFlow pipeline automation assistant.',
          },
          { role: 'user', content: prompt },
        ],
      })

      aiResponse = extractCompletionText(completion) || '{}'
    } catch (error) {
      recordAutomationEvent(db, {
        jobId: job.id,
        grantId: grant.id,
        previousStatus: grant.status,
        suggestedStatus: null,
        appliedStatus: grant.status,
        confidence: null,
        handoffRequired: false,
        handoffReason: null,
        recommendedActions: null,
        aiSummary: `Automation failed: ${error instanceof Error ? error.message : String(error)}`,
      })
      continue
    }

    let parsed = {}
    try {
      parsed = JSON.parse(aiResponse)
    } catch (error) {
      recordAutomationEvent(db, {
        jobId: job.id,
        grantId: grant.id,
        previousStatus: grant.status,
        suggestedStatus: null,
        appliedStatus: grant.status,
        confidence: null,
        handoffRequired: false,
        handoffReason: null,
        recommendedActions: null,
        aiSummary: 'Automation response could not be parsed as JSON.',
      })
      continue
    }

    const suggestedStatus = normalizeStatus(parsed.suggested_status) ?? grant.status
    const cappedStatus = capAdvance(grant.status, suggestedStatus)
    const handoffRequired = Boolean(parsed.handoff_required)
    const handoffReason =
      typeof parsed.handoff_reason === 'string' && parsed.handoff_reason.trim().length > 0
        ? parsed.handoff_reason.trim()
        : null

    let appliedStatus = cappedStatus

    if (handoffRequired && compareStatuses(grant.status, cappedStatus) > 0) {
      // Keep status one notch before submission to wait for human approval
      const safeIndex = Math.max(STATUS_ORDER.indexOf(cappedStatus) - 1, STATUS_ORDER.indexOf(grant.status))
      appliedStatus = STATUS_ORDER[safeIndex]
      handoffs += 1
    }

    if (appliedStatus !== grant.status) {
      db.prepare(
        `
          UPDATE grants
          SET status = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
      ).run(appliedStatus, grant.id)
      advanced += 1
    }

    recordAutomationEvent(db, {
      jobId: job.id,
      grantId: grant.id,
      previousStatus: grant.status,
      suggestedStatus,
      appliedStatus,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
      handoffRequired,
      handoffReason,
      recommendedActions: Array.isArray(parsed.recommended_actions) ? parsed.recommended_actions : null,
      aiSummary: typeof parsed.reasoning === 'string' ? parsed.reasoning : null,
    })

    grantLogs.push({
      grant_id: grant.id,
      title: grant.title,
      previous_status: grant.status,
      suggested_status: suggestedStatus,
      applied_status: appliedStatus,
      handoff_required: handoffRequired,
      handoff_reason: handoffReason,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
      recommended_actions: Array.isArray(parsed.recommended_actions) ? parsed.recommended_actions : null,
    })
  }

  return {
    result_count: advanced,
    result_meta: {
      evaluated: grants.length,
      advanced,
      handoffs,
      grants: grantLogs,
    },
  }
}
