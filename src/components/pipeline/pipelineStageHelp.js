/**
 * pipelineStageHelp
 * -----------------
 * Plain-English help for every pipeline status the Kanban board shows.
 *
 * Anya goal #2 (plain language, no jargon) and goal #4 (every prompt leaves
 * the user knowing what to do next). Consumed by:
 *   - `GrantCard.jsx`  → "Human Review Needed" badge when humanRequired
 *   - `KanbanBoard.jsx` → column header tooltips
 *   - `ProfileGrantPacketPrint.jsx` → printable handoff section
 *
 * Status keys MUST stay in sync with `STATUSES` in
 * `src/components/pipeline/KanbanBoard.jsx`. Any unknown status falls
 * through to the default helper at the bottom of this file.
 */

export const PIPELINE_STAGE_HELP = Object.freeze({
  discovery: {
    label: 'Discovery',
    plainEnglish: 'GrantFlow found this opportunity, but no one has reviewed it yet.',
    nextStep: 'Open the card and check if the funding source seems useful.',
  },

  discovered: {
    label: 'Discovered',
    plainEnglish: 'This is a possible funding source that may fit the profile.',
    nextStep: 'Check the deadline, amount, and basic eligibility.',
  },

  interested: {
    label: 'Assessing',
    plainEnglish: 'This one looks promising enough to review more closely.',
    nextStep: 'Read the requirements and decide whether to prepare an application.',
  },

  auto_applied: {
    label: 'Auto-applied',
    plainEnglish: 'GrantFlow advanced this on its own based on the profile and the funder rules.',
    nextStep: 'Open the card and confirm what was submitted is correct.',
  },

  drafting: {
    label: 'Drafting',
    plainEnglish: 'The application is being written or prepared.',
    nextStep: 'Gather the required documents and complete the written sections.',
  },

  application_prep: {
    label: 'Application Prep',
    plainEnglish: 'The application is almost ready, but some pieces may still be missing.',
    nextStep: 'Check required forms, uploads, signatures, budget, and attachments.',
  },

  // Some legacy records use the shorter `app_prep` key — alias so the UI
  // doesn't fall through to "Unknown status".
  app_prep: {
    label: 'Application Prep',
    plainEnglish: 'The application is almost ready, but some pieces may still be missing.',
    nextStep: 'Check required forms, uploads, signatures, budget, and attachments.',
  },

  revision: {
    label: 'Revising',
    plainEnglish: 'The application needs another pass before it is ready to submit.',
    nextStep: 'Address feedback or fill in the missing pieces, then move it back to Drafting or Submitted.',
  },

  portal: {
    label: 'Portal',
    plainEnglish: 'A person needs to log into an online portal and submit the application.',
    nextStep: 'Open the handoff steps, gather the listed documents, and submit through the funder’s portal.',
    humanRequired: true,
  },

  submitted: {
    label: 'Submitted',
    plainEnglish: 'The application has been sent.',
    nextStep: 'Watch for emails, portal updates, or requests for more information.',
  },

  pending_review: {
    label: 'Pending Review',
    plainEnglish: 'The funder is reviewing the application.',
    nextStep: 'Check the portal or email regularly until the funder responds.',
  },

  under_review: {
    label: 'Under Review',
    plainEnglish: 'The funder is reviewing the application.',
    nextStep: 'Check the portal or email regularly until the funder responds.',
  },

  follow_up: {
    label: 'Follow Up',
    plainEnglish: 'The funder needs more information or a response.',
    nextStep: 'Read the request carefully and send the missing information.',
    humanRequired: true,
  },

  awarded: {
    label: 'Awarded',
    plainEnglish: 'The funding was approved.',
    nextStep: 'Track the award, spending rules, reports, and deadlines.',
  },

  report: {
    label: 'Reporting',
    plainEnglish: 'The funder may require progress reports or spending reports.',
    nextStep: 'Prepare reports, receipts, outcome notes, and compliance documents.',
    humanRequired: true,
  },

  declined: {
    label: 'Declined',
    plainEnglish: 'The funder declined this application.',
    nextStep: 'Keep notes on what was learned and look for similar opportunities to apply to instead.',
  },

  declined_no_review: {
    label: 'Declined (no review)',
    plainEnglish: 'The funder rejected this before a full review — usually an eligibility mismatch.',
    nextStep: 'Confirm the profile is up to date and move on to opportunities that fit better.',
  },

  closed: {
    label: 'Closed',
    plainEnglish: 'This opportunity is no longer being worked on.',
    nextStep: 'No further action needed. Move on to other pipeline items.',
  },
})

const DEFAULT_HELP = Object.freeze({
  label: 'Unknown status',
  plainEnglish: 'GrantFlow does not have a description for this status yet.',
  nextStep: 'Open the card and review where this opportunity stands.',
})

/**
 * Look up help for a status. Always returns an object so callers don't
 * need to null-check.
 */
export function getStageHelp(status) {
  const key = String(status || '').toLowerCase()
  return key in PIPELINE_STAGE_HELP
    ? { ...PIPELINE_STAGE_HELP[key] }
    : { ...DEFAULT_HELP }
}

/**
 * Does this status require a human to step in?
 *   - The stage itself is flagged `humanRequired` (portal / follow_up / report), OR
 *   - The latest automation event says `handoff_required === true`.
 *
 * The latest automation event takes precedence — it reflects the most
 * recent pipeline_automation run, which knows things the static stage
 * map can't (e.g. drafting+missing_documents → needs human).
 */
export function isHumanReviewNeeded(status, latestAutomation) {
  if (latestAutomation && typeof latestAutomation === 'object') {
    if (latestAutomation.handoff_required === true) return true
  }
  const help = getStageHelp(status)
  return help.humanRequired === true
}
