import { buildPipelineAutomationPrompt, PIPELINE_ALLOWED_STATUSES } from '../prompts/pipelineAutomation.js'
import { extractCompletionText } from '../utils/openai.js'
import { summarizeOpenAIError } from '../utils/openaiClient.js'

// STATUS_ORDER must match the frontend KanbanBoard STATUSES exactly
const STATUS_ORDER = [
    'discovery',
    'discovered',
    'interested',
    'auto_applied',
    'drafting',
    'application_prep',
    'revision',
    'portal',
    'submitted',
    'pending_review',
    'follow_up',
    'awarded',
    'report',
    'declined_no_review',
    'declined',
    'closed',
  ]

// Map legacy backend statuses to current UI statuses
const LEGACY_STATUS_MAP = {
    'app_prep': 'application_prep',
    'under_review': 'pending_review',
    'rejected': 'declined',
    'archived': 'closed',
}

function mapLegacyStatus(status) {
    if (!status || typeof status !== 'string') return status
    return LEGACY_STATUS_MAP[status.trim().toLowerCase()] || status.trim().toLowerCase()
}

function normalizeStatus(status) {
    if (!status || typeof status !== 'string') return null
    const mapped = mapLegacyStatus(status)
    return PIPELINE_ALLOWED_STATUSES.includes(mapped) ? mapped : null
}

function compareStatuses(current, next) {
    const currentIndex = STATUS_ORDER.indexOf(mapLegacyStatus(current))
    const nextIndex = STATUS_ORDER.indexOf(mapLegacyStatus(next))
    if (currentIndex === -1 || nextIndex === -1) return 0
    return nextIndex - currentIndex
}

// Allow the AI to advance grants to the appropriate stage without artificial caps.
// The AI prompt already instructs it to choose the correct submission stage
// (portal, submitted, or pending_review) based on funding source requirements.
// We only prevent backward movement unless the AI explicitly recommends it.
function validateAdvance(current, suggested) {
    const currentMapped = mapLegacyStatus(current)
    const suggestedMapped = mapLegacyStatus(suggested)
    // Ensure the suggested status is a known canonical status before accepting it
    if (!PIPELINE_ALLOWED_STATUSES.includes(suggestedMapped)) return currentMapped
    const delta = compareStatuses(currentMapped, suggestedMapped)
    // If AI suggests moving backward, keep current
    if (delta < 0) return currentMapped
    return suggestedMapped
}

async function createAnthropicClient() {
    const key = String(process.env.ANTHROPIC_API_KEY || '').trim()
    if (!key) return null
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    return new Anthropic({
          apiKey: key,
          timeout: Number(process.env.ANYA_ANTHROPIC_TIMEOUT_MS || 20_000),
          maxRetries: Number(process.env.ANYA_ANTHROPIC_MAX_RETRIES || 1),
    })
}

function extractAnthropicText(response) {
    const parts = Array.isArray(response?.content) ? response.content : []
        return parts
      .map((part) => {
              if (typeof part?.text === 'string') return part.text
              if (typeof part === 'string') return part
              return ''
      })
      .filter(Boolean)
      .join('\n')
      .trim()
}

async function fetchGrantContext(db, grantId) {
    const grant = await db
      .prepare(
              `
                    SELECT * FROM grants WHERE id = ?
                          `,
            )
      .get(grantId)

  if (!grant) {
        throw new Error(`Grant ${grantId} not found`)
  }

  const organization = grant.organization_id
      ? await db
            .prepare(
                        `
                                SELECT * FROM organizations WHERE id = ?
                                        `,
                      )
            .get(grant.organization_id)
        : null

  const milestones = await db
      .prepare(
              `
                    SELECT id, title, due_date, completed, completed_date, type
                          FROM milestones
                                WHERE grant_id = ?
                                      ORDER BY due_date ASC
                                            `,
            )
      .all(grantId)

  const documents = await db
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

  const drafts = await db
      .prepare(
              `
                    SELECT id, section_name, status, updated_at
                          FROM application_drafts
                                WHERE grant_id = ?
                                      ORDER BY section_order ASC
                                            `,
            )
      .all(grantId)

  const expenses = await db
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

  const includeKeys = [
        'basic_information',
        'organization_details',
        'financial_information',
        'military',
        'education',
        'family',
        'health',
        'emergency',
        'business',
        'housing',
    ]
    includeKeys.forEach((key) => {
          if (sections && sections[key]) {
                  summary.sections[key] = sections[key]
          }
    })

  return summary
}

async function recordAutomationEvent(db, payload) {
    await db.prepare(
          `
              INSERT INTO grant_pipeline_events (
                    grant_id, job_id, previous_status, suggested_status, applied_status,
                          confidence, handoff_required, handoff_reason, recommended_actions, ai_summary
                              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                  `,
        ).run(
          payload.grantId,
          payload.jobId ?? null,
          payload.previousStatus ?? null,
          payload.suggestedStatus ?? null,
          payload.appliedStatus ?? null,
          payload.confidence ?? null,
          payload.handoffRequired ? true : false,
          payload.handoffReason ?? null,
          (() => {
        const actions = payload.recommendedActions ?? []
        const steps = payload.applicationSteps ?? null
        if (!actions.length && !steps) return null
        return JSON.stringify({ actions, application_steps: steps })
      })(),
          payload.aiSummary ?? null,
        )
}

// All statuses that are eligible for pipeline automation processing
const PROCESSABLE_STATUSES = [
    'discovery', 'discovered', 'interested', 'auto_applied',
    'drafting', 'application_prep', 'revision',
    // Late-stage statuses that may still need AI-assisted advancement
    'portal', 'submitted',
    // Legacy statuses that may still exist in DB
    'app_prep',
  ]

export async function processPipelineAutomationJob({ db, job, profileContext, getOpenAI }) {
    const parameters = job.parameters ?? {}
        const grantId = parameters.grant_id
    const organizationId = parameters.organization_id
    const profileId = job?.profile_id ?? parameters.profile_id ?? null

  const wantsAll =
        parameters.process_all === true ||
        String(parameters.process_all || '').toLowerCase() === 'true' ||
        parameters.all === true ||
        String(parameters.all || '').toLowerCase() === 'true'

  const statusPlaceholders = PROCESSABLE_STATUSES.map(() => '?').join(', ')

  let grants = []

      if (grantId) {
            const context = await fetchGrantContext(db, grantId)
            grants.push(context)
      } else if (profileId) {
            const limitRaw = parameters.limit
            const defaultLimit = 200
            const limit =
                    Number.isFinite(Number(limitRaw)) && Number(limitRaw) > 0
                ? Number(limitRaw)
                      : defaultLimit

      let rows = []
            try {
                    rows = await db
                      .prepare(
                                  `
                                            SELECT id FROM grants
                                                      WHERE profile_id = ?
                                                                  AND status IN (${statusPlaceholders})
                                                                            ORDER BY deadline IS NULL, deadline ASC
                                                                                      LIMIT ?
                                                                                                `,
                                )
                      .all(profileId, ...PROCESSABLE_STATUSES, limit)
            } catch (error) {
                    console.warn('[pipeline_automation] profile-scoped query failed; falling back', {
                              profile_id: profileId,
                              error: error?.message || String(error),
                    })
                    rows = []
            }

      grants = []
            for (const row of rows) {
                    grants.push(await fetchGrantContext(db, row.id))
            }
      } else if (organizationId) {
            const limitRaw = parameters.limit
            const defaultLimit = 100
            const limit =
                    Number.isFinite(Number(limitRaw)) && Number(limitRaw) > 0
                ? Number(limitRaw)
                      : defaultLimit

            const rows = await db
              .prepare(
                        `
                                SELECT id FROM grants
                                        WHERE organization_id = ?
                                                  AND status IN (${statusPlaceholders})
                                                          ORDER BY deadline IS NULL, deadline ASC
                                                                  LIMIT ?
                                                                          `,
                      )
              .all(organizationId, ...PROCESSABLE_STATUSES, limit)

      grants = []
            for (const row of rows) {
                    grants.push(await fetchGrantContext(db, row.id))
            }
      } else {
            const rows = await db
              .prepare(
                        `
                                SELECT id FROM grants
                                        WHERE status IN (${statusPlaceholders})
                                                ORDER BY deadline IS NULL, deadline ASC
                                                        LIMIT ?
                                                                `,
                      )
              .all(
                        ...PROCESSABLE_STATUSES,
                        (() => {
                                    const limitRaw = parameters.limit
                                    const defaultLimit = wantsAll ? 100 : 10
                                    const limit =
                                                  Number.isFinite(Number(limitRaw)) && Number(limitRaw) > 0
                                        ? Number(limitRaw)
                                                    : defaultLimit
                                    return limit
                        })(),
                      )

      grants = []
            for (const row of rows) {
                    grants.push(await fetchGrantContext(db, row.id))
            }
      }

  if (grants.length === 0) {
        return {
                evaluated: 0,
                advanced: 0,
                handoffs: 0,
        }
  }

  const profileSummary = buildProfileSummary(profileContext)

  let openai = null
    try {
          openai = typeof getOpenAI === 'function' ? getOpenAI() : null
    } catch (clientError) {
          console.warn('[pipeline_automation] getOpenAI() threw; falling back to Anthropic', {
                error: clientError?.message || String(clientError),
          })
          openai = null
    }
    const anthropic = await createAnthropicClient()

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
              if (openai) {
                        const completion = await openai.chat.completions.create({
                                    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
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
              } else {
                        throw new Error('OpenAI client unavailable')
              }
      } catch (error) {
              const summary = summarizeOpenAIError(error)
              if (anthropic) {
                        try {
                                    const response = await anthropic.messages.create({
                                                  model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
                                                  max_tokens: 1200,
                                                  temperature: 0.2,
                                                  system:
                                                                  'You are Anya, the GrantFlow pipeline automation assistant. Output JSON only (json_object).',
                                                  messages: [{ role: 'user', content: prompt }],
                                    })

                          aiResponse = extractAnthropicText(response) || '{}'
                        } catch (anthropicError) {
                                    await recordAutomationEvent(db, {
                                                  jobId: job.id,
                                                  grantId: grant.id,
                                                  previousStatus: grant.status,
                                                  suggestedStatus: null,
                                                  appliedStatus: grant.status,
                                                  confidence: null,
                                                  handoffRequired: true,
                                                  handoffReason: 'Both OpenAI and Anthropic failed â manual review required.',
                                                  recommendedActions: ['review_ai_failure', 'manually_advance_status'],
                                                  aiSummary: `Automation failed (both providers): ${
                                                                  anthropicError instanceof Error ? anthropicError.message : String(anthropicError)
                                                  }`,
                                    })
                                    handoffs += 1
                                    continue
                        }
              } else {
                        await recordAutomationEvent(db, {
                                    jobId: job.id,
                                    grantId: grant.id,
                                    previousStatus: grant.status,
                                    suggestedStatus: null,
                                    appliedStatus: grant.status,
                                    confidence: null,
                                    handoffRequired: true,
                                    handoffReason: 'No AI provider available â manual review required.',
                                    recommendedActions: ['configure_ai_provider', 'manually_advance_status'],
                                    aiSummary: `Automation failed (no provider): ${error instanceof Error ? error.message : String(error)}`,
                        })
                        handoffs += 1
                        continue
              }
      }

      let parsed = {}
            try {
                    parsed = JSON.parse(aiResponse)
            } catch (parseError) {
                    await recordAutomationEvent(db, {
                              jobId: job.id,
                              grantId: grant.id,
                              previousStatus: grant.status,
                              suggestedStatus: null,
                              appliedStatus: grant.status,
                              confidence: null,
                              handoffRequired: true,
                              handoffReason: 'AI response could not be parsed as JSON â manual review required.',
                              recommendedActions: ['review_ai_response', 'manually_advance_status'],
                              aiSummary: `Automation parse failure: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
                    })
                    handoffs += 1
                    continue
            }

      const currentStatus = mapLegacyStatus(grant.status)
              const suggestedStatus = normalizeStatus(parsed.suggested_status) ?? currentStatus
              const validatedStatus = validateAdvance(currentStatus, suggestedStatus)

      const handoffRequired = Boolean(parsed.handoff_required)
              const handoffReason =
                      typeof parsed.handoff_reason === 'string' && parsed.handoff_reason.trim().length > 0
                  ? parsed.handoff_reason.trim()
                        : null

      let appliedStatus = validatedStatus

      if (handoffRequired) {
              handoffs += 1
      }

      if (appliedStatus !== currentStatus) {
              await db
                .prepare(
                            `
                                    UPDATE grants SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
                                            `,
                          )
                .run(appliedStatus, grant.id)
              advanced += 1
      }

      await recordAutomationEvent(db, {
              jobId: job.id,
              grantId: grant.id,
              previousStatus: currentStatus,
              suggestedStatus,
              appliedStatus,
              confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
              handoffRequired,
              handoffReason,
              recommendedActions: Array.isArray(parsed.recommended_actions)
                ? parsed.recommended_actions
                        : null,
              applicationSteps: typeof parsed.application_steps === 'string'
                ? parsed.application_steps.trim()
                : null,
              aiSummary: typeof parsed.reasoning === 'string' ? parsed.reasoning : null,
      })

      grantLogs.push({
              grant_id: grant.id,
              title: grant.title,
              previous_status: currentStatus,
              suggested_status: suggestedStatus,
              applied_status: appliedStatus,
              handoff_required: handoffRequired,
              handoff_reason: handoffReason,
              confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
              recommended_actions: Array.isArray(parsed.recommended_actions)
                ? parsed.recommended_actions
                        : null,
      application_steps: typeof parsed.application_steps === 'string'
                ? parsed.application_steps.trim()
                        : null,
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
