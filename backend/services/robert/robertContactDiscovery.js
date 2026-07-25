/**
 * robertContactDiscovery.js — Robert's ONLY lead source.
 *
 * Owner-authoritative scope (updated 2026-07-03):
 *   "Robert is supposed to be able to crawl my contacts from social media and
 *    from my emails (both in the email bodies and in the contacts), and send
 *    them to John to write a promo email."
 *
 * So a LEAD (a prospect to pitch GrantFlow TO) comes exclusively from the
 * owner's own address graph — NOT from web/funding discovery. Robert's funding
 * discovery (funders/opportunities → profiles) is unchanged and never produces
 * leads. This module reads, via Microsoft Graph (app-only):
 *   1. the mailbox's Contacts folder (ROBERT_SCAN_EMAIL_CONTACTS), and
 *   2. recent mail MESSAGES (ROBERT_SCAN_EMAIL_MESSAGES): every counterparty
 *      (from/to/cc) plus email addresses written inside message bodies,
 * and tags each as a client-prospect lead on a robert_source_candidates row,
 * which the existing robertJohnBridge then hands to John. Nothing here sends
 * email.
 *
 * SOCIAL MEDIA: intentionally NOT implemented — there is no Facebook/LinkedIn/X
 * API access configured, and those platforms don't expose a user's contact
 * graph to server-side apps without per-platform OAuth apps + review. If that
 * access is ever granted, add it as a third source here so the same
 * dedupe/client-skip/idempotency rules apply.
 *
 * Gating:
 *   - ROBERT_SCAN_EMAIL_CONTACTS 'true' → Contacts folder scan (needs
 *     Contacts.Read application permission consented on the Azure app).
 *   - ROBERT_SCAN_EMAIL_MESSAGES 'true' → message scan (Mail.Read — already
 *     consented; the grant email feed uses it).
 *   - Same MICROSOFT_* creds John uses. Mailbox = ROBERT_CONTACTS_MAILBOX or
 *     JOHN_PRIMARY_MAILBOX. ROBERT_MESSAGE_SCAN_MAX caps messages read
 *     (default 500).
 *   - Note: this reads the axiombiolabs.org (Outlook) mailbox. Gmail
 *     (buckeye7066@gmail.com) contacts are a different provider and are not
 *     covered by this Graph path.
 *
 * Safety:
 *   - Skips any contact whose email already belongs to a GrantFlow user/profile
 *     (never pitch GrantFlow to an existing client).
 *   - Skips non-human/system senders (noreply, postmaster, mailer-daemon, …)
 *     and the mailbox's own domain.
 *   - Idempotent: rows are keyed by source_url = mailto:<email> (UNIQUE), so a
 *     re-scan updates rather than duplicates.
 */

import crypto from 'crypto'
import { getJohnConfig } from '../john/johnOutreachSafety.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('robertContacts')
const TOKEN_BASE = 'https://login.microsoftonline.com'
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

export function isContactScanEnabled() {
  return String(process.env.ROBERT_SCAN_EMAIL_CONTACTS || 'false').toLowerCase() === 'true'
}

export function isMessageScanEnabled() {
  return String(process.env.ROBERT_SCAN_EMAIL_MESSAGES || 'false').toLowerCase() === 'true'
}

function messageScanMax() {
  const n = Number.parseInt(process.env.ROBERT_MESSAGE_SCAN_MAX || '500', 10)
  return Number.isFinite(n) && n > 0 ? Math.min(n, 2000) : 500
}

// System/robot senders that must never become "leads".
const NON_HUMAN_LOCALPARTS = /^(no-?reply|do-?not-?reply|noreply|postmaster|mailer-daemon|bounce|bounces|notifications?|alerts?|newsletter|news|updates?|info-noreply|support|billing|invoice|receipts?|automated?|robot|daemon|admin|webmaster|unsubscribe|marketing|hello@mail|team@mail)/i

export function isNonHumanEmail(email) {
  const [local = '', domain = ''] = String(email).split('@')
  if (NON_HUMAN_LOCALPARTS.test(local)) return true
  // Sending-infrastructure subdomains — mass mailers, not people
  // (e.g. reply.github.com, email.updates.example.com, bounce.stripe.com).
  if (/^(email|mail|edm|mktg|marketing|newsletters?|notifications?|reply|bounces?|smtp|mta)\./i.test(domain)) return true
  return false
}

function contactsMailbox(config) {
  return (process.env.ROBERT_CONTACTS_MAILBOX || config.primaryMailbox || '').trim()
}

async function getGraphToken(config, fetchImpl) {
  const url = `${TOKEN_BASE}/${encodeURIComponent(config.msTenantId)}/oauth2/v2.0/token`
  const body = new URLSearchParams({
    client_id: config.msClientId,
    client_secret: config.msClientSecret,
    grant_type: 'client_credentials',
    scope: 'https://graph.microsoft.com/.default',
  })
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
  if (!res.ok) {
    const err = new Error(`Graph token request failed: ${res.status}`)
    err.code = 'ROBERT_CONTACTS_TOKEN_FAILED'
    throw err
  }
  const json = await res.json()
  return json.access_token
}

/** Page through the mailbox's contacts. Returns an array of raw Graph contacts. */
async function fetchAllContacts(mailbox, token, fetchImpl, { max = 1000 } = {}) {
  const out = []
  let url = `${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/contacts?$select=displayName,emailAddresses,companyName,jobTitle&$top=100`
  while (url && out.length < max) {
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } })
    if (!res.ok) {
      const err = new Error(`Graph contacts request failed: ${res.status}`)
      err.code = 'ROBERT_CONTACTS_FETCH_FAILED'
      throw err
    }
    const json = await res.json()
    for (const c of json.value || []) out.push(c)
    url = json['@odata.nextLink'] || null
  }
  return out
}

function primaryEmailOf(contact) {
  const list = Array.isArray(contact?.emailAddresses) ? contact.emailAddresses : []
  for (const e of list) {
    const addr = String(e?.address || '').trim()
    if (addr && addr.includes('@')) return addr.toLowerCase()
  }
  return null
}

/**
 * Page through recent messages in the mailbox. Reads from/to/cc plus the body
 * so counterparties AND addresses written inside the mail (signatures,
 * introductions, forwarded threads) become lead candidates.
 */
async function fetchRecentMessages(mailbox, token, fetchImpl, { max = 500 } = {}) {
  const out = []
  let url = `${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/messages?$select=from,toRecipients,ccRecipients,subject,body&$orderby=receivedDateTime desc&$top=100`
  while (url && out.length < max) {
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } })
    if (!res.ok) {
      const err = new Error(`Graph messages request failed: ${res.status}`)
      err.code = 'ROBERT_MESSAGES_FETCH_FAILED'
      throw err
    }
    const json = await res.json()
    for (const m of json.value || []) out.push(m)
    url = json['@odata.nextLink'] || null
  }
  return out.slice(0, max)
}

const EMAIL_IN_TEXT = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi

/**
 * Turn recent messages into contact candidates: every human counterparty
 * (from/to/cc) plus every address mentioned in a message body. Returns a Map
 * email → {name, origin} (first occurrence wins; counterparties beat
 * body-mentions because they carry a display name).
 */
export function extractContactsFromMessages(messages, { selfMailbox = '' } = {}) {
  const self = String(selfMailbox || '').toLowerCase()
  const selfDomain = self.includes('@') ? self.split('@')[1] : null
  const found = new Map()
  const consider = (address, name, origin) => {
    const email = String(address || '').trim().toLowerCase()
    if (!email || !email.includes('@')) return
    if (email === self) return
    if (selfDomain && email.endsWith(`@${selfDomain}`)) return // colleagues, not prospects
    if (isNonHumanEmail(email)) return
    if (!found.has(email)) found.set(email, { name: name || null, origin })
  }
  for (const m of messages || []) {
    consider(m?.from?.emailAddress?.address, m?.from?.emailAddress?.name, 'message_counterparty')
    for (const r of m?.toRecipients || []) consider(r?.emailAddress?.address, r?.emailAddress?.name, 'message_counterparty')
    for (const r of m?.ccRecipients || []) consider(r?.emailAddress?.address, r?.emailAddress?.name, 'message_counterparty')
    const bodyText = String(m?.body?.content || '')
      .replace(/<[^>]+>/g, ' ') // strip HTML tags — addresses inside markup still match
    for (const hit of bodyText.match(EMAIL_IN_TEXT) || []) consider(hit, null, 'message_body')
  }
  return found
}

/** Is this email already a GrantFlow user/profile contact? (don't pitch clients) */
async function isExistingClient(db, email) {
  try {
    const u = await db.prepare('SELECT 1 FROM users WHERE lower(primary_email) = ? LIMIT 1').get(email)
    if (u) return true
  } catch { /* ignore */ }
  try {
    const p = await db.prepare('SELECT 1 FROM profile_emails WHERE lower(email) = ? LIMIT 1').get(email)
    if (p) return true
  } catch { /* ignore */ }
  return false
}

/**
 * Scan the owner's Outlook address graph — the Contacts folder AND recent
 * messages (counterparties + addresses inside bodies) — and tag each
 * (non-client, human) contact as a client-prospect lead on
 * robert_source_candidates. Each source is independently gated and degrades
 * independently (e.g. missing Contacts.Read consent must not kill the message
 * scan). Returns a summary with a per-source breakdown.
 */
export async function runContactScanForRobert(db, { force = false, mailbox = null, fetchImpl = null, max = 1000 } = {}) {
  const contactsEnabled = force || isContactScanEnabled()
  const messagesEnabled = force || isMessageScanEnabled()
  if (!contactsEnabled && !messagesEnabled) return { ran: false, reason: 'disabled' }
  const fetcher = fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)
  if (!fetcher) return { ran: false, reason: 'no_fetch' }

  const config = getJohnConfig()
  if (!config.msTenantId || !config.msClientId || !config.msClientSecret) {
    return { ran: false, reason: 'graph_not_configured' }
  }
  const box = mailbox || contactsMailbox(config)
  if (!box) return { ran: false, reason: 'no_mailbox' }

  let token
  try {
    token = await getGraphToken(config, fetcher)
  } catch (err) {
    log.warn('contact scan token failed', { error: err?.message, code: err?.code })
    return { ran: false, reason: err?.code || 'token_failed', error: err?.message }
  }

  // email → { name, title, company, origin }. Contacts folder wins over
  // message counterparties, which win over bare body-mentions (richer names).
  const candidates = new Map()
  const sources = {}

  if (contactsEnabled) {
    try {
      const contacts = await fetchAllContacts(box, token, fetcher, { max })
      let added = 0
      for (const c of contacts) {
        const email = primaryEmailOf(c)
        if (!email || isNonHumanEmail(email)) continue
        candidates.set(email, {
          name: c.displayName || null,
          title: c.jobTitle || null,
          company: c.companyName || null,
          origin: 'email_contacts',
        })
        added += 1
      }
      sources.contacts = { fetched: contacts.length, usable: added }
    } catch (err) {
      // Contacts.Read may not be consented yet — degrade, keep scanning mail.
      log.warn('contacts folder scan failed (continuing with messages)', { error: err?.message, code: err?.code })
      sources.contacts = { error: err?.code || 'fetch_failed', detail: err?.message }
    }
  }

  if (messagesEnabled) {
    try {
      const messages = await fetchRecentMessages(box, token, fetcher, { max: messageScanMax() })
      const extracted = extractContactsFromMessages(messages, { selfMailbox: box })
      let added = 0
      for (const [email, info] of extracted) {
        if (candidates.has(email)) continue
        candidates.set(email, { name: info.name, title: null, company: null, origin: info.origin })
        added += 1
      }
      sources.messages = { fetched: messages.length, extracted: extracted.size, added }
    } catch (err) {
      log.warn('message scan failed', { error: err?.message, code: err?.code })
      sources.messages = { error: err?.code || 'fetch_failed', detail: err?.message }
    }
  }

  if (candidates.size === 0) {
    const allFailed = Object.values(sources).every((s) => s?.error)
    if (allFailed && Object.keys(sources).length > 0) {
      return { ran: false, reason: 'fetch_failed', sources }
    }
  }

  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  let tagged = 0, skippedClient = 0

  for (const [email, info] of candidates) {
    if (await isExistingClient(db, email)) { skippedClient += 1; continue }

    const orgName = String(info.company || info.name || email.split('@')[1] || 'Contact').slice(0, 200)
    const lead = {
      is_client_prospect: true,
      email,
      organization_name: orgName,
      contact_person: info.name ? { name: info.name, title: info.title || null } : null,
      organization_type: 'email_contact',
      source: info.origin === 'email_contacts' ? 'owner_email_contacts' : 'owner_email_messages',
    }
    const evidence = JSON.stringify({ origin: `robert_${info.origin}`, lead })
    const sourceUrl = `mailto:${email}`
    const domain = email.split('@')[1] || null

    try {
      if (db?.dialect === 'postgres') {
        await db.prepare(
          `INSERT INTO robert_source_candidates
             (id, source_name, source_url, source_domain, source_type, discovered_by, discovered_at, status, evidence_json)
           VALUES (?, ?, ?, ?, 'email_contact', 'robert_contacts', ${nowFn}, 'pending', ?)
           ON CONFLICT (source_url) DO UPDATE SET evidence_json = EXCLUDED.evidence_json, source_name = EXCLUDED.source_name`,
        ).run(crypto.randomUUID(), orgName, sourceUrl, domain, evidence)
      } else {
        await db.prepare(
          `INSERT INTO robert_source_candidates
             (id, source_name, source_url, source_domain, source_type, discovered_by, discovered_at, status, evidence_json)
           VALUES (?, ?, ?, ?, 'email_contact', 'robert_contacts', ${nowFn}, 'pending', ?)
           ON CONFLICT (source_url) DO UPDATE SET evidence_json = excluded.evidence_json, source_name = excluded.source_name`,
        ).run(crypto.randomUUID(), orgName, sourceUrl, domain, evidence)
      }
      tagged += 1
    } catch (err) {
      log.warn('contact upsert failed', { email: email.replace(/(.{2}).*(@.*)/, '$1***$2'), error: err?.message })
    }
  }

  const summary = {
    ran: true,
    mailbox: box,
    contacts: candidates.size,
    tagged,
    skipped_existing_client: skippedClient,
    skipped_no_email: 0,
    sources,
    at: new Date().toISOString(),
  }
  log.info('contact scan complete', summary)
  return summary
}
