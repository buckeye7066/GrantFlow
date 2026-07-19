/**
 * John — Microsoft Outlook (Graph) draft provider.
 *
 * Responsibilities:
 *   - obtain an app-only access token via OAuth2 client_credentials
 *   - create a draft message in the configured primary mailbox
 *   - attempt to set From + Reply-To when supported
 *   - never send (no `/sendMail` endpoint is reachable from this module)
 *   - mask secrets in any logging the agent does on failure
 *
 * The HTTP layer is injectable: `createOutlookProvider({ fetch, logger })`.
 * Tests pass a fake `fetch` so we never make a network call. Production
 * uses the global `fetch` (Node 18+).
 *
 * If credentials are missing, the provider returns a `notConfigured` flag
 * rather than throwing on construction — callers (alias verifier, draft
 * service) decide whether to abort or to record a "provider_not_configured"
 * audit row.
 */

import { getJohnConfig, maskSecrets } from './johnOutreachSafety.js'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
const TOKEN_BASE = 'https://login.microsoftonline.com'

function configMissing(config) {
  if (!config.msTenantId) return 'MICROSOFT_TENANT_ID'
  if (!config.msClientId) return 'MICROSOFT_CLIENT_ID'
  if (!config.msClientSecret) return 'MICROSOFT_CLIENT_SECRET'
  if (!config.primaryMailbox) return 'JOHN_PRIMARY_MAILBOX'
  return null
}

export function createOutlookProvider({
  fetch: fetchImpl = (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null),
  logger = console,
  config = getJohnConfig(),
} = {}) {
  const missing = configMissing(config)
  const ready = !missing && typeof fetchImpl === 'function'

  let cachedToken = null
  let cachedTokenExpiresAt = 0

  async function getAccessToken() {
    if (!ready) {
      const err = new Error(
        `Outlook provider not configured: missing ${missing || 'fetch'}. Set MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, JOHN_PRIMARY_MAILBOX.`
      )
      err.code = 'JOHN_OUTLOOK_NOT_CONFIGURED'
      throw err
    }
    if (cachedToken && Date.now() < cachedTokenExpiresAt - 30_000) return cachedToken

    const url = `${TOKEN_BASE}/${encodeURIComponent(config.msTenantId)}/oauth2/v2.0/token`
    const body = new URLSearchParams({
      client_id: config.msClientId,
      client_secret: config.msClientSecret,
      grant_type: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default',
    })
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    if (!res.ok) {
      const text = await safeText(res)
      const err = new Error(`Outlook token request failed: ${res.status}`)
      err.code = 'JOHN_OUTLOOK_TOKEN_FAILED'
      err.detail = redact(text)
      throw err
    }
    const json = await res.json()
    cachedToken = json.access_token
    cachedTokenExpiresAt = Date.now() + Number(json.expires_in || 3600) * 1000
    return cachedToken
  }

  async function safeText(res) {
    try { return await res.text() } catch { return '' }
  }

  function redact(text) {
    return maskSecrets(String(text || '').slice(0, 500))
  }

  function buildMessagePayload({
    toEmail,
    toName,
    subject,
    bodyText,
    bodyHtml,
    fromAlias,
    replyTo,
    displayName,
  }) {
    // `toEmail` may be a single address (string) or several (array) — Hamilton's
    // weekly digest addresses every email on a profile. Existing callers pass a
    // string, which still produces exactly one recipient.
    const toList = (Array.isArray(toEmail) ? toEmail : [toEmail])
      .map((e) => String(e || '').trim())
      .filter(Boolean)
    const msg = {
      subject: String(subject || '').slice(0, 255),
      body: {
        contentType: bodyHtml ? 'HTML' : 'Text',
        content: bodyHtml || bodyText || '',
      },
      toRecipients: toList.map((address, i) => ({
        emailAddress: {
          address,
          name: i === 0 && toName ? String(toName).slice(0, 200) : undefined,
        },
      })),
    }
    if (fromAlias) {
      msg.from = {
        emailAddress: {
          address: String(fromAlias),
          name: displayName ? String(displayName).slice(0, 200) : undefined,
        },
      }
    }
    if (replyTo) {
      msg.replyTo = [{ emailAddress: { address: String(replyTo) } }]
    }
    return msg
  }

  /**
   * Create a draft on the configured primary mailbox. Returns
   *   { ok, provider_draft_id, alias_attempted, alias_set, raw }
   * `raw` is masked.
   *
   * Never sends; the caller would need to POST to /messages/{id}/send to
   * actually deliver the email — this module does not expose that path.
   */
  async function createDraft({
    toEmail,
    toName,
    subject,
    bodyText,
    bodyHtml,
    requestedFromAlias,
    replyTo,
    displayName,
  }) {
    if (!ready) {
      const err = new Error(`Outlook provider not configured (missing ${missing || 'fetch'})`)
      err.code = 'JOHN_OUTLOOK_NOT_CONFIGURED'
      throw err
    }
    if (!toEmail) {
      const err = new Error('createDraft: toEmail is required')
      err.code = 'JOHN_OUTLOOK_MISSING_RECIPIENT'
      throw err
    }

    const token = await getAccessToken()
    const mailbox = encodeURIComponent(config.primaryMailbox)
    const url = `${GRAPH_BASE}/users/${mailbox}/messages`

    let aliasAttempted = !!requestedFromAlias
    let aliasSet = false

    // Attempt with From alias first.
    let payload = buildMessagePayload({
      toEmail, toName, subject, bodyText, bodyHtml,
      fromAlias: requestedFromAlias || null,
      replyTo, displayName,
    })

    let res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    })

    if (!res.ok && requestedFromAlias) {
      // Fall back: retry without the From alias. Some tenants reject
      // setting `from` on draft creation unless the app has SendAs
      // permission for the alias mailbox.
      const errText = await safeText(res)
      logger?.warn?.(
        '[John] Outlook rejected draft with From alias; retrying without alias',
        { status: res.status, detail: redact(errText) }
      )
      aliasSet = false
      payload = buildMessagePayload({
        toEmail, toName, subject, bodyText, bodyHtml,
        fromAlias: null,
        replyTo, displayName,
      })
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      })
    }
    // A successful POST does NOT prove the alias stuck. Microsoft Graph returns
    // 200 and silently rewrites `from` to the mailbox identity when the alias
    // is not a permitted send-as / proxy address on the mailbox. We confirm
    // against the PERSISTED `from` below rather than assuming success here.

    if (!res.ok) {
      const text = await safeText(res)
      const err = new Error(`Outlook draft creation failed: ${res.status}`)
      err.code = 'JOHN_OUTLOOK_DRAFT_FAILED'
      err.detail = redact(text)
      throw err
    }

    const json = await res.json()
    const actualFrom = json.from?.emailAddress?.address || null
    // Only treat the alias as set if Graph actually kept it as the sender.
    // Otherwise it fell back to the mailbox identity and the draft must be
    // flagged needs_sender_alias_review for a human to fix the send-as config.
    if (
      requestedFromAlias &&
      actualFrom &&
      actualFrom.toLowerCase() === String(requestedFromAlias).toLowerCase()
    ) {
      aliasSet = true
    }
    return {
      ok: true,
      provider_draft_id: json.id || null,
      provider_message_id: json.internetMessageId || null,
      alias_attempted: aliasAttempted,
      alias_set: aliasSet,
      actual_from: actualFrom || (aliasSet ? requestedFromAlias : config.primaryMailbox),
      reply_to: json.replyTo?.[0]?.emailAddress?.address || replyTo || null,
      raw: maskSecrets(json),
    }
  }

  /**
   * Fetch a single draft message by its Graph id from the primary mailbox.
   * Returns { ok, message } or { ok:false, status, notFound, detail }.
   * Used by the draft-refresh routine to confirm a draft still exists before
   * patching it (a human may have deleted or sent it).
   */
  async function getMessage(messageId) {
    if (!ready) {
      const err = new Error(`Outlook provider not configured (missing ${missing || 'fetch'})`)
      err.code = 'JOHN_OUTLOOK_NOT_CONFIGURED'
      throw err
    }
    if (!messageId) throw new Error('getMessage: messageId is required')
    const token = await getAccessToken()
    const mailbox = encodeURIComponent(config.primaryMailbox)
    const url = `${GRAPH_BASE}/users/${mailbox}/messages/${encodeURIComponent(messageId)}`
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    })
    if (res.ok) return { ok: true, message: maskSecrets(await res.json()) }
    return { ok: false, status: res.status, notFound: res.status === 404, detail: redact(await safeText(res)) }
  }

  /**
   * Delete a DRAFT message from the mailbox (Graph DELETE → Deleted Items).
   *
   * Guarded: it re-reads the message first and refuses anything that is not
   * `isDraft`, so a bug or a bad id can never remove a real sent/received mail.
   * A 404 counts as success — the draft is already gone, which is the desired
   * end state and keeps the caller idempotent.
   *
   * Only ever called for drafts whose recipient provably fails the plausibility
   * gate (see johnDraftPlausibilityPurge).
   */
  async function deleteDraft({ messageId }) {
    if (!ready) {
      const err = new Error(`Outlook provider not configured (missing ${missing || 'fetch'})`)
      err.code = 'JOHN_OUTLOOK_NOT_CONFIGURED'
      throw err
    }
    if (!messageId) throw new Error('deleteDraft: messageId is required')

    // Refuse to delete anything that isn't still a draft.
    const existing = await getMessage(messageId)
    if (!existing.ok) {
      if (existing.notFound) return { ok: true, alreadyGone: true }
      return { ok: false, status: existing.status, detail: existing.detail }
    }
    if (existing.message?.isDraft === false) {
      return { ok: false, refused: 'not_a_draft' }
    }

    const token = await getAccessToken()
    const mailbox = encodeURIComponent(config.primaryMailbox)
    const url = `${GRAPH_BASE}/users/${mailbox}/messages/${encodeURIComponent(messageId)}`
    const res = await fetchImpl(url, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    })
    if (res.ok || res.status === 204) return { ok: true }
    if (res.status === 404) return { ok: true, alreadyGone: true }
    return { ok: false, status: res.status, detail: redact(await safeText(res)) }
  }

  /**
   * Update the subject/body of an existing draft via Graph PATCH. Only drafts
   * (isDraft === true) can be edited; Graph rejects edits to sent items. Returns
   * { ok, provider_draft_id } or throws with a redacted detail.
   *
   * Never sends — PATCH only mutates the draft in place.
   */
  async function updateDraftBody({ messageId, subject, bodyText, bodyHtml, from, replyTo: replyToOverride }) {
    if (!ready) {
      const err = new Error(`Outlook provider not configured (missing ${missing || 'fetch'})`)
      err.code = 'JOHN_OUTLOOK_NOT_CONFIGURED'
      throw err
    }
    if (!messageId) {
      const err = new Error('updateDraftBody: messageId is required')
      err.code = 'JOHN_OUTLOOK_MISSING_MESSAGE_ID'
      throw err
    }
    const token = await getAccessToken()
    const mailbox = encodeURIComponent(config.primaryMailbox)
    const url = `${GRAPH_BASE}/users/${mailbox}/messages/${encodeURIComponent(messageId)}`

    const patch = {}
    if (subject !== undefined && subject !== null) patch.subject = String(subject).slice(0, 255)
    if (bodyHtml || bodyText) {
      patch.body = {
        contentType: bodyHtml ? 'HTML' : 'Text',
        content: bodyHtml || bodyText || '',
      }
    }
    // Re-apply the sender identity so a refreshed draft picks up the CURRENT
    // from-alias + display name (e.g. Annie) instead of keeping whatever it was
    // created with. `from` here is the alias address; the display name comes from
    // config.displayName. replyTo defaults to the configured reply address.
    const fromAddr = from || config.fromAlias
    if (fromAddr) {
      patch.from = {
        emailAddress: {
          address: String(fromAddr),
          name: config.displayName ? String(config.displayName).slice(0, 200) : undefined,
        },
      }
    }
    const replyAddr = replyToOverride || config.replyTo
    if (replyAddr) patch.replyTo = [{ emailAddress: { address: String(replyAddr) } }]

    const res = await fetchImpl(url, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(patch),
    })
    if (!res.ok) {
      const text = await safeText(res)
      const err = new Error(`Outlook draft update failed: ${res.status}`)
      err.code = 'JOHN_OUTLOOK_DRAFT_UPDATE_FAILED'
      err.status = res.status
      err.notFound = res.status === 404
      err.detail = redact(text)
      throw err
    }
    // Graph PATCH returns the updated message.
    const json = await res.json().catch(() => ({}))
    return { ok: true, provider_draft_id: json.id || messageId, is_draft: json.isDraft !== false }
  }

  /**
   * List draft messages in the primary mailbox's Drafts folder. Returns the most
   * recent `top` drafts (id/subject/toRecipients/isDraft). Used for diagnostics
   * and to reconcile the DB's tracked drafts against the live mailbox.
   */
  async function listDrafts({ top = 50 } = {}) {
    if (!ready) {
      const err = new Error(`Outlook provider not configured (missing ${missing || 'fetch'})`)
      err.code = 'JOHN_OUTLOOK_NOT_CONFIGURED'
      throw err
    }
    const token = await getAccessToken()
    const mailbox = encodeURIComponent(config.primaryMailbox)
    const lim = Math.max(1, Math.min(200, Number(top) || 50))
    const url =
      `${GRAPH_BASE}/users/${mailbox}/mailFolders/drafts/messages` +
      `?$select=id,subject,toRecipients,isDraft,lastModifiedDateTime&$top=${lim}&$orderby=lastModifiedDateTime desc`
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      const text = await safeText(res)
      const err = new Error(`Outlook list drafts failed: ${res.status}`)
      err.code = 'JOHN_OUTLOOK_LIST_DRAFTS_FAILED'
      err.detail = redact(text)
      throw err
    }
    const json = await res.json()
    return { ok: true, drafts: Array.isArray(json.value) ? json.value : [] }
  }

  /**
   * List recent messages from the primary mailbox's INBOX. Read-only (needs the
   * app's Mail.Read/Mail.ReadWrite application permission, already consented).
   * Returns the most recent `top` messages newest-first, optionally only those
   * received on/after `sinceIso`. Used by the email→grant feeder to pull grant
   * announcements GrantFlow can parse into funding opportunities.
   */
  async function listInboxMessages({ top = 25, sinceIso = null } = {}) {
    if (!ready) {
      const err = new Error(`Outlook provider not configured (missing ${missing || 'fetch'})`)
      err.code = 'JOHN_OUTLOOK_NOT_CONFIGURED'
      throw err
    }
    const token = await getAccessToken()
    const mailbox = encodeURIComponent(config.primaryMailbox)
    const lim = Math.max(1, Math.min(100, Number(top) || 25))
    const select = 'id,internetMessageId,subject,from,receivedDateTime,bodyPreview,body'
    let url =
      `${GRAPH_BASE}/users/${mailbox}/mailFolders/inbox/messages` +
      `?$select=${select}&$top=${lim}&$orderby=receivedDateTime desc`
    if (sinceIso) {
      url += `&$filter=${encodeURIComponent(`receivedDateTime ge ${sinceIso}`)}`
    }
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      const text = await safeText(res)
      const err = new Error(`Outlook list inbox failed: ${res.status}`)
      err.code = 'JOHN_OUTLOOK_LIST_INBOX_FAILED'
      err.detail = redact(text)
      throw err
    }
    const json = await res.json()
    return { ok: true, messages: Array.isArray(json.value) ? json.value : [] }
  }

  /**
   * Verify the primary mailbox is reachable. Probes the mailbox's Drafts folder
   * (`/users/{mailbox}/mailFolders/drafts`) rather than `/users/{mailbox}`: the
   * app-only role John actually has is Mail.ReadWrite, which CAN read the drafts
   * folder but CANNOT read the directory user object — so `/users/{mailbox}`
   * returned 403 Authorization_RequestDenied and the verifier mislabeled it
   * `mailbox_not_found`, sending operators down the wrong path. The drafts probe
   * confirms exactly what John needs (the mailbox is reachable AND he can write
   * drafts into it) using only the permission he has. A 403 is reported honestly
   * as an insufficient-privileges signal, not a missing mailbox.
   */
  async function verifyMailbox() {
    if (!ready) {
      return { ok: false, reason: 'not_configured', missing }
    }
    const token = await getAccessToken()
    const url = `${GRAPH_BASE}/users/${encodeURIComponent(config.primaryMailbox)}/mailFolders/drafts`
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    })
    if (res.ok) {
      const json = await res.json()
      return {
        ok: true,
        primary_mailbox: config.primaryMailbox,
        drafts_folder_id: json?.id || null,
      }
    }
    const text = await safeText(res)
    // Honest, actionable reasons (the verifier maps these to its report).
    const reason = res.status === 403
      ? 'insufficient_graph_privileges'
      : res.status === 404
        ? 'mailbox_not_found'
        : 'graph_returned_error'
    return { ok: false, reason, status: res.status, detail: redact(text) }
  }

  return {
    ready,
    notConfigured: !ready,
    missing,
    createDraft,
    getMessage,
    deleteDraft,
    updateDraftBody,
    listDrafts,
    listInboxMessages,
    verifyMailbox,
    _internal: { buildMessagePayload },
  }
}
