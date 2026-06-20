/**
 * hamiltonPortalLoginSuggester
 *
 * Powers the "✨ Auto-fill with Hamilton" button on the Saved Logins / Generate
 * Login dialogs and the cloud-login form. The user's complaint was real: the
 * forms asked for the Portal site/URL and Username — information Hamilton
 * already knows. This service resolves a best-effort
 *   { portalHost, loginUrl, username, label, source }
 * so the user only has to type their password (+ optional 2FA secret).
 *
 * Resolution order (deterministic FIRST, AI only as a last resort):
 *   1. Opportunity-derived: when an opportunityId/context is given, read the
 *      funding opportunity's application_url / apply_url and derive a host +
 *      login URL from it.
 *   2. Connector-derived: when a (typed) host or opportunity host maps to a
 *      registered portal connector (e.g. MTSU), use the connector's label and
 *      normalize the host. The connector knows the portal even when the user
 *      typed only a partial.
 *   3. Typed-partial: normalize whatever the caller typed into a real host and
 *      a sensible https login URL.
 *   4. AI fallback (OPTIONAL): only when we have a portal NAME but still no
 *      usable login URL, ask Claude for the canonical login URL. Cheap, capped,
 *      and degrades gracefully to whatever we already have if it fails or the
 *      key is absent.
 *
 * username is the profile's primary email (basic_information.email, then the
 * profile row's email) when known; left blank otherwise (the UI says so).
 *
 * Nothing here writes to the DB or calls a portal — it only suggests. The route
 * has already verified the caller may access `profileId`.
 */

import { normalizeHost } from './hamiltonCredentialSessionService.js'
import { getConnectorForHost, resolveConnector } from './portalSync/registry.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:hamilton-portal-login-suggester')

// ── helpers ────────────────────────────────────────────────────────────────

function firstNonEmpty(...vals) {
  for (const v of vals) {
    const s = v === null || v === undefined ? '' : String(v).trim()
    if (s) return s
  }
  return ''
}

/**
 * Derive a sensible https login URL from a host or a full URL. If the caller
 * already passed a full http(s) URL we keep it verbatim; otherwise we build
 * `https://<host>` so Hamilton has something concrete to open.
 */
function deriveLoginUrl({ loginUrl, applicationUrl, host }) {
  const explicit = firstNonEmpty(loginUrl, applicationUrl)
  if (explicit && /^https?:\/\//i.test(explicit)) return explicit
  const h = normalizeHost(explicit || host)
  return h ? `https://${h}` : ''
}

/** A connector that isn't the generic fallback gives us a real portal label. */
function specificConnectorLabel(connector) {
  if (!connector || connector.id === 'generic') return ''
  return firstNonEmpty(connector.label)
}

/**
 * Read the profile's primary email. Mirrors how preflight resolves it
 * (basic_information.email first, then the bare profiles.email column).
 */
async function resolvePrimaryEmail(db, profileId) {
  if (!db || !profileId) return ''
  try {
    const row = await db.prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1').get(String(profileId))
    if (!row) return ''
    let basic = {}
    try {
      const sec = await db
        .prepare("SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = 'basic_information' LIMIT 1")
        .get(String(profileId))
      if (sec?.data) basic = typeof sec.data === 'string' ? JSON.parse(sec.data) : sec.data
    } catch { basic = {} }
    return firstNonEmpty(
      basic?.email,
      basic?.email_address,
      basic?.primary_email,
      basic?.contact_email,
      row.email,
    )
  } catch (err) {
    log.warn('resolve_email_failed', { err: err?.message })
    return ''
  }
}

/** Load an opportunity's apply links so we can derive a portal host + URL. */
async function resolveOpportunityLinks(db, opportunityId) {
  if (!db || !opportunityId) return null
  try {
    const opp = await db
      .prepare('SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1')
      .get(String(opportunityId))
    if (!opp) return null
    const applicationUrl = firstNonEmpty(opp.application_url, opp.apply_url, opp.apply_guidelines_url)
    return {
      applicationUrl,
      host: normalizeHost(applicationUrl),
      title: firstNonEmpty(opp.title, opp.name),
    }
  } catch (err) {
    log.warn('resolve_opportunity_failed', { err: err?.message })
    return null
  }
}

let cachedAnthropic = null
async function getAnthropicClient() {
  if (cachedAnthropic) return cachedAnthropic
  const key = String(process.env.ANTHROPIC_API_KEY || '').trim()
  if (!key) return null
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  cachedAnthropic = new Anthropic({
    apiKey: key,
    timeout: Number(process.env.HAMILTON_SUGGEST_TIMEOUT_MS || 12_000),
    maxRetries: Number(process.env.HAMILTON_SUGGEST_MAX_RETRIES || 0),
  })
  return cachedAnthropic
}

const SUGGEST_MODEL = process.env.HAMILTON_SUGGEST_MODEL || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5'

/**
 * LAST-RESORT only: given a portal NAME/partial with no usable URL, ask the
 * model for the canonical login URL. Returns { host, loginUrl } or null. Never
 * throws — any failure degrades to "no AI help".
 */
async function aiResolveLoginUrl(portalName) {
  const name = firstNonEmpty(portalName)
  if (!name) return null
  let anthropic
  try { anthropic = await getAnthropicClient() } catch { anthropic = null }
  if (!anthropic) return null
  try {
    const response = await anthropic.messages.create({
      model: SUGGEST_MODEL,
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: (
          'Return ONLY compact JSON {"host":"...","loginUrl":"..."} for the '
          + 'official sign-in page of this application/grant/student portal. '
          + 'Use the real public host and a plausible https login URL. If you are '
          + 'not reasonably confident the portal exists, return {"host":"","loginUrl":""}.\n\n'
          + `Portal: ${name}`
        ),
      }],
    })
    const text = (Array.isArray(response?.content) ? response.content : [])
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .join('')
      .trim()
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return null
    const parsed = JSON.parse(match[0])
    const host = normalizeHost(parsed?.host || parsed?.loginUrl)
    if (!host) return null
    const loginUrl = firstNonEmpty(parsed?.loginUrl) || `https://${host}`
    return { host, loginUrl }
  } catch (err) {
    log.warn('ai_resolve_login_url_failed', { err: err?.message })
    return null
  }
}

/**
 * Best-effort portal-login suggestion.
 *
 * @param {object} args
 * @param {import('better-sqlite3').Database} args.db        request db handle
 * @param {string} args.profileId                            access already verified by the route
 * @param {string} [args.portalHost]                         a typed partial (host, URL, or portal name)
 * @param {string} [args.opportunityId]                      derive host/url from this opportunity
 * @param {string} [args.context]                            free-text portal name/hint (used for AI fallback only)
 * @param {boolean} [args.allowAi=true]                      allow the AI last-resort URL lookup
 * @returns {Promise<{ portalHost:string, loginUrl:string, username:string, label:string, source:string }>}
 */
export async function suggestPortalLogin({
  db,
  profileId,
  portalHost = '',
  opportunityId = '',
  context = '',
  allowAi = true,
} = {}) {
  const typed = firstNonEmpty(portalHost)
  const hint = firstNonEmpty(context)

  // username is independent of portal resolution — fill it whenever we can.
  const username = await resolvePrimaryEmail(db, profileId)

  let resolvedHost = ''
  let resolvedLoginUrl = ''
  let label = ''
  const sources = []

  // 1. Opportunity-derived (strongest deterministic signal).
  if (opportunityId) {
    const opp = await resolveOpportunityLinks(db, opportunityId)
    if (opp?.host) {
      resolvedHost = opp.host
      resolvedLoginUrl = deriveLoginUrl({ applicationUrl: opp.applicationUrl, host: opp.host })
      if (opp.title) label = opp.title
      sources.push('opportunity')
    }
  }

  // 2. Typed partial → real host (also seeds connector resolution below).
  const typedHost = normalizeHost(typed)
  if (!resolvedHost && typedHost) {
    resolvedHost = typedHost
    resolvedLoginUrl = deriveLoginUrl({ loginUrl: typed, host: typedHost })
    sources.push('typed')
  }

  // 3. Connector-derived: a registered connector knows the portal (label) and
  //    can claim a credential even by username/label (shared-IdP schools).
  const connector = resolveConnector({
    host: resolvedHost || typedHost,
    username,
    label: hint || null,
  })
  const connLabel = specificConnectorLabel(connector)
  if (connLabel) {
    if (!label) label = connLabel
    if (!sources.includes('connector')) sources.push('connector')
    // If the typed value mapped to a connector but we still have no host (user
    // typed a bare name), keep the typed host if any; the connector gives the
    // friendly label regardless.
    if (!resolvedHost) {
      const byHostConnector = getConnectorForHost(typedHost)
      if (byHostConnector && byHostConnector.id !== 'generic') resolvedHost = typedHost
    }
  }

  // 4. AI last resort: only when we have a NAME-like hint but no usable URL.
  if (allowAi && !resolvedLoginUrl) {
    const aiName = firstNonEmpty(hint, typed, label)
    const ai = await aiResolveLoginUrl(aiName)
    if (ai?.host) {
      if (!resolvedHost) resolvedHost = ai.host
      resolvedLoginUrl = ai.loginUrl
      sources.push('ai')
    }
  }

  // Final normalization: ensure loginUrl is concrete when we have a host.
  if (!resolvedLoginUrl && resolvedHost) resolvedLoginUrl = `https://${resolvedHost}`

  return {
    portalHost: resolvedHost,
    loginUrl: resolvedLoginUrl,
    username,
    label,
    // Most-specific deterministic source wins for display; 'none' when we
    // could fill nothing but the username.
    source: sources[0] || (username ? 'profile' : 'none'),
  }
}

export default { suggestPortalLogin }
