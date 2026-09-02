import { buildPipelineAutomationPrompt, PIPELINE_ALLOWED_STATUSES } from '../prompts/pipelineAutomation.js'
import { extractCompletionText } from '../utils/openai.js'
import { summarizeOpenAIError } from '../utils/openaiClient.js'
import { isAutomationEnabled } from '../../shared/automationPreferences.js'
import {
  PIPELINE_STAGE,
  PIPELINE_STAGE_ALL,
  PIPELINE_STAGES,
  canonicalStage,
  stageOrder,
} from '../../shared/pipelineStages.js'

// Per-profile automation toggle: is pipeline auto-processing allowed for this
// profile? Reads the automation_preferences profile section directly so the
// scheduled job runner can skip a profile the user opted out of. Absent
// preference defaults ON (current behaviour). See shared/automationPreferences.js.
async function pipelineProcessingAllowedForProfile(db, profileId) {
  if (!profileId) return true
  try {
    const row = await db
      .prepare(`SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = 'automation_preferences' LIMIT 1`)
      .get(String(profileId))
    const prefs = row?.data
      ? (typeof row.data === 'string' ? JSON.parse(row.data) : row.data)
      : {}
    return isAutomationEnabled(prefs, 'pipeline_processing')
  } catch {
    return true // never let a read failure silently disable a user's automation
  }
}

// Pipeline automation prepares work; it never records an external action or
// outcome. All lifecycle vocabulary comes from the shared canonical registry.
const SUBMITTED_STAGE_ORDER = stageOrder(PIPELINE_STAGE.SUBMITTED)
export const PIPELINE_AUTOMATION_STATUSES = Object.freeze(
  PIPELINE_STAGES.filter((stage) => stageOrder(stage) < SUBMITTED_STAGE_ORDER),
)

const EXTERNAL_EVIDENCE_STATUSES = new Set([
  PIPELINE_STAGE.SUBMITTED,
  PIPELINE_STAGE.FOLLOW_UP,
  PIPELINE_STAGE.AWARDED,
  PIPELINE_STAGE.DECLINED,
])

export function isExternalOutcomeStatus(status) {
  const canonical = canonicalStage(status)
  return canonical ? EXTERNAL_EVIDENCE_STATUSES.has(canonical) : false
}

export function isPipelineAutomationProcessable(status) {
  const canonical = canonicalStage(status)
  return canonical !== null && stageOrder(canonical) < SUBMITTED_STAGE_ORDER
}

export function validateAdvance(current, suggested) {
  const currentCanonical = canonicalStage(current)
  const suggestedCanonical = canonicalStage(suggested)
  const fallback = currentCanonical || current

  if (!currentCanonical || !suggestedCanonical) return fallback
  // A submitted or post-submission row is evidence/history, not automation
  // input. An explicit single-grant call must be harmless too.
  if (!isPipelineAutomationProcessable(currentCanonical)) return currentCanonical
  // The model may organize preparation through ready_to_submit, but only a
  // human or Hamilton's evidence-gated execution path can cross submission.
  if (!PIPELINE_AUTOMATION_STATUSES.includes(suggestedCanonical)) return currentCanonical
  if (stageOrder(suggestedCanonical) < stageOrder(currentCanonical)) return currentCanonical
  return suggestedCanonical
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
    // FK guard: grant_pipeline_events.grant_id REFERENCES grants(id) NOT NULL.
    // A pipeline job fetches the grant, then runs AI for many seconds; the grant
    // can be deleted in that window. Inserting the event then violates
    // grant_pipeline_events_grant_id_fkey and aborts the job. Verify the grant
    // still exists (and is committed) immediately before the write; if it's
    // gone, skip the audit event rather than crash — the work it described no
    // longer has a parent to attach to.
    if (!payload.grantId) {
      console.warn('[pipeline_automation] recordAutomationEvent skipped: no grantId')
      return
    }
    try {
      const grant = await db
        .prepare('SELECT id FROM grants WHERE id = ? LIMIT 1')
        .get(String(payload.grantId))
      if (!grant) {
        console.warn(
          `[pipeline_automation] grant ${payload.grantId} no longer exists — skipping pipeline event (avoids FK violation)`,
        )
        return
      }
    } catch (lookupErr) {
      console.warn(
        `[pipeline_automation] grant existence check failed for ${payload.grantId}: ${lookupErr?.message || lookupErr} — skipping event`,
      )
      return
    }
    try {
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
    } catch (err) {
      // Final guard for the TOCTOU race the pre-check above cannot fully close:
      // if the grant is deleted between the existence check and this insert,
      // Postgres raises 23503 / SQLite raises SQLITE_CONSTRAINT_FOREIGNKEY. The
      // event is best-effort audit, so skip it instead of aborting the job.
      const code = err?.code || err?.original?.code
      const isFkViolation =
        code === '23503' ||
        code === 'SQLITE_CONSTRAINT_FOREIGNKEY' ||
        /foreign key/i.test(String(err?.message || ''))
      if (isFkViolation) {
        console.warn(
          `[pipeline_automation] grant ${payload.grantId} deleted mid-flight — pipeline event skipped (FK)`,
        )
        return
      }
      throw err
    }
}

// Query every canonical/legacy pre-submission spelling, and nothing at or
// beyond submitted. The per-grant validator repeats the same rule.
const PROCESSABLE_STATUSES = Object.freeze(
  PIPELINE_STAGE_ALL.filter((status) => isPipelineAutomationProcessable(status)),
)

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

  // Per-profile automation toggle: skip a profile-scoped automation run when the
  // user has turned OFF "Pipeline auto-processing" for this profile. We only gate
  // the profile-scoped batch path (the scheduled "Process All for this profile"
  // automation), not an explicit single-grant request.
  if (profileId && !(await pipelineProcessingAllowedForProfile(db, profileId))) {
    return {
      evaluated: 0,
      advanced: 0,
      handoffs: 0,
      skipped: true,
      skipped_reason: 'pipeline_processing_disabled_for_profile',
    }
  }

  const statusPlaceholders = PROCESSABLE_STATUSES.map(() => '?').join(', ')

  let grants = []

      if (grantId) {
            const context = await fetchGrantContext(db, grantId)
            if (!isPipelineAutomationProcessable(context.grant?.status)) {
              return {
                evaluated: 0,
                advanced: 0,
                handoffs: 0,
                skipped: true,
                skipped_reason: 'pipeline_stage_protected',
              }
            }
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
                                                  handoffReason: 'Both OpenAI and Anthropic failed — manual review required.',
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
                                    handoffReason: 'No AI provider available — manual review required.',
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
                              handoffReason: 'AI response could not be parsed as JSON — manual review required.',
                              recommendedActions: ['review_ai_response', 'manually_advance_status'],
                              aiSummary: `Automation parse failure: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
                    })
                    handoffs += 1
                    continue
            }

      const currentStatus = canonicalStage(grant.status) || grant.status
              const suggestedStatus = canonicalStage(parsed.suggested_status) || currentStatus
              const validatedStatus = validateAdvance(currentStatus, suggestedStatus)

      // If the model tried to infer a submission or external outcome,
      // validateAdvance refused it. Surface that as work for the owner instead
      // of silently treating the inference as a real event.
      const withheldOutcome = isExternalOutcomeStatus(parsed.suggested_status)
        && suggestedStatus !== validatedStatus

      const handoffRequired = Boolean(parsed.handoff_required) || withheldOutcome
              const handoffReason =
                      typeof parsed.handoff_reason === 'string' && parsed.handoff_reason.trim().length > 0
                  ? parsed.handoff_reason.trim()
                        : (withheldOutcome
                          ? `Automation read this as "${suggestedStatus}". A funder decision is only recorded from portal evidence or by you — confirm it, then record the outcome.`
                          : null)

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

// Test-only exports.
export const __testing__ = { recordAutomationEvent }
