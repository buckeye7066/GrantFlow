/**
 * robertMailboxReaders.js — per-account mailbox/contacts READERS for Robert's
 * owner-contact harvest (robertContactHarvest.js).
 *
 * One reader per explicitly configured owner account. Both account names and
 * credentials come from environment variables; source control contains only
 * `.invalid` local fixtures. No interactive OAuth flow is used.
 *
 * Reader contract (what robertContactHarvest consumes, and what tests inject):
 *   {
 *     account: 'a@b.c',
 *     kind: 'imap' | 'graph',
 *     capabilities: { contacts: bool, messages: bool },
 *     async listContacts({ max })            -> [{ name, email }]
 *     async listMessageHeaders({ sinceDays, max })
 *       -> [{ date: ISO|null, from: [{name,email}], to: [...], cc: [...] }]
 *   }
 *
 * PRIVACY FLOOR: no reader ever fetches a message BODY. Graph $selects only
 * from/toRecipients/ccRecipients/receivedDateTime; IMAP fetches only the
 * ENVELOPE (RFC 3501 header summary). Names+addresses are all that leaves a
 * mailbox. An account whose credentials are not configured resolves to `null`
 * (the harvester reports it skipped — never an error, never a fabrication).
 */

import { getJohnConfig } from '../john/johnOutreachSafety.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('robertMailboxReaders')

const TOKEN_BASE = 'https://login.microsoftonline.com'
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

// Environment contract (listed explicitly for the env-inventory generator):
// process.env.ROBERT_GMAIL_ACCOUNT
// process.env.ROBERT_GMAIL_APP_PASSWORD
// process.env.ROBERT_YAHOO_PRIMARY_ACCOUNT
// process.env.ROBERT_YAHOO_PRIMARY_APP_PASSWORD
// process.env.ROBERT_YAHOO_SECONDARY_ACCOUNT
// process.env.ROBERT_YAHOO_SECONDARY_APP_PASSWORD
// process.env.ROBERT_GRAPH_ACCOUNT
const HARVEST_ACCOUNT_SPECS = Object.freeze([
  Object.freeze({
    accountEnv: 'ROBERT_GMAIL_ACCOUNT',
    localFixtureAccount: 'demo.owner-gmail@example.invalid',
    kind: 'imap',
    host: 'imap.gmail.com',
    passwordEnv: 'ROBERT_GMAIL_APP_PASSWORD',
  }),
  Object.freeze({
    accountEnv: 'ROBERT_YAHOO_PRIMARY_ACCOUNT',
    localFixtureAccount: 'demo.owner-yahoo-primary@example.invalid',
    kind: 'imap',
    host: 'imap.mail.yahoo.com',
    passwordEnv: 'ROBERT_YAHOO_PRIMARY_APP_PASSWORD',
  }),
  Object.freeze({
    accountEnv: 'ROBERT_YAHOO_SECONDARY_ACCOUNT',
    localFixtureAccount: 'demo.owner-yahoo-secondary@example.invalid',
    kind: 'imap',
    host: 'imap.mail.yahoo.com',
    passwordEnv: 'ROBERT_YAHOO_SECONDARY_APP_PASSWORD',
  }),
  Object.freeze({
    accountEnv: 'ROBERT_GRAPH_ACCOUNT',
    localFixtureAccount: 'demo.owner-graph@example.invalid',
    kind: 'graph',
  }),
])

function isDeployedRuntime(env) {
  return String(env?.NODE_ENV || '').trim().toLowerCase() === 'production'
    || Boolean(String(env?.RAILWAY_ENVIRONMENT_ID || '').trim())
    || Boolean(String(env?.RAILWAY_DEPLOYMENT_ID || '').trim())
}

export function getHarvestAccounts(env = process.env) {
  const deployed = isDeployedRuntime(env)
  return HARVEST_ACCOUNT_SPECS.map(spec => Object.freeze({
    ...spec,
    account: String(env?.[spec.accountEnv] || (deployed ? '' : spec.localFixtureAccount))
      .trim()
      .toLowerCase(),
  }))
}

/** Resolved once for runtime self-address filtering; production has no defaults. */
export const HARVEST_ACCOUNTS = Object.freeze(getHarvestAccounts())

// ---------------------------------------------------------------------------
// IMAP reader (Gmail + Yahoo app passwords)
// ---------------------------------------------------------------------------

function addrList(list) {
  const out = []
  for (const a of Array.isArray(list) ? list : []) {
    const email = String(a?.address || '').trim().toLowerCase()
    if (!email || !email.includes('@')) continue
    out.push({ name: String(a?.name || '').trim() || null, email })
  }
  return out
}

/**
 * Read recent message ENVELOPES (never bodies) over IMAP with an app password.
 * Lazy-imports imapflow so environments without the dependency degrade to an
 * honest error instead of crashing module load.
 */
export function makeImapReader({ account, host, port = 993, password }) {
  return {
    account,
    kind: 'imap',
    capabilities: { contacts: false, messages: true },
    // IMAP exposes no address book — Gmail/Yahoo contacts need a CSV export
    // (see yanaContactsImport.parseContactsCsv) or a provider API.
    async listContacts() {
      return []
    },
    async listMessageHeaders({ sinceDays = 90, max = 200 } = {}) {
      const { ImapFlow } = await import('imapflow')
      const client = new ImapFlow({
        host,
        port,
        secure: true,
        auth: { user: account, pass: password },
        logger: false,
      })
      const out = []
      await client.connect()
      try {
        const lock = await client.getMailboxLock('INBOX', { readOnly: true })
        try {
          const since = new Date(Date.now() - Math.max(1, sinceDays) * 24 * 60 * 60 * 1000)
          const uids = await client.search({ since }, { uid: true })
          const chosen = (Array.isArray(uids) ? uids : []).slice(-Math.max(1, max))
          if (chosen.length > 0) {
            for await (const msg of client.fetch(chosen, { envelope: true, internalDate: true }, { uid: true })) {
              const env = msg?.envelope || {}
              out.push({
                date: msg?.internalDate ? new Date(msg.internalDate).toISOString() : null,
                from: addrList(env.from),
                to: addrList(env.to),
                cc: addrList(env.cc),
              })
            }
          }
        } finally {
          lock.release()
        }
      } finally {
        try {
          await client.logout()
        } catch {
          try { client.close() } catch { /* already closed */ }
        }
      }
      return out
    },
  }
}

// ---------------------------------------------------------------------------
// Microsoft Graph reader (axiombiolabs.org — reuses John's app-only creds)
// ---------------------------------------------------------------------------

async function getGraphToken(config, fetchImpl) {
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
    body,
  })
  if (!res.ok) {
    const err = new Error(`Graph token request failed: ${res.status}`)
    err.code = 'HARVEST_GRAPH_TOKEN_FAILED'
    throw err
  }
  const json = await res.json()
  return json.access_token
}

async function pageGraph(url, token, fetchImpl, max) {
  const out = []
  let next = url
  while (next && out.length < max) {
    const res = await fetchImpl(next, { headers: { authorization: `Bearer ${token}` } })
    if (!res.ok) {
      const err = new Error(`Graph request failed: ${res.status}`)
      err.code = 'HARVEST_GRAPH_FETCH_FAILED'
      throw err
    }
    const json = await res.json()
    for (const v of json.value || []) out.push(v)
    next = json['@odata.nextLink'] || null
  }
  return out.slice(0, max)
}

export function makeGraphReader({ account, config = null, fetchImpl = null }) {
  const fetcher = fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)
  return {
    account,
    kind: 'graph',
    capabilities: { contacts: true, messages: true },
    async listContacts({ max = 1000 } = {}) {
      const cfg = config || getJohnConfig()
      if (!fetcher) throw new Error('no fetch implementation available')
      const token = await getGraphToken(cfg, fetcher)
      const url = `${GRAPH_BASE}/users/${encodeURIComponent(account)}/contacts?$select=displayName,emailAddresses&$top=100`
      const contacts = await pageGraph(url, token, fetcher, max)
      const out = []
      for (const c of contacts) {
        const name = String(c?.displayName || '').trim() || null
        for (const e of Array.isArray(c?.emailAddresses) ? c.emailAddresses : []) {
          const email = String(e?.address || '').trim().toLowerCase()
          if (email && email.includes('@')) {
            out.push({ name, email })
            break // primary address only
          }
        }
      }
      return out
    },
    async listMessageHeaders({ sinceDays = 90, max = 200 } = {}) {
      const cfg = config || getJohnConfig()
      if (!fetcher) throw new Error('no fetch implementation available')
      const token = await getGraphToken(cfg, fetcher)
      const since = new Date(Date.now() - Math.max(1, sinceDays) * 24 * 60 * 60 * 1000).toISOString()
      // NO body in $select — headers only, by design.
      const url =
        `${GRAPH_BASE}/users/${encodeURIComponent(account)}/messages` +
        `?$select=from,toRecipients,ccRecipients,receivedDateTime` +
        `&$filter=receivedDateTime ge ${since}` +
        `&$orderby=receivedDateTime desc&$top=100`
      const messages = await pageGraph(url, token, fetcher, max)
      return messages.map((m) => ({
        date: m?.receivedDateTime || null,
        from: addrList([m?.from?.emailAddress]),
        to: addrList((m?.toRecipients || []).map((r) => r?.emailAddress)),
        cc: addrList((m?.ccRecipients || []).map((r) => r?.emailAddress)),
      }))
    },
  }
}

// ---------------------------------------------------------------------------
// Env-driven resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a reader for each configured owner account from env credentials.
 * Returns [{ account, reader|null, skipReason|null }] — an unconfigured
 * account gets reader:null and an honest skipReason; it is NEVER an error.
 */
export function resolveHarvestReaders({ env = process.env, fetchImpl = null } = {}) {
  const out = []
  for (const spec of getHarvestAccounts(env)) {
    if (!spec.account) {
      out.push({ account: spec.accountEnv, reader: null, skipReason: `no_account:${spec.accountEnv}` })
      continue
    }
    if (spec.kind === 'imap') {
      const password = String(env[spec.passwordEnv] || '').trim()
      if (!password) {
        out.push({ account: spec.account, reader: null, skipReason: `no_credentials:${spec.passwordEnv}` })
        continue
      }
      out.push({ account: spec.account, reader: makeImapReader({ account: spec.account, host: spec.host, password }), skipReason: null })
      continue
    }
    // graph — REUSES John's app-only Graph credentials (same env names
    // getJohnConfig reads), taken from the passed env so tests can isolate.
    const cfg = {
      msTenantId: String(env.MICROSOFT_TENANT_ID || '').trim(),
      msClientId: String(env.MICROSOFT_CLIENT_ID || '').trim(),
      msClientSecret: String(env.MICROSOFT_CLIENT_SECRET || '').trim(),
    }
    if (!cfg.msTenantId || !cfg.msClientId || !cfg.msClientSecret) {
      out.push({ account: spec.account, reader: null, skipReason: 'no_credentials:MICROSOFT_TENANT_ID/MICROSOFT_CLIENT_ID/MICROSOFT_CLIENT_SECRET' })
      continue
    }
    out.push({ account: spec.account, reader: makeGraphReader({ account: spec.account, config: cfg, fetchImpl }), skipReason: null })
  }
  log.debug?.(`resolved harvest readers: ${out.filter((r) => r.reader).length}/${out.length} configured`)
  return out
}
