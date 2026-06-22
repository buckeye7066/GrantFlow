/**
 * robertContactDiscovery.js — Robert's ONLY lead source.
 *
 * Owner-authoritative scope clarification:
 *   "Robert only looks for leads in my email contacts, and gives those to John."
 *
 * So a LEAD (a prospect to pitch GrantFlow TO) comes exclusively from the
 * owner's email contacts — NOT from web/funding discovery. Robert's funding
 * discovery (funders/opportunities → profiles) is unchanged and never produces
 * leads. This module reads Outlook contacts (Microsoft Graph, app-only) from the
 * configured mailbox and tags each as a client-prospect lead on a
 * robert_source_candidates row, which the existing robertJohnBridge then hands
 * to John. Nothing here sends email.
 *
 * Gating:
 *   - ROBERT_SCAN_EMAIL_CONTACTS must be 'true' (default off).
 *   - Needs Contacts.Read application permission consented on the Azure app, and
 *     the same MICROSOFT_* creds John uses. Mailbox = ROBERT_CONTACTS_MAILBOX or
 *     JOHN_PRIMARY_MAILBOX.
 *   - Note: this reads the axiombiolabs.org (Outlook) mailbox contacts. Gmail
 *     (buckeye7066@gmail.com) contacts are a different provider and are not
 *     covered by this Graph path.
 *
 * Safety:
 *   - Skips any contact whose email already belongs to a GrantFlow user/profile
 *     (never pitch GrantFlow to an existing client).
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
 * Scan the owner's Outlook contacts and tag each (non-client) contact as a
 * client-prospect lead on robert_source_candidates. Returns a summary.
 */
export async function runContactScanForRobert(db, { force = false, mailbox = null, fetchImpl = null, max = 1000 } = {}) {
  if (!force && !isContactScanEnabled()) return { ran: false, reason: 'disabled' }
  const fetcher = fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)
  if (!fetcher) return { ran: false, reason: 'no_fetch' }

  const config = getJohnConfig()
  if (!config.msTenantId || !config.msClientId || !config.msClientSecret) {
    return { ran: false, reason: 'graph_not_configured' }
  }
  const box = mailbox || contactsMailbox(config)
  if (!box) return { ran: false, reason: 'no_mailbox' }

  let token, contacts
  try {
    token = await getGraphToken(config, fetcher)
    contacts = await fetchAllContacts(box, token, fetcher, { max })
  } catch (err) {
    log.warn('contact scan fetch failed', { error: err?.message, code: err?.code })
    return { ran: false, reason: err?.code || 'fetch_failed', error: err?.message }
  }

  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  let tagged = 0, skippedClient = 0, skippedNoEmail = 0
  const seen = new Set()

  for (const c of contacts) {
    const email = primaryEmailOf(c)
    if (!email) { skippedNoEmail += 1; continue }
    if (seen.has(email)) continue
    seen.add(email)
    if (await isExistingClient(db, email)) { skippedClient += 1; continue }

    const orgName = String(c.companyName || c.displayName || email.split('@')[1] || 'Contact').slice(0, 200)
    const lead = {
      is_client_prospect: true,
      email,
      organization_name: orgName,
      contact_person: c.displayName ? { name: c.displayName, title: c.jobTitle || null } : null,
      organization_type: 'email_contact',
      source: 'owner_email_contacts',
    }
    const evidence = JSON.stringify({ origin: 'robert_email_contacts', lead })
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

  const summary = { ran: true, mailbox: box, contacts: contacts.length, tagged, skipped_existing_client: skippedClient, skipped_no_email: skippedNoEmail, at: new Date().toISOString() }
  log.info('contact scan complete', summary)
  return summary
}
