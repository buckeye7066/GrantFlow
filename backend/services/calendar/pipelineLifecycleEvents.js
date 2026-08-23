// backend/services/calendar/pipelineLifecycleEvents.js
//
// Funder-aware funding-lifecycle calendar events for a profile's pipeline
// (owner rule 2026-08-23): a submission shows on the user's calendar with its
// submission date, plus the cornerstones — expected award/rejection date, award
// date, grant period, and required funder follow-ups (e.g. "25% of the award
// spent within 90 days") — and application deadlines for pipeline sources.
//
// HONESTY IS THE WHOLE POINT: every date is either a REAL stored date or one
// COMPUTED from a funder-stated rule the crawler captured. A cornerstone whose
// date we do not know is OMITTED — never invented, never guessed. Estimated
// dates (a decision window derived from a stated review length) are labeled
// `estimated: true` so the UI can mark them as such.
//
// Pure: no I/O. Callers pass the joined grant + opportunity row; the route does
// the DB work. Every event shares the shape the calendar feed already renders
// (`deadline` = the event's date, `title`), plus `type`/`label`/`estimated`/
// `funding_source` so the UI can group and style the lifecycle.

const DAY_MS = 86_400_000

/** Parse a date-ish value to YYYY-MM-DD, or null. Never throws. */
function isoDate(value) {
  if (!value) return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10)
  const s = String(value).trim()
  if (!s || /^rolling$/i.test(s)) return null
  // Already YYYY-MM-DD (or a timestamp starting with it).
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/)
  if (m) return m[1]
  const t = Date.parse(s)
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null
}

/** Add whole days to a YYYY-MM-DD date, returning YYYY-MM-DD (UTC-safe). */
function addDays(iso, days) {
  const t = Date.parse(`${iso}T00:00:00Z`)
  if (!Number.isFinite(t) || !Number.isFinite(days)) return null
  return new Date(t + days * DAY_MS).toISOString().slice(0, 10)
}

const TERMINAL_REPORTING_ANCHORS = Object.freeze(['award_date', 'submitted_date'])

/**
 * Reporting/follow-up requirements the funder stated, captured by the crawler
 * as a JSON array on the opportunity. Each entry:
 *   { label, offset_days, anchor?: 'award_date'|'submitted_date', due_date? }
 * A concrete `due_date` wins; otherwise `anchor + offset_days` computes one from
 * a REAL stored date. Anything that cannot resolve to a real date is skipped
 * (never placed on the calendar as a guess).
 */
function parseReportingRequirements(raw) {
  if (!raw) return []
  let list = raw
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw) } catch { return [] }
  }
  if (!Array.isArray(list)) return []
  return list
    .map((r) => (r && typeof r === 'object' ? r : null))
    .filter(Boolean)
    .filter((r) => typeof r.label === 'string' && r.label.trim())
}

/**
 * Derive the lifecycle events for ONE pipeline row.
 * @param {object} row grant + opportunity fields (snake_case), plus title/sponsor
 * @param {object} [opts]
 * @param {string} [opts.today] YYYY-MM-DD (injectable for tests; used only to
 *   decide whether an application deadline is still upcoming)
 * @returns {Array<{id,deadline,title,type,label,estimated,funding_source,grant_id,opportunity_id}>}
 */
export function deriveLifecycleEvents(row, { today = null } = {}) {
  if (!row || typeof row !== 'object') return []
  const events = []
  const title = String(row.title || row.opportunity_title || 'Funding opportunity').slice(0, 160)
  const funder = row.sponsor || row.funder || null
  const status = String(row.pipeline_status || row.status || '').toLowerCase()
  const oppId = row.opportunity_id || row.funding_opportunity_id || row.id || null
  const grantId = row.grant_id || row.id || null
  const base = { funding_source: funder, grant_id: grantId, opportunity_id: oppId }
  const push = (type, date, label, extra = {}) => {
    const d = isoDate(date)
    if (!d) return
    events.push({
      id: `${type}:${grantId || oppId || 'x'}:${d}`,
      deadline: d,
      title: `${label}: ${title}`,
      type,
      label,
      estimated: false,
      ...base,
      ...extra,
    })
  }

  const submitted = isoDate(row.submitted_date)
  const awardDate = isoDate(row.award_date)

  // 1. APPLICATION DEADLINE — only while the row is not yet submitted (a
  //    submitted row's deadline is history). deadline_type 'rolling' has no date.
  if (!submitted && String(row.deadline_type || '').toLowerCase() !== 'rolling') {
    const dl = isoDate(row.deadline)
    if (dl && (!today || dl >= today)) push('apply_deadline', dl, 'Apply by')
  }

  // 2. SUBMITTED — the cornerstone the owner asked for first.
  if (submitted) push('submitted', submitted, 'Submitted')

  // 3. EXPECTED DECISION (award/rejection). Funder-aware:
  //    - a captured concrete `expected_decision_date` is authoritative;
  //    - else, if the funder stated a review LENGTH (`decision_review_days`) and
  //      we have a submission date, compute an ESTIMATED window end and LABEL it;
  //    - else omit (no invented date). Never emitted once the award landed.
  if (!awardDate) {
    const stated = isoDate(row.expected_decision_date)
    if (stated) {
      push('expected_decision', stated, 'Expected decision')
    } else {
      const reviewDays = Number(row.decision_review_days)
      if (submitted && Number.isFinite(reviewDays) && reviewDays > 0) {
        push('expected_decision', addDays(submitted, reviewDays), 'Expected decision (estimated)', { estimated: true })
      }
    }
  }

  // 4. AWARD DATE.
  if (awardDate) push('awarded', awardDate, 'Awarded')

  // 5. GRANT PERIOD (a funded award's performance window).
  if (row.start_date) push('grant_start', row.start_date, 'Grant period begins')
  if (row.end_date) push('grant_end', row.end_date, 'Grant period ends / closeout')

  // 6. FUNDER-REQUIRED FOLLOW-UPS / REPORTING. Each resolves to a REAL date or
  //    is skipped: an absolute `due_date`, or `anchor + offset_days` off a real
  //    stored date (award_date preferred, else submitted_date).
  for (const req of parseReportingRequirements(row.reporting_requirements)) {
    let due = isoDate(req.due_date)
    if (!due && Number.isFinite(Number(req.offset_days))) {
      const anchorKey = TERMINAL_REPORTING_ANCHORS.includes(req.anchor) ? req.anchor : (awardDate ? 'award_date' : 'submitted_date')
      const anchorDate = anchorKey === 'award_date' ? awardDate : submitted
      if (anchorDate) due = addDays(anchorDate, Number(req.offset_days))
    }
    if (!due) continue // no resolvable date → not a calendar event (never guessed)
    push('reporting', due, `Report due — ${String(req.label).slice(0, 80)}`)
  }

  return events
}

/** Derive lifecycle events for a set of pipeline rows, flattened + sorted. */
export function deriveLifecycleEventsForPipeline(rows, opts = {}) {
  const out = []
  for (const row of Array.isArray(rows) ? rows : []) out.push(...deriveLifecycleEvents(row, opts))
  out.sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)))
  return out
}

export const LIFECYCLE_EVENT_TYPES = Object.freeze([
  'apply_deadline', 'submitted', 'expected_decision', 'awarded', 'grant_start', 'grant_end', 'reporting',
])

export default { deriveLifecycleEvents, deriveLifecycleEventsForPipeline, LIFECYCLE_EVENT_TYPES }
