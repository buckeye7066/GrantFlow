/**
 * John — draft reconciliation against the live Outlook mailbox.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * John records every draft he creates as a row in `john_email_drafts` with
 * `draft_status='created'` and the Outlook message id in `provider_draft_id`.
 * The owner reviews those drafts in the mailbox and DELETES the ones they don't
 * want to send — that deletion IS the owner's "reject this outreach" decision.
 *
 * Nothing in GrantFlow deletes Outlook messages, so once the owner removes a
 * draft the DB row is left stranded as `created` forever. Two bad consequences:
 *   1. The system keeps reporting a draft that no longer exists ("thinks it's
 *      still there"), so counts/dashboards lie.
 *   2. `hasDraftForLead()` still sees a live row, so John treats the lead as
 *      handled — which is correct (the owner rejected it) but only by accident;
 *      the row's status is dishonest about WHY.
 *
 * THE FIX (single choke point — see CLAUDE.md INVARIANTS)
 * ------------------------------------------------------
 * Before each John run we reconcile every tracked-as-live draft against the
 * mailbox. A draft that returns 404 from Graph has been deleted by the owner;
 * we flip its row to the terminal `DELETED_BY_USER` status. That status is
 * deliberately OUTSIDE hasDraftForLead's re-draft-eligible exclusion set, so:
 *   - the system stops reporting the draft as live, AND
 *   - John never resurrects a draft the owner deliberately deleted.
 *
 * This is the ONE place the rule "a live draft row must correspond to an
 * existing Outlook draft" is enforced against the live store, regardless of
 * which path created the row.
 */

import { listDrafts, updateDraft, insertAudit } from './johnRunStore.js'
import { DRAFT_STATUS, AUDIT_STATUS } from './johnTypes.js'

// Statuses whose Outlook draft is expected to still be live in the mailbox.
// Only these are worth checking — terminal rows (blocked/failed/archived/
// reviewed/sent/deleted) have no live mailbox object to reconcile.
const LIVE_STATUSES = [
  DRAFT_STATUS.CREATED,
  DRAFT_STATUS.NEEDS_REVIEW,
  DRAFT_STATUS.NEEDS_SENDER_ALIAS_REVIEW,
]

/**
 * Mark a single draft row as deleted-by-owner in Outlook. Idempotent and
 * shared with the draft-refresh service's 404 branch so the two paths agree on
 * exactly how a vanished draft is recorded.
 */
export async function markDraftDeletedInOutlook(db, row, { logger } = {}) {
  const nowIso = new Date().toISOString()
  await updateDraft(db, row.id, {
    draft_status: DRAFT_STATUS.DELETED_BY_USER,
    archived_at: nowIso,
    archived_reason: AUDIT_STATUS.DELETED_IN_OUTLOOK,
  })
  // Best-effort audit trail — never let an audit write fail the reconcile.
  try {
    await insertAudit(db, {
      draft_id: row.id,
      yana_lead_id: row.yana_lead_id || null,
      recipient_email: row.recipient_email || null,
      organization_name: row.organization_name || null,
      subject: row.subject || null,
      from_mailbox: row.from_mailbox || null,
      provider_draft_id: row.provider_draft_id || null,
      status: AUDIT_STATUS.DELETED_IN_OUTLOOK,
    })
  } catch (err) {
    logger?.warn?.('[John] reconcile audit write failed (non-fatal)', { draft_id: row.id, error: err?.message })
  }
}

/**
 * Reconcile John's tracked-as-live drafts against the Outlook mailbox.
 *
 * For every row in a LIVE status that carries a provider_draft_id, confirm the
 * message still exists via Graph. A 404 means the owner deleted it → flip the
 * row to DELETED_BY_USER. Any other Graph error is left alone (transient /
 * permission) so we never wrongly retire a draft that is actually present.
 *
 * Best-effort by contract: a not-ready provider or a thrown error returns a
 * skipped result and NEVER aborts the caller (John's run must proceed).
 *
 * @returns {Promise<{ ok, skipped?, reason?, scanned, reconciled, errors }>}
 */
export async function reconcileDeletedDrafts({ db, provider, logger = console, limit = 500 } = {}) {
  if (!db) throw new Error('reconcileDeletedDrafts: db is required')
  if (!provider || !provider.ready || typeof provider.getMessage !== 'function') {
    return { ok: true, skipped: true, reason: 'provider_not_ready', scanned: 0, reconciled: 0, errors: 0 }
  }

  // listDrafts filters by a single status; gather all live statuses and cap.
  const perStatus = Math.max(1, Math.min(500, Number(limit) || 500))
  const rows = []
  for (const status of LIVE_STATUSES) {
    const batch = await listDrafts(db, { status, limit: perStatus })
    for (const r of batch) if (r.provider_draft_id) rows.push(r)
  }

  let reconciled = 0
  let errors = 0
  for (const row of rows) {
    let res
    try {
      res = await provider.getMessage(row.provider_draft_id)
    } catch (err) {
      // getMessage throws on hard errors; treat an explicit notFound/404 as a
      // deletion, everything else as transient (leave the row untouched).
      if (err?.notFound || err?.status === 404) {
        await markDraftDeletedInOutlook(db, row, { logger })
        reconciled += 1
      } else {
        errors += 1
        logger?.warn?.('[John] reconcile getMessage error (left as-is)', {
          draft_id: row.id,
          status: err?.status,
          error: err?.message,
        })
      }
      continue
    }
    // getMessage also returns { ok:false, notFound:true } without throwing.
    if (res && res.ok === false) {
      if (res.notFound || res.status === 404) {
        await markDraftDeletedInOutlook(db, row, { logger })
        reconciled += 1
      } else {
        errors += 1
      }
    }
  }

  if (reconciled > 0) {
    logger?.info?.(`[John] reconciled ${reconciled} draft(s) deleted in Outlook by the owner`)
  }
  return { ok: true, scanned: rows.length, reconciled, errors }
}
