/**
 * John — Outreach Drafting Agent — HTTP API.
 *
 * Public:
 *   GET    /api/john/health             — liveness/safety summary
 *
 * Admin-only:
 *   GET    /api/john/status             — full status + metrics
 *   POST   /api/john/run                — run an agent mode
 *   POST   /api/john/verify-alias       — verify Outlook alias
 *   POST   /api/john/create-test-draft  — create a test draft to JOHN_TEST_RECIPIENT
 *   POST   /api/john/draft-from-yana    — draft from explicit Yana lead packets
 *   GET    /api/john/runs               — list recent runs
 *   GET    /api/john/runs/:runId        — single run
 *   GET    /api/john/drafts             — list drafts
 *   GET    /api/john/drafts/:draftId    — single draft
 *   POST   /api/john/drafts/:id/revise  — manual revision
 *   POST   /api/john/drafts/:id/archive — archive (no send)
 *   GET    /api/john/audit              — audit feed
 *   GET    /api/john/suppression        — suppression list
 *   POST   /api/john/suppression        — add to suppression list
 *
 * Notes:
 *   - John has NO send endpoint. The agent is draft-only by guarantee.
 *   - All admin endpoints require req.ctx.isAdmin or a valid admin token.
 */

import express from 'express'
import crypto from 'crypto'

import { db } from '../db/index.js'
import { createLogger } from '../utils/logger.js'

import { runJohn, getJohnStatus } from '../services/john/johnAgent.js'
import { verifyAlias } from '../services/john/johnAliasVerifier.js'
import { createOutlookProvider } from '../services/john/johnOutlookProvider.js'
import {
  archiveDraft,
  reviseDraftBody,
} from '../services/john/johnDraftService.js'
import { refreshDraftBodies } from '../services/john/johnDraftRefreshService.js'
import {
  getRun,
  listRuns,
  getDraft,
  listDrafts,
  listAudit,
  insertAudit,
} from '../services/john/johnRunStore.js'
import {
  addSuppression,
  listSuppression,
} from '../services/john/johnSuppressionService.js'
import { fetchLeadsForJohn } from '../services/john/johnYanaBridge.js'
import {
  ALL_JOHN_MODES,
  AUDIT_STATUS,
  JOHN_MODES,
  JOHN_TRIGGERS,
} from '../services/john/johnTypes.js'
import { assertDraftOnly, getJohnConfig } from '../services/john/johnOutreachSafety.js'

const router = express.Router()
const log = createLogger('route:john')

function resolveAdminToken() {
  return (
    process.env.ADMIN_TOKEN ||
    process.env.ANYA_ADMIN_TOKEN ||
    process.env.JOHN_ADMIN_TOKEN ||
    null
  )
}

function adminAuth(req, res, next) {
  if (req.ctx && req.ctx.isAdmin === true) return next()
  if (req.user?.role === 'admin' || req.user?.is_admin === true) return next()
  const configuredToken = resolveAdminToken()
  if (!configuredToken) {
    return res.status(401).json({ error: 'Admin token not configured' })
  }
  const headerToken =
    req.headers.authorization?.replace('Bearer ', '') ||
    req.headers['x-admin-token'] ||
    req.headers['x-john-token']
  if (!headerToken) return res.status(401).json({ error: 'Missing admin credentials' })
  const a = Buffer.from(String(headerToken))
  const b = Buffer.from(String(configuredToken))
  const tokenMatch = a.length === b.length && crypto.timingSafeEqual(a, b)
  if (!tokenMatch) return res.status(403).json({ error: 'Invalid admin credentials' })
  return next()
}

/** -------- Public health -------- */

router.get('/health', async (_req, res) => {
  const cfg = getJohnConfig()
  return res.status(200).json({
    ok: true,
    agent: 'John',
    status: cfg.enabled ? cfg.mode : 'disabled',
    draft_only: !!cfg.draftOnly,
  })
})

/** -------- Admin: status / runs / drafts / audit -------- */

router.get('/status', adminAuth, async (_req, res) => {
  try {
    const status = await getJohnStatus(db)
    res.json({ ok: true, status })
  } catch (err) {
    log.error('status failed', { error: err?.message })
    res.status(500).json({ ok: false, error: err?.message })
  }
})

router.post('/run', adminAuth, async (req, res) => {
  try {
    assertDraftOnly() // guard the API too
    const body = req.body || {}
    const mode = body.mode || JOHN_MODES.OBSERVE
    if (!ALL_JOHN_MODES.includes(mode)) {
      return res.status(400).json({ ok: false, error: `Unknown mode: ${mode}` })
    }
    const result = await runJohn({
      db,
      mode,
      trigger: JOHN_TRIGGERS.ADMIN,
      maxDrafts: typeof body.maxDrafts === 'number' ? body.maxDrafts : undefined,
      dryRun: !!body.dryRun,
      leadIds: Array.isArray(body.leadIds) ? body.leadIds : null,
      requireYanaQualified: typeof body.requireYanaQualified === 'boolean'
        ? body.requireYanaQualified
        : undefined,
      draftOnly: true,
      logger: log,
      createdByUserId: req.user?.id || null,
    })
    res.json({ ok: result.ok !== false, ...result })
  } catch (err) {
    log.error('run failed', { error: err?.message })
    res.status(500).json({ ok: false, error: err?.message })
  }
})

router.post('/verify-alias', adminAuth, async (_req, res) => {
  try {
    assertDraftOnly()
    const result = await verifyAlias({ db, logger: log })
    res.json({ ok: !!result.ok, ...result })
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message })
  }
})

router.post('/create-test-draft', adminAuth, async (_req, res) => {
  try {
    assertDraftOnly()
    const cfg = getJohnConfig()
    const provider = createOutlookProvider({ config: cfg, logger: log })
    if (!provider.ready) {
      await insertAudit(db, {
        recipient_email: cfg.testRecipient,
        subject: 'GrantFlow alias verification (test draft)',
        from_mailbox: cfg.primaryMailbox,
        from_alias: cfg.fromAlias,
        reply_to: cfg.replyTo,
        status: AUDIT_STATUS.DRAFT_BLOCKED,
        error: `provider_not_configured (${provider.missing})`,
      })
      return res.status(503).json({
        ok: false,
        reason: 'provider_not_configured',
        missing: provider.missing,
      })
    }
    const draft = await provider.createDraft({
      toEmail: cfg.testRecipient || cfg.primaryMailbox,
      toName: 'GrantFlow Test Draft',
      subject: 'GrantFlow test draft (do not send)',
      bodyText: 'This is a test draft created by John. Do not send.',
      requestedFromAlias: cfg.fromAlias,
      replyTo: cfg.replyTo,
      displayName: cfg.displayName,
    })
    await insertAudit(db, {
      recipient_email: cfg.testRecipient,
      subject: 'GrantFlow test draft (do not send)',
      from_mailbox: cfg.primaryMailbox,
      from_alias: draft.alias_set ? cfg.fromAlias : null,
      reply_to: cfg.replyTo,
      status: AUDIT_STATUS.DRAFT_CREATED,
      provider_draft_id: draft.provider_draft_id,
    })
    res.json({ ok: true, draft })
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message, code: err?.code })
  }
})

router.post('/draft-from-yana', adminAuth, async (req, res) => {
  try {
    assertDraftOnly()
    const body = req.body || {}
    if (!Array.isArray(body.leads) && !Array.isArray(body.leadIds)) {
      return res.status(400).json({
        ok: false,
        error: 'Provide `leads` (array of Yana packets) or `leadIds` (array of ids)',
      })
    }
    const result = await runJohn({
      db,
      mode: JOHN_MODES.DRAFT,
      trigger: JOHN_TRIGGERS.ADMIN,
      logger: log,
      maxDrafts: typeof body.maxDrafts === 'number' ? body.maxDrafts : undefined,
      leadIds: Array.isArray(body.leadIds) ? body.leadIds : null,
      // If the admin passed explicit lead packets, register a one-shot lead
      // source for this call without mutating the global registration.
      leadSource: Array.isArray(body.leads)
        ? {
            name: 'inline-admin',
            async listQualifiedLeads() {
              return body.leads
            },
            async markQueuedForReview() {
              return { ok: true }
            },
          }
        : null,
      requireYanaQualified: typeof body.requireYanaQualified === 'boolean'
        ? body.requireYanaQualified
        : undefined,
      draftOnly: true,
      createdByUserId: req.user?.id || null,
    })
    res.json({ ok: result.ok !== false, ...result })
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message })
  }
})

router.get('/runs', adminAuth, async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 25
    const runs = await listRuns(db, { limit })
    res.json({ ok: true, runs })
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message })
  }
})

router.get('/runs/:runId', adminAuth, async (req, res) => {
  try {
    const run = await getRun(db, req.params.runId)
    if (!run) return res.status(404).json({ ok: false, error: 'not_found' })
    res.json({ ok: true, run })
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message })
  }
})

router.get('/drafts', adminAuth, async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 50
    const status = req.query.status ? String(req.query.status) : null
    const drafts = await listDrafts(db, { limit, status })
    res.json({ ok: true, drafts })
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message })
  }
})

router.get('/drafts/:draftId', adminAuth, async (req, res) => {
  try {
    const draft = await getDraft(db, req.params.draftId)
    if (!draft) return res.status(404).json({ ok: false, error: 'not_found' })
    res.json({ ok: true, draft })
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message })
  }
})

router.post('/drafts/:id/revise', adminAuth, async (req, res) => {
  try {
    const body = req.body || {}
    const result = await reviseDraftBody(db, req.params.id, {
      subject: body.subject,
      body_text: body.body_text,
      body_html: body.body_html,
    })
    if (!result.ok) {
      return res.status(400).json({ ok: false, ...result })
    }
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message })
  }
})

router.post('/drafts/:id/archive', adminAuth, async (req, res) => {
  try {
    const reason = req.body?.reason || null
    await archiveDraft(db, req.params.id, reason)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message })
  }
})

/**
 * Rewrite the body/subject of all of John's existing Outlook drafts to the
 * current email template (e.g. after a messaging change). Never sends — Graph
 * PATCH only. Pass { dryRun: true } to preview which drafts would change.
 */
router.post('/drafts/refresh-bodies', adminAuth, async (req, res) => {
  try {
    assertDraftOnly()
    const body = req.body || {}
    const result = await refreshDraftBodies(db, {
      dryRun: !!body.dryRun,
      limit: typeof body.limit === 'number' ? body.limit : undefined,
      logger: log,
    })
    res.status(result.ok ? 200 : 503).json(result)
  } catch (err) {
    log.error('refresh-bodies failed', { error: err?.message })
    res.status(500).json({ ok: false, error: err?.message })
  }
})

/** -------- Admin: audit + suppression -------- */

router.get('/audit', adminAuth, async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 100
    const audit = await listAudit(db, { limit })
    res.json({ ok: true, audit })
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message })
  }
})

router.get('/suppression', adminAuth, async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 200
    const rows = await listSuppression(db, { limit })
    res.json({ ok: true, suppression: rows })
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message })
  }
})

router.post('/suppression', adminAuth, async (req, res) => {
  try {
    const body = req.body || {}
    const result = await addSuppression(db, {
      type: body.type,
      value: body.value,
      reason: body.reason || null,
      source: body.source || 'admin',
      added_by_user_id: req.user?.id || null,
    })
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message, code: err?.code })
  }
})

/** -------- Admin: leads available for John -------- */

router.get('/leads', adminAuth, async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 50
    const result = await fetchLeadsForJohn({ db, limit })
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message })
  }
})

export default router
