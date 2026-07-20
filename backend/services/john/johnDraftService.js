/**
 * John — draft service.
 *
 * Single entry point that, given one Yana lead, runs the full pipeline:
 *
 *   pre-flight  -> rate-limit  -> compose  -> safety  -> Outlook draft  -> persist
 *
 * Every step that produces a verdict is captured in the safety_report and
 * audit row so reviewers can trace exactly why a draft was created, blocked,
 * or marked needs_sender_alias_review.
 *
 * Important guarantees (asserted by tests):
 *   - never sends an email
 *   - never makes more than one Outlook call per lead
 *   - never silently overwrites an existing draft for the same lead
 *   - never records a "draft_created" audit row without a real
 *     provider_draft_id from Outlook (or a fake provider in tests)
 */

import { randomUUID } from 'node:crypto'

import {
  AUDIT_STATUS,
  BLOCK_REASONS,
  DRAFT_STATUS,
  SAFETY_STATUS,
  makeAliasReport,
  makeSafetyReport,
} from './johnTypes.js'
import {
  assertDraftOnly,
  evaluateDraftSafety,
  getJohnConfig,
} from './johnOutreachSafety.js'
import { composeEmailFromLead } from './johnEmailWriter.js'
import { interpretLead } from './johnLeadInterpreter.js'
import {
  hasDraftForLead,
  insertAudit,
  insertDraft,
  updateDraft,
} from './johnRunStore.js'
import { checkRateGate } from './johnRateLimiter.js'
import { makeSuppressionChecker } from './johnSuppressionService.js'
import { createOutlookProvider } from './johnOutlookProvider.js'
import { getLatestAliasCheck } from './johnRunStore.js'

const PROVIDER_NAME = 'outlook'

/**
 * Outcome shape:
 *   { ok, status, draft_id, provider_draft_id?, safety_report,
 *     alias_report, blocked_reasons[], error? }
 */
export async function draftEmailForLead({
  db,
  lead,
  runId = null,
  provider = null,
  config = getJohnConfig(),
  logger = console,
  suppression = null,
  aliasCheck = undefined,
  forcePolicyOverride = false,
  operatorNote = null,
} = {}) {
  assertDraftOnly(config)
  if (!db) throw new Error('draftEmailForLead: db is required')
  if (!lead) throw new Error('draftEmailForLead: lead is required')

  const aliasReport = makeAliasReport({
    requested_from_alias: config.fromAlias || null,
    reply_to: config.replyTo || null,
    actual_from: null,
  })

  // 1. Has this lead already been drafted?
  let already = false
  if (lead.lead_id) {
    already = await hasDraftForLead(db, lead.lead_id)
  }

  // 2. Suppression checker
  const supp = suppression || (await makeSuppressionChecker(db))

  // 3. Rate limit pre-flight
  const rate = await checkRateGate(db, config)

  // 4. Interpret + compose
  const interpretation = interpretLead(lead)
  const composed = await composeEmailFromLead(lead, { config, interpretation, logger, operatorNote })

  // 5. Safety classification
  const safety = evaluateDraftSafety({
    lead,
    draft: {
      subject: composed.subject,
      body: composed.body_text,
      recipient_email: composed.recipient_email,
      recipient_name: composed.recipient_name,
    },
    suppression: supp,
    config,
    alreadyDrafted: already,
  })

  // Merge rate-gate reasons into safety reasons.
  const reasons = [...safety.reasons, ...rate.reasons]
  if (reasons.length > 0 && !forcePolicyOverride) {
    return finalizeBlocked({
      db, lead, runId, composed, safety: makeSafetyReport({ ...safety, reasons }), aliasReport,
    })
  }

  // 6. Alias state — read latest alias check from DB if not provided.
  let cachedAlias = aliasCheck
  if (cachedAlias === undefined) {
    try { cachedAlias = await getLatestAliasCheck(db) } catch { cachedAlias = null }
  }

  // 7. Provider — if not configured, block with a precise reason.
  const p = provider || createOutlookProvider({ config, logger })
  if (!p.ready) {
    return finalizeBlocked({
      db, lead, runId, composed,
      safety: makeSafetyReport({
        status: SAFETY_STATUS.BLOCKED,
        reasons: [BLOCK_REASONS.PROVIDER_NOT_CONFIGURED],
      }),
      aliasReport,
    })
  }

  // 8. Create the Outlook draft.
  let providerResult
  try {
    providerResult = await p.createDraft({
      toEmail: composed.recipient_email,
      toName: composed.recipient_name,
      subject: composed.subject,
      bodyText: composed.body_text,
      bodyHtml: composed.body_html,
      requestedFromAlias: config.fromAlias,
      replyTo: config.replyTo,
      displayName: config.displayName,
    })
  } catch (err) {
    logger?.warn?.('[John] Outlook draft creation threw', { error: err?.message, code: err?.code })
    return finalizeFailed({
      db, lead, runId, composed,
      safety: makeSafetyReport({
        status: SAFETY_STATUS.BLOCKED,
        reasons: [BLOCK_REASONS.PROVIDER_NOT_CONFIGURED],
      }),
      aliasReport,
      error: err?.message || 'unknown_provider_error',
    })
  }

  // 9. Decide draft status based on alias outcome.
  aliasReport.actual_from = providerResult.actual_from || null
  aliasReport.alias_verified = !!cachedAlias?.alias_verified
  aliasReport.alias_send_supported = !!providerResult.alias_set
  aliasReport.fallback_used = !providerResult.alias_set
  aliasReport.needs_sender_alias_review =
    !providerResult.alias_set && !!config.requireAliasReviewIfFallback

  let draft_status = DRAFT_STATUS.CREATED
  let needsAliasReview = false
  if (aliasReport.needs_sender_alias_review) {
    draft_status = DRAFT_STATUS.NEEDS_SENDER_ALIAS_REVIEW
    needsAliasReview = true
  }

  const draftId = randomUUID().replace(/-/g, '')

  await insertDraft(db, {
    id: draftId,
    yana_lead_id: lead.lead_id,
    run_id: runId,
    organization_name: lead.organization_name,
    recipient_email: composed.recipient_email,
    recipient_name: composed.recipient_name,
    recipient_role: composed.recipient_role,
    subject: composed.subject,
    body_text: composed.body_text,
    body_html: composed.body_html,
    from_mailbox: config.primaryMailbox,
    from_alias: providerResult.alias_set ? config.fromAlias : null,
    reply_to: config.replyTo,
    display_name: config.displayName,
    provider: PROVIDER_NAME,
    provider_draft_id: providerResult.provider_draft_id,
    provider_message_id: providerResult.provider_message_id,
    draft_status,
    safety_status: SAFETY_STATUS.PASSED,
    safety_report_json: makeSafetyReport({ status: SAFETY_STATUS.PASSED, reasons: [] }),
    alias_report_json: aliasReport,
    personalization_json: composed.personalization,
    source_evidence_json: {
      source_urls: lead.source_urls || [],
      public_evidence: lead.public_evidence || [],
    },
    needs_sender_alias_review: needsAliasReview,
    fallback_used: aliasReport.fallback_used,
  })

  await insertAudit(db, {
    yana_lead_id: lead.lead_id,
    draft_id: draftId,
    recipient_email: composed.recipient_email,
    organization_name: lead.organization_name,
    subject: composed.subject,
    from_mailbox: config.primaryMailbox,
    from_alias: providerResult.alias_set ? config.fromAlias : null,
    reply_to: config.replyTo,
    status: AUDIT_STATUS.DRAFT_CREATED,
    provider_draft_id: providerResult.provider_draft_id,
    safety_report_json: makeSafetyReport({ status: SAFETY_STATUS.PASSED }),
    alias_report_json: aliasReport,
    error: null,
  })

  return {
    ok: true,
    status: draft_status,
    draft_id: draftId,
    provider_draft_id: providerResult.provider_draft_id,
    needs_sender_alias_review: needsAliasReview,
    alias_report: aliasReport,
    safety_report: makeSafetyReport({ status: SAFETY_STATUS.PASSED }),
  }
}

async function finalizeBlocked({ db, lead, runId, composed, safety, aliasReport }) {
  const draftId = randomUUID().replace(/-/g, '')
  await insertDraft(db, {
    id: draftId,
    yana_lead_id: lead?.lead_id,
    run_id: runId,
    organization_name: lead?.organization_name,
    recipient_email: composed?.recipient_email,
    recipient_name: composed?.recipient_name,
    recipient_role: composed?.recipient_role,
    subject: composed?.subject || null,
    body_text: composed?.body_text || null,
    body_html: composed?.body_html || null,
    from_mailbox: null,
    from_alias: null,
    reply_to: null,
    display_name: null,
    provider: PROVIDER_NAME,
    provider_draft_id: null,
    provider_message_id: null,
    draft_status: DRAFT_STATUS.BLOCKED,
    safety_status: SAFETY_STATUS.BLOCKED,
    safety_report_json: safety,
    alias_report_json: aliasReport,
    personalization_json: composed?.personalization || null,
    source_evidence_json: {
      source_urls: lead?.source_urls || [],
      public_evidence: lead?.public_evidence || [],
    },
    needs_sender_alias_review: false,
    fallback_used: false,
  })
  await insertAudit(db, {
    yana_lead_id: lead?.lead_id,
    draft_id: draftId,
    recipient_email: composed?.recipient_email || null,
    organization_name: lead?.organization_name || null,
    subject: composed?.subject || null,
    status: AUDIT_STATUS.DRAFT_BLOCKED,
    safety_report_json: safety,
    alias_report_json: aliasReport,
    error: null,
  })
  return {
    ok: false,
    status: DRAFT_STATUS.BLOCKED,
    draft_id: draftId,
    blocked_reasons: safety.reasons,
    safety_report: safety,
    alias_report: aliasReport,
  }
}

async function finalizeFailed({ db, lead, runId, composed, safety, aliasReport, error }) {
  const draftId = randomUUID().replace(/-/g, '')
  await insertDraft(db, {
    id: draftId,
    yana_lead_id: lead?.lead_id,
    run_id: runId,
    organization_name: lead?.organization_name,
    recipient_email: composed?.recipient_email,
    recipient_name: composed?.recipient_name,
    subject: composed?.subject,
    body_text: composed?.body_text,
    body_html: composed?.body_html,
    provider: PROVIDER_NAME,
    draft_status: DRAFT_STATUS.FAILED,
    safety_status: SAFETY_STATUS.BLOCKED,
    safety_report_json: safety,
    alias_report_json: aliasReport,
    personalization_json: composed?.personalization || null,
    source_evidence_json: {
      source_urls: lead?.source_urls || [],
      public_evidence: lead?.public_evidence || [],
    },
  })
  await insertAudit(db, {
    yana_lead_id: lead?.lead_id,
    draft_id: draftId,
    recipient_email: composed?.recipient_email || null,
    organization_name: lead?.organization_name || null,
    subject: composed?.subject || null,
    status: AUDIT_STATUS.DRAFT_FAILED,
    safety_report_json: safety,
    alias_report_json: aliasReport,
    error: error || 'unknown_error',
  })
  return {
    ok: false,
    status: DRAFT_STATUS.FAILED,
    draft_id: draftId,
    error: error || 'unknown_error',
    safety_report: safety,
    alias_report: aliasReport,
  }
}

/**
 * Helper used by /api/john/drafts/:id/archive.
 */
export async function archiveDraft(db, id, reason = null) {
  await updateDraft(db, id, {
    draft_status: DRAFT_STATUS.ARCHIVED,
    archived_at: new Date().toISOString(),
    archived_reason: reason,
  })
}

/**
 * Helper used by /api/john/drafts/:id/revise. Reviser callers can pass new
 * subject / body text; we re-run the body classifier and either save the
 * revision or refuse it.
 */
export async function reviseDraftBody(db, id, { subject, body_text, body_html, config = getJohnConfig() } = {}) {
  if (!id) throw new Error('reviseDraftBody: id required')
  const safety = evaluateDraftSafety({
    lead: { qualified: true, public_evidence: [{ summary: 'manual revision' }], source_urls: ['manual'], do_not_contact_flags: [] },
    draft: {
      subject: subject || 'Possible funding help',
      body: body_text || '',
      recipient_email: 'placeholder@example.org',
    },
    config,
    alreadyDrafted: false,
  })
  if (safety.status === SAFETY_STATUS.BLOCKED) {
    return { ok: false, blocked_reasons: safety.reasons, safety_report: safety }
  }
  await updateDraft(db, id, {
    subject: subject ?? undefined,
    body_text: body_text ?? undefined,
    body_html: body_html ?? undefined,
    draft_status: DRAFT_STATUS.NEEDS_REVIEW,
    safety_report_json: safety,
  })
  return { ok: true, safety_report: safety }
}
