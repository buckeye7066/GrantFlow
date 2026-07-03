/**
 * John — bounce (NDR) reconciliation against the live Outlook mailbox.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * The owner sends John's drafts manually. When a recipient address is bad, the
 * mailbox receives a non-delivery report (postmaster / mailer-daemon), but
 * nothing in GrantFlow ever learned from it: the address stayed usable, the
 * draft row stayed "live", and the owner reported bounced mail with no system
 * response ("2 of them returned undeliverable", 2026-07-03).
 *
 * THE FIX (single choke point — see CLAUDE.md INVARIANTS)
 * ------------------------------------------------------
 * At the start of every John drafting run (right after deleted-draft
 * reconciliation) we scan the inbox's recent messages for NDRs, extract the
 * failed recipient addresses, and:
 *   1. add each to `john_suppression_list` (type=email, source
 *      'john_bounce_reconcile') so NO future draft ever targets it again, and
 *   2. archive the matching `john_email_drafts` rows with
 *      archived_reason='bounced' (+ audit row), so dashboards stop counting a
 *      dead outreach as live. Archived is redraft-eligible by design, but the
 *      suppression from (1) blocks any redraft to the same address.
 *
 * Detection is deliberately conservative: a message counts as an NDR only when
 * BOTH the sender looks like mail infrastructure (postmaster@/mailer-daemon@/
 * microsoftexchange…) AND the subject matches a known bounce phrase. Addresses
 * are extracted from the body, excluding our own mailbox/domain.
 */

import { addSuppression } from './johnSuppressionService.js'
import { insertAudit } from './johnRunStore.js'
import { DRAFT_STATUS, SUPPRESSION_TYPE } from './johnTypes.js'

const NDR_SENDER = /^(postmaster|mailer-daemon|microsoftexchange[0-9a-f]*)@/i
const NDR_SUBJECT = /(undeliverable|delivery (has )?failed|delivery status notification|failure notice|returned mail|couldn'?t be delivered|mail delivery failed)/i
const EMAIL_IN_TEXT = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi

/**
 * Pure extraction: NDR messages → Set of bounced recipient emails.
 * `selfMailbox` (and its domain) is excluded so the report's references to our
 * own sender address never count as "bounced recipients".
 */
export function extractBouncedRecipients(messages, { selfMailbox = '' } = {}) {
  const self = String(selfMailbox || '').toLowerCase()
  const selfDomain = self.includes('@') ? self.split('@')[1] : null
  const bounced = new Set()
  for (const m of messages || []) {
    const fromAddr = String(m?.from?.emailAddress?.address || '').toLowerCase()
    const subject = String(m?.subject || '')
    if (!NDR_SENDER.test(fromAddr) || !NDR_SUBJECT.test(subject)) continue
    const text = `${String(m?.bodyPreview || '')}\n${String(m?.body?.content || '').replace(/<[^>]+>/g, ' ')}`
    for (const hit of text.match(EMAIL_IN_TEXT) || []) {
      const email = hit.toLowerCase()
      if (email === self) continue
      if (selfDomain && email.endsWith(`@${selfDomain}`)) continue
      if (NDR_SENDER.test(email)) continue
      bounced.add(email)
    }
  }
  return bounced
}

/**
 * Scan the inbox for NDRs and reconcile: suppress bounced addresses + archive
 * their draft rows. Non-fatal by contract — callers treat any throw as a
 * skipped step. Returns a summary for the run record.
 */
export async function reconcileBouncedDrafts({ db, provider, logger = console, lookbackHours = 96, top = 100 } = {}) {
  const summary = { scanned: 0, ndr_recipients: 0, suppressed: 0, drafts_archived: 0 }
  if (!db || !provider?.listInboxMessages) return summary

  const sinceIso = new Date(Date.now() - Math.max(1, lookbackHours) * 3600_000).toISOString()
  const { messages } = await provider.listInboxMessages({ top, sinceIso })
  summary.scanned = (messages || []).length

  const selfMailbox = process.env.JOHN_PRIMARY_MAILBOX || ''
  const bounced = extractBouncedRecipients(messages, { selfMailbox })
  summary.ndr_recipients = bounced.size
  if (bounced.size === 0) return summary

  const nowIso = new Date().toISOString()
  for (const email of bounced) {
    try {
      await addSuppression(db, {
        type: SUPPRESSION_TYPE.EMAIL,
        value: email,
        reason: 'bounced (NDR received in mailbox)',
        source: 'john_bounce_reconcile',
      })
      summary.suppressed += 1
    } catch (err) {
      logger?.warn?.('[John] bounce suppression failed', { error: err?.message })
    }

    // Archive this address's still-live draft rows so counts stay honest.
    let rows = []
    try {
      rows = await db
        .prepare(
          `SELECT id FROM john_email_drafts
            WHERE lower(recipient_email) = ?
              AND draft_status IN (?, ?, ?)`,
        )
        .all(email, DRAFT_STATUS.CREATED, DRAFT_STATUS.NEEDS_REVIEW, DRAFT_STATUS.NEEDS_SENDER_ALIAS_REVIEW)
    } catch {
      rows = []
    }
    for (const row of rows || []) {
      try {
        await db
          .prepare(
            `UPDATE john_email_drafts
                SET draft_status = ?, archived_at = ?, archived_reason = 'bounced'
              WHERE id = ?`,
          )
          .run(DRAFT_STATUS.ARCHIVED, nowIso, row.id)
        summary.drafts_archived += 1
        try {
          await insertAudit(db, {
            draft_id: row.id,
            status: 'suppressed',
            recipient_email: email,
            error: 'NDR received; address suppressed and draft archived (bounced)',
          })
        } catch { /* audit is best-effort */ }
      } catch (err) {
        logger?.warn?.('[John] bounce draft archive failed', { error: err?.message })
      }
    }
  }

  logger?.info?.('[John] bounce reconcile complete', summary)
  return summary
}
