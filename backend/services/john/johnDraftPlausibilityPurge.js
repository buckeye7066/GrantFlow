/**
 * John — purge drafts addressed to the WRONG organization.
 *
 * WHY THIS EXISTS
 * ---------------
 * Yana's contact enrichment used to accept any homepage the search returned,
 * even when nothing matched the org, and scrape that stranger's email (see
 * `isPlausibleHomepage` in services/yana/prospectExclusions.js and the
 * `enforceLeadContactPlausibility` boot net). John then drafted real outreach
 * to those addresses. In prod, 113 of 190 lead-linked drafts (59%) carried an
 * implausible recipient — a funeral home's address for a health foundation, a
 * newspaper's admin@ for a community clinic, `configured-admin@example.invalid` scraped off a
 * template. The owner had hand-deleted 95 of them.
 *
 * The enrichment gate stops NEW ones and the boot net cleans the lead rows, but
 * neither retracts a draft already sitting in the mailbox. This does.
 *
 * SAFETY
 * ------
 *  - Scope: ONLY drafts still live in the mailbox whose recipient domain fails
 *    the same plausibility gate the enricher now enforces. A draft whose
 *    recipient plausibly belongs to its org is never touched.
 *  - The provider re-reads each message and refuses anything that is not still
 *    a draft, so a sent or received mail can never be removed.
 *  - Rows are marked ARCHIVED with an explicit reason — NOT `deleted_by_user`,
 *    which means "the owner curated this away" and would be a lie here (see the
 *    status contract in johnTypes.js: the whole point of that status is that it
 *    is honest about WHY). ARCHIVED is deliberately re-draft-eligible in
 *    `hasDraftForLead`, so once the lead earns a correct address John writes a
 *    proper replacement instead of the lead going silently dark.
 *  - `dryRun` reports exactly what WOULD go without touching anything.
 */

import { listDrafts, insertAudit } from './johnRunStore.js'
import { archiveDraft } from './johnDraftService.js'
import { DRAFT_STATUS } from './johnTypes.js'
import { isPlausibleHomepage } from '../yana/prospectExclusions.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('john-draft-purge')

/** Reason recorded on every row this purge archives. */
export const PURGE_REASON = 'implausible_recipient'

// Statuses whose Outlook draft is expected to still exist in the mailbox.
// Terminal rows (blocked/failed/archived/sent/deleted) have nothing live to purge.
const LIVE_STATUSES = new Set([
  DRAFT_STATUS.CREATED,
  DRAFT_STATUS.NEEDS_REVIEW,
  DRAFT_STATUS.NEEDS_SENDER_ALIAS_REVIEW,
  DRAFT_STATUS.REVIEWED,
])

/**
 * Does this draft's recipient plausibly belong to the org it addresses?
 * Title-less (a stored row has no search-result title), matching the
 * conservative stored-row bar used by enforceLeadContactPlausibility.
 */
export function draftRecipientIsImplausible(draft) {
  const org = draft?.organization_name
  const email = draft?.recipient_email
  if (!org || !email) return false // nothing to judge — never purge on a guess
  const domain = String(email).split('@')[1]
  if (!domain) return false
  return !isPlausibleHomepage({ url: `https://${domain}`, title: '' }, org)
}

/**
 * @param {object} db
 * @param {object} opts
 * @param {object} [opts.provider] Outlook provider (needs deleteDraft); omit to
 *        archive rows without touching the mailbox.
 * @param {boolean} [opts.dryRun=false]
 * @param {number} [opts.limit=200]
 * @returns {Promise<{scanned:number, implausible:number, purged:number,
 *   mailbox_deleted:number, failed:number, dryRun:boolean, items:Array}>}
 */
export async function purgeImplausibleDrafts(db, { provider = null, dryRun = false, limit = 200 } = {}) {
  const rows = await listDrafts(db, { limit })
  const live = (rows || []).filter((r) => LIVE_STATUSES.has(r.draft_status))
  const targets = live.filter(draftRecipientIsImplausible)

  const result = {
    scanned: live.length,
    implausible: targets.length,
    purged: 0,
    mailbox_deleted: 0,
    failed: 0,
    dryRun: Boolean(dryRun),
    items: targets.map((t) => ({
      id: t.id,
      organization_name: t.organization_name,
      recipient_email: t.recipient_email,
      draft_status: t.draft_status,
    })),
  }
  if (dryRun || targets.length === 0) return result

  for (const draft of targets) {
    const messageId = draft.provider_draft_id || draft.provider_message_id || null
    let mailboxOk = true

    if (messageId && provider?.deleteDraft) {
      try {
        const res = await provider.deleteDraft({ messageId })
        if (res?.ok) {
          if (!res.alreadyGone) result.mailbox_deleted += 1
        } else {
          // Refused (not a draft) or a Graph error: leave the ROW alone too, so
          // the store keeps telling the truth about what is still in the mailbox.
          mailboxOk = false
          result.failed += 1
          log.warn(`could not delete draft ${draft.id} from mailbox`, {
            reason: res?.refused || res?.status || 'unknown',
          })
        }
      } catch (err) {
        mailboxOk = false
        result.failed += 1
        log.warn(`deleteDraft threw for ${draft.id}: ${err?.message || err}`)
      }
    }
    if (!mailboxOk) continue

    await archiveDraft(db, draft.id, PURGE_REASON)
    result.purged += 1
    try {
      await insertAudit(db, {
        draft_id: draft.id,
        yana_lead_id: draft.yana_lead_id || null,
        status: PURGE_REASON,
        detail: `Archived + removed from mailbox: recipient ${draft.recipient_email} does not plausibly belong to ${draft.organization_name}.`,
      })
    } catch { /* audit is best-effort — never fail the purge on it */ }
  }

  if (result.purged > 0) {
    log.info('purged drafts addressed to the wrong organization', {
      purged: result.purged,
      mailbox_deleted: result.mailbox_deleted,
      failed: result.failed,
    })
  }
  return result
}
