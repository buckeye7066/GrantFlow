/**
 * fafsaStatus.js — FAFSA submission lifecycle (beyond a single boolean).
 *
 * Tracks where a student is in the FAFSA process so the committed-college
 * workspace can show stage + the next concrete action. Pure + unit-tested. Stays
 * back-compatible with the existing `education.fafsa_completed` boolean (derived
 * both ways) and stays compliant: this records STATUS only — it never stores an
 * FSA ID, never logs into studentaid.gov, never submits federal aid.
 */

// Ordered lifecycle. `next` is the concrete action the student should take.
export const FAFSA_STAGES = Object.freeze([
  { key: 'not_started', label: 'Not started', next: 'Create your FSA ID and begin the FAFSA at studentaid.gov.' },
  { key: 'fsa_id_created', label: 'FSA ID created', next: 'Start the FAFSA form at studentaid.gov.' },
  { key: 'in_progress', label: 'In progress', next: 'Finish and submit the FAFSA.' },
  { key: 'submitted', label: 'Submitted', next: 'Wait for your FAFSA Submission Summary (your SAI).' },
  { key: 'processed', label: 'Processed — SAI received', next: 'Confirm your committed school received your FAFSA.' },
  { key: 'school_received', label: 'School received', next: 'Watch for an aid offer or a verification request.' },
  { key: 'verification', label: 'Verification requested', next: 'Submit the documents your school requested to verify your FAFSA.' },
  { key: 'complete', label: 'Complete', next: 'No further FAFSA action needed.' },
])

const KEYS = FAFSA_STAGES.map((s) => s.key)
const META = Object.fromEntries(FAFSA_STAGES.map((s) => [s.key, s]))
// "Filed" — index at/after which the boolean fafsa_completed is true.
const SUBMITTED_INDEX = KEYS.indexOf('submitted')

export function isKnownStage(stage) { return KEYS.includes(String(stage)) }
export function stageIndex(stage) { return KEYS.indexOf(String(stage)) }

/** Boolean (legacy) ⇐ stage: filed once submitted or beyond. */
export function deriveFafsaCompleted(stage) {
  const i = stageIndex(stage)
  return i >= 0 && i >= SUBMITTED_INDEX
}

/** The next concrete action for a stage. */
export function nextAction(stage) {
  return META[stage]?.next || META.not_started.next
}

/**
 * Resolve the current status from an education section. Prefers a stored
 * `fafsa_status` object; otherwise derives a stage from the legacy
 * `fafsa_completed` boolean. Always returns a normalized object.
 */
export function normalizeFafsaStatus(education = {}) {
  const stored = education?.fafsa_status
  if (stored && isKnownStage(stored.stage)) {
    return {
      stage: stored.stage,
      updated_at: stored.updated_at || null,
      history: Array.isArray(stored.history) ? stored.history : [],
    }
  }
  const stage = education?.fafsa_completed ? 'submitted' : 'not_started'
  return { stage, updated_at: null, history: [] }
}

/**
 * Set the FAFSA stage (forward, backward correction, or branch all allowed —
 * students/admins legitimately correct). Returns the new status, the derived
 * boolean to keep in sync, and an appended history entry.
 *
 * @returns {{ok:boolean, error?:string, status?:object, fafsa_completed?:boolean}}
 */
export function setFafsaStage(current = {}, stage, { now = null } = {}) {
  if (!isKnownStage(stage)) return { ok: false, error: 'unknown_stage' }
  const history = Array.isArray(current.history) ? current.history.slice(-49) : []
  history.push({ stage, at: now })
  return {
    ok: true,
    status: { stage, updated_at: now, history },
    fafsa_completed: deriveFafsaCompleted(stage),
  }
}

/** Full UI-ready view: stage + label + next action + completed + ordered stages. */
export function describeFafsaStatus(education = {}) {
  const status = normalizeFafsaStatus(education)
  return {
    stage: status.stage,
    label: META[status.stage]?.label || status.stage,
    next_action: nextAction(status.stage),
    completed: deriveFafsaCompleted(status.stage),
    updated_at: status.updated_at,
    history: status.history,
    stages: FAFSA_STAGES,
  }
}

// ── Verification-document checklist (active at the `verification` stage) ──────
// Common documents schools request when a FAFSA is selected for verification.
// GrantFlow only TRACKS which are gathered — it never collects the documents.
export const FAFSA_VERIFICATION_DOCUMENTS = Object.freeze([
  { key: 'verification_worksheet', label: 'Verification worksheet (signed)', help: 'The worksheet your school sent, completed and signed.' },
  { key: 'student_tax_transcript', label: 'Student tax transcript / IRS DRT', help: 'Use the IRS Data Retrieval Tool or order a Tax Return Transcript.' },
  { key: 'parent_tax_transcript', label: 'Parent tax transcript / IRS DRT', help: 'Required for dependent students.' },
  { key: 'w2_forms', label: 'W-2 / income statements', help: 'All W-2s (and 1099s) for the relevant tax year.' },
  { key: 'identity_statement', label: 'Identity + Statement of Educational Purpose', help: 'Photo ID plus the signed statement, if identity verification was requested.' },
  { key: 'hs_completion', label: 'Proof of high school completion', help: 'Diploma, transcript, or recognized equivalent.' },
  { key: 'household_size', label: 'Household size / number in college', help: 'Documentation of household members and any in college.' },
  { key: 'snap_benefits', label: 'SNAP / benefits documentation', help: 'Only if flagged — proof of benefits received.' },
  { key: 'child_support', label: 'Child support paid/received', help: 'Only if flagged — documentation of amounts.' },
])

const VERIFICATION_KEYS = new Set(FAFSA_VERIFICATION_DOCUMENTS.map((d) => d.key))

/**
 * Build the verification checklist with done-state from the education section.
 * `active` is true only when the FAFSA stage is `verification`, so the UI shows
 * it exactly when it's relevant.
 */
export function buildVerificationChecklist(education = {}) {
  const stage = normalizeFafsaStatus(education).stage
  const done = education?.fafsa_verification_docs || {}
  const items = FAFSA_VERIFICATION_DOCUMENTS.map((d) => ({ ...d, done: Boolean(done[d.key]) }))
  const remaining = items.filter((i) => !i.done).length
  return { active: stage === 'verification', stage, items, total: items.length, remaining, complete: remaining === 0 }
}

/** Toggle one verification document's done-state. Returns the updated map. */
export function setVerificationDoc(education = {}, key, done) {
  if (!VERIFICATION_KEYS.has(key)) return { ok: false, error: 'unknown_document' }
  const docs = { ...(education?.fafsa_verification_docs || {}) }
  docs[key] = Boolean(done)
  return { ok: true, fafsa_verification_docs: docs }
}

export const __testing__ = { KEYS, SUBMITTED_INDEX, VERIFICATION_KEYS }
