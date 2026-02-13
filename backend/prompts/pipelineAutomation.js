const ALLOWED_STATUSES = [
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
    Your job is to analyze each grant and determine the correct pipeline status,
    moving it forward to the appropriate submission stage.

    Important rules:
    - Allowed status values: ${ALLOWED_STATUSES.join(', ')}.
    - Never move the grant backwards unless critical work is genuinely missing.
    - You MAY and SHOULD advance a grant by multiple stages when appropriate.

    === MANDATORY SUBMISSION ROUTING ===

    When a grant is currently in "drafting", "application_prep", or "revision", you MUST
    route it directly to one of these three submission stages based on the funding source:

    1. "portal" — The funder requires online portal submission.
       USE THIS FOR:
          - ALL federal government grants (e.g., Grants.gov, SAM.gov, NIH eRA Commons, NSF FastLane/Research.gov)
             - ALL state government grants (state agency portals)
                - ALL county/city government grants
                   - Foundation grants that have an online application portal or "apply online" link
                      - Any grant where the funder name suggests a government agency (Department of, Bureau of, Agency for, Administration of, Office of, National, Federal, State of, etc.)
                         - Any grant from organizations like NIH, NSF, DOD, DOE, EPA, USDA, HHS, ED, DOJ, DOL, FEMA, SBA, NEA, NEH, etc.

                         2. "submitted" — The application can be sent directly without a portal.
                            USE THIS FOR:
                               - Small private foundations that accept email or mail submissions
                                  - Grants where submission is via email attachment or physical mail
                                     - Corporate giving programs with direct submission

                                     3. "pending_review" — The application has already been submitted and is awaiting review.
                                        USE THIS FOR:
                                           - Only if there is explicit evidence the application was already sent/submitted

                                           === DEFAULT ROUTING RULE ===
                                           If you cannot determine the submission method from the grant data, use these defaults:
                                           - Government funder (federal, state, county, city) → "portal"
                                           - Named foundation or nonprofit funder → "portal" (most foundations now use online portals)
                                           - Unknown or unclear funder → "portal"

                                           DO NOT leave grants in "application_prep" or "drafting". The purpose of this automation
                                           is to advance grants to the correct submission stage. "application_prep" and "revision"
                                           are intermediate steps that should be skipped when routing from Process All.

                                           - If human intervention is needed (e.g., to actually upload/submit), set "handoff_required"
                                             to true and explain what the human must do, BUT STILL set the status to the correct
                                               submission stage (portal, submitted, or pending_review).

                                               Return ONLY valid JSON with this structure:
                                               {
                                                 "suggested_status": "<one of the allowed statuses>",
                                                   "confidence": 0.0-1.0,
                                                     "reasoning": "short explanation summarizing the evidence",
                                                       "recommended_actions": [
                                                           {
                                                                 "description": "clear next action",
                                                                       "owner": "ai" | "team" | "client",
                                                                             "due_in_days": number | null
                                                                                 }
                                                                                   ],
                                                                                     "handoff_required": true | false,
                                                                                       "handoff_reason": "if handoff_required is true, explain what the human must do"
                                                                                       }

                                                                                       Current context (JSON):
                                                                                       ${safeStringify(base)}
                                                                                       `
}

export const PIPELINE_ALLOWED_STATUSES = ALLOWED_STATUSES
