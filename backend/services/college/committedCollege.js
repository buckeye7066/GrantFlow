/**
 * committedCollege.js — committed-college flow + financial-aid workspace.
 *
 * When a student commits to a college, that college becomes the single active
 * school and the others drop off (archived). The committed college opens a
 * financial-aid workspace aggregating cost of attendance, FAFSA status, aid
 * received, GrantFlow-matched funding, unmet need, missing documents, deadlines,
 * and Hamilton automation status.
 *
 * The hard logic here is PURE (operates on the `university_applications` section
 * object + already-loaded funding/tasks) so it is fully unit-tested; the route
 * is a thin DB wrapper. This never invents data — empty inputs yield explicit
 * "not committed" / null fields, never fabricated amounts.
 */

import { describeFafsaStatus } from './fafsaStatus.js'

// Statuses that mean "this is the school the student chose".
export const COMMITTED_STATUSES = Object.freeze([
  'committed', 'enrolled', 'attending', 'current', 'matriculated', 'deposited',
])

// Shared ranking with schoolResolver so "most committed" wins deterministically.
const STATUS_RANK = Object.freeze({
  enrolled: 100, attending: 100, current: 100, matriculated: 100,
  committed: 90, deposited: 90, accepted: 80, admitted: 80,
  submitted: 55, applied: 50, in_review: 45, pending: 45, in_progress: 40,
  planning: 30, interested: 25, considering: 20, prospective: 15,
  deferred: 10, waitlisted: 10, archived: -50,
  declined: -10, denied: -10, rejected: -100, withdrawn: -100,
})

// Already "dropped off" — a commit elsewhere should not touch these.
const TERMINAL_STATUSES = new Set(['declined', 'denied', 'rejected', 'withdrawn', 'archived'])

export function normStatus(s) { return String(s || '').trim().toLowerCase() }
export function isCommittedStatus(s) { return COMMITTED_STATUSES.includes(normStatus(s)) }
function rankStatus(s) {
  const n = normStatus(s)
  return Object.prototype.hasOwnProperty.call(STATUS_RANK, n) ? STATUS_RANK[n] : 25
}
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function getApplications(uniSection) {
  return Array.isArray(uniSection?.applications) ? uniSection.applications : []
}

/** The single committed college (highest rank; tie → most recently updated). */
export function resolveCommittedCollege(uniSection) {
  const committed = getApplications(uniSection).filter((a) => isCommittedStatus(a?.status))
  if (!committed.length) return null
  return [...committed].sort((a, b) => (
    rankStatus(b.status) - rankStatus(a.status)
    || String(b.committed_at || b.updated_at || '').localeCompare(String(a.committed_at || a.updated_at || ''))
  ))[0]
}

/** Active (not committed, not terminal/archived) applications — the cards that would drop off. */
export function activeNonCommitted(uniSection) {
  return getApplications(uniSection).filter(
    (a) => !isCommittedStatus(a?.status) && !TERMINAL_STATUSES.has(normStatus(a?.status)),
  )
}

/**
 * Commit to one college (pure). The chosen app → 'committed'; every OTHER active
 * (non-terminal) app → 'archived' with reason/timestamp + previous_status so it
 * can be restored. Terminal/already-archived apps are left untouched. Idempotent.
 *
 * @returns {{ok:boolean, error?:string, section:object, committed_id?:string, archived?:string[]}}
 */
export function commitToCollege(uniSection, collegeId, { now = null } = {}) {
  const apps = getApplications(uniSection)
  const target = apps.find((a) => String(a?.id) === String(collegeId))
  if (!target) return { ok: false, error: 'college_not_found', section: uniSection }

  const archived = []
  const applications = apps.map((a) => {
    if (String(a?.id) === String(collegeId)) {
      return { ...a, status: 'committed', committed_at: a.committed_at || now }
    }
    if (TERMINAL_STATUSES.has(normStatus(a?.status))) return a
    archived.push(a.id)
    return {
      ...a,
      status: 'archived',
      archived_at: now,
      archived_reason: 'committed_elsewhere',
      previous_status: a.previous_status || a.status || null,
    }
  })
  return { ok: true, section: { ...uniSection, applications }, committed_id: String(collegeId), archived }
}

/** Restore an archived college back to its previous status (undo). */
export function uncommitArchived(uniSection, collegeId) {
  const apps = getApplications(uniSection)
  const target = apps.find((a) => String(a?.id) === String(collegeId))
  if (!target) return { ok: false, error: 'college_not_found', section: uniSection }
  const applications = apps.map((a) => {
    if (String(a?.id) !== String(collegeId)) return a
    const restored = a.previous_status || 'planning'
    const { archived_at, archived_reason, previous_status, ...rest } = a
    return { ...rest, status: restored }
  })
  return { ok: true, section: { ...uniSection, applications } }
}

function summarizeHamiltonTasks(tasks = []) {
  const list = Array.isArray(tasks) ? tasks : []
  const blocked = list.filter((t) => String(t?.status || '').includes('blocked'))
  return {
    total: list.length,
    in_progress: list.filter((t) => ['in_progress', 'running', 'queued'].includes(String(t?.status))).length,
    completed: list.filter((t) => ['completed', 'submitted'].includes(String(t?.status))).length,
    blocked: blocked.length,
    blockers: blocked.map((t) => ({ task_id: t.id, status: t.status, blocker_type: t.blocker_type || null })),
  }
}

function deriveMissingDocuments(college, fafsa) {
  const missing = []
  if (!fafsa.completed) missing.push({ key: 'fafsa', label: 'FAFSA not yet filed for the current year' })
  const declared = Array.isArray(college?.missing_documents) ? college.missing_documents : []
  for (const d of declared) {
    missing.push(typeof d === 'string' ? { key: d, label: d } : d)
  }
  return missing
}

function deriveDeadlines(college, fafsa) {
  const out = Array.isArray(college?.deadlines) ? [...college.deadlines] : []
  if (!fafsa.completed) {
    out.push({ key: 'fafsa', label: 'File FAFSA (priority deadlines vary by school/state)', source: 'federal' })
  }
  return out
}

/**
 * Build the committed-college financial-aid workspace (pure). `matchedFunding`
 * and `hamiltonTasks` are passed in already-loaded so this stays DB-free.
 */
export function buildCollegeAidWorkspace({ sections = {}, matchedFunding = [], hamiltonTasks = [] } = {}) {
  const uni = sections.university_applications || {}
  const college = resolveCommittedCollege(uni)
  if (!college) {
    return {
      committed: false,
      reason: 'no_committed_college',
      candidate_count: activeNonCommitted(uni).length,
    }
  }

  const edu = sections.education || {}
  const costs = college.costs || {}
  const coa = {
    tuition: numOrNull(costs.tuition),
    housing: numOrNull(costs.housing ?? costs.room_and_board ?? costs.room_board),
    books: numOrNull(costs.books),
    other: numOrNull(costs.other),
    total: numOrNull(costs.total_cost_of_attendance ?? costs.total ?? costs.coa),
  }

  const aidPipeline = Array.isArray(college.financial_aid_pipeline) ? college.financial_aid_pipeline : []
  const aidReceived = aidPipeline.reduce((sum, a) => sum + (numOrNull(a?.amount) || 0), 0)
  const matchedFundingTotal = (Array.isArray(matchedFunding) ? matchedFunding : [])
    .reduce((sum, f) => sum + (numOrNull(f?.amount ?? f?.award_amount) || 0), 0)

  const fafsaStatus = describeFafsaStatus(edu)
  const fafsa = {
    completed: fafsaStatus.completed,
    stage: fafsaStatus.stage,
    stage_label: fafsaStatus.label,
    next_action: fafsaStatus.next_action,
    efc_sai_band: edu.efc_sai_band || edu.sai_band || null,
    pell_grant_eligible: Boolean(edu.pell_grant_eligible),
    first_generation: Boolean(edu.first_generation_college_student),
  }

  const unmetNeed = coa.total === null
    ? null
    : Math.max(0, coa.total - aidReceived - matchedFundingTotal)

  return {
    committed: true,
    college: {
      id: college.id,
      name: college.name || null,
      status: normStatus(college.status),
      city: college.city || null,
      state: college.state || null,
      website_url: college.website_url || null,
      portals: college.portals || {},
    },
    cost_of_attendance: coa,
    fafsa,
    aid: { received_total: aidReceived, pipeline: aidPipeline },
    matched_funding: {
      count: Array.isArray(matchedFunding) ? matchedFunding.length : 0,
      total: matchedFundingTotal,
      items: Array.isArray(matchedFunding) ? matchedFunding : [],
    },
    unmet_need: unmetNeed,
    missing_documents: deriveMissingDocuments(college, fafsa),
    deadlines: deriveDeadlines(college, fafsa),
    hamilton: summarizeHamiltonTasks(hamiltonTasks),
    archived_colleges: getApplications(uni)
      .filter((a) => normStatus(a.status) === 'archived')
      .map((a) => ({ id: a.id, name: a.name || null, previous_status: a.previous_status || null })),
  }
}

export const __testing__ = { STATUS_RANK, TERMINAL_STATUSES, rankStatus }
