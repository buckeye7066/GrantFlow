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

import { describeFafsaStatus, buildVerificationChecklist } from './fafsaStatus.js'

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

// ── Financial-aid-pipeline entry statuses ───────────────────────────────────
// Aid entries (scholarships/grants the student logged on their committed
// college) carry a status. Only SECURED money reduces unmet need; "applied for"
// is tracked but not yet counted.
export const AID_STATUSES = Object.freeze(['awarded', 'received', 'accepted', 'applied', 'pending', 'declined'])
// Statuses that mean "applied but not yet won" — tracked, not counted as received.
const AID_PENDING_STATUSES = new Set(['applied', 'pending', 'in_review', 'submitted'])
// Statuses that mean "no money" — tracked, not counted.
const AID_DECLINED_STATUSES = new Set(['declined', 'denied', 'rejected', 'withdrawn'])

/**
 * Does this aid entry represent money actually secured (counts toward "aid
 * received" / reduces unmet need)? Backward-compatible: an entry with NO status
 * is treated as secured (older pipelines logged amounts without a status).
 */
export function aidIsSecured(entry) {
  const s = normStatus(entry?.status)
  if (!s) return true
  if (AID_PENDING_STATUSES.has(s)) return false
  if (AID_DECLINED_STATUSES.has(s)) return false
  return true // awarded / received / accepted / anything else affirmative
}

/** Is this entry an "applied for, not yet decided" scholarship? */
export function aidIsPending(entry) {
  return AID_PENDING_STATUSES.has(normStatus(entry?.status))
}

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

/**
 * Normalize a caller-supplied aid entry into the stored shape. `id` is provided
 * by the caller (route) so this stays pure/deterministic. Returns
 * { ok, error?, entry? }.
 */
export function normalizeAidEntry(input = {}, { id = null } = {}) {
  const name = String(input.name ?? input.title ?? '').trim()
  if (!name) return { ok: false, error: 'name_required' }
  const status = normStatus(input.status) || 'awarded'
  if (!AID_STATUSES.includes(status)) return { ok: false, error: 'invalid_status' }
  const amount = numOrNull(input.amount)
  if (amount !== null && amount < 0) return { ok: false, error: 'invalid_amount' }
  return {
    ok: true,
    entry: {
      id: id || input.id || null,
      name,
      amount,
      status,
      source: input.source ? String(input.source).slice(0, 120) : null,
      renewable: input.renewable === true,
      notes: input.notes ? String(input.notes).slice(0, 2000) : null,
      deadline: input.deadline ? String(input.deadline).slice(0, 40) : null,
    },
  }
}

function committedPipeline(uniSection) {
  const committed = resolveCommittedCollege(uniSection)
  if (!committed) return { committed: null }
  return { committed, pipeline: Array.isArray(committed.financial_aid_pipeline) ? committed.financial_aid_pipeline : [] }
}

function withCommittedPipeline(uniSection, committedId, nextPipeline) {
  return {
    ...uniSection,
    applications: getApplications(uniSection).map((a) => (
      String(a.id) === String(committedId) ? { ...a, financial_aid_pipeline: nextPipeline } : a
    )),
  }
}

/**
 * Add a scholarship/aid entry to the committed college's financial-aid pipeline.
 * `id`/`now` injected by the caller. Returns { ok, error?, section?, entry? }.
 */
export function addAidEntry(uniSection, input, { id, now = null } = {}) {
  const { committed, pipeline } = committedPipeline(uniSection)
  if (!committed) return { ok: false, error: 'no_committed_college', section: uniSection }
  const norm = normalizeAidEntry(input, { id })
  if (!norm.ok) return { ok: false, error: norm.error, section: uniSection }
  const entry = { ...norm.entry, added_at: now, updated_at: now }
  const next = [...pipeline, entry]
  return { ok: true, section: withCommittedPipeline(uniSection, committed.id, next), entry }
}

/** Update an existing aid entry by id (partial patch). */
export function updateAidEntry(uniSection, entryId, patch = {}, { now = null } = {}) {
  const { committed, pipeline } = committedPipeline(uniSection)
  if (!committed) return { ok: false, error: 'no_committed_college', section: uniSection }
  const idx = pipeline.findIndex((a) => String(a?.id) === String(entryId))
  if (idx === -1) return { ok: false, error: 'aid_entry_not_found', section: uniSection }
  const merged = { ...pipeline[idx], ...patch, id: pipeline[idx].id }
  const norm = normalizeAidEntry(merged, { id: pipeline[idx].id })
  if (!norm.ok) return { ok: false, error: norm.error, section: uniSection }
  const next = pipeline.map((a, i) => (
    i === idx ? { ...norm.entry, added_at: pipeline[idx].added_at || now, updated_at: now } : a
  ))
  return { ok: true, section: withCommittedPipeline(uniSection, committed.id, next), entry: next[idx] }
}

/** Remove an aid entry by id. */
export function removeAidEntry(uniSection, entryId) {
  const { committed, pipeline } = committedPipeline(uniSection)
  if (!committed) return { ok: false, error: 'no_committed_college', section: uniSection }
  const next = pipeline.filter((a) => String(a?.id) !== String(entryId))
  if (next.length === pipeline.length) return { ok: false, error: 'aid_entry_not_found', section: uniSection }
  return { ok: true, section: withCommittedPipeline(uniSection, committed.id, next) }
}

export const HOUSING_STATUSES = Object.freeze(['on_campus', 'off_campus'])

function normalizeAddress(a = {}) {
  const s = (v) => (v === null || v === undefined ? null : String(v).trim().slice(0, 200) || null)
  return {
    line1: s(a.line1 ?? a.street ?? a.address),
    line2: s(a.line2),
    city: s(a.city),
    state: s(a.state),
    zip: s(a.zip ?? a.postal_code ?? a.zip_code),
  }
}

/**
 * Set the committed student's housing choice (on/off campus) + an off-campus
 * address. Pure. The address changes where funding crawlers search (see
 * resolveStudentFundingLocation). Returns { ok, error?, section }.
 */
export function setHousing(uniSection, { housing_status = null, address = null } = {}, { now = null } = {}) {
  const committed = resolveCommittedCollege(uniSection)
  if (!committed) return { ok: false, error: 'no_committed_college', section: uniSection }
  const status = housing_status === null ? null : normStatus(housing_status)
  if (status !== null && !HOUSING_STATUSES.includes(status)) return { ok: false, error: 'invalid_housing_status', section: uniSection }
  const nextAddress = address ? normalizeAddress(address) : (committed.student_address || null)
  const applications = getApplications(uniSection).map((a) => (
    a.id === committed.id
      ? { ...a, housing_status: status, student_address: nextAddress, housing_updated_at: now }
      : a
  ))
  return { ok: true, section: { ...uniSection, applications } }
}

/**
 * The location funding crawlers should search for a committed student:
 *   - off-campus with an address → that address's zip/state/city
 *   - otherwise (on-campus / committed) → the school's city/state
 * Returns null when no committed college (caller falls back to the home address).
 */
export function resolveStudentFundingLocation(uniSection) {
  const committed = resolveCommittedCollege(uniSection)
  if (!committed) return null
  const status = normStatus(committed.housing_status)
  const addr = committed.student_address || null
  if (status === 'off_campus' && addr && (addr.zip || addr.state || addr.city)) {
    return { zip: addr.zip || null, state: addr.state || null, city: addr.city || null, source: 'off_campus_address', college: committed.name || null }
  }
  if (committed.city || committed.state || committed.zip) {
    return { zip: committed.zip || null, state: committed.state || null, city: committed.city || null, source: 'committed_campus', college: committed.name || null }
  }
  return null
}

// Map the coarse blocked_* task statuses to a short, human label. The most
// specific reason usually lives in last_agent_message; this is the fallback
// when a task only carries a generic status.
const BLOCKED_STATUS_LABELS = {
  blocked: 'Blocked',
  blocked_login_required: 'Needs portal login',
  blocked_2fa: 'Needs two-factor code',
  blocked_captcha: 'Blocked by CAPTCHA',
  blocked_missing_info: 'Missing required info',
  blocked_terms_or_policy: 'Portal forbids automation',
}

// Turn a raw agent message into a concise, deduplicable reason. Preflight/engine
// messages are long and per-source; we keep the meaningful head so identical
// causes (e.g. "Profile is missing first name") collapse into one grouped line.
export function resolveBlockerReason(task = {}) {
  const raw = String(task?.last_agent_message || '').trim()
  if (raw) {
    // Strip the common "Hamilton Autopilot stopped at preflight: " prefix and
    // take the first clause so the same root cause groups together.
    const cleaned = raw
      .replace(/^Hamilton(\s+Autopilot)?\s+(stopped at preflight:|could not|)/i, (m) => m).trim()
    const head = cleaned.split(/[.;]\s|\s—\s/)[0].trim()
    return head.length > 90 ? `${head.slice(0, 87)}…` : head
  }
  return BLOCKED_STATUS_LABELS[String(task?.status || '')] || task?.current_step || 'Blocked'
}

function summarizeHamiltonTasks(tasks = []) {
  const list = Array.isArray(tasks) ? tasks : []
  const blocked = list.filter((t) => String(t?.status || '').includes('blocked'))

  // Group blocked tasks by their resolved human reason so the UI shows a few
  // meaningful lines with counts instead of N identical "blocked" rows.
  const groups = new Map()
  for (const t of blocked) {
    const reason = resolveBlockerReason(t)
    const g = groups.get(reason) || { reason, count: 0, task_ids: [] }
    g.count += 1
    if (g.task_ids.length < 25) g.task_ids.push(t.id)
    groups.set(reason, g)
  }
  const blockers = [...groups.values()].sort((a, b) => b.count - a.count)

  return {
    total: list.length,
    in_progress: list.filter((t) => ['in_progress', 'running', 'queued'].includes(String(t?.status))).length,
    completed: list.filter((t) => ['completed', 'submitted'].includes(String(t?.status))).length,
    blocked: blocked.length,
    blockers,
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
  // Only SECURED aid (awarded/received, or legacy status-less entries) reduces
  // unmet need; "applied for" is tracked separately so the student can see what's
  // still pending without it inflating their covered total.
  const aidReceived = aidPipeline
    .filter(aidIsSecured)
    .reduce((sum, a) => sum + (numOrNull(a?.amount) || 0), 0)
  const aidApplied = aidPipeline
    .filter(aidIsPending)
    .reduce((sum, a) => sum + (numOrNull(a?.amount) || 0), 0)
  const aidAppliedCount = aidPipeline.filter(aidIsPending).length
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
  if (fafsaStatus.stage === 'verification') {
    const vc = buildVerificationChecklist(edu)
    fafsa.verification = { active: true, remaining: vc.remaining, total: vc.total, complete: vc.complete }
  }

  // Both AWARDED and APPLIED-for aid count toward the student's running total
  // (and reduce unmet need); the awarded/applied split is preserved for display.
  const aidTotalInPlay = aidReceived + aidApplied
  const unmetNeed = coa.total === null
    ? null
    : Math.max(0, coa.total - aidTotalInPlay - matchedFundingTotal)

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
      housing_status: normStatus(college.housing_status) || null,
      student_address: college.student_address || null,
    },
    funding_location: resolveStudentFundingLocation(uni),
    cost_of_attendance: coa,
    fafsa,
    aid: {
      received_total: aidReceived,
      applied_total: aidApplied,
      applied_count: aidAppliedCount,
      // Awarded + applied combined — the figure that offsets cost of attendance.
      total_in_play: aidTotalInPlay,
      // Normalized, id-bearing items so the UI can render/edit each entry.
      pipeline: aidPipeline.map((a) => ({
        id: a.id || null,
        name: a.name || a.title || 'Scholarship',
        amount: numOrNull(a.amount),
        status: normStatus(a.status) || 'awarded',
        source: a.source || null,
        renewable: a.renewable === true,
        notes: a.notes || null,
        deadline: a.deadline || null,
        secured: aidIsSecured(a),
      })),
    },
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
