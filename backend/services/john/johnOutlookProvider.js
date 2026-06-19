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
    const msg = {
      subject: String(subject || '').slice(0, 255),
      body: {
        contentType: bodyHtml ? 'HTML' : 'Text',
        content: bodyHtml || bodyText || '',
      },
      toRecipients: [
        {
          emailAddress: {
            address: String(toEmail),
            name: toName ? String(toName).slice(0, 200) : undefined,
          },
        },
      ],
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
   * Verify the primary mailbox is reachable. Tries /users/{mailbox} which
   * returns 200 for an existing mailbox, 404 otherwise.
   */
  async function verifyMailbox() {
    if (!ready) {
      return { ok: false, reason: 'not_configured', missing }
    }
    const token = await getAccessToken()
    const url = `${GRAPH_BASE}/users/${encodeURIComponent(config.primaryMailbox)}`
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    })
    if (res.ok) {
      const json = await res.json()
      return {
        ok: true,
        primary_mailbox: config.primaryMailbox,
        user_principal_name: json?.userPrincipalName || null,
      }
    }
    const text = await safeText(res)
    return { ok: false, reason: 'graph_returned_error', status: res.status, detail: redact(text) }
  }

  return {
    ready,
    notConfigured: !ready,
    missing,
    createDraft,
    verifyMailbox,
    _internal: { buildMessagePayload },
  }
}
