/**
 * awardCompliance.js — Award Compliance & Restriction Tracking routes.
 *
 * Profile-scoped CRUD over award restriction rules + spend entries, plus a
 * compliance summary and scholarship reconciliation. Access control uses the
 * shared ensureProfileAccess / requireAuthenticatedUser helpers so it matches
 * every other profile route.
 *
 * Money in/out is integer CENTS. Proof of spending is an EXISTING uploaded
 * document (documents.id) — we do not add a new upload mechanism here; the
 * client uploads via /api/documents/ingest and passes the returned id as
 * proof_document_id.
 */

import express from 'express'
import { requireAuthenticatedUser, ensureProfileAccess, getAuthUserId } from '../utils/accessControl.js'
import {
  createRule,
  getRule,
  listRulesForProfile,
  listRulesForGrant,
  addSpendEntry,
  listSpendEntries,
  computeComplianceSummary,
  computeScholarshipReconciliation,
  deriveDraftRulesForGrant,
} from '../services/awardCompliance/awardComplianceStore.js'
import { createLogger } from '../utils/logger.js'

const routeLogger = createLogger('route:award-compliance')
const router = express.Router()

function normalizeId(v) {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s && s.toLowerCase() !== 'all' ? s : null
}

// Confirm a proof document (if supplied) exists and belongs to the same
// profile. Conservative: a proof for the wrong profile is rejected, not
// silently dropped.
async function assertProofDocumentValid(req, res, { proofDocumentId, profileId }) {
  if (!proofDocumentId) return true
  const doc = await req.db.prepare('SELECT id, profile_id FROM documents WHERE id = ?').get(String(proofDocumentId))
  if (!doc) {
    res.status(400).json({ error: 'proof_document_id does not reference an existing document' })
    return false
  }
  if (doc.profile_id && String(doc.profile_id) !== String(profileId)) {
    res.status(403).json({ error: 'proof_document_id belongs to a different profile' })
    return false
  }
  return true
}

// GET /api/award-compliance/rules?profile_id=...&grant_id=...
// Lists rules for a profile (optionally narrowed to one grant), each with its
// computed compliance summary.
router.get('/rules', async (req, res) => {
  try {
    const profileId = normalizeId(req.query?.profile_id)
    if (!(await ensureProfileAccess(req, res, profileId))) return

    const grantId = normalizeId(req.query?.grant_id)
    const rules = grantId
      ? (await listRulesForGrant(req.db, grantId)).filter((r) => r.profile_id === profileId)
      : await listRulesForProfile(req.db, profileId)

    const withSummary = []
    for (const rule of rules) {
      const summary = await computeComplianceSummary(req.db, rule)
      withSummary.push({ ...rule, summary })
    }
    res.json({ profile_id: profileId, grant_id: grantId, rules: withSummary })
  } catch (error) {
    routeLogger.error('[award-compliance] list rules failed', { error: error?.message })
    res.status(500).json({ error: error?.message || String(error) })
  }
})

// POST /api/award-compliance/rules
// Body: { profile_id, grant_id?, award_ref?, title, total_amount_cents?,
//         restriction_type, category?, required_amount_cents?, spend_by_date?,
//         description? }
router.post('/rules', async (req, res) => {
  try {
    const body = req.body ?? {}
    const profileId = normalizeId(body.profile_id)
    if (!(await ensureProfileAccess(req, res, profileId))) return

    const user = requireAuthenticatedUser(req, res)
    if (!user) return

    if (!body.title || !String(body.title).trim()) {
      return res.status(400).json({ error: 'title is required' })
    }

    const rule = await createRule(req.db, {
      profileId,
      grantId: normalizeId(body.grant_id),
      awardRef: body.award_ref ? String(body.award_ref) : null,
      title: body.title,
      totalAmountCents: body.total_amount_cents ?? null,
      restrictionType: body.restriction_type ?? 'other',
      category: body.category ?? null,
      requiredAmountCents: body.required_amount_cents ?? null,
      spendByDate: body.spend_by_date ?? null,
      description: body.description ?? null,
      isDraft: body.is_draft === true || body.is_draft === 'true',
      sourceExcerpt: body.source_excerpt ?? null,
      createdBy: getAuthUserId(user) || null,
    })
    res.status(201).json({ rule })
  } catch (error) {
    routeLogger.error('[award-compliance] create rule failed', { error: error?.message })
    res.status(500).json({ error: error?.message || String(error) })
  }
})

// PATCH /api/award-compliance/rules/:id
// Confirm/edit a (possibly draft) rule. Profile is resolved from the rule.
router.patch('/rules/:id', async (req, res) => {
  try {
    const rule = await getRule(req.db, req.params.id)
    if (!rule) return res.status(404).json({ error: 'Rule not found' })
    if (!(await ensureProfileAccess(req, res, rule.profile_id))) return

    const body = req.body ?? {}
    const sets = []
    const args = []
    const MUTABLE = {
      title: (v) => String(v),
      total_amount_cents: (v) => (v === null ? null : Math.round(Number(v))),
      restriction_type: (v) => String(v),
      category: (v) => (v === null ? null : String(v)),
      required_amount_cents: (v) => (v === null ? null : Math.round(Number(v))),
      spend_by_date: (v) => (v ? String(v) : null),
      description: (v) => (v === null ? null : String(v)),
      is_draft: (v) => (v === true || v === 'true' ? 1 : 0),
    }
    for (const [key, coerce] of Object.entries(MUTABLE)) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        sets.push(`${key} = ?`)
        args.push(coerce(body[key]))
      }
    }
    if (sets.length === 0) return res.status(400).json({ error: 'No valid fields provided' })

    const nowFn = req.db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
    args.push(rule.id)
    await req.db.prepare(
      `UPDATE award_compliance_rules SET ${sets.join(', ')}, updated_at = ${nowFn} WHERE id = ?`,
    ).run(...args)

    const updated = await getRule(req.db, rule.id)
    const summary = await computeComplianceSummary(req.db, updated)
    res.json({ rule: { ...updated, summary } })
  } catch (error) {
    routeLogger.error('[award-compliance] update rule failed', { error: error?.message })
    res.status(500).json({ error: error?.message || String(error) })
  }
})

// POST /api/award-compliance/rules/:id/spend
// Body: { amount_cents, spent_on?, category?, memo?, proof_document_id? }
router.post('/rules/:id/spend', async (req, res) => {
  try {
    const rule = await getRule(req.db, req.params.id)
    if (!rule) return res.status(404).json({ error: 'Rule not found' })
    if (!(await ensureProfileAccess(req, res, rule.profile_id))) return

    const user = requireAuthenticatedUser(req, res)
    if (!user) return

    const body = req.body ?? {}
    if (body.amount_cents === undefined || body.amount_cents === null || body.amount_cents === '') {
      return res.status(400).json({ error: 'amount_cents is required' })
    }
    const proofDocumentId = body.proof_document_id ? String(body.proof_document_id) : null
    if (!(await assertProofDocumentValid(req, res, { proofDocumentId, profileId: rule.profile_id }))) return

    const entry = await addSpendEntry(req.db, {
      ruleId: rule.id,
      amountCents: body.amount_cents,
      spentOn: body.spent_on ?? null,
      category: body.category ?? null,
      memo: body.memo ?? null,
      proofDocumentId,
      createdBy: getAuthUserId(user) || null,
    })

    const refreshed = await getRule(req.db, rule.id)
    const summary = await computeComplianceSummary(req.db, refreshed)
    res.status(201).json({ entry, summary })
  } catch (error) {
    routeLogger.error('[award-compliance] add spend failed', { error: error?.message })
    res.status(400).json({ error: error?.message || String(error) })
  }
})

// GET /api/award-compliance/rules/:id/spend  — list entries for a rule
router.get('/rules/:id/spend', async (req, res) => {
  try {
    const rule = await getRule(req.db, req.params.id)
    if (!rule) return res.status(404).json({ error: 'Rule not found' })
    if (!(await ensureProfileAccess(req, res, rule.profile_id))) return
    const entries = await listSpendEntries(req.db, rule.id)
    res.json({ rule_id: rule.id, entries })
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) })
  }
})

// GET /api/award-compliance/summary?profile_id=...&grant_id=...
// Aggregated compliance summary for every rule on a profile (or one grant).
router.get('/summary', async (req, res) => {
  try {
    const profileId = normalizeId(req.query?.profile_id)
    if (!(await ensureProfileAccess(req, res, profileId))) return

    const grantId = normalizeId(req.query?.grant_id)
    const rules = grantId
      ? (await listRulesForGrant(req.db, grantId)).filter((r) => r.profile_id === profileId)
      : await listRulesForProfile(req.db, profileId)

    const items = []
    let overdue = 0
    let short = 0
    let over = 0
    let met = 0
    for (const rule of rules) {
      const summary = await computeComplianceSummary(req.db, rule)
      items.push({ rule, summary })
      if (summary.status === 'overdue') overdue += 1
      else if (summary.status === 'short') short += 1
      else if (summary.status === 'over') over += 1
      else if (summary.status === 'met') met += 1
    }
    res.json({
      profile_id: profileId,
      grant_id: grantId,
      counts: { total: rules.length, overdue, short, over, met },
      items,
    })
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) })
  }
})

// POST /api/award-compliance/scholarship-reconciliation
// Body: { award_cents, school_bill_cents }  (stateless math helper)
router.post('/scholarship-reconciliation', async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return
    const body = req.body ?? {}
    const result = computeScholarshipReconciliation({
      award_cents: body.award_cents,
      school_bill_cents: body.school_bill_cents,
    })
    res.json(result)
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) })
  }
})

// POST /api/award-compliance/grants/:grantId/derive
// (Re)derive DRAFT restriction rules for an awarded grant by parsing its
// free-text fields. Conservative: invents no numbers, creates nothing when
// nothing parseable is found, and skips equivalents that already exist.
router.post('/grants/:grantId/derive', async (req, res) => {
  try {
    const grant = await req.db.prepare('SELECT * FROM grants WHERE id = ?').get(String(req.params.grantId))
    if (!grant) return res.status(404).json({ error: 'Grant not found' })
    if (!grant.profile_id) {
      return res.status(400).json({ error: 'Grant has no profile_id; cannot derive compliance rules' })
    }
    if (!(await ensureProfileAccess(req, res, grant.profile_id))) return

    const user = requireAuthenticatedUser(req, res)
    const created = await deriveDraftRulesForGrant(req.db, grant, {
      createdBy: getAuthUserId(user) || 'system-derive',
    })
    res.json({ grant_id: grant.id, created_count: created.length, rules: created })
  } catch (error) {
    routeLogger.error('[award-compliance] derive failed', { error: error?.message })
    res.status(500).json({ error: error?.message || String(error) })
  }
})

export default router
