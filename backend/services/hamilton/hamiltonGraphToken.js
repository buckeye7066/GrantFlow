/**
 * hamiltonGraphToken.js
 *
 * The real credential behind `readEmailCode`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `hamiltonVerificationCodes.readEmailCode` takes an INJECTED `getToken` so the
 * module never owns a credential and tests never touch the network. That seam
 * was never joined to anything: no production caller passed a provider, so the
 * email lane returned `no Graph token provider configured` forever and only the
 * SMS lane could ever produce a code.
 *
 * This module is the join. It reuses the SAME app-only Microsoft Graph
 * registration the rest of the product already speaks to - `getJohnConfig()`'s
 * `MICROSOFT_TENANT_ID` / `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET`,
 * client_credentials against `https://graph.microsoft.com/.default`, exactly as
 * `robertContactDiscovery.getGraphToken` and `johnOutlookProvider` do. There is
 * deliberately no second app registration and no second set of env vars.
 *
 * THE MAILBOX IS HAMILTON'S, AND THAT IS A SEPARATE PERMISSION
 * -----------------------------------------------------------
 * The app registration is shared, but the MAILBOX is not: `readEmailCode` reads
 * `HAMILTON_IDENTITY.email`, not `JOHN_PRIMARY_MAILBOX`. An app-only token grants
 * whatever `Mail.Read` the tenant consented to; if that consent does not cover
 * Hamilton's mailbox (or the mailbox does not exist), Graph answers 403/404 and
 * `readEmailCode` reports `graph 403` / `graph 404` as its reason. That is an
 * EXTERNAL blocker for the owner to clear in Azure - it is named honestly here
 * rather than being papered over.
 *
 * HONEST DEGRADATION, NEVER A CRASH
 * ---------------------------------
 * `hamiltonGraphStatus()` reports exactly which env var is missing.
 * `makeHamiltonGraphTokenProvider()` always returns a function; when config is
 * incomplete that function REJECTS with a message naming the missing variable,
 * which `readEmailCode` already catches and turns into
 * `{ code: null, reason: 'graph token failed: ...' }`. Nothing here throws
 * synchronously and nothing here can take a run down.
 */
import { HAMILTON_IDENTITY } from '../../config/hamiltonIdentity.js'
import { getJohnConfig } from '../john/johnOutreachSafety.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:hamilton-graph-token')

const TOKEN_BASE = 'https://login.microsoftonline.com'

/** The mailbox Hamilton's verification codes arrive in. */
export function hamiltonMailbox() {
  return String(HAMILTON_IDENTITY.email || '').trim()
}

/**
 * Is the Microsoft Graph app registration configured? Returns
 * `{ ready, missing: [...envVarNames], mailbox }` - never throws, never reads a
 * secret out.
 */
export function hamiltonGraphStatus(config = null) {
  let cfg = config
  if (!cfg) {
    try { cfg = getJohnConfig() } catch { cfg = null }
  }
  const missing = []
  if (!cfg?.msTenantId) missing.push('MICROSOFT_TENANT_ID')
  if (!cfg?.msClientId) missing.push('MICROSOFT_CLIENT_ID')
  if (!cfg?.msClientSecret) missing.push('MICROSOFT_CLIENT_SECRET')
  const mailbox = hamiltonMailbox()
  if (!mailbox) missing.push('HAMILTON_IDENTITY_EMAIL')
  return { ready: missing.length === 0, missing, mailbox: mailbox || null }
}

/** One honest sentence naming what the owner must supply. */
export function hamiltonGraphBlockerReason(status = null) {
  const s = status || hamiltonGraphStatus()
  if (s.ready) return null
  return `Microsoft Graph is not configured for Hamilton's mailbox: set ${s.missing.join(', ')}`
}

/**
 * Build a MEMOIZED app-only Graph token provider.
 *
 * Memoized because the bounded verification poll calls `readEmailCode` once per
 * attempt: a fresh token request per attempt is needless latency and needless
 * throttle exposure against AAD. The 30s margin mirrors `johnOutlookProvider`.
 *
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl]  injectable fetch (tests)
 * @param {object}   [opts.config]     injectable config (tests)
 * @param {Function} [opts.now]        injectable clock (tests)
 * @returns {Function} async () => accessToken
 */
export function makeHamiltonGraphTokenProvider({
  fetchImpl = null,
  config = null,
  now = null,
} = {}) {
  let cachedToken = null
  let cachedExpiresAt = 0

  return async function getHamiltonGraphToken() {
    const cfg = config || getJohnConfig()
    const status = hamiltonGraphStatus(cfg)
    if (!status.ready) {
      const err = new Error(hamiltonGraphBlockerReason(status))
      err.code = 'HAMILTON_GRAPH_NOT_CONFIGURED'
      err.missing = status.missing
      throw err
    }
    const clock = typeof now === 'function' ? now : Date.now
    const stamp = clock()
    if (cachedToken && stamp < cachedExpiresAt - 30_000) return cachedToken

    const fetcher = fetchImpl
      || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)
    if (!fetcher) {
      const err = new Error('no fetch implementation available for the Graph token request')
      err.code = 'HAMILTON_GRAPH_NO_FETCH'
      throw err
    }

    const url = `${TOKEN_BASE}/${encodeURIComponent(cfg.msTenantId)}/oauth2/v2.0/token`
    const body = new URLSearchParams({
      client_id: cfg.msClientId,
      client_secret: cfg.msClientSecret,
      grant_type: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default',
    })
    const res = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    if (!res?.ok) {
      // The response body can carry the client secret back in an error echo, so
      // only the status is surfaced.
      const err = new Error(`Graph token request failed: ${res?.status ?? 'no response'}`)
      err.code = 'HAMILTON_GRAPH_TOKEN_FAILED'
      throw err
    }
    const json = await res.json()
    cachedToken = json?.access_token || null
    if (!cachedToken) {
      const err = new Error('Graph token response carried no access_token')
      err.code = 'HAMILTON_GRAPH_TOKEN_EMPTY'
      throw err
    }
    cachedExpiresAt = stamp + Number(json?.expires_in || 3600) * 1000
    log.info('graph_token_acquired', { mailbox: status.mailbox })
    return cachedToken
  }
}

export default {
  makeHamiltonGraphTokenProvider,
  hamiltonGraphStatus,
  hamiltonGraphBlockerReason,
  hamiltonMailbox,
}
