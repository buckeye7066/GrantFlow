/**
 * Anya Match Scout — user-facing routes.
 *
 *   GET  /api/anya/match-suggestions/pending           list pending suggestions
 *   POST /api/anya/match-suggestions/:id/accept        Add to Pipeline
 *   POST /api/anya/match-suggestions/:id/dismiss       Not right now
 *
 * Access control: the suggestion's owning user (or an admin) only.
 * Accept forwards the opportunity into the existing trust-gated
 * /api/grants/from-opportunity handler — no logic duplication, no
 * bypass of pipeline trust checks. We do NOT auto-add anywhere else.
 */

import express from 'express'
import { requireAuthenticatedUser } from '../utils/accessControl.js'
import { isAdminUserWithDb } from '../utils/accessControl.js'
import { safeParseJSON } from '../utils/safeJson.js'
import { isScoutMutedForUser } from '../services/anyaMatchScout.js'
import { filterOutPipelineMembers } from '../services/pipelineExclusion.js'
import { createLogger } from '../utils/logger.js'

const routeLogger = createLogger('route:anya-match-suggestions')

const router = express.Router()

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mapSuggestionRow(row) {
  if (!row) return null
  return {
    id: row.id,
    profile_id: row.profile_id,
    user_id: row.user_id,
    opportunity_id: row.opportunity_id,
    title: row.title,
    funder: row.funder,
    match_score: typeof row.match_score === 'number' ? row.match_score : Number(row.match_score),
    match_reasons: safeParseJSON(row.match_reasons, []),
    need_summary: safeParseJSON(row.need_summary, {}),
    search_strategy: safeParseJSON(row.search_strategy, {}),
    opportunity_data: safeParseJSON(row.opportunity_data, null),
    status: row.status,
    created_at: row.created_at,
    acted_at: row.acted_at,
    action_result: row.action_result,
  }
}

/**
 * Load + authorize a suggestion by id. Returns the row or null after
 * already writing an HTTP response (404/403/401).
 */
async function loadAuthorizedSuggestion(req, res, id) {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return null
  const userId = user.userId ?? user.id ?? null
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' })
    return null
  }

  let row = null
  try {
    row = await req.db
      .prepare('SELECT * FROM anya_match_suggestions WHERE id = ? LIMIT 1')
      .get(String(id))
  } catch (err) {
    // Table missing → treat as 404 (the scout simply hasn't run yet).
    routeLogger.warn('[match-suggestions] table read failed', { id, err: err?.message })
    res.status(404).json({ error: 'Suggestion not found' })
    return null
  }
  if (!row) {
    res.status(404).json({ error: 'Suggestion not found' })
    return null
  }

  const isAdmin = req.ctx?.isAdmin === true || (await isAdminUserWithDb(req.db, user))
  if (!isAdmin && String(row.user_id || '') !== String(userId)) {
    res.status(403).json({ error: 'Access denied' })
    return null
  }
  return row
}

/**
 * Internal loopback POST to /api/grants/from-opportunity. We forward the
 * caller's Authorization + cookie headers so the inner handler runs with
 * the exact same auth context — meaning all trust gates, profile-access
 * checks, and duplicate-detection logic apply unchanged.
 *
 * Returns `{ ok, status, body }` (never throws on non-2xx — the caller
 * inspects status to decide what to surface to the UI).
 */
async function forwardFromOpportunity(req, body) {
  const host = req.get('host')
  if (!host) {
    return { ok: false, status: 500, body: { error: 'cannot resolve internal host' } }
  }
  const base = (process.env.ANYA_SELF_BASE_URL || `${req.protocol || 'http'}://${host}`).replace(
    /\/+$/,
    '',
  )

  const headers = {
    'content-type': 'application/json',
    // The grants route uses req.user / req.ctx populated by middleware. The
    // middleware reads Authorization OR cookie — forward both.
    ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
    ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
    // Mark the call as internal so audit logs can distinguish.
    'x-anya-internal': 'match-scout-accept',
  }

  try {
    const r = await fetch(`${base}/api/grants/from-opportunity`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    let parsed = null
    try {
      parsed = await r.json()
    } catch {
      parsed = null
    }
    return { ok: r.ok, status: r.status, body: parsed }
  } catch (err) {
    routeLogger.error('[match-suggestions] internal forward failed', { err: err?.message })
    return { ok: false, status: 502, body: { error: 'internal_forward_failed', message: err?.message } }
  }
}

// ---------------------------------------------------------------------------
// GET /pending
// ---------------------------------------------------------------------------

router.get('/pending', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const userId = user.userId ?? user.id ?? null
  if (!userId) return res.status(401).json({ error: 'Authentication required' })

  // Honor the mute preference — return empty list rather than 4xx, so the
  // frontend poll silently does nothing instead of error-toasting.
  if (await isScoutMutedForUser(req.db, userId)) {
    return res.json({ suggestions: [], muted: true })
  }

  let rows = []
  try {
    rows = await req.db
      .prepare(
        `SELECT s.*, p.display_name AS profile_name
         FROM anya_match_suggestions s
         LEFT JOIN profiles p ON p.id = s.profile_id
         WHERE s.user_id = ? AND s.status = 'pending'
         ORDER BY s.match_score DESC, s.created_at DESC
         LIMIT 20`,
      )
      .all(String(userId))
  } catch (err) {
    // Table not yet present (migrate-on-boot is off + self-heal failed):
    // return empty list rather than 500. The UI poll is best-effort.
    routeLogger.warn('[match-suggestions] /pending table read failed', { err: err?.message })
    return res.json({ suggestions: [], muted: false })
  }

  let suggestions = (rows || []).map((row) => ({
    ...mapSuggestionRow(row),
    profile_name: row.profile_name || null,
  }))

  // Never surface a suggestion for something already in (or dismissed from)
  // that suggestion's OWN profile pipeline. Suggestions are user-scoped but can
  // span several profiles, so we exclude per profile_id with the canonical,
  // profile-scoped helper (no cross-profile bleed-over). Recall over
  // suppression: any failure leaves the list untouched.
  try {
    const byProfile = new Map()
    for (const s of suggestions) {
      const pid = s.profile_id ? String(s.profile_id) : ''
      if (!byProfile.has(pid)) byProfile.set(pid, [])
      byProfile.get(pid).push(s)
    }
    const kept = []
    for (const [pid, group] of byProfile) {
      if (!pid) {
        kept.push(...group)
        continue
      }
      // Build identity-bearing candidates the helper can key on (it reads
      // id/opportunity_id, title, funder/sponsor). Keep a back-reference to the
      // original suggestion so we can return the unmodified shape.
      const candidates = group.map((s) => ({
        _suggestion: s,
        id: s.opportunity_id ?? s.id,
        title: s.title,
        funder: s.funder ?? s.opportunity_data?.funder ?? s.opportunity_data?.sponsor ?? null,
      }))
      const filtered = await filterOutPipelineMembers(req.db, pid, candidates)
      // filterOutPipelineMembers preserves object identity in `results`.
      for (const c of filtered.results) kept.push(c._suggestion)
    }
    suggestions = kept
  } catch (exclErr) {
    routeLogger.warn('[match-suggestions] /pending pipeline exclusion skipped', {
      err: exclErr?.message || String(exclErr),
    })
  }

  return res.json({ suggestions, muted: false })
})

// ---------------------------------------------------------------------------
// POST /:id/accept
// ---------------------------------------------------------------------------

router.post('/:id/accept', async (req, res) => {
  const row = await loadAuthorizedSuggestion(req, res, req.params.id)
  if (!row) return

  if (row.status !== 'pending') {
    return res.status(409).json({
      error: 'already_acted',
      status: row.status,
      action_result: row.action_result || null,
    })
  }

  const opportunityData = safeParseJSON(row.opportunity_data, null) || {}
  const forwardBody = {
    profile_id: row.profile_id,
    opportunity_id: row.opportunity_id || null,
    match_score: typeof row.match_score === 'number' ? row.match_score : Number(row.match_score),
    match_reasons: safeParseJSON(row.match_reasons, []),
    ...(row.opportunity_id ? {} : { opportunity_data: opportunityData }),
  }

  const forwardResult = await forwardFromOpportunity(req, forwardBody)
  if (!forwardResult.ok) {
    routeLogger.warn('[match-suggestions] accept forward returned non-2xx', {
      suggestion_id: row.id,
      status: forwardResult.status,
      body: forwardResult.body,
    })
    return res.status(forwardResult.status || 502).json({
      error: 'pipeline_add_failed',
      detail: forwardResult.body,
    })
  }

  const grantId = forwardResult.body?.id || null
  const alreadyExisted = Boolean(forwardResult.body?.already_exists)

  // Mark the suggestion accepted. If the grant already existed, label it
  // `already_in_pipeline` so analytics can distinguish — the user still
  // wanted it, just nothing changed in the pipeline.
  const finalStatus = alreadyExisted ? 'already_in_pipeline' : 'accepted'
  const nowFn = req.db?.dialect === 'postgres' ? 'NOW()' : 'CURRENT_TIMESTAMP'
  try {
    await req.db
      .prepare(
        `UPDATE anya_match_suggestions
         SET status = ?, acted_at = ${nowFn}, action_result = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(finalStatus, grantId, row.id)
  } catch (err) {
    routeLogger.warn('[match-suggestions] post-accept update failed (non-fatal)', {
      suggestion_id: row.id,
      err: err?.message,
    })
  }

  return res.json({
    ok: true,
    suggestion_id: row.id,
    status: finalStatus,
    grant_id: grantId,
    already_existed: alreadyExisted,
    grant: forwardResult.body,
  })
})

// ---------------------------------------------------------------------------
// POST /:id/dismiss
// ---------------------------------------------------------------------------

router.post('/:id/dismiss', async (req, res) => {
  const row = await loadAuthorizedSuggestion(req, res, req.params.id)
  if (!row) return

  if (row.status !== 'pending') {
    return res.status(409).json({
      error: 'already_acted',
      status: row.status,
      action_result: row.action_result || null,
    })
  }

  const reason =
    typeof req.body?.reason === 'string' && req.body.reason.trim()
      ? req.body.reason.trim().slice(0, 200)
      : 'user_dismissed'

  const nowFn = req.db?.dialect === 'postgres' ? 'NOW()' : 'CURRENT_TIMESTAMP'
  try {
    await req.db
      .prepare(
        `UPDATE anya_match_suggestions
         SET status = 'dismissed', acted_at = ${nowFn}, action_result = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(reason, row.id)
  } catch (err) {
    routeLogger.warn('[match-suggestions] dismiss update failed', {
      suggestion_id: row.id,
      err: err?.message,
    })
    return res.status(500).json({ error: 'dismiss_failed', message: err?.message })
  }

  return res.json({ ok: true, suggestion_id: row.id, status: 'dismissed', reason })
})

export default router
