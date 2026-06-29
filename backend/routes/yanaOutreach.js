/**
 * Yana — Lead Pipeline (public + admin API).
 *
 * Mounted at /api/yana-leads/* (canonical) and /api/yanaOutreach/* (legacy
 * alias, still served for backward compatibility).
 *
 *   GET  /yana-leads/health                    public; only ok+agent+status
 *   GET  /yana-leads/status                    admin
 *   POST /yana-leads/run                       admin; body.mode picks the phase
 *   POST /yana-leads/discover-prospects        admin; alias for run(mode=...)
 *   POST /yana-leads/verify-contacts           admin; alias
 *   POST /yana-leads/score-fit                 admin; alias
 *   POST /yana-leads/build-packets             admin; alias
 *   POST /yana-leads/qualify                   admin; alias
 *   POST /yana-leads/draft-outreach            admin; alias
 *   POST /yana-leads/send-outreach             admin; alias (still per-attempt approval)
 *   GET  /yana-leads/runs                      admin; recent run history
 *   GET  /yana-leads/prospects                 admin; review/triage queue
 *   GET  /yana-leads/leads                     admin; lead review queue
 *   GET  /yana-leads/leads/:id                 admin; full packet
 *   POST /yana-leads/leads/:id/approve         admin; mark approved_for_outreach
 *   POST /yana-leads/leads/:id/archive         admin
 *   POST /yana-leads/outreach/:attemptId/approve   admin; approves a single send
 *   POST /yana-leads/outreach/:attemptId/cancel    admin
 *   POST /yana-leads/relationships/:prospectId/dnc admin; force DNC
 */

import express from 'express'

import { logAuditEvent, AUDIT_CATEGORIES, SEVERITY } from '../services/auditService.js'
import { YANA_OUTREACH_AGENT_NAME, YANA_OUTREACH_MODES, LEAD_STATUS, OUTREACH_SEND_STATUS, PROSPECT_STATUS } from '../services/yanaOutreach/yanaOutreachTypes.js'
import { getYanaOutreachConfig, maskSecrets } from '../services/yanaOutreach/yanaOutreachSafety.js'
import {
  listRuns,
  listProspects,
  listLeads,
  getLead,
  updateLead,
  listOutreachAttemptsForLead,
  getOutreachAttempt,
  updateOutreachAttempt,
  getProspect,
} from '../services/yanaOutreach/yanaOutreachRunStore.js'
import { runYanaOutreach, getYanaOutreachStatus } from '../services/yanaOutreach/yanaOutreachAgent.js'
import { sendOutreachAttempt, buildEmailSenderAdapter } from '../services/yanaOutreach/yanaOutreachSender.js'
import { markDoNotContact } from '../services/yanaOutreach/yanaOutreachRelationshipTracker.js'

const router = express.Router()

function adminOnly(req, res, next) {
  if (!req.ctx?.isAdmin) {
    return res.status(403).json({ error: 'admin_only', agent: YANA_OUTREACH_AGENT_NAME })
  }
  return next()
}

async function audit(db, req, action, details = {}, severity = SEVERITY.INFO) {
  if (!db) return
  try {
    await logAuditEvent(db, {
      category: AUDIT_CATEGORIES.ADMIN,
      action: `yanaOutreach:${action}`,
      severity,
      userId: req?.ctx?.userId || null,
      details: maskSecrets(details),
    })
  } catch {
    // never fail a request because audit logging failed
  }
}

router.get('/health', async (_req, res) => {
  const cfg = getYanaOutreachConfig()
  res.json({
    ok: true,
    agent: YANA_OUTREACH_AGENT_NAME,
    // Yana's discovery + drafting are always available; "status" reflects that,
    // not the separate manual-send switch. She never sends email herself.
    status: 'ok',
    role: 'lead_discovery_and_drafting',
    sends_email: false,
    discovery_and_drafting: 'always_on',
    manual_send_step_enabled: cfg.enabled,
    mode: cfg.mode,
    require_approval_to_send: cfg.requireApprovalToSend,
  })
})

router.get('/status', adminOnly, async (req, res) => {
  try {
    const status = await getYanaOutreachStatus(req.db)
    return res.json({ ok: true, ...status })
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || 'status_failed' })
  }
})

async function runWithMode(req, res, mode) {
  try {
    const result = await runYanaOutreach({
      db: req.db,
      req,
      mode,
      trigger: 'admin_api',
      options: req.body?.options || {},
    })
    await audit(req.db, req, `run:${mode}`, { ok: result.ok, run_id: result.run_id })
    return res.json(result)
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || 'run_failed' })
  }
}

router.post('/run', adminOnly, async (req, res) => {
  const requested = req.body?.mode
  const allowed = new Set(Object.values(YANA_OUTREACH_MODES))
  const mode = allowed.has(requested) ? requested : YANA_OUTREACH_MODES.OBSERVE
  return runWithMode(req, res, mode)
})

router.post('/discover-prospects', adminOnly, (req, res) => runWithMode(req, res, YANA_OUTREACH_MODES.DISCOVER_PROSPECTS))
router.post('/verify-contacts', adminOnly, (req, res) => runWithMode(req, res, YANA_OUTREACH_MODES.VERIFY_CONTACTS))
router.post('/score-fit', adminOnly, (req, res) => runWithMode(req, res, YANA_OUTREACH_MODES.SCORE_FIT))
router.post('/build-packets', adminOnly, (req, res) => runWithMode(req, res, YANA_OUTREACH_MODES.BUILD_PACKETS))
router.post('/qualify', adminOnly, (req, res) => runWithMode(req, res, YANA_OUTREACH_MODES.QUALIFY))
router.post('/draft-outreach', adminOnly, (req, res) => runWithMode(req, res, YANA_OUTREACH_MODES.DRAFT_OUTREACH))
router.post('/send-outreach', adminOnly, (req, res) => runWithMode(req, res, YANA_OUTREACH_MODES.SEND_OUTREACH))

router.get('/runs', adminOnly, async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 25))
    const rows = await listRuns(req.db, { limit })
    return res.json({ ok: true, runs: rows })
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || 'list_failed' })
  }
})

router.get('/prospects', adminOnly, async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : null
    const qualified = req.query.qualified === 'true' ? true : req.query.qualified === 'false' ? false : null
    const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit, 10) || 50))
    const rows = await listProspects(req.db, { status, qualified, limit })
    return res.json({ ok: true, prospects: rows })
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || 'list_failed' })
  }
})

router.get('/leads', adminOnly, async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : null
    const approved =
      req.query.approved === 'true' ? true : req.query.approved === 'false' ? false : null
    const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit, 10) || 50))
    const rows = await listLeads(req.db, { status, approvedForOutreach: approved, limit })
    return res.json({ ok: true, leads: rows })
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || 'list_failed' })
  }
})

router.get('/leads/:id', adminOnly, async (req, res) => {
  try {
    const lead = await getLead(req.db, String(req.params.id))
    if (!lead) return res.status(404).json({ ok: false, error: 'not_found' })
    const attempts = await listOutreachAttemptsForLead(req.db, lead.id)
    return res.json({ ok: true, lead, attempts })
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || 'get_failed' })
  }
})

router.post('/leads/:id/approve', adminOnly, async (req, res) => {
  try {
    const lead = await getLead(req.db, String(req.params.id))
    if (!lead) return res.status(404).json({ ok: false, error: 'not_found' })
    const updated = await updateLead(req.db, lead.id, {
      status: LEAD_STATUS.APPROVED_FOR_OUTREACH,
      approved_for_outreach: true,
      approved_for_outreach_at: new Date().toISOString(),
      approved_for_outreach_by_user_id: req.ctx?.userId || null,
    })
    await audit(req.db, req, 'lead.approve', { lead_id: lead.id })
    return res.json({ ok: true, lead: updated })
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || 'approve_failed' })
  }
})

router.post('/leads/:id/archive', adminOnly, async (req, res) => {
  try {
    const lead = await getLead(req.db, String(req.params.id))
    if (!lead) return res.status(404).json({ ok: false, error: 'not_found' })
    const updated = await updateLead(req.db, lead.id, {
      status: LEAD_STATUS.ARCHIVED,
      archived_at: new Date().toISOString(),
      archived_reason: req.body?.reason || 'admin_archived',
    })
    await audit(req.db, req, 'lead.archive', { lead_id: lead.id, reason: req.body?.reason || null })
    return res.json({ ok: true, lead: updated })
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || 'archive_failed' })
  }
})

router.post('/outreach/:attemptId/approve', adminOnly, async (req, res) => {
  try {
    const attempt = await getOutreachAttempt(req.db, String(req.params.attemptId))
    if (!attempt) return res.status(404).json({ ok: false, error: 'not_found' })
    const updated = await updateOutreachAttempt(req.db, attempt.id, {
      send_status: OUTREACH_SEND_STATUS.APPROVED,
      approved_at: new Date().toISOString(),
      approved_by_user_id: req.ctx?.userId || null,
    })
    await audit(req.db, req, 'outreach.approve', { attempt_id: attempt.id }, SEVERITY.INFO)
    return res.json({ ok: true, attempt: updated })
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || 'approve_failed' })
  }
})

router.post('/outreach/:attemptId/cancel', adminOnly, async (req, res) => {
  try {
    const attempt = await getOutreachAttempt(req.db, String(req.params.attemptId))
    if (!attempt) return res.status(404).json({ ok: false, error: 'not_found' })
    const updated = await updateOutreachAttempt(req.db, attempt.id, {
      send_status: OUTREACH_SEND_STATUS.CANCELLED,
      send_error: req.body?.reason || 'admin_cancelled',
    })
    await audit(req.db, req, 'outreach.cancel', { attempt_id: attempt.id, reason: req.body?.reason || null })
    return res.json({ ok: true, attempt: updated })
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || 'cancel_failed' })
  }
})

router.post('/outreach/:attemptId/send', adminOnly, async (req, res) => {
  try {
    const attempt = await getOutreachAttempt(req.db, String(req.params.attemptId))
    if (!attempt) return res.status(404).json({ ok: false, error: 'not_found' })
    if (!attempt.approved_at && !attempt.approved_by_user_id) {
      return res.status(409).json({ ok: false, error: 'attempt_not_approved' })
    }
    const prospect = await getProspect(req.db, attempt.prospect_candidate_id)
    if (!prospect) return res.status(404).json({ ok: false, error: 'prospect_not_found' })

    let emailSender = null
    try {
      const { sendApplicationEmail } = await import('../services/email.js')
      const adapter = buildEmailSenderAdapter(async ({ from, to, subject, html, text }) => {
        // Resend via the shared module's helper — keeps a single email client.
        try {
          await sendApplicationEmail(to, { from, subject, html, text })
          return { id: null }
        } catch (err) {
          return { error: { message: err?.message || String(err) } }
        }
      })
      emailSender = adapter
    } catch {
      emailSender = null
    }

    const dryRun = req.body?.dryRun === true
    const result = await sendOutreachAttempt({
      db: req.db,
      attempt,
      prospect,
      emailSender,
      dryRun,
    })

    await audit(req.db, req, 'outreach.send', {
      attempt_id: attempt.id,
      sent: result.sent,
      blocked: result.blocked || null,
    }, result.sent ? SEVERITY.INFO : SEVERITY.WARNING)

    return res.json({ ok: result.sent, ...result })
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || 'send_failed' })
  }
})

router.post('/relationships/:prospectId/dnc', adminOnly, async (req, res) => {
  try {
    const prospect = await getProspect(req.db, String(req.params.prospectId))
    if (!prospect) return res.status(404).json({ ok: false, error: 'not_found' })
    const result = await markDoNotContact({
      db: req.db,
      prospect,
      reason: req.body?.reason || 'admin_request',
      addedByUserId: req.ctx?.userId || null,
    })
    await audit(
      req.db,
      req,
      'relationship.dnc',
      { prospect_id: prospect.id, reason: req.body?.reason || null },
      SEVERITY.WARNING,
    )
    return res.json({ ok: true, relationship: result })
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || 'dnc_failed' })
  }
})

void PROSPECT_STATUS

export default router
