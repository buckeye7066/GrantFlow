/**
 * robertContactHarvest.js — Robert harvests (name, email) contacts from the
 * owner's four mailboxes and hands them to YANA'S VERIFICATION LANE.
 *
 * Owner directive (2026-07-25): look through the owner's contacts and recent
 * emails in buckeye7066@gmail.com, firerookie_74@yahoo.com,
 * jwhiternmba@yahoo.com and dr.johnwhite@axiombiolabs.org; extract contacts
 * that have BOTH a name and an email address; send them to Yana for
 * verification; only Yana-VERIFIED contacts may reach John via the EXISTING
 * yana→john handoff (qualification → pushQualifiedToJohn → johnYanaBridge).
 *
 * Hard rules (fail-closed everywhere):
 *   - Feature gate: ROBERT_CONTACT_HARVEST=true required (default OFF — this
 *     reads personal mailboxes).
 *   - BOTH fields required: a contact without a human name is DROPPED, never
 *     synthesized from the email local-part.
 *   - No-reply / bulk / list / excluded-domain addresses are dropped
 *     (prospectExclusions + robertContactDiscovery's non-human filter + list
 *     patterns).
 *   - Deduped across accounts by email.
 *   - PRIVACY FLOOR: message bodies are never fetched and never stored. A
 *     harvested contact persists only name, email, source account(s),
 *     last-seen date and provenance.
 *   - Robert NEVER writes John's stores. Rows land in yana_lead_candidates
 *     with source='robert_contact_harvest', status 'candidate' (Yana's
 *     verification lane — see yana/yanaHarvestVerification.js). Nothing in
 *     this module can send email.
 *   - An account with no configured credentials is SKIPPED with an honest
 *     per-account status; a reader failure is an honest per-account error.
 *     Neither ever fabricates a contact or kills the other accounts.
 *
 * Env (read via the injectable `env` param; literal names listed here so
 * scripts/generate-env-examples.mjs documents them — see
 * docs/ROBERT_CONTACT_HARVEST.md for what the owner must provision):
 *   process.env.ROBERT_CONTACT_HARVEST                  master gate (default OFF)
 *   process.env.ROBERT_HARVEST_DAYS                     lookback window, days (default 90)
 *   process.env.ROBERT_HARVEST_MAX_MESSAGES             per-account message cap (default 200)
 *   process.env.ROBERT_HARVEST_MAX_CONTACTS             per-account address-book cap (default 500)
 *   process.env.ROBERT_GMAIL_APP_PASSWORD               buckeye7066@gmail.com IMAP app password
 *   process.env.ROBERT_YAHOO_FIREROOKIE74_APP_PASSWORD  firerookie_74@yahoo.com IMAP app password
 *   process.env.ROBERT_YAHOO_JWHITERNMBA_APP_PASSWORD   jwhiternmba@yahoo.com IMAP app password
 *   (axiombiolabs.org reuses MICROSOFT_TENANT_ID / MICROSOFT_CLIENT_ID /
 *    MICROSOFT_CLIENT_SECRET — John's existing Graph app credentials)
 */

import crypto from 'node:crypto'
import { isValidEmail } from '../john/johnOutreachSafety.js'
import { isExcludedEmail } from '../yana/prospectExclusions.js'
import { ensureYanaLeadSchema } from '../yana/yanaLeadDiscovery.js'
import { OWNER_SEED_CONTACTS } from '../yana/yanaContactsImport.js'
import { isNonHumanEmail } from './robertContactDiscovery.js'
import { resolveHarvestReaders, HARVEST_ACCOUNTS } from './robertMailboxReaders.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('robertContactHarvest')

export const HARVEST_SOURCE = 'robert_contact_harvest'
export const HARVEST_ORIGIN = 'robert_contact_harvest'

/** Domains that belong to the owner's own org — colleagues, not prospects. */
const OWN_ORG_DOMAINS = Object.freeze(['axiombiolabs.org'])

export function isHarvestEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.ROBERT_CONTACT_HARVEST || '').trim())
}

function intEnv(env, name, fallback, max) {
  const n = Number.parseInt(env?.[name] ?? '', 10)
  const v = Number.isFinite(n) && n > 0 ? n : fallback
  return Math.min(v, max)
}

/** Bounded batch config (env-tunable, hard-capped). */
export function getHarvestConfig(env = process.env) {
  return {
    enabled: isHarvestEnabled(env),
    sinceDays: intEnv(env, 'ROBERT_HARVEST_DAYS', 90, 365),
    maxMessagesPerAccount: intEnv(env, 'ROBERT_HARVEST_MAX_MESSAGES', 200, 1000),
    maxContactsPerAccount: intEnv(env, 'ROBERT_HARVEST_MAX_CONTACTS', 500, 2000),
  }
}

// Mailing-list / bulk address patterns beyond the shared non-human filter.
const LIST_LOCALPART_RE = /(^(listserv|majordomo|mailman|discuss|digest|announce|announcements)$)|(-(request|bounces?|owner|list|digest|unsubscribe)$)|(^(list|lists)-)/i
const LIST_DOMAIN_RE = /^(lists?|listserv|groups)\./i

export function isListAddress(email) {
  const [local = '', domain = ''] = String(email || '').split('@')
  return LIST_LOCALPART_RE.test(local) || LIST_DOMAIN_RE.test(domain)
}

/** All owner self-addresses (the four harvest accounts). */
const SELF_ADDRESSES = new Set(
  [...OWNER_SEED_CONTACTS, ...HARVEST_ACCOUNTS.map((a) => a.account)].map((e) => e.toLowerCase()),
)

function domainOfEmail(email) {
  return String(email || '').split('@')[1]?.toLowerCase() || ''
}

/**
 * Is `name` a real display name (and not just the address echoed back)?
 * BOTH-FIELDS rule: a missing/derived name means the contact is dropped —
 * we never invent "Buckeye7066" from a local-part.
 */
export function isUsableName(name, email) {
  const n = String(name || '').trim()
  if (n.length < 2) return false
  if (/@/.test(n)) return false // an address is not a name
  const local = String(email || '').split('@')[0] || ''
  if (n.toLowerCase() === String(email || '').toLowerCase()) return false
  if (local && n.toLowerCase().replace(/[\s._-]+/g, '') === local.toLowerCase().replace(/[._-]+/g, '')) return false
  return true
}

/** Every reason a (name,email) pair is not harvestable; null = keep. */
export function harvestDropReason({ name, email }) {
  const e = String(email || '').trim().toLowerCase()
  if (!e || !isValidEmail(e)) return 'invalid_email'
  if (SELF_ADDRESSES.has(e)) return 'owner_self_address'
  if (OWN_ORG_DOMAINS.includes(domainOfEmail(e))) return 'own_org_domain'
  if (isNonHumanEmail(e)) return 'non_human_address'
  if (isListAddress(e)) return 'list_address'
  if (isExcludedEmail(e)) return 'excluded_domain'
  if (!isUsableName(name, e)) return 'missing_name'
  return null
}

/**
 * Merge one account's raw reader output into the cross-account contact map.
 * `map` is email -> { name, email, source_accounts:Set, last_seen, origin }.
 * Contacts-folder names beat message-header names (richer, owner-curated).
 */
export function foldAccountIntoMap(map, account, { contacts = [], messages = [] } = {}, drops = {}) {
  const consider = (name, email, origin, date) => {
    const e = String(email || '').trim().toLowerCase()
    const reason = harvestDropReason({ name, email: e })
    if (reason) {
      drops[reason] = (drops[reason] || 0) + 1
      return
    }
    const existing = map.get(e)
    if (!existing) {
      map.set(e, {
        name: String(name).trim(),
        email: e,
        source_accounts: new Set([account]),
        last_seen: date || null,
        origin,
      })
      return
    }
    existing.source_accounts.add(account)
    // Prefer address-book names over header names.
    if (origin === 'address_book' && existing.origin !== 'address_book') {
      existing.name = String(name).trim()
      existing.origin = 'address_book'
    }
    if (date && (!existing.last_seen || date > existing.last_seen)) existing.last_seen = date
  }

  for (const c of contacts) consider(c?.name, c?.email, 'address_book', null)
  for (const m of messages) {
    const date = m?.date || null
    for (const a of [...(m?.from || []), ...(m?.to || []), ...(m?.cc || [])]) {
      consider(a?.name, a?.email, 'message_header', date)
    }
  }
  return map
}

/**
 * Persist harvested contacts into Yana's verification lane:
 * yana_lead_candidates rows with source='robert_contact_harvest' and
 * qualification_status='candidate'. Idempotent: an existing (source, email)
 * row only gets its provenance/last-seen refreshed — its qualification_status
 * (Yana's verdict) is NEVER touched here.
 */
export async function submitHarvestedToYana(db, harvested, { runId = null } = {}) {
  if (!db) throw new Error('db required')
  await ensureYanaLeadSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  let inserted = 0
  let refreshed = 0

  for (const c of harvested) {
    const evidence = JSON.stringify([
      { type: 'contact', name: c.name, title: null, email: c.email },
      {
        type: 'harvest_provenance',
        origin: HARVEST_ORIGIN,
        source_accounts: Array.from(c.source_accounts || []),
        last_seen: c.last_seen || null,
        found_in: c.origin,
      },
    ])
    let existing = null
    try {
      existing = await db
        .prepare('SELECT id FROM yana_lead_candidates WHERE source = ? AND external_id = ? LIMIT 1')
        .get(HARVEST_SOURCE, c.email)
    } catch { /* table just created */ }

    if (existing) {
      // Refresh provenance only — never reopen or overwrite Yana's verdict.
      await db
        .prepare(`UPDATE yana_lead_candidates SET public_evidence_json = ?, updated_at = ${nowFn} WHERE id = ?`)
        .run(evidence, String(existing.id))
      refreshed += 1
      continue
    }

    await db
      .prepare(
        `INSERT INTO yana_lead_candidates
           (id, organization_id, profile_id, source, external_id, entity_type, organization_name,
            contact_email, public_evidence_json, source_urls_json, fit_score, urgency_score,
            contact_confidence, lead_score, qualification_status, qualification_reasons_json,
            pushed_to_john, run_id, discovered_at, created_at, updated_at)
         VALUES (?, NULL, NULL, ?, ?, 'person', ?, ?, ?, ?, 0, 0, 0, 0, 'candidate', ?, 0, ?, ${nowFn}, ${nowFn}, ${nowFn})`,
      )
      .run(
        crypto.randomUUID(),
        HARVEST_SOURCE,
        c.email,
        c.name,
        c.email,
        evidence,
        JSON.stringify([`mailto:${c.email}`]),
        JSON.stringify([`origin:${HARVEST_ORIGIN}`, 'pending_yana_verification']),
        runId,
      )
    inserted += 1
  }
  return { inserted, refreshed }
}

/**
 * One harvest pass over all four owner accounts.
 *
 * opts.readers — injectable for tests: [{ account, reader|null, skipReason }].
 * Without injection, readers resolve from env (resolveHarvestReaders).
 *
 * Returns an honest summary:
 *   { ran, accounts: { <account>: {status, ...counts} }, harvested, submitted }
 * Gate off → { ran:false, reason:'disabled' } and the DB is untouched.
 */
export async function runContactHarvestForRobert(db, { readers = null, env = process.env, runId = null } = {}) {
  const cfg = getHarvestConfig(env)
  if (!cfg.enabled) return { ran: false, reason: 'disabled' }
  if (!db) return { ran: false, reason: 'no_db' }

  const resolved = Array.isArray(readers) ? readers : resolveHarvestReaders({ env })
  const accounts = {}
  const drops = {}
  const map = new Map()

  for (const { account, reader, skipReason } of resolved) {
    if (!reader) {
      accounts[account] = { status: 'skipped', reason: skipReason || 'no_credentials' }
      continue
    }
    const acct = { status: 'ok', contacts: 0, messages: 0 }
    let contacts = []
    let messages = []
    try {
      if (reader.capabilities?.contacts) {
        contacts = (await reader.listContacts({ max: cfg.maxContactsPerAccount })) || []
      }
      acct.contacts = contacts.length
      if (reader.capabilities?.messages !== false) {
        messages = (await reader.listMessageHeaders({ sinceDays: cfg.sinceDays, max: cfg.maxMessagesPerAccount })) || []
      }
      acct.messages = messages.length
    } catch (err) {
      // Honest per-account failure; the other accounts keep going. Nothing is
      // fabricated for a mailbox we could not read.
      acct.status = 'error'
      acct.error = String(err?.message || err).slice(0, 200)
      accounts[account] = acct
      log.warn(`harvest failed for ${account}: ${acct.error}`)
      continue
    }
    foldAccountIntoMap(map, account, { contacts, messages }, drops)
    accounts[account] = acct
  }

  const harvested = Array.from(map.values())
  let submitted = { inserted: 0, refreshed: 0 }
  if (harvested.length > 0) {
    submitted = await submitHarvestedToYana(db, harvested, { runId })
  }

  const summary = {
    ran: true,
    origin: HARVEST_ORIGIN,
    accounts,
    dropped: drops,
    harvested: harvested.length,
    submitted,
    bounds: { since_days: cfg.sinceDays, max_messages: cfg.maxMessagesPerAccount, max_contacts: cfg.maxContactsPerAccount },
    at: new Date().toISOString(),
  }
  log.info(
    `contact harvest: ${harvested.length} contacts from ` +
    `${Object.values(accounts).filter((a) => a.status === 'ok').length}/${resolved.length} accounts ` +
    `(+${submitted.inserted} new, ${submitted.refreshed} refreshed in Yana's lane)`,
  )
  return summary
}
