/**
 * /api/profiles/:profileId/committed-college/workspace  — GET the committed
 *   college financial-aid workspace (aggregated, read-only).
 * /api/profiles/:profileId/committed-college/commit      — POST { collegeId }:
 *   commit to one college; the others archive (drop off).
 * /api/profiles/:profileId/committed-college/uncommit    — POST { collegeId }:
 *   restore an archived college to its previous status.
 *
 * Mounted alongside studentPortals on /api (the /:profileId path is identical
 * from the client's perspective). The heavy logic lives in the pure, unit-tested
 * service backend/services/college/committedCollege.js — this file is the thin
 * DB wrapper (load sections + funding + tasks, transform, persist).
 */

import express from 'express'
import { randomUUID } from 'crypto'
import { requireAuthenticatedUser, getAuthUserId, getAccessibleProfileIds } from '../utils/accessControl.js'
import {
  commitToCollege,
  uncommitArchived,
  buildCollegeAidWorkspace,
  resolveCommittedCollege,
  getApplications,
  addAidEntry,
  updateAidEntry,
  removeAidEntry,
  setHousing,
  HOUSING_STATUSES,
} from '../services/college/committedCollege.js'
import { planCollegeFundingMerge } from '../services/college/collegeFundingMerge.js'
import {
  describeFafsaStatus, normalizeFafsaStatus, setFafsaStage,
  buildVerificationChecklist, setVerificationDoc,
} from '../services/college/fafsaStatus.js'
import { recordDismissal as recordPipelineDismissal, ensurePipelineDismissalsSchema } from '../services/pipelineDismissals.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('route:committed-college')
const router = express.Router()

const grantIdOf = (s) => s?.id ?? s?.grant_id ?? null

/**
 * Hard-delete the deselected funding items from this profile's pipeline and
 * record sticky tombstones so the matcher / Process All won't resurrect them.
 * Mirrors the cascade in DELETE /api/grants/:id. Best-effort per item — one
 * failure never aborts the rest. Returns the count actually removed.
 */
async function deleteDeselectedFromPipeline(db, { profileId, deselected, userId }) {
  let removed = 0
  try { await ensurePipelineDismissalsSchema(db) } catch { /* best-effort */ }
  for (const item of Array.isArray(deselected) ? deselected : []) {
    const grantId = grantIdOf(item)
    if (!grantId) continue
    try {
      const grantRow = await db
        .prepare('SELECT * FROM grants WHERE id = ? AND profile_id = ? LIMIT 1')
        .get(String(grantId), String(profileId))
      if (!grantRow) continue
      await db.prepare('DELETE FROM milestones WHERE grant_id = ?').run(String(grantId))
      await db.prepare('DELETE FROM expenses WHERE grant_id = ?').run(String(grantId))
      await db.prepare('DELETE FROM application_drafts WHERE grant_id = ?').run(String(grantId))
      await db.prepare('UPDATE documents SET grant_id = NULL WHERE grant_id = ?').run(String(grantId))
      await db.prepare('DELETE FROM grants WHERE id = ? AND profile_id = ?').run(String(grantId), String(profileId))
      removed += 1
      try {
        await recordPipelineDismissal(db, {
          profileId,
          grantRow,
          userId,
          reason: 'deselected_from_committed_college_merge',
        })
      } catch (tombErr) {
        log.warn('merge deselect tombstone failed', { grantId, error: tombErr?.message })
      }
    } catch (err) {
      log.warn('merge deselect delete failed', { grantId, error: err?.message })
    }
  }
  return removed
}

async function userMayAccessProfile(req, profileId) {
  const user = req.user || { role: 'guest' }
  if (!profileId) return false
  if (user.role === 'admin') return true
  const accessible = await getAccessibleProfileIds(req.db, user)
  if (accessible === null) return true // admin
  return accessible.has(String(profileId))
}

/** Load the profile sections we need for the workspace / commit. */
async function loadSections(db, profileId) {
  const sections = {}
  try {
    const rows = await db
      .prepare(`SELECT section_key, data FROM profile_sections WHERE profile_id = ? AND section_key IN ('university_applications', 'education')`)
      .all(String(profileId))
    for (const r of rows || []) {
      try { sections[r.section_key] = JSON.parse(r.data) } catch { sections[r.section_key] = {} }
    }
  } catch (err) {
    log.warn('loadSections failed', { error: err?.message })
  }
  return sections
}

/** Best-effort: funding matched to this profile (title + amount). Never throws. */
async function loadMatchedFunding(db, profileId) {
  try {
    const rows = await db
      .prepare(`SELECT id, funding_opportunity_id, title, amount_awarded, amount_requested FROM grants WHERE profile_id = ? ORDER BY updated_at DESC LIMIT 100`)
      .all(String(profileId))
    return (rows || []).map((r) => ({
      id: r.id,
      opportunity_id: r.funding_opportunity_id || null,
      title: r.title,
      amount: r.amount_awarded ?? r.amount_requested ?? null,
    }))
  } catch {
    return []
  }
}

/** Best-effort: Hamilton/application tasks for this profile. Never throws. */
async function loadHamiltonTasks(db, profileId) {
  try {
    // Select the fields that carry the human-readable blocker reason so the
    // workspace can show WHY a task is blocked (not a bare "blocked"). The real
    // reason lives in last_agent_message / current_step on the task row.
    const rows = await db
      .prepare(`SELECT id, status, last_agent_message, current_step, automation_type
                FROM application_tasks WHERE profile_id = ? ORDER BY updated_at DESC LIMIT 200`)
      .all(String(profileId))
    return rows || []
  } catch {
    return []
  }
}

async function persistUniversityApplications(db, profileId, userId, section) {
  const data = JSON.stringify(section)
  const existing = await db
    .prepare(`SELECT 1 AS x FROM profile_sections WHERE profile_id = ? AND section_key = 'university_applications'`)
    .get(String(profileId))
  if (existing) {
    await db
      .prepare(`UPDATE profile_sections SET data = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE profile_id = ? AND section_key = 'university_applications'`)
      .run(data, userId, String(profileId))
  } else {
    await db
      .prepare(`INSERT INTO profile_sections (profile_id, section_key, data, updated_by) VALUES (?, 'university_applications', ?, ?)`)
      .run(String(profileId), data, userId)
  }
}

async function persistEducation(db, profileId, userId, education) {
  const data = JSON.stringify(education)
  const existing = await db
    .prepare(`SELECT 1 AS x FROM profile_sections WHERE profile_id = ? AND section_key = 'education'`)
    .get(String(profileId))
  if (existing) {
    await db
      .prepare(`UPDATE profile_sections SET data = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE profile_id = ? AND section_key = 'education'`)
      .run(data, userId, String(profileId))
  } else {
    await db
      .prepare(`INSERT INTO profile_sections (profile_id, section_key, data, updated_by) VALUES (?, 'education', ?, ?)`)
      .run(String(profileId), data, userId)
  }
}

router.get('/profiles/:profileId/fafsa-status', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const { profileId } = req.params
  if (!(await userMayAccessProfile(req, profileId))) return res.status(403).json({ error: 'Forbidden' })
  try {
    const sections = await loadSections(req.db, profileId)
    return res.json({ ok: true, fafsa: describeFafsaStatus(sections.education || {}) })
  } catch (err) {
    log.error('GET fafsa-status failed', { error: err?.message })
    return res.status(500).json({ ok: false, error: 'fafsa_status_failed' })
  }
})

router.post('/profiles/:profileId/fafsa-status', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const { profileId } = req.params
  const stage = req.body?.stage
  if (!stage) return res.status(400).json({ ok: false, error: 'stage is required' })
  if (!(await userMayAccessProfile(req, profileId))) return res.status(403).json({ error: 'Forbidden' })
  try {
    const sections = await loadSections(req.db, profileId)
    const education = sections.education || {}
    const current = normalizeFafsaStatus(education)
    const result = setFafsaStage(current, stage, { now: new Date().toISOString() })
    if (!result.ok) return res.status(400).json({ ok: false, error: result.error })
    education.fafsa_status = result.status
    education.fafsa_completed = result.fafsa_completed
    await persistEducation(req.db, profileId, getAuthUserId(user), education)
    return res.json({ ok: true, fafsa: describeFafsaStatus(education) })
  } catch (err) {
    log.error('POST fafsa-status failed', { error: err?.message })
    return res.status(500).json({ ok: false, error: 'fafsa_status_update_failed' })
  }
})

router.get('/profiles/:profileId/fafsa-verification', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const { profileId } = req.params
  if (!(await userMayAccessProfile(req, profileId))) return res.status(403).json({ error: 'Forbidden' })
  try {
    const sections = await loadSections(req.db, profileId)
    return res.json({ ok: true, verification: buildVerificationChecklist(sections.education || {}) })
  } catch (err) {
    log.error('GET fafsa-verification failed', { error: err?.message })
    return res.status(500).json({ ok: false, error: 'fafsa_verification_failed' })
  }
})

router.post('/profiles/:profileId/fafsa-verification', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const { profileId } = req.params
  const key = req.body?.key
  const done = req.body?.done
  if (!key) return res.status(400).json({ ok: false, error: 'key is required' })
  if (!(await userMayAccessProfile(req, profileId))) return res.status(403).json({ error: 'Forbidden' })
  try {
    const sections = await loadSections(req.db, profileId)
    const education = sections.education || {}
    const result = setVerificationDoc(education, key, done)
    if (!result.ok) return res.status(400).json({ ok: false, error: result.error })
    education.fafsa_verification_docs = result.fafsa_verification_docs
    await persistEducation(req.db, profileId, getAuthUserId(user), education)
    return res.json({ ok: true, verification: buildVerificationChecklist(education) })
  } catch (err) {
    log.error('POST fafsa-verification failed', { error: err?.message })
    return res.status(500).json({ ok: false, error: 'fafsa_verification_update_failed' })
  }
})

router.get('/profiles/:profileId/committed-college/workspace', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const { profileId } = req.params
  if (!(await userMayAccessProfile(req, profileId))) return res.status(403).json({ error: 'Forbidden' })
  try {
    const [sections, matchedFunding, hamiltonTasks] = await Promise.all([
      loadSections(req.db, profileId),
      loadMatchedFunding(req.db, profileId),
      loadHamiltonTasks(req.db, profileId),
    ])
    const workspace = buildCollegeAidWorkspace({ sections, matchedFunding, hamiltonTasks })
    return res.json({ ok: true, workspace })
  } catch (err) {
    log.error('GET committed-college/workspace failed', { error: err?.message })
    return res.status(500).json({ ok: false, error: 'committed_college_workspace_failed' })
  }
})

router.post('/profiles/:profileId/committed-college/commit', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const { profileId } = req.params
  const collegeId = req.body?.collegeId ?? req.body?.college_id
  if (!collegeId) return res.status(400).json({ ok: false, error: 'collegeId is required' })
  if (!(await userMayAccessProfile(req, profileId))) return res.status(403).json({ error: 'Forbidden' })
  try {
    const sections = await loadSections(req.db, profileId)
    const uni = sections.university_applications || { applications: [] }
    const result = commitToCollege(uni, collegeId, { now: new Date().toISOString() })
    if (!result.ok) return res.status(404).json({ ok: false, error: result.error })
    await persistUniversityApplications(req.db, profileId, getAuthUserId(user), result.section)
    return res.json({ ok: true, committed_id: result.committed_id, archived: result.archived })
  } catch (err) {
    log.error('POST committed-college/commit failed', { error: err?.message })
    return res.status(500).json({ ok: false, error: 'committed_college_commit_failed' })
  }
})

router.post('/profiles/:profileId/committed-college/uncommit', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const { profileId } = req.params
  const collegeId = req.body?.collegeId ?? req.body?.college_id
  if (!collegeId) return res.status(400).json({ ok: false, error: 'collegeId is required' })
  if (!(await userMayAccessProfile(req, profileId))) return res.status(403).json({ error: 'Forbidden' })
  try {
    const sections = await loadSections(req.db, profileId)
    const uni = sections.university_applications || { applications: [] }
    const result = uncommitArchived(uni, collegeId)
    if (!result.ok) return res.status(404).json({ ok: false, error: result.error })
    await persistUniversityApplications(req.db, profileId, getAuthUserId(user), result.section)
    return res.json({ ok: true })
  } catch (err) {
    log.error('POST committed-college/uncommit failed', { error: err?.message })
    return res.status(500).json({ ok: false, error: 'committed_college_uncommit_failed' })
  }
})

/**
 * Merge selected matched funding into Hamilton for the committed college.
 * Returns a compliance-annotated plan; if { authorize:true }, hands the
 * autopilot/packet-able (non-federal) items to Hamilton's automateSelected.
 * Federal/FAFSA + institutional items are never auto-submitted (user_confirm).
 */
router.post('/profiles/:profileId/committed-college/merge-funding', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const { profileId } = req.params
  if (!(await userMayAccessProfile(req, profileId))) return res.status(403).json({ error: 'Forbidden' })

  const selectedFunding = Array.isArray(req.body?.selectedFunding) ? req.body.selectedFunding : []
  if (!selectedFunding.length) return res.status(400).json({ ok: false, error: 'selectedFunding is required' })
  const authorize = req.body?.authorize === true

  try {
    const sections = await loadSections(req.db, profileId)
    const workspace = buildCollegeAidWorkspace({ sections })
    const plan = planCollegeFundingMerge({ workspace, selectedFunding })
    if (!plan.ok) return res.status(409).json({ ok: false, error: plan.error })

    let handoff = null
    if (authorize && plan.automatable_ids.length) {
      try {
        const { automateSelected } = await import('../services/hamilton/hamiltonAutomationOrchestrator.js')
        const idOf = (s) => s.id ?? s.opportunity_id ?? s.grant_id ?? s.funding_opportunity_id
        const selectedSources = selectedFunding.filter((s) => plan.automatable_ids.includes(idOf(s)))
        handoff = await automateSelected(req.db, {
          profileId,
          userId: getAuthUserId(user),
          selectedSources,
          options: { source: 'committed_college_merge' },
        })
      } catch (err) {
        log.warn('committed-college merge handoff failed', { error: err?.message })
        handoff = { ok: false, error: 'hamilton_handoff_failed' }
      }
    }

    // Optionally remove the items the user did NOT select from the pipeline.
    let removed = 0
    const deselectedFunding = Array.isArray(req.body?.deselectedFunding) ? req.body.deselectedFunding : []
    if (authorize && deselectedFunding.length) {
      removed = await deleteDeselectedFromPipeline(req.db, {
        profileId,
        deselected: deselectedFunding,
        userId: getAuthUserId(user),
      })
    }

    return res.json({ ok: true, plan, handoff, removed })
  } catch (err) {
    log.error('POST committed-college/merge-funding failed', { error: err?.message })
    return res.status(500).json({ ok: false, error: 'committed_college_merge_failed' })
  }
})

/**
 * Set the cost-of-attendance for the committed college. The COA grid + unmet-need
 * read from the committed application's `costs` object; nothing else wrote it, so
 * the workspace showed blanks and a dead "Add COA" label. Persists the provided
 * fields onto that application and returns the recomputed workspace.
 */
router.post('/profiles/:profileId/committed-college/cost-of-attendance', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const { profileId } = req.params
  if (!(await userMayAccessProfile(req, profileId))) return res.status(403).json({ error: 'Forbidden' })

  const num = (v) => {
    if (v === '' || v === null || v === undefined) return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }

  try {
    const sections = await loadSections(req.db, profileId)
    const uni = sections.university_applications || {}
    const committed = resolveCommittedCollege(uni)
    if (!committed) return res.status(409).json({ ok: false, error: 'no_committed_college' })

    const body = req.body || {}
    const patch = {}
    for (const k of ['tuition', 'housing', 'books', 'other', 'total']) {
      if (k in body) patch[k] = num(body[k])
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ ok: false, error: 'no_coa_fields' })
    }

    const nextUni = {
      ...uni,
      applications: getApplications(uni).map((a) => (
        a.id === committed.id ? { ...a, costs: { ...(a.costs || {}), ...patch } } : a
      )),
    }
    await persistUniversityApplications(req.db, profileId, getAuthUserId(user), nextUni)

    const workspace = buildCollegeAidWorkspace({
      sections: { ...sections, university_applications: nextUni },
    })
    return res.json({ ok: true, workspace })
  } catch (err) {
    log.error('POST committed-college/cost-of-attendance failed', { error: err?.message })
    return res.status(500).json({ ok: false, error: 'cost_of_attendance_failed' })
  }
})

/**
 * Scholarships / financial-aid entries on the committed college.
 *   POST   .../committed-college/aid            — add { name, amount, status, source?, notes?, deadline?, renewable? }
 *   PATCH  .../committed-college/aid/:entryId    — update (partial)
 *   DELETE .../committed-college/aid/:entryId    — remove
 *
 * status ∈ awarded|received|accepted (secured → reduces unmet need) or
 * applied|pending (tracked but not counted) or declined. Each returns the
 * recomputed workspace so the UI updates aid-received / unmet-need in one round-trip.
 */
async function recomputeWorkspace(db, profileId, nextUni, sections) {
  return buildCollegeAidWorkspace({
    sections: { ...sections, university_applications: nextUni },
    matchedFunding: await loadMatchedFunding(db, profileId),
    hamiltonTasks: await loadHamiltonTasks(db, profileId),
  })
}

router.post('/profiles/:profileId/committed-college/aid', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const { profileId } = req.params
  if (!(await userMayAccessProfile(req, profileId))) return res.status(403).json({ error: 'Forbidden' })
  try {
    const sections = await loadSections(req.db, profileId)
    const uni = sections.university_applications || { applications: [] }
    const result = addAidEntry(uni, req.body || {}, { id: randomUUID(), now: new Date().toISOString() })
    if (!result.ok) {
      const code = result.error === 'no_committed_college' ? 409 : 400
      return res.status(code).json({ ok: false, error: result.error })
    }
    await persistUniversityApplications(req.db, profileId, getAuthUserId(user), result.section)
    return res.json({ ok: true, entry: result.entry, workspace: await recomputeWorkspace(req.db, profileId, result.section, sections) })
  } catch (err) {
    log.error('POST committed-college/aid failed', { error: err?.message })
    return res.status(500).json({ ok: false, error: 'aid_add_failed' })
  }
})

router.patch('/profiles/:profileId/committed-college/aid/:entryId', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const { profileId, entryId } = req.params
  if (!(await userMayAccessProfile(req, profileId))) return res.status(403).json({ error: 'Forbidden' })
  try {
    const sections = await loadSections(req.db, profileId)
    const uni = sections.university_applications || { applications: [] }
    const result = updateAidEntry(uni, entryId, req.body || {}, { now: new Date().toISOString() })
    if (!result.ok) {
      const code = result.error === 'aid_entry_not_found' ? 404 : result.error === 'no_committed_college' ? 409 : 400
      return res.status(code).json({ ok: false, error: result.error })
    }
    await persistUniversityApplications(req.db, profileId, getAuthUserId(user), result.section)
    return res.json({ ok: true, entry: result.entry, workspace: await recomputeWorkspace(req.db, profileId, result.section, sections) })
  } catch (err) {
    log.error('PATCH committed-college/aid failed', { error: err?.message })
    return res.status(500).json({ ok: false, error: 'aid_update_failed' })
  }
})

router.delete('/profiles/:profileId/committed-college/aid/:entryId', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const { profileId, entryId } = req.params
  if (!(await userMayAccessProfile(req, profileId))) return res.status(403).json({ error: 'Forbidden' })
  try {
    const sections = await loadSections(req.db, profileId)
    const uni = sections.university_applications || { applications: [] }
    const result = removeAidEntry(uni, entryId)
    if (!result.ok) {
      const code = result.error === 'aid_entry_not_found' ? 404 : result.error === 'no_committed_college' ? 409 : 400
      return res.status(code).json({ ok: false, error: result.error })
    }
    await persistUniversityApplications(req.db, profileId, getAuthUserId(user), result.section)
    return res.json({ ok: true, workspace: await recomputeWorkspace(req.db, profileId, result.section, sections) })
  } catch (err) {
    log.error('DELETE committed-college/aid failed', { error: err?.message })
    return res.status(500).json({ ok: false, error: 'aid_remove_failed' })
  }
})

/**
 * Set the committed student's housing (on/off campus) + off-campus address.
 * Changes where funding crawlers search for this profile (loadProfileContext
 * re-points geo location at the school's area / the off-campus address).
 */
router.post('/profiles/:profileId/committed-college/housing', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const { profileId } = req.params
  if (!(await userMayAccessProfile(req, profileId))) return res.status(403).json({ error: 'Forbidden' })
  const housing_status = req.body?.housing_status ?? null
  if (housing_status !== null && !HOUSING_STATUSES.includes(String(housing_status))) {
    return res.status(400).json({ ok: false, error: `housing_status must be one of: ${HOUSING_STATUSES.join(', ')}` })
  }
  try {
    const sections = await loadSections(req.db, profileId)
    const uni = sections.university_applications || { applications: [] }
    const result = setHousing(uni, { housing_status, address: req.body?.address || null }, { now: new Date().toISOString() })
    if (!result.ok) return res.status(result.error === 'no_committed_college' ? 409 : 400).json({ ok: false, error: result.error })
    await persistUniversityApplications(req.db, profileId, getAuthUserId(user), result.section)
    const workspace = buildCollegeAidWorkspace({ sections: { ...sections, university_applications: result.section } })
    return res.json({ ok: true, workspace })
  } catch (err) {
    log.error('POST committed-college/housing failed', { error: err?.message })
    return res.status(500).json({ ok: false, error: 'housing_update_failed' })
  }
})

export default router
