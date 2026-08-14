/**
 * generalApplicationCoverage.js — reflect a school's UMBRELLA application onto
 * every portal link it governs.
 *
 * OWNER RULE (2026-08-02): "If the school determines eligibility based on the
 * one general application, and that general application is complete, then that
 * should be reflected in those related portals."
 *
 * THE REAL SHAPE OF THE PROBLEM (measured in prod on Demo Student's profile):
 * MTSU's Scholarship Manager portal says, in its own words, "you can NOT apply
 * individually to scholarships … you apply by completing the scholarship
 * application(s)" — yet the pipeline held SIX individual MTSU scholarships
 * (True Blue, Centennial, Academic Service, Honors College, Foundation
 * Need-Based, CBAS Forensic Science) at pending_review/portal, each with its
 * own Hamilton task at waiting_for_review, each implying she still had to act.
 * Her General Scholarship Application was verified SUBMITTED by the portal
 * sync ("Thank you for your submission of the Middle Tennessee State
 * University Scholarship Application(s)."). Those rows described work that
 * does not exist.
 *
 * WHAT THIS DOES, only when a portal-sync READ verifies the general
 * application submitted (quote-anchored evidence + the sync run id):
 *   1. marks the portal itself COMPLETE (profile_portal_status, with proof);
 *   2. advances the profile's GOVERNED pipeline grants to `submitted` — with
 *      submitted_date and a provenance note naming the general application
 *      and the sync run (enforceImportedStatusHonesty requires exactly this:
 *      a submitted with NULL submitted_date + import provenance is demoted);
 *   3. completes the matching Hamilton application_tasks with an agent
 *      message saying WHY no separate application exists.
 *
 * PRECISION RULES (the #937 one-shared-word class, and its locals):
 *   - Only URL-structural claims: a grant is governed when its application
 *     target is ON the tenant portal itself, on the school's LEGACY
 *     scholarship portal, or on a school page whose PATH names scholarships.
 *     "mtsu.edu" alone is NEVER enough — the same host serves admissions,
 *     housing, the emergency fund and work-study, none of which the General
 *     Scholarship Application covers (all six were live on this profile and
 *     all six must be left alone).
 *   - Only pre-submission statuses are advanced; a human-progressed or
 *     terminal row is never touched, and nothing is ever demoted.
 *   - No verified submission ⇒ hard no-op. "The portal says complete" is the
 *     only trigger; this module never infers.
 */

import { createLogger } from '../../../utils/logger.js'
import { markPortalComplete } from '../portalCompletionStore.js'
import {
  listApplicationTasks, updateApplicationTask, appendTaskEvent, TASK_TERMINAL_STATUSES,
} from '../applicationTaskStore.js'

const log = createLogger('service:generalApplicationCoverage')

/**
 * Which URLs a school's general scholarship application GOVERNS, by NGWeb
 * tenant slug. `hostRe` must match the URL's host; `pathRe` (when present)
 * must ALSO match its path. An entry with no pathRe governs the whole host
 * (dedicated scholarship portals only — never a school's main site).
 */
export const UMBRELLA_GOVERNED_URLS = Object.freeze({
  mtsu: [
    // The scholarship portal itself (any tenant path).
    { hostRe: /(^|\.)mtsu\.scholarships\.ngwebsolutions\.com$/i },
    // The LEGACY dedicated scholarship portal (AcademicWorks) — catalog rows
    // still point at it (live prod row: "MTSU Foundation Need-Based
    // Scholarships" → https://mtsu.academicworks.com/).
    { hostRe: /(^|\.)mtsu\.academicworks\.com$/i },
    // School pages whose PATH names scholarships (financial-aid/scholarships/
    // *.php, cbas/scholarships.php, honors/scholarships.php — all live rows).
    { hostRe: /(^|\.)mtsu\.edu$/i, pathRe: /scholarship/i },
  ],
  clevelandstatecc: [
    { hostRe: /(^|\.)clevelandstatecc\.scholarships\.ngwebsolutions\.com$/i },
    { hostRe: /(^|\.)clevelandstatecc\.edu$/i, pathRe: /scholarship/i },
  ],
})

/** Is this URL governed by the tenant's general scholarship application? */
export function governedByGeneralApplication(tenant, url) {
  const rules = UMBRELLA_GOVERNED_URLS[String(tenant || '').toLowerCase()]
  if (!rules || !url) return false
  let u
  try { u = new URL(String(url)) } catch { return false }
  return rules.some((r) => r.hostRe.test(u.hostname) && (!r.pathRe || r.pathRe.test(u.pathname)))
}

// Pre-submission pipeline statuses this coverage may ADVANCE. Anything else —
// submitted/awarded/declined/archived, or a status we do not recognize — is
// left exactly as it is (never demote, never guess).
const ADVANCEABLE_GRANT_STATUSES = Object.freeze([
  'discovered', 'pending_review', 'portal', 'researching', 'preparing', 'ready_to_submit',
])

/** Rows an UPDATE actually touched. SQLite reports `changes`, pg `rowCount`. */
function rowsChanged(result) {
  return Number(result?.changes ?? result?.rowCount ?? 0)
}

/**
 * Apply verified general-application coverage for one profile + tenant.
 *
 * @param {object} db
 * @param {object} opts
 * @param {string} opts.profileId
 * @param {string} opts.portalHost   the NGWeb tenant host that was synced
 * @param {string} opts.tenant       tenant slug ('mtsu', 'clevelandstatecc')
 * @param {{status:string, evidence:string}|null} opts.generalApplication
 *        the connector's quote-anchored derivation
 * @param {string|null} opts.syncRunId
 * @returns {Promise<object>} honest counts for the run summary
 */
export async function applyGeneralApplicationCoverage(db, {
  profileId, portalHost, tenant, generalApplication, syncRunId = null,
} = {}) {
  const out = {
    applied: false,
    portal_marked_complete: false,
    grants_advanced: [],
    grants_advance_conflicted: 0,
    grants_skipped_not_governed: 0,
    tasks_completed: [],
  }
  if (!db || !profileId || !tenant) return out
  // The ONLY trigger is a verified submission. no_open_applications, null,
  // or anything else is a hard no-op.
  if (generalApplication?.status !== 'submitted' || !generalApplication?.evidence) return out
  out.applied = true

  const evidence = `general application submitted — portal's own words: "${generalApplication.evidence}"`

  // 1) The portal tile itself: COMPLETE (application done; results pending).
  try {
    const marked = await markPortalComplete(db, {
      profileId, portalHost, evidence, syncRunId, source: 'portal_sync_general_application',
    })
    out.portal_marked_complete = Boolean(marked)
  } catch (err) {
    log.warn('portal_complete_failed', { profileId: String(profileId), portalHost, err: err?.message })
  }

  // 2) Governed pipeline grants → submitted, with provenance.
  let grants = []
  try {
    grants = await db.prepare(
      `SELECT id, title, status, application_url, url, portal_url, notes
         FROM grants WHERE profile_id = ?`,
    ).all(String(profileId))
  } catch (err) {
    log.warn('grants_read_failed', { profileId: String(profileId), err: err?.message })
    grants = []
  }
  const governedGrantIds = new Set()
  const nowIso = new Date().toISOString()
  for (const g of grants || []) {
    const target = g?.application_url || g?.portal_url || g?.url || null
    if (!governedByGeneralApplication(tenant, target)) { out.grants_skipped_not_governed += 1; continue }
    governedGrantIds.add(String(g.id))
    const status = String(g?.status || '').toLowerCase()
    if (!ADVANCEABLE_GRANT_STATUSES.includes(status)) continue // already progressed or terminal — never touched
    const note = `Covered by the school's General Scholarship Application (verified submitted via Hamilton portal sync${syncRunId ? ` ${syncRunId}` : ''} on ${nowIso}): the portal states scholarships cannot be applied to individually. Evidence: "${generalApplication.evidence}"`
    try {
      const res = await db.prepare(
        `UPDATE grants
            SET status = 'submitted',
                submitted_date = COALESCE(submitted_date, ?),
                notes = CASE WHEN COALESCE(notes, '') = '' THEN ? ELSE notes || ${db?.dialect === 'postgres' ? `E'\\n'` : `char(10)`} || ? END,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = ?`,
      ).run(nowIso, note, note, String(g.id), g.status)
      // A STATUS CLAIM IS ONLY TRUE IF THE WRITE LANDED (2026-08-14). The
      // optimistic `AND status = ?` guard is correct — it refuses to advance a
      // row someone else moved mid-run — but its result was DISCARDED and
      // `grants_advanced` was pushed unconditionally. So a 0-row update (a
      // concurrent status change, or stored casing differing from the
      // lowercased `status` the eligibility check used) still reported the
      // grant advanced to `submitted` to the run summary and every surface
      // reading it. That is a submission claim made without verifying it
      // happened — the same class as the packet-as-proof defect. A refused
      // update is now counted as a CONFLICT, never as an advance.
      if (rowsChanged(res) > 0) {
        out.grants_advanced.push({ id: String(g.id), title: g.title, from: g.status })
      } else {
        out.grants_advance_conflicted += 1
        log.warn('grant_advance_no_rows', { grantId: String(g.id), expectedStatus: g.status })
      }
    } catch (err) {
      log.warn('grant_advance_failed', { grantId: String(g.id), err: err?.message })
    }
  }

  // 3) Hamilton tasks for governed targets → completed, with the reason.
  let tasks = []
  try {
    tasks = await listApplicationTasks(db, { profileId, limit: 500 })
  } catch (err) {
    log.warn('tasks_read_failed', { profileId: String(profileId), err: err?.message })
    tasks = []
  }
  const terminal = new Set([...(TASK_TERMINAL_STATUSES || []), 'completed', 'cancelled'])
  for (const t of tasks || []) {
    if (terminal.has(String(t?.status || '').toLowerCase())) continue
    const target = t?.portal_url || t?.application_url || null
    const governed = governedByGeneralApplication(tenant, target)
      || (t?.grant_id && governedGrantIds.has(String(t.grant_id)))
    if (!governed) continue
    const message = 'No separate application exists for this scholarship: the school\'s portal states scholarships cannot be applied to individually. It is covered by the General Scholarship Application, which the portal confirms was submitted. The school\'s committee decides from here (matching runs Mondays and Thursdays).'
    try {
      await updateApplicationTask(db, t.id, {
        status: 'completed',
        completedAt: nowIso,
        lastAgentMessage: message,
      })
      try {
        await appendTaskEvent(db, {
          taskId: t.id,
          eventType: 'general_application_coverage',
          status: 'completed',
          message,
          details: { portal_host: portalHost, sync_run_id: syncRunId, evidence: generalApplication.evidence },
        })
      } catch { /* the event is audit sugar — the completion is the fact */ }
      out.tasks_completed.push({ id: String(t.id), title: t?.title || null })
    } catch (err) {
      log.warn('task_complete_failed', { taskId: String(t?.id), err: err?.message })
    }
  }

  log.info('general_application_coverage_applied', {
    profileId: String(profileId), portalHost, tenant,
    grants: out.grants_advanced.length, tasks: out.tasks_completed.length,
  })
  return out
}

export default { applyGeneralApplicationCoverage, governedByGeneralApplication, UMBRELLA_GOVERNED_URLS }
