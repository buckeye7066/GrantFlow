/**
 * Gmail filter sync — server-side path.
 *
 * Gmail's API does NOT expose true "blocked senders"; the closest machine-
 * readable signal is the user's FILTERS that trash/delete incoming mail. This
 * service reads those filters (criteria.from) and treats those senders as
 * blocked, adding them to the owner blocklist.
 *
 * It requires Google OAuth credentials in env:
 *   GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET, GMAIL_OAUTH_REFRESH_TOKEN
 * and the `googleapis` package. If either is missing, the endpoint degrades
 * gracefully and tells the operator to use the Google Apps Script push instead
 * (which needs no server-side OAuth — see docs/OWNER_BLOCKLIST.md).
 */

import { addEntry, MATCH_TYPE } from './ownerBlocklistService.js'

function hasOAuthEnv() {
  return !!(
    process.env.GMAIL_OAUTH_CLIENT_ID &&
    process.env.GMAIL_OAUTH_CLIENT_SECRET &&
    process.env.GMAIL_OAUTH_REFRESH_TOKEN
  )
}

const NOT_CONFIGURED = Object.freeze({
  ok: false,
  configured: false,
  reason: 'gmail_oauth_not_configured',
  message:
    'Server-side Gmail sync needs GMAIL_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN and the googleapis package. ' +
    'Until then, use the Google Apps Script in docs/OWNER_BLOCKLIST.md — it reads your filters on Google’s ' +
    'side and POSTs the senders to /api/blocklist/ingest (no server OAuth required).',
})

/**
 * Pull blocked senders from Gmail filters and add them to the blocklist.
 * @returns {Promise<{ok:boolean, configured:boolean, added?:number, reason?:string, message?:string}>}
 */
export async function syncGmailFilters(db, { addedByUserId = null } = {}) {
  if (!hasOAuthEnv()) return NOT_CONFIGURED

  let google
  try {
    ;({ google } = await import('googleapis'))
  } catch {
    return {
      ...NOT_CONFIGURED,
      reason: 'googleapis_not_installed',
      message: 'The googleapis package is not installed. ' + NOT_CONFIGURED.message,
    }
  }

  const oauth2 = new google.auth.OAuth2(
    process.env.GMAIL_OAUTH_CLIENT_ID,
    process.env.GMAIL_OAUTH_CLIENT_SECRET,
  )
  oauth2.setCredentials({ refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN })
  const gmail = google.gmail({ version: 'v1', auth: oauth2 })

  const resp = await gmail.users.settings.filters.list({ userId: 'me' })
  const filters = resp?.data?.filter || []

  let added = 0
  let scanned = 0
  for (const f of filters) {
    const from = f?.criteria?.from
    // Only treat "trash/delete" filters as a block signal.
    const action = f?.action || {}
    const removesFromInbox =
      Array.isArray(action.removeLabelIds) && action.removeLabelIds.includes('INBOX')
    const isTrash = Array.isArray(action.addLabelIds) && action.addLabelIds.includes('TRASH')
    if (!from) continue
    if (!isTrash && !removesFromInbox) continue

    // criteria.from may be a list ("a@x.com OR b@y.com") or a bare domain.
    for (const token of String(from).split(/\s+OR\s+|[,\s]+/i).filter(Boolean)) {
      scanned += 1
      const isEmail = token.includes('@')
      try {
        await addEntry(db, {
          match_type: isEmail ? MATCH_TYPE.EMAIL : MATCH_TYPE.DOMAIN,
          value: token,
          reason: 'Gmail filter (trash/skip-inbox)',
          source: 'gmail_filter_sync',
          added_by_user_id: addedByUserId,
        })
        added += 1
      } catch {
        /* skip unparseable token */
      }
    }
  }

  return { ok: true, configured: true, filters: filters.length, scanned, added }
}
