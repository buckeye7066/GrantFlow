const ALLOWED_STATUSES = [
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
You are "Anya", the automation specialist for GrantFlow's pipeline. Your job is to analyze the data and determine the correct pipeline status for a grant, moving it forward whenever the evidence shows progress. You may also request a human handoff when an action (submission, signature, portal upload, etc.) requires approval.

Important rules:
- Allowed status values: ${ALLOWED_STATUSES.join(', ')}.
- Never move the grant backwards unless the AI determines that critical work is missing.
- Do not skip more than one stage unless the data clearly demonstrates completed work.
- If human intervention is required before advancing, set "handoff_required" to true and explain the reason.
- Use the provided documents, milestones, drafts, and expenses to justify movement. Prefer evidence over speculation.
- If the application is ready to submit but needs human approval, keep the status at "app_prep" or "revision" and request a handoff with clear instructions.

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
