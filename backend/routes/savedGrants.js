/**
 * Saved Grants API
 *
 * GET    /api/saved-grants              — list saved grants for authenticated user
 * POST   /api/saved-grants              — save a grant (optional notes)
 * PATCH  /api/saved-grants/:id/notes    — update notes on a saved grant
 * DELETE /api/saved-grants/:id          — unsave a grant (id = opportunity_id)
 */

import { Router } from 'express'
import crypto from 'node:crypto'
import { requireAuthenticatedUser } from '../utils/accessControl.js'
import {
  assessOpportunityTrust,
  buildTrustMetadata,
} from '../services/opportunityTrust.js'
import { ensureSavedGrantsSchema } from '../services/savedGrantsSchema.js'
import { getProfileContext } from '../middleware/profileContext.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:savedGrants')

const router = Router()

// Resolve the active profile id for this request. Order:
//   1. ?profile_id=…       (explicit override; honored for admin/inspect tools)
//   2. X-Profile-Id header (set by the frontend client)
//   3. profileContext      (AsyncLocalStorage middleware — same source the SQL
//                            scoping layer uses)
// Returns null if none of those carry a value, in which case the caller must
// decide whether to allow the operation (GET/DELETE: yes, with legacy-NULL
// visibility; POST: no, reject — saves are profile-scoped now).
function resolveActiveProfileId(req) {
  const fromQuery = req?.query?.profile_id ?? req?.query?.profileId
  if (fromQuery && String(fromQuery).trim()) return String(fromQuery).trim()
  const fromHeader = req?.headers?.['x-profile-id']
  if (fromHeader && String(fromHeader).trim()) return String(fromHeader).trim()
  const ctx = getProfileContext()
  if (ctx?.profileId && String(ctx.profileId).trim()) return String(ctx.profileId).trim()
  return null
}

// Columns we want to project off `funding_opportunities` when listing saved
// grants. Kept in sync with `backend/db/schema.sql` (`CREATE TABLE
// funding_opportunities`) and the column set consumed by
// `assessOpportunityTrust`. If any one of these columns is missing in the
// live database (e.g. a deploy hits a Postgres instance that hasn't been
// migrated yet), we fall back to the safe-subset query below — that's a
// recall-over-suppression decision: the user has clearly saved the grant,
// so we must always show *something* rather than 500'ing the whole list.
const FO_PROJECTION_FULL = `
  fo.title,
  fo.sponsor,
  fo.deadline,
  fo.amount_min,
  fo.amount_max,
  fo.application_url,
  fo.apply_url,
  fo.source_url,
  fo.url,
  fo.link_status,
  fo.source,
  fo.source_category,
  fo.record_origin,
  fo.opportunity_type,
  fo.type,
  fo.is_loan,
  fo.requires_match,
  fo.description,
  fo.categories
`

// Minimal projection used when the full projection fails (e.g. column drift
// on an old Postgres instance). Only columns that have existed since the
// table was first created — this query must succeed even on the oldest
// production schema.
const FO_PROJECTION_MIN = `
  fo.title,
  fo.sponsor,
  fo.deadline,
  fo.amount_min,
  fo.amount_max,
  fo.application_url,
  fo.source,
  fo.description,
  fo.categories
`

// Build the SELECT for a user's saved grants.
//
// Profile scoping rules (RC-14):
//   - When an active profile is set, return rows where profile_id matches
//     that profile OR where profile_id IS NULL (legacy rows preserved as
//     visible to all of the user's profiles).
//   - When no active profile is set (e.g. admin tools, system context), fall
//     back to the user-only filter so we don't break existing behavior. The
//     same rows the old query returned are still returned.
function buildSavedGrantsListSql(projection, profileScoped) {
  const profileClause = profileScoped
    ? 'AND (sg.profile_id = ? OR sg.profile_id IS NULL)'
    : ''
  return `
    SELECT sg.opportunity_id, sg.saved_at, sg.notes, sg.profile_id,
           ${projection}
    FROM saved_grants sg
    LEFT JOIN funding_opportunities fo ON fo.id = sg.opportunity_id
    WHERE sg.user_id = ? ${profileClause}
    ORDER BY sg.saved_at DESC
    LIMIT 500
  `
}

router.get('/', async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return
    const userId = user.userId
    if (!userId) return res.status(401).json({ error: 'Authentication required' })
    await ensureSavedGrantsSchema(req.db)

    const activeProfileId = resolveActiveProfileId(req)
    const params = activeProfileId ? [userId, activeProfileId] : [userId]
    const profileScoped = Boolean(activeProfileId)

    let userRows
    try {
      userRows = await req.db.prepare(buildSavedGrantsListSql(FO_PROJECTION_FULL, profileScoped)).all(...params)
    } catch (selectErr) {
      // Schema drift recovery: a missing column on funding_opportunities (e.g.
      // a Postgres instance that hasn't received a recent migration) must NOT
      // turn a "list my saved grants" call into a 500. Retry once with the
      // minimal projection and log the drift so we can repair it offline.
      const message = String(selectErr?.message || '')
      const isMissingColumn =
        /column .* does not exist/i.test(message) || /no such column/i.test(message)
      if (!isMissingColumn) throw selectErr
      routeLogger.warn(
        '[saved-grants] funding_opportunities column drift detected — falling back to minimal projection',
        { error: message, userId, activeProfileId },
      )
      userRows = await req.db.prepare(buildSavedGrantsListSql(FO_PROJECTION_MIN, profileScoped)).all(...params)
    }

    // Attach canonical trust metadata so saved-grants UI and Anya can explain
    // lower-trust / directory / expired items consistently with discovery.
    const saved = (Array.isArray(userRows) ? userRows : []).map((row) => {
      const trust = assessOpportunityTrust(row, {
        allowDirectory: true,
        allowExpired: true, // saved items are always shown; mark status instead
      })
      const meta = buildTrustMetadata(trust) || {}
      return {
        ...row,
        trust_tier: meta.trust_tier ?? null,
        source_trust: meta.source_trust ?? null,
        trust_flags: meta.trust_flags ?? null,
        trust_reasons: meta.trust_reasons ?? [],
        trust_downgrade: Boolean(meta.trust_downgrade),
        trust_downgrade_reason: meta.trust_downgrade_reason ?? null,
        actionable_url: meta.actionable_url ?? row.application_url ?? null,
      }
    })

    res.json({ saved, ids: saved.map((r) => r.opportunity_id) })
  } catch (err) {
    routeLogger.error('[saved-grants] GET error', {
      message: err?.message,
      code: err?.code,
      stack: err?.stack,
    })
    res.status(500).json({ error: err.message })
  }
})

router.post('/', async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return
    const userId = user.userId
    if (!userId) return res.status(401).json({ error: 'Authentication required' })
    await ensureSavedGrantsSchema(req.db)

    const { opportunity_id, notes } = req.body ?? {}
    if (!opportunity_id) return res.status(400).json({ error: 'opportunity_id required' })

    // Saves are profile-scoped now (RC-14). The frontend passes the active
    // profile via X-Profile-Id; admin tools may pass ?profile_id=…. If neither
    // is present we reject explicitly rather than silently writing a legacy
    // NULL row that could bleed across profiles.
    const activeProfileId = resolveActiveProfileId(req)
    if (!activeProfileId) {
      return res.status(400).json({
        error: 'profile_id required',
        message:
          'Saving a grant requires an active profile. Select a profile in the UI before saving (the client should pass it via the X-Profile-Id header), or include ?profile_id=… on the request.',
      })
    }

    const id = crypto.randomUUID()
    // audit:allow unscoped-profile-query -- INSERT includes profile_id and is scoped by activeProfileId.
    // ON CONFLICT targets the partial unique index keyed on
    // (user_id, profile_id, opportunity_id) WHERE profile_id IS NOT NULL.
    // Both Postgres (>=9.5) and SQLite (>=3.35) support this WHERE-on-conflict
    // form. Result: a re-save under the same profile updates notes, while a
    // re-save under a different profile creates a new row (no bleed).
    // audit:allow unscoped-profile-query -- INSERT includes profile_id and is scoped by activeProfileId.
    await req.db.prepare(`
      INSERT INTO saved_grants (id, user_id, profile_id, opportunity_id, notes)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, profile_id, opportunity_id) WHERE profile_id IS NOT NULL DO UPDATE SET
        notes = COALESCE(excluded.notes, saved_grants.notes)
    `).run(id, userId, activeProfileId, opportunity_id, notes ?? null)

    res.json({ saved: true, id, profile_id: activeProfileId })
  } catch (err) {
    routeLogger.error('[saved-grants] POST error:', err)
    res.status(500).json({ error: err.message })
  }
})

router.patch('/:opportunityId/notes', async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return
    const userId = user.userId
    if (!userId) return res.status(401).json({ error: 'Authentication required' })
    await ensureSavedGrantsSchema(req.db)

    const { notes } = req.body ?? {}
    if (typeof notes !== 'string') return res.status(400).json({ error: 'notes must be a string' })

    // Update the row owned by the active profile, plus a legacy NULL row that
    // the user might have inherited from a pre-RC-14 save. Other profiles' rows
    // are never touched.
    const activeProfileId = resolveActiveProfileId(req)
    if (!activeProfileId) {
      return res.status(400).json({
        error: 'profile_id required',
        message: 'Updating saved grant notes requires an active profile.',
      })
    }
    const result = await req.db.prepare(`
      UPDATE saved_grants SET notes = ?
      WHERE user_id = ? AND opportunity_id = ?
        AND (profile_id = ? OR profile_id IS NULL)
    `).run(notes, userId, req.params.opportunityId, activeProfileId)

    if (result.changes === 0) return res.status(404).json({ error: 'Saved grant not found' })
    res.json({ updated: true })
  } catch (err) {
    routeLogger.error('[saved-grants] PATCH notes error:', err)
    res.status(500).json({ error: err.message })
  }
})

router.delete('/:opportunityId', async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return
    const userId = user.userId
    if (!userId) return res.status(401).json({ error: 'Authentication required' })
    await ensureSavedGrantsSchema(req.db)

    // Delete the active profile's row AND any legacy NULL row (which was
    // bleeding across profiles before RC-14). Other profiles' explicit saves
    // are preserved.
    const activeProfileId = resolveActiveProfileId(req)
    if (!activeProfileId) {
      return res.status(400).json({
        error: 'profile_id required',
        message: 'Removing a saved grant requires an active profile.',
      })
    }
    await req.db.prepare(`
      DELETE FROM saved_grants
      WHERE user_id = ? AND opportunity_id = ?
        AND (profile_id = ? OR profile_id IS NULL)
    `).run(userId, req.params.opportunityId, activeProfileId)

    res.json({ removed: true })
  } catch (err) {
    routeLogger.error('[saved-grants] DELETE error:', err)
    res.status(500).json({ error: err.message })
  }
})

export default router
