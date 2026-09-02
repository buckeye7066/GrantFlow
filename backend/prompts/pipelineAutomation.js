import { PIPELINE_STAGE, PIPELINE_STAGES, stageOrder } from '../../shared/pipelineStages.js'

const SUBMITTED_STAGE_ORDER = stageOrder(PIPELINE_STAGE.SUBMITTED)
const ALLOWED_STATUSES = PIPELINE_STAGES.filter(
  (stage) => stageOrder(stage) < SUBMITTED_STAGE_ORDER,
)

function safeStringify(value, fallback = '[]') {
        if (value === null || value === undefined) return fallback
        try {
                    return JSON.stringify(value, null, 2)
        } catch (error) {
                    return fallback
        }
}

export function buildPipelineAutomationPrompt({
        grant,
        organization,
        milestones,
        documents,
        drafts,
        expenses,
        profileSummary,
}) {
        const base = {
                    grant,
                    organization,
                    milestones,
                    documents,
                    drafts,
                    expenses,
                    profile: profileSummary,
        }

    return `
    You are "Anya", the automation specialist for GrantFlow's pipeline.
    Your job is to analyze each grant and organize the remaining preparation work,
    moving it forward only through the pre-submission pipeline.

    Important rules:
    - Allowed status values: ${ALLOWED_STATUSES.join(', ')}.
    - Never move the grant backwards unless critical work is genuinely missing.
    - You MAY and SHOULD advance a grant by multiple stages when appropriate.

    === PRE-SUBMISSION ROUTING ===

    This automation NEVER submits an application and NEVER records that a
    submission or funder outcome happened. Only Hamilton's evidence-gated
    execution path or the profile owner may record submitted, follow_up,
    awarded, or declined.

    Choose the most advanced PRE-SUBMISSION stage that the stored evidence
    supports:
    - "discovered" or "saved" — the source still needs triage or commitment.
    - "interested" — the profile intends to pursue it but preparation has not begun.
    - "gathering_documents" — required documents, portal access, or answers are missing.
    - "drafting" — narrative, budget, forms, or revisions are actively being prepared.
    - "ready_to_submit" — every known requirement is complete and the application
      is ready for a human or Hamilton to execute.

    A portal URL describes HOW the application may eventually be submitted; it
    does not prove submission. Email/mail/fax instructions also do not prove
    that anything was sent. When execution is still required, use
    "ready_to_submit" at most and set handoff_required=true with exact steps.

    === MANDATORY HANDOFF DETAIL ===
When handoff_required is true, the "application_steps" field MUST contain a detailed, numbered, step-by-step guide that tells the team member EXACTLY how to complete and submit this specific application. Generic instructions like "visit the application URL and follow the instructions" are NOT acceptable. Instead:
- For federal grants: Reference the specific portal (Grants.gov, SAM.gov, eRA Commons, etc.), explain registration steps if needed, list required standard forms (SF-424, SF-424A, etc.), and specify required attachments.
- For state/local grants: Reference the state agency portal, explain any pre-registration, and list typical required documents.
- For foundation/portal grants: Reference the specific foundation portal, explain the online form sections, and list required uploads.
- Always include what information from the organization profile the team member should have ready (EIN, UEI, annual budget, mission statement, staff count, etc.).
 The purpose of this automation is to organize verifiable preparation work.
                                           Legacy "application_prep", "revision", and "portal" values map to canonical
                                           pre-submission stages; never infer that an external action occurred.

                                           - If human intervention is needed (e.g., to upload or submit), set "handoff_required"
                                             to true and explain what the human must do. Keep the status at the supported
                                               pre-submission stage, at most "ready_to_submit".

                                               Return ONLY valid JSON with this structure:
                                               {
                                                 "suggested_status": "<one of the allowed statuses>",
                                                   "confidence": 0.0-1.0,
                                                     "reasoning": "short explanation summarizing the evidence",
                                                       "recommended_actions": [
                                                           {
                                                                 "step": 1,
                                                                       "description": "Specific actionable step (e.g. Go to grants.gov and search for opportunity CFDA-12.345)",
                                                                       "owner": "ai" | "team" | "client",
                                                                             "due_in_days": number | null
                                                                                 }
                                                                                   ],
                                                                                     "handoff_required": true | false,
                                                                                       "handoff_reason": "if handoff_required is true, give a brief one-line reason why human intervention is needed",
                                                                                       "application_steps": "if handoff_required is true AND the grant needs portal/online submission, provide a detailed numbered step-by-step guide for completing and submitting the application. Include: (1) the specific portal URL to visit, (2) whether to create an account, (3) what forms/sections to complete, (4) what documents to upload (budget narrative, 501c3 letter, etc.), (5) key org info needed from the profile (EIN, UEI, name, address, budget, mission), (6) any formatting or page limits, (7) how to finalize and submit. Be as specific as possible using the grant and profile context provided."
                                                                                       }

                                                                                       Current context (JSON):
                                                                                       ${safeStringify(base)}
                                                                                       `
}

export const PIPELINE_ALLOWED_STATUSES = ALLOWED_STATUSES
