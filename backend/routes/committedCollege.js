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
import { requireAuthenticatedUser, getAuthUserId, getAccessibleProfileIds } from '../utils/accessControl.js'
import {
  commitToCollege,
  uncommitArchived,
  buildCollegeAidWorkspace,
} from '../services/college/committedCollege.js'
import { planCollegeFundingMerge } from '../services/college/collegeFundingMerge.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('route:committed-college')
const router = express.Router()

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
    const rows = await db
      .prepare(`SELECT id, status FROM application_tasks WHERE profile_id = ? ORDER BY updated_at DESC LIMIT 200`)
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

    return res.json({ ok: true, plan, handoff })
  } catch (err) {
    log.error('POST committed-college/merge-funding failed', { error: err?.message })
    return res.status(500).json({ ok: false, error: 'committed_college_merge_failed' })
  }
})

export default router
