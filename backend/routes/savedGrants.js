/**
 * Saved Grants API
 *
 * GET    /api/saved-grants              — list saved grants for authenticated user
 * POST   /api/saved-grants              — save a grant (optional notes)
 * PATCH  /api/saved-grants/:id/notes    — update notes on a saved grant
 * DELETE /api/saved-grants/:id          — unsave a grant (id = opportunity_id)
 *
 * Profile scoping (RC-14): when the caller supplies a `profile_id` (query param
 * on GET/DELETE, body field on POST/PATCH) the save is keyed to that profile so
 * a user's saves never bleed across their profiles, and the same opportunity can
 * be saved independently under more than one profile. Rows with an empty
 * `profile_id` are legacy / no-profile saves; they remain visible under every
 * profile (we can't know which profile they belonged to, so hiding them would
 * look like data loss) but new saves are always profile-stamped and isolated.
 * `profile_id` is optional for backward compatibility with older clients.
 */

import { Router } from 'express'
import crypto from 'node:crypto'
import {
  requireAuthenticatedUser,
  ensureProfileAccess,
} from '../utils/accessControl.js'
import {
  assessOpportunityTrust,
  buildTrustMetadata,
} from '../services/opportunityTrust.js'
import { ensureSavedGrantsSchema } from '../services/savedGrantsSchema.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:savedGrants')

const router = Router()

// Normalize an incoming profile_id to a non-empty string, or '' when absent.
// '' is the canonical "no/legacy profile" sentinel stored in the column.
function readProfileId(value) {
  if (value === null || value === undefined) return ''
  const str = String(value).trim()
  return str
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

// Build the list query. When `scopeByProfile` is true we add the profile
// filter (the active profile's rows plus legacy '' rows); otherwise we return
// every saved row for the user (admin / no-profile clients).
function buildSavedGrantsListSql(projection, scopeByProfile) {
  const profileClause = scopeByProfile ? "AND (sg.profile_id = ? OR sg.profile_id = '')" : ''
  return `
    SELECT sg.opportunity_id, sg.profile_id, sg.saved_at, sg.notes,
           ${projection}
    FROM saved_grants sg
    LEFT JOIN funding_opportunities fo ON fo.id = sg.opportunity_id
    WHERE sg.user_id = ?
    ${profileClause}
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

    const profileId = readProfileId(req.query.profile_id)
    if (profileId) {
      const canAccess = await ensureProfileAccess(req, res, profileId)
      if (!canAccess) return
    }
    const params = profileId ? [userId, profileId] : [userId]

    let userRows
    try {
      userRows = await req.db
        .prepare(buildSavedGrantsListSql(FO_PROJECTION_FULL, Boolean(profileId)))
        .all(...params)
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
        { error: message, userId },
      )
      userRows = await req.db
        .prepare(buildSavedGrantsListSql(FO_PROJECTION_MIN, Boolean(profileId)))
        .all(...params)
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

    const profileId = readProfileId(req.body?.profile_id)
    if (profileId) {
      const canAccess = await ensureProfileAccess(req, res, profileId)
      if (!canAccess) return
    }

    const id = crypto.randomUUID()
    await req.db.prepare(`
      INSERT INTO saved_grants (id, user_id, profile_id, opportunity_id, notes)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, profile_id, opportunity_id) DO UPDATE SET
        notes = COALESCE(excluded.notes, saved_grants.notes)
    `).run(id, userId, profileId, opportunity_id, notes ?? null)

    res.json({ saved: true, id })
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

    const profileId = readProfileId(req.body?.profile_id)
    const clauses = ['user_id = ?', 'opportunity_id = ?']
    const params = [notes, userId, req.params.opportunityId]
    if (profileId) {
      clauses.push('profile_id = ?')
      params.push(profileId)
    }

    const result = await req.db
      .prepare(`UPDATE saved_grants SET notes = ? WHERE ${clauses.join(' AND ')}`)
      .run(...params)

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

    const profileId = readProfileId(req.query.profile_id)
    const clauses = ['user_id = ?', 'opportunity_id = ?']
    const params = [userId, req.params.opportunityId]
    if (profileId) {
      clauses.push('profile_id = ?')
      params.push(profileId)
    }

    await req.db
      .prepare(`DELETE FROM saved_grants WHERE ${clauses.join(' AND ')}`)
      .run(...params)

    res.json({ removed: true })
  } catch (err) {
    routeLogger.error('[saved-grants] DELETE error:', err)
    res.status(500).json({ error: err.message })
  }
})

export default router
