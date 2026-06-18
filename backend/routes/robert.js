/**
 * /api/robert
 *
 * Robert is GrantFlow's Funding Discovery Agent. This router exposes:
 *   - public:           GET /api/robert/health
 *   - admin:            POST /api/robert/run, /diagnose-style endpoints
 *   - admin candidates: source/opportunity-candidate review
 *   - user/profile:     pending recommendation queue + accept/decline
 *
 * Every endpoint that touches a profile uses `ensureProfileAccess` so
 * users can never read or act on another profile's recommendations.
 *
 * NOTE: Robert never adds anything to a user's pipeline by itself.
 * `/recommendations/:id/accept` calls the canonical add-to-pipeline
 * helper (`saveToProfilePipeline`) — same gates a normal "Add to
 * pipeline" UI click would go through.
 */

import express from 'express'
import crypto from 'crypto'

import { ensureProfileAccess } from '../utils/accessControl.js'
import { logAuditEvent, AUDIT_CATEGORIES, SEVERITY } from '../services/auditService.js'
import { getRobertConfig, maskSecrets } from '../services/robert/robertSafety.js'
import {
  isValidMode,
  ROBERT_MODES,
  ROBERT_TRIGGERS,
} from '../services/robert/robertTypes.js'
import {
  getRobertStatus,
  listPendingRecommendationsForProfile,
  runRobert,
} from '../services/robert/robertAgent.js'
import {
  getRecommendation,
  getRun,
  listOpportunityCandidates,
  listRuns,
  listSourceCandidates,
  setSourceCandidateStatus,
  updateOpportunityCandidate,
  upsertSourceCandidate,
} from '../services/robert/robertRunStore.js'
import { traceFundingIntoCandidates } from '../services/robert/robertFundingTraceBridge.js'
import {
  markAccepted,
  markDeclined,
  markDismissed,
  markViewed,
} from '../services/robert/robertRecommendationService.js'
import {
  listRecommendationsSince,
  markDelivered,
  selectDeliverable,
} from '../services/robert/robertRecommendationDelivery.js'

const router = express.Router()

const resolveAdminToken = () =>
  process.env.ADMIN_TOKEN || process.env.ROBERT_ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN || null

function adminOnly(req, res, next) {
  if (req.ctx && req.ctx.isAdmin === true) return next()
  if (req.user?.role === 'admin' || req.user?.is_admin === true) return next()
  const configured = resolveAdminToken()
  if (configured) {
    const header =
      req.headers.authorization?.replace('Bearer ', '') ||
      req.headers['x-admin-token'] ||
      req.headers['x-robert-token']
    if (header) {
      const a = Buffer.from(String(header))
      const b = Buffer.from(String(configured))
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next()
    }
  }
  return res.status(403).json({ error: 'Admin access required for Robert.' })
}

function requireAuth(req, res, next) {
  if (req.ctx?.userId || req.user?.id) return next()
  return res.status(401).json({ error: 'Authentication required.' })
}

function handleError(res, err, fallbackMessage = 'Robert encountered an error.') {
  return res.status(500).json({
    ok: false,
    error: maskSecrets(String(err?.message || fallbackMessage)).slice(0, 500),
  })
}

// ---------------------------------------------------------------------------
// Public health
// ---------------------------------------------------------------------------
router.get('/health', async (_req, res) => {
  const cfg = getRobertConfig()
  return res.json({
    ok: true,
    agent: 'Robert',
    status: cfg.enabled ? 'enabled' : 'disabled',
  })
})

// ---------------------------------------------------------------------------
// Admin status / run controls
// ---------------------------------------------------------------------------
router.get('/status', adminOnly, async (req, res) => {
  try {
    const status = await getRobertStatus(req.db)
    return res.json({ ok: true, ...status })
  } catch (err) { return handleError(res, err) }
})

async function runWithMode(req, res, mode) {
  try {
    const body = req.body || {}
    const requestedMode = body.mode || mode
    if (!isValidMode(requestedMode)) return res.status(400).json({ error: `Invalid mode: ${requestedMode}` })
    const result = await runRobert({
      db: req.db,
      req,
      mode: requestedMode,
      trigger: ROBERT_TRIGGERS.ADMIN_UI,
      profileIds: Array.isArray(body.profileIds) ? body.profileIds : null,
      dryRun: body.dryRun === true,
      options: body,
    })
    await logAuditEvent(req.db, {
      category: AUDIT_CATEGORIES.CRAWLER,
      action: `robert.run.${requestedMode}`,
      severity: SEVERITY.INFO,
      userId: req.ctx?.userId ?? null,
      details: { run_id: result?.run_id, status: result?.status, counters: result?.counters },
    })
    return res.json(result)
  } catch (err) { return handleError(res, err) }
}

router.post('/run', adminOnly, (req, res) => runWithMode(req, res, ROBERT_MODES.OBSERVE))
router.post('/analyze-coverage', adminOnly, (req, res) => runWithMode(req, res, ROBERT_MODES.OBSERVE))
router.post('/discover-sources', adminOnly, (req, res) => runWithMode(req, res, ROBERT_MODES.DISCOVER_SOURCES))
router.post('/discover-opportunities', adminOnly, (req, res) => runWithMode(req, res, ROBERT_MODES.DISCOVER_OPPORTUNITIES))
router.post('/verify-candidates', adminOnly, (req, res) => runWithMode(req, res, ROBERT_MODES.VERIFY))
router.post('/ingest-verified', adminOnly, (req, res) => runWithMode(req, res, ROBERT_MODES.INGEST))
router.post('/match-new', adminOnly, (req, res) => runWithMode(req, res, ROBERT_MODES.MATCH))
router.post('/recommend', adminOnly, (req, res) => runWithMode(req, res, ROBERT_MODES.RECOMMEND))

// ---------------------------------------------------------------------------
// Run history
// ---------------------------------------------------------------------------
router.get('/runs', adminOnly, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25))
    const runs = await listRuns(req.db, { limit })
    return res.json({ ok: true, runs })
  } catch (err) { return handleError(res, err) }
})

router.get('/runs/:runId', adminOnly, async (req, res) => {
  try {
    const run = await getRun(req.db, req.params.runId)
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found' })
    return res.json({ ok: true, run })
  } catch (err) { return handleError(res, err) }
})

// ---------------------------------------------------------------------------
// Source candidates
// ---------------------------------------------------------------------------
router.get('/source-candidates', adminOnly, async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : null
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100))
    const rows = await listSourceCandidates(req.db, { status, limit })
    return res.json({ ok: true, candidates: rows })
  } catch (err) { return handleError(res, err) }
})

// Funding Trace as a discovery tool: trace where a known entity gets its
// funding and stage the real funders as pending source candidates.
router.post('/trace-funding', adminOnly, async (req, res) => {
  try {
    const entity = req.body?.entity
    if (!entity || !String(entity).trim()) {
      return res.status(400).json({ ok: false, error: 'entity is required' })
    }
    const entityType = req.body?.entity_type || 'company'
    const useAi = req.body?.use_ai !== false
    const summary = await traceFundingIntoCandidates(req.db, {
      entity: String(entity),
      entityType,
      useAi,
      upsert: upsertSourceCandidate,
    })
    return res.json({ ok: true, ...summary })
  } catch (err) {
    return handleError(res, err, 'Funding trace failed.')
  }
})

router.post('/source-candidates/:id/approve', adminOnly, async (req, res) => {
  try {
    await setSourceCandidateStatus(req.db, req.params.id, 'approved')
    return res.json({ ok: true })
  } catch (err) { return handleError(res, err) }
})

router.post('/source-candidates/:id/reject', adminOnly, async (req, res) => {
  try {
    const reason = (req.body && req.body.reason) || 'admin_rejected'
    await setSourceCandidateStatus(req.db, req.params.id, 'rejected', { rejection_reason: String(reason).slice(0, 200) })
    return res.json({ ok: true })
  } catch (err) { return handleError(res, err) }
})

// ---------------------------------------------------------------------------
// Opportunity candidates
// ---------------------------------------------------------------------------
router.get('/opportunity-candidates', adminOnly, async (req, res) => {
  try {
    const verification_status = req.query.verification_status ? String(req.query.verification_status) : null
    const run_id = req.query.run_id ? String(req.query.run_id) : null
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100))
    const rows = await listOpportunityCandidates(req.db, { run_id, verification_status, limit })
    return res.json({ ok: true, candidates: rows })
  } catch (err) { return handleError(res, err) }
})

router.post('/opportunity-candidates/:id/approve-ingest', adminOnly, async (req, res) => {
  try {
    await updateOpportunityCandidate(req.db, req.params.id, { verification_status: 'verified' })
    return res.json({ ok: true })
  } catch (err) { return handleError(res, err) }
})

router.post('/opportunity-candidates/:id/reject', adminOnly, async (req, res) => {
  try {
    const reason = (req.body && req.body.reason) || 'admin_rejected'
    await updateOpportunityCandidate(req.db, req.params.id, {
      verification_status: 'rejected',
      verification_reasons: [String(reason).slice(0, 200)],
    })
    return res.json({ ok: true })
  } catch (err) { return handleError(res, err) }
})

// ---------------------------------------------------------------------------
// Authenticated user/profile recommendations
// ---------------------------------------------------------------------------
function resolveActiveProfileId(req) {
  return (
    (req.body && (req.body.active_profile_id || req.body.profile_id)) ||
    req.query.active_profile_id ||
    req.query.profile_id ||
    req.ctx?.activeProfileId ||
    null
  )
}

router.get('/recommendations', requireAuth, async (req, res) => {
  try {
    const profileId = String(resolveActiveProfileId(req) || '')
    if (!profileId) return res.status(400).json({ error: 'active_profile_id required' })
    if (!(await ensureProfileAccess(req, res, profileId))) return
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50))
    const since = req.query.since ? String(req.query.since) : null
    const items = since
      ? await listRecommendationsSince(req.db, profileId, since, { limit })
      : await listPendingRecommendationsForProfile(req.db, profileId, { limit })
    return res.json({ ok: true, profile_id: profileId, recommendations: items })
  } catch (err) { return handleError(res, err) }
})

router.get('/recommendations/deliverable', requireAuth, async (req, res) => {
  try {
    const profileId = String(resolveActiveProfileId(req) || '')
    if (!profileId) return res.status(400).json({ error: 'active_profile_id required' })
    if (!(await ensureProfileAccess(req, res, profileId))) return
    const cfg = getRobertConfig()
    const deliverable = await selectDeliverable({ db: req.db, profileId, config: cfg })
    return res.json({ ok: true, profile_id: profileId, ...deliverable })
  } catch (err) { return handleError(res, err) }
})

router.get('/recommendations/:id', requireAuth, async (req, res) => {
  try {
    const rec = await getRecommendation(req.db, req.params.id)
    if (!rec) return res.status(404).json({ ok: false, error: 'Recommendation not found' })
    if (!(await ensureProfileAccess(req, res, rec.profile_id))) return
    return res.json({ ok: true, recommendation: rec })
  } catch (err) { return handleError(res, err) }
})

/**
 * Long-poll-style stream. We expose this as a polling-friendly endpoint
 * that takes a `since` timestamp and returns any recommendations created
 * after it. The frontend listener prefers this over SSE because the
 * project's auth uses bearer tokens (SSE inside the browser cannot send
 * custom headers), so polling is the durable choice.
 */
router.get('/recommendations/stream', requireAuth, async (req, res) => {
  try {
    const profileId = String(resolveActiveProfileId(req) || '')
    if (!profileId) return res.status(400).json({ error: 'active_profile_id required' })
    if (!(await ensureProfileAccess(req, res, profileId))) return
    const sinceISO = req.query.since ? String(req.query.since) : null
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20))
    const items = await listRecommendationsSince(req.db, profileId, sinceISO, { limit })
    res.set('Cache-Control', 'no-store')
    return res.json({
      ok: true,
      profile_id: profileId,
      transport: 'poll',
      poll_interval_ms: getRobertConfig().recommendationPollIntervalMs,
      since: sinceISO,
      recommendations: items,
      server_time: new Date().toISOString(),
    })
  } catch (err) { return handleError(res, err) }
})

router.post('/recommendations/:id/accept', requireAuth, async (req, res) => {
  try {
    const rec = await getRecommendation(req.db, req.params.id)
    if (!rec) return res.status(404).json({ ok: false, error: 'Recommendation not found' })
    if (!(await ensureProfileAccess(req, res, rec.profile_id))) return

    // Delegate add-to-pipeline to the canonical helper.
    let pipelineResult = null
    if (rec.opportunity_id) {
      try {
        const { saveToProfilePipeline } = await import('../services/opportunityMatcher.js')
        const opp = await req.db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(rec.opportunity_id)
        if (opp) {
          pipelineResult = await saveToProfilePipeline(req.db, opp, rec.profile_id, null, Number(rec.match_score) || null)
        }
      } catch (err) {
        await logAuditEvent(req.db, {
          category: AUDIT_CATEGORIES.GRANT,
          action: 'robert.recommendation.accept_pipeline_error',
          severity: SEVERITY.ERROR,
          userId: req.ctx?.userId ?? null,
          profileId: rec.profile_id,
          resourceType: 'robert_recommendation',
          resourceId: rec.id,
          details: { message: maskSecrets(String(err?.message || err)).slice(0, 500) },
        })
      }
    }
    await markAccepted(req.db, rec.id)
    await logAuditEvent(req.db, {
      category: AUDIT_CATEGORIES.GRANT,
      action: 'robert.recommendation.accepted',
      severity: SEVERITY.INFO,
      userId: req.ctx?.userId ?? null,
      profileId: rec.profile_id,
      resourceType: 'robert_recommendation',
      resourceId: rec.id,
      details: { opportunity_id: rec.opportunity_id, pipeline_result: pipelineResult ? { saved: pipelineResult.saved, reason: pipelineResult.reason } : null },
    })
    return res.json({ ok: true, recommendation_id: rec.id, pipeline: pipelineResult })
  } catch (err) { return handleError(res, err) }
})

router.post('/recommendations/:id/decline', requireAuth, async (req, res) => {
  try {
    const rec = await getRecommendation(req.db, req.params.id)
    if (!rec) return res.status(404).json({ ok: false, error: 'Recommendation not found' })
    if (!(await ensureProfileAccess(req, res, rec.profile_id))) return
    await markDeclined(req.db, rec.id)
    await logAuditEvent(req.db, {
      category: AUDIT_CATEGORIES.GRANT,
      action: 'robert.recommendation.declined',
      severity: SEVERITY.INFO,
      userId: req.ctx?.userId ?? null,
      profileId: rec.profile_id,
      resourceType: 'robert_recommendation',
      resourceId: rec.id,
      details: { opportunity_id: rec.opportunity_id },
    })
    return res.json({ ok: true, recommendation_id: rec.id })
  } catch (err) { return handleError(res, err) }
})

router.post('/recommendations/:id/viewed', requireAuth, async (req, res) => {
  try {
    const rec = await getRecommendation(req.db, req.params.id)
    if (!rec) return res.status(404).json({ ok: false, error: 'Recommendation not found' })
    if (!(await ensureProfileAccess(req, res, rec.profile_id))) return
    await markViewed(req.db, rec.id)
    return res.json({ ok: true, recommendation_id: rec.id })
  } catch (err) { return handleError(res, err) }
})

router.post('/recommendations/:id/dismiss', requireAuth, async (req, res) => {
  try {
    const rec = await getRecommendation(req.db, req.params.id)
    if (!rec) return res.status(404).json({ ok: false, error: 'Recommendation not found' })
    if (!(await ensureProfileAccess(req, res, rec.profile_id))) return
    await markDismissed(req.db, rec.id)
    return res.json({ ok: true, recommendation_id: rec.id })
  } catch (err) { return handleError(res, err) }
})

router.post('/recommendations/:id/delivered', requireAuth, async (req, res) => {
  try {
    const rec = await getRecommendation(req.db, req.params.id)
    if (!rec) return res.status(404).json({ ok: false, error: 'Recommendation not found' })
    if (!(await ensureProfileAccess(req, res, rec.profile_id))) return
    const via = req.body && req.body.via === 'login' ? 'login' : 'live'
    const updated = await markDelivered(req.db, rec.id, { via })
    return res.json({ ok: true, recommendation: updated })
  } catch (err) { return handleError(res, err) }
})

export default router
