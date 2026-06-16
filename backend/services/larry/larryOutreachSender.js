/**
 * Larry — outreach sender.
 *
 * The most safety-critical file in Larry. Sending real outbound email to a
 * third party MUST be:
 *   1. Explicitly enabled (LARRY_ENABLED=true).
 *   2. Approved per attempt (attempt.approved_by_user_id set, unless the
 *      operator opts out of approval — which we discourage).
 *   3. Off the suppression list, off DNC for the relationship.
 *   4. Inside the daily send budget.
 *   5. The email service must actually be configured.
 *
 * The sender accepts an injected `emailSender` so unit tests can prove the
 * gating logic *never* calls the real Resend client when conditions aren't
 * met. In production, the route layer wires `sendApplicationEmail`-style
 * Resend client into this module.
 *
 * Every send attempt is logged regardless of outcome, including blocked
 * sends — admins should always be able to see why a send didn't go out.
 */

import { OUTREACH_SEND_STATUS, SEND_BLOCK_REASONS } from './larryTypes.js'
import { checkSendIsAllowed, getLarryConfig } from './larrySafety.js'
import {
  countSendsInWindow,
  findSuppressionsForProspect,
  getRelationship,
  upsertRelationship,
  updateOutreachAttempt,
} from './larryRunStore.js'
import { recordContactedRelationship } from './larryRelationshipTracker.js'

/**
 * Run all gates in order; return the first blocking reason or null.
 */
async function evaluateSendGates({ db, attempt, prospect, config, dryRun }) {
  if (dryRun) {
    return { reason: SEND_BLOCK_REASONS.DRY_RUN, detail: 'dryRun=true' }
  }

  const cfg = config || getLarryConfig()

  if (cfg.requireApprovalToSend && !attempt.approved_by_user_id) {
    return { reason: SEND_BLOCK_REASONS.SEND_NOT_APPROVED, detail: 'admin approval required' }
  }

  if (!cfg.fromEmail) {
    return { reason: SEND_BLOCK_REASONS.PROVIDER_NOT_CONFIGURED, detail: 'no FROM_EMAIL configured' }
  }

  const suppressionHits = db ? await findSuppressionsForProspect(db, prospect) : []
  const relationship = db && prospect?.id ? await getRelationship(db, prospect.id) : null

  const safetyVerdict = checkSendIsAllowed({
    attempt,
    prospect,
    relationship,
    suppressionHits,
    config: cfg,
  })
  if (safetyVerdict) return safetyVerdict

  if (db) {
    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const sentToday = await countSendsInWindow(db, { sinceIso })
    if (sentToday >= cfg.maxOutreachSendsPerDay) {
      return {
        reason: SEND_BLOCK_REASONS.DAILY_LIMIT,
        detail: `${sentToday} sends in last 24h ≥ ${cfg.maxOutreachSendsPerDay}`,
      }
    }
  }

  return null
}

/**
 * Send a single outreach attempt. Returns:
 *   { sent: true, attempt }
 *   { sent: false, blocked: { reason, detail }, attempt }
 *
 * The attempt row is updated with the outcome (sent_at + provider id, OR
 * send_status=cancelled + send_error="blocked: <reason>"). The relationship
 * row is bumped to `contacted` only when the send actually succeeded.
 */
export async function sendOutreachAttempt({
  db,
  attempt,
  prospect,
  emailSender = null,
  config = null,
  dryRun = false,
  fromName = 'The GrantFlow team',
} = {}) {
  if (!attempt?.id) return { sent: false, blocked: { reason: 'invalid_attempt' } }

  const cfg = config || getLarryConfig()
  const blocked = await evaluateSendGates({ db, attempt, prospect, config: cfg, dryRun })
  if (blocked) {
    if (db) {
      await updateOutreachAttempt(db, attempt.id, {
        send_status: blocked.reason === SEND_BLOCK_REASONS.DRY_RUN ? OUTREACH_SEND_STATUS.DRAFTED : OUTREACH_SEND_STATUS.CANCELLED,
        send_error: `blocked:${blocked.reason}${blocked.detail ? `:${blocked.detail}` : ''}`,
      })
    }
    return { sent: false, blocked, attempt }
  }

  if (typeof emailSender !== 'function') {
    if (db) {
      await updateOutreachAttempt(db, attempt.id, {
        send_status: OUTREACH_SEND_STATUS.FAILED,
        send_error: 'no email sender wired',
      })
    }
    return { sent: false, blocked: { reason: SEND_BLOCK_REASONS.PROVIDER_NOT_CONFIGURED, detail: 'no emailSender' } }
  }

  const recipient = attempt.sent_to_email || prospect?.primary_contact_email
  if (!recipient) {
    if (db) {
      await updateOutreachAttempt(db, attempt.id, {
        send_status: OUTREACH_SEND_STATUS.FAILED,
        send_error: 'no recipient',
      })
    }
    return { sent: false, blocked: { reason: SEND_BLOCK_REASONS.RECIPIENT_MISSING } }
  }

  let providerResult
  try {
    providerResult = await emailSender({
      from: cfg.fromEmail,
      fromName,
      replyTo: cfg.replyToEmail || cfg.fromEmail,
      bcc: cfg.bccCompliance || null,
      to: recipient,
      subject: attempt.draft_subject,
      html: attempt.draft_body,
      text: attempt.draft_text,
      headers: {
        'List-Unsubscribe': cfg.replyToEmail ? `<mailto:${cfg.replyToEmail}?subject=unsubscribe>` : undefined,
      },
    })
  } catch (err) {
    if (db) {
      await updateOutreachAttempt(db, attempt.id, {
        send_status: OUTREACH_SEND_STATUS.FAILED,
        send_error: err?.message || String(err),
      })
    }
    return { sent: false, blocked: { reason: 'provider_error', detail: err?.message || String(err) } }
  }

  const messageId = providerResult?.messageId || providerResult?.id || providerResult?.data?.id || null
  const success = providerResult?.ok !== false && !providerResult?.error
  if (!success) {
    if (db) {
      await updateOutreachAttempt(db, attempt.id, {
        send_status: OUTREACH_SEND_STATUS.FAILED,
        send_error: providerResult?.error?.message || 'unknown send failure',
      })
    }
    return { sent: false, blocked: { reason: 'provider_error', detail: providerResult?.error?.message || 'unknown' } }
  }

  let updatedAttempt = attempt
  if (db) {
    updatedAttempt = await updateOutreachAttempt(db, attempt.id, {
      send_status: OUTREACH_SEND_STATUS.SENT,
      sent_at: new Date().toISOString(),
      sent_to_email: recipient,
      send_provider: providerResult?.provider || 'resend',
      send_provider_message_id: messageId,
    })

    if (prospect?.id) {
      try {
        await recordContactedRelationship({ db, prospectCandidateId: prospect.id })
      } catch {
        // best-effort: relationship tracking should never break a send
      }
    }
  }

  return { sent: true, attempt: updatedAttempt, providerMessageId: messageId }
}

/**
 * Adapter that wraps Resend's `sendApplicationEmail`-style API into the
 * shape `sendOutreachAttempt` expects. Real production callers wire this
 * up by passing the actual Resend client into the route layer; the agent
 * never imports Resend directly.
 */
export function buildEmailSenderAdapter(resendSendFn) {
  if (typeof resendSendFn !== 'function') return null
  return async function emailSender({ from, fromName, to, subject, html, text, replyTo, bcc, headers }) {
    const result = await resendSendFn({
      from: fromName ? `${fromName} <${from}>` : from,
      to,
      subject,
      html,
      text,
      reply_to: replyTo,
      bcc,
      headers,
    })
    if (result?.error) {
      return { ok: false, error: result.error, provider: 'resend' }
    }
    return { ok: true, provider: 'resend', messageId: result?.id || result?.data?.id || null }
  }
}

void upsertRelationship
