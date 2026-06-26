// Canonical pipeline-stages module (RC-13).
//
// Single source of truth for the GrantFlow pipeline lifecycle. Both backend
// (config validators, route guards, application workflow) and frontend
// (KanbanBoard columns, breakdown summaries, badges) import this module so
// the three places that previously kept independent lists stop drifting:
//
//   1. backend/config/constants.js GRANT_STATUSES (API validator)
//   2. backend/db/schema.sql grants.status CHECK constraint (DB)
//   3. src/components/pipeline/KanbanBoard.jsx STATUSES (UI columns)
//
// Mission spec:
//   discovered → saved → interested → gathering_documents → drafting →
//   ready_to_submit → submitted → follow_up → awarded → declined → archived
//
// Three stages were missing from production lists before this module:
// `saved`, `gathering_documents`, `ready_to_submit`. Migration 076 (SQLite)
// and 0072 (Postgres) widen the grants.status CHECK to accept them.
//
// We KEEP the legacy stage names accepted by the DB CHECK and listed in
// GRANT_STATUSES, but the canonical lifecycle exposed to UI/Anya/scoring
// uses the 11 names above. PIPELINE_STAGE_ALIASES maps legacy → canonical
// so reads can always render legacy data in the right column without a
// data backfill.

export const PIPELINE_STAGES = Object.freeze([
  'discovered',
  'saved',
  'interested',
  'gathering_documents',
  'drafting',
  'ready_to_submit',
  'submitted',
  'follow_up',
  'awarded',
  'declined',
  'archived',
])

export const PIPELINE_STAGE = Object.freeze({
  DISCOVERED: 'discovered',
  SAVED: 'saved',
  INTERESTED: 'interested',
  GATHERING_DOCUMENTS: 'gathering_documents',
  DRAFTING: 'drafting',
  READY_TO_SUBMIT: 'ready_to_submit',
  SUBMITTED: 'submitted',
  FOLLOW_UP: 'follow_up',
  AWARDED: 'awarded',
  DECLINED: 'declined',
  ARCHIVED: 'archived',
})

export const TERMINAL_STAGES = Object.freeze([
  PIPELINE_STAGE.AWARDED,
  PIPELINE_STAGE.DECLINED,
  PIPELINE_STAGE.ARCHIVED,
])

// Legacy stage name → canonical stage. Used by readers (UI bucketing, Anya
// summaries, pipeline-totals tools) so historical rows render correctly even
// before any backfill.
//
// IMPORTANT: This is a READ-side normalization. Writes can still use legacy
// names (the DB CHECK accepts them) so backfill is never urgent. The
// canonical stages are the recommended values for new writes.
export const PIPELINE_STAGE_ALIASES = Object.freeze({
  // Discovery synonym
  discovery: 'discovered',
  // Pre-submit work
  app_prep: 'drafting',
  application_prep: 'drafting',
  revision: 'drafting',
  portal: 'gathering_documents',
  // Submission flow
  auto_applied: 'submitted',
  pending_review: 'submitted',
  under_review: 'submitted',
  // Post-submit follow-up
  report: 'follow_up',
  // Outcomes
  rejected: 'declined',
  declined_no_review: 'declined',
  // Terminal / cleanup
  closed: 'archived',
  deadline_passed: 'archived',
})

// Legacy stage names accepted by the DB CHECK constraint and the API
// validator. Kept here as a single export so migrations and validators stay
// in lock-step.
export const PIPELINE_STAGE_LEGACY = Object.freeze(Object.keys(PIPELINE_STAGE_ALIASES))

// Full set of stages allowed by the API/DB. Always equals canonical ∪ legacy.
export const PIPELINE_STAGE_ALL = Object.freeze([
  ...PIPELINE_STAGES,
  ...PIPELINE_STAGE_LEGACY,
])

const CANONICAL_SET = new Set(PIPELINE_STAGES)
const LEGACY_MAP = PIPELINE_STAGE_ALIASES

export function isCanonicalStage(stage) {
  if (stage === null || stage === undefined) return false
  return CANONICAL_SET.has(String(stage).toLowerCase().trim())
}

export function isValidStage(stage) {
  return isCanonicalStage(stage)
}

/**
 * Resolve a raw stage value to its canonical name.
 * - Returns the value itself if it's already canonical.
 * - Returns the alias's canonical target if it's a known legacy name.
 * - Returns null for unknown values so callers can route to an
 *   "Other / Unknown" bucket (UI rule: counts displayed in the UI must
 *   map 1:1 to backend response fields).
 */
export function canonicalStage(raw) {
  if (raw === null || raw === undefined) return null
  const v = String(raw).toLowerCase().trim()
  if (!v) return null
  if (CANONICAL_SET.has(v)) return v
  return Object.prototype.hasOwnProperty.call(LEGACY_MAP, v) ? LEGACY_MAP[v] : null
}

/**
 * True iff `raw` is either canonical or a recognised legacy synonym.
 * Used by API validators that must accept legacy data without 400'ing
 * pre-RC-13 rows.
 */
export function isAcceptedStage(raw) {
  if (raw === null || raw === undefined) return false
  const v = String(raw).toLowerCase().trim()
  return CANONICAL_SET.has(v) || Object.prototype.hasOwnProperty.call(LEGACY_MAP, v)
}

/**
 * Position of a canonical stage in the lifecycle (0-indexed). Useful for
 * sorting/comparing progress across grants.
 */
export function stageOrder(stage) {
  const c = canonicalStage(stage)
  if (!c) return -1
  return PIPELINE_STAGES.indexOf(c)
}

/**
 * Legal transitions between canonical pipeline stages.
 *
 * Legacy status strings are intentionally not accepted here; callers that read
 * old data should normalize with canonicalStage() first. This keeps writes and
 * agent workflow moves on the 11-stage mission lifecycle.
 */
export function canTransition(from, to) {
  if (!isCanonicalStage(from) || !isCanonicalStage(to)) return false
  if (from === to) return true
  if (to === PIPELINE_STAGE.ARCHIVED) return true

  const active = PIPELINE_STAGES.slice(0, PIPELINE_STAGES.indexOf(PIPELINE_STAGE.SUBMITTED) + 1)
  const fromIdx = PIPELINE_STAGES.indexOf(from)
  const toIdx = PIPELINE_STAGES.indexOf(to)

  if (TERMINAL_STAGES.includes(from)) return false

  if (from === PIPELINE_STAGE.SUBMITTED) {
    return [PIPELINE_STAGE.FOLLOW_UP, PIPELINE_STAGE.AWARDED, PIPELINE_STAGE.DECLINED].includes(to)
  }
  if (from === PIPELINE_STAGE.FOLLOW_UP) {
    return [PIPELINE_STAGE.AWARDED, PIPELINE_STAGE.DECLINED].includes(to)
  }

  if (active.includes(from)) {
    if (toIdx > fromIdx) return true
    if (toIdx === fromIdx - 1) return true
    return false
  }
  return false
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(`illegal pipeline transition: ${from} -> ${to}`)
  }
  return to
}

// ── Application tracker ↔ pipeline reconciliation ─────────────────────────
//
// The application tracker (grant_applications) is a DISTINCT feature from the
// opportunity pipeline (grants) — it tracks the formal application-execution
// lifecycle, not opportunity assessment. The two are intentionally separate, but
// for a coherent discovery→action view (mission goal #10) every tracked item
// should report a position on ONE canonical lifecycle. This maps the application
// statuses (draft/in_progress/submitted/under_review/awarded/denied/withdrawn)
// onto the canonical pipeline stages — a READ-side reconciliation only; it does
// NOT change what the application tracker stores (no lossy migration).
export const APPLICATION_STATUS_TO_STAGE = Object.freeze({
  draft: 'drafting',
  in_progress: 'drafting',
  submitted: 'submitted',
  under_review: 'follow_up',
  awarded: 'awarded',
  denied: 'declined',
  withdrawn: 'archived',
})

/**
 * Reconcile any tracked-item status to a canonical pipeline stage for unified
 * display/reporting. Tries the application-status map first (its `under_review`
 * means "post-submission", → follow_up), then falls back to the pipeline
 * canonicalStage resolver (covers grants/vnext/apply-engine statuses). Returns
 * null for unknown values so callers can bucket them as "Other".
 *
 * @param {string|null|undefined} status
 * @returns {string|null} canonical pipeline stage
 */
export function applicationStatusToStage(status) {
  if (status === null || status === undefined) return null
  const v = String(status).toLowerCase().trim()
  if (!v) return null
  if (Object.prototype.hasOwnProperty.call(APPLICATION_STATUS_TO_STAGE, v)) {
    return APPLICATION_STATUS_TO_STAGE[v]
  }
  return canonicalStage(v)
}
