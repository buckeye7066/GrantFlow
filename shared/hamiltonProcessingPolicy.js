import {
  PIPELINE_STAGE,
  PIPELINE_STAGE_ALL,
  canonicalStage,
  stageOrder,
} from './pipelineStages.js'

const SUBMITTED_ORDER = stageOrder(PIPELINE_STAGE.SUBMITTED)

// Hamilton must never begin a fresh application once the pipeline has reached
// submission or any post-submission state. Include every recognized legacy
// alias whose canonical target is submitted-or-later, plus the evidence-hold
// states used while an external submit may still be in flight.
export const HAMILTON_PROTECTED_PIPELINE_STATUSES = Object.freeze([
  ...PIPELINE_STAGE_ALL.filter((raw) => {
    const canonical = canonicalStage(raw)
    return canonical && stageOrder(canonical) >= SUBMITTED_ORDER
  }),
  'submit_attempt_started',
  'submit_evidence_pending',
  'submission_verification_required',
  'completed',
  'complete',
  'done',
])

const PROTECTED_SET = new Set(HAMILTON_PROTECTED_PIPELINE_STATUSES)

/**
 * True when a pipeline stage proves that starting Hamilton again could create
 * a duplicate application or overwrite post-submission history.
 *
 * Unknown/legacy non-submission values remain processable here because this is
 * a narrow duplicate-submission guard, not the URL/deadline/readiness policy.
 */
export function isHamiltonProtectedPipelineStage(raw) {
  if (raw === null || raw === undefined) return false
  return PROTECTED_SET.has(String(raw).toLowerCase().trim())
}

export function isHamiltonProcessableStage(raw) {
  return !isHamiltonProtectedPipelineStage(raw)
}

export function hamiltonProcessingBlockReason(raw) {
  if (!isHamiltonProtectedPipelineStage(raw)) return null
  const canonical = canonicalStage(raw)
  if (canonical === PIPELINE_STAGE.SUBMITTED) {
    return 'Already submitted; Hamilton will not start a duplicate application.'
  }
  if (canonical === PIPELINE_STAGE.FOLLOW_UP) {
    return 'Post-submission follow-up is protected from reprocessing.'
  }
  if (canonical) {
    return 'This outcome is protected from reprocessing.'
  }
  return 'A submission may already be in flight or complete; verify its evidence before retrying.'
}
