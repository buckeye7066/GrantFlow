/**
 * robertEmailFeedBridge.js
 *
 * Connects Robert to the EXISTING email→grant ingestion pipeline. Robert does
 * not scrape email himself and does not build any new email parsing — he simply
 * triggers the already-shipped Outlook grant feeder
 * (services/emailGrants/outlookGrantFeeder.runOutlookGrantFeed), which reads the
 * configured Microsoft 365 mailbox, parses grant-announcement emails, and
 * inserts the resulting opportunities into the SAME `funding_opportunities`
 * catalog Robert's catalog-mining step (robertCatalogMiner) reads from. So:
 *
 *   email → outlookGrantFeeder → funding_opportunities → Robert catalog mine →
 *   match + recommend
 *
 * Gating (respected, not re-invented): the feeder is governed by the same env
 * the nightly scheduler uses — EMAIL_GRANTS_SYNC_ENABLED (default 'true', set
 * 'false' to disable) — and the feeder ITSELF no-ops gracefully when the
 * mailbox / Graph credentials aren't configured (returns
 * { ok:false, reason:'outlook_not_configured' }). We therefore never throw and
 * never block Robert's cycle on email; a missing config is a logged no-op.
 *
 * The feeder + provider are injectable so unit tests can prove Robert invokes
 * the feed without touching Microsoft Graph.
 */

import { createLogger } from '../../utils/logger.js'

const log = createLogger('robert-email-feed-bridge')

/** Matches emailGrantScheduler.isEnabled() so Robert respects the same switch. */
export function emailFeedEnabled() {
  return String(process.env.EMAIL_GRANTS_SYNC_ENABLED ?? 'true').toLowerCase() !== 'false'
}

function scanTop() {
  return Math.max(1, Math.min(100, Number(process.env.EMAIL_GRANTS_SYNC_TOP) || 50))
}

/**
 * Run the email→grant feed as part of Robert's cycle. Never throws.
 *
 * @param {object} args
 * @param {object} args.db
 * @param {Function} [args.runOutlookGrantFeed] — injectable feeder (default = real)
 * @param {object}  [args.provider]             — injectable Graph provider (default = real)
 * @param {number}  [args.top]
 * @returns {Promise<{ ran: boolean, reason?: string, result?: object }>}
 */
export async function runEmailFeedForRobert({
  db,
  runOutlookGrantFeed = null,
  provider = null,
  top = null,
} = {}) {
  if (!emailFeedEnabled()) {
    return { ran: false, reason: 'email_feed_disabled' }
  }
  let feed = runOutlookGrantFeed
  if (typeof feed !== 'function') {
    try {
      ;({ runOutlookGrantFeed: feed } = await import('../emailGrants/outlookGrantFeeder.js'))
    } catch (err) {
      log.warn('email feeder not loadable (skipping email step)', { error: String(err?.message || err) })
      return { ran: false, reason: 'feeder_unavailable', error: String(err?.message || err) }
    }
  }

  try {
    const result = await feed(db, { provider, top: top ?? scanTop() })
    // The feeder reports its own no-op reasons (outlook_not_configured etc.).
    if (result && result.ok === false) {
      log.info('email feed no-op', { reason: result.reason })
      return { ran: false, reason: result.reason || 'feed_not_ok', result }
    }
    log.info('email feed ran in Robert cycle', {
      candidates: result?.candidates,
      imported: result?.summary?.imported,
    })
    return { ran: true, result }
  } catch (err) {
    // No silent failure: log it and surface the reason, but never abort Robert.
    log.warn('email feed threw (continuing Robert cycle)', { error: String(err?.message || err) })
    return { ran: false, reason: 'feed_error', error: String(err?.message || err) }
  }
}
