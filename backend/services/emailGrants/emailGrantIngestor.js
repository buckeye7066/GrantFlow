/**
 * Email → Grant ingestion service.
 *
 * The owner forwards / auto-pushes grant-announcement emails into GrantFlow.
 * This service turns one of those emails into (at most) one funding
 * opportunity in the catalog, so it flows through the normal Smart Match /
 * Discover pipeline — now correctly deduped against what's already saved.
 *
 * Pipeline for each email:
 *   1. Idempotency — dedup on (source, message_id); a re-POST is a no-op.
 *   2. Sender denylist — skip anything from a blocklisted sender (Keep-Me-Legal
 *      + owner blocklist). Never ingest from a blocked address.
 *   3. Parse — ask the AI to extract grant fields, or return is_grant:false.
 *   4. Persist — upsert through upsertFundingOpportunity() so the email grant
 *      gets the SAME reality/trust/loan/URL gate every crawler row gets.
 *
 * Self-healing schema (ensureEmailGrantSchema) mirrors migration 110 / 0107 so
 * the feature works even before the migration runner has touched the DB — the
 * same recall-over-suppression posture as pipelineDismissals.
 */

import crypto from 'node:crypto'
import { invokeJsonWithFallback, getOpenAIOptional } from '../../utils/aiProviders.js'
import { upsertFundingOpportunity } from '../opportunityInserter.js'
import { checkIdentity } from '../blocklist/ownerBlocklistService.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:emailGrantIngestor')

const ensuredDbs = new WeakSet()
const ensurePromises = new WeakMap()

export async function ensureEmailGrantSchema(db) {
  if (!db || typeof db.prepare !== 'function') return
  if (ensuredDbs.has(db)) return
  if (ensurePromises.has(db)) return ensurePromises.get(db)

  const ensurePromise = (async () => {
    const isPostgres = db?.dialect === 'postgres'
    const ts = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME'
    const tsDefault = isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS email_grant_ingestions (
           id TEXT PRIMARY KEY,
           source TEXT NOT NULL DEFAULT 'email_inbox',
           message_id TEXT,
           from_email TEXT,
           from_name TEXT,
           subject TEXT,
           received_at ${ts},
           snippet TEXT,
           status TEXT NOT NULL DEFAULT 'pending',
           parse_provider TEXT,
           parsed_json TEXT,
           opportunity_id TEXT,
           profile_id TEXT,
           reason TEXT,
           created_at ${ts} DEFAULT ${tsDefault},
           updated_at ${ts} DEFAULT ${tsDefault}
         )`,
      )
      .run()
    try {
      await db
        .prepare(
          `CREATE UNIQUE INDEX IF NOT EXISTS uq_email_grant_ingestions_msg
             ON email_grant_ingestions(source, message_id)
             WHERE message_id IS NOT NULL`,
        )
        .run()
    } catch (err) {
      log.warn('partial unique index not created (non-fatal)', { error: String(err?.message || err) })
    }
    await db
      .prepare('CREATE INDEX IF NOT EXISTS idx_email_grant_ingestions_status ON email_grant_ingestions(status)')
      .run()
    await db
      .prepare('CREATE INDEX IF NOT EXISTS idx_email_grant_ingestions_created ON email_grant_ingestions(created_at)')
      .run()
    ensuredDbs.add(db)
  })()

  ensurePromises.set(db, ensurePromise)
  try {
    return await ensurePromise
  } finally {
    ensurePromises.delete(db)
  }
}

function str(v, max = 0) {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  if (!s) return null
  return max > 0 ? s.slice(0, max) : s
}

/**
 * RFC 5321 caps a path at 256 octets and a mailbox at 320; a display name plus
 * an address has no legitimate reason to exceed this. Every OTHER field in
 * `ingestEmail` is already capped (`source` 64, `messageId` 512, `subject` 998)
 * — `from` was the one that was not, and it is the one feeding the regex below.
 */
export const MAX_FROM_HEADER_LENGTH = 1024

/**
 * Extract "Name <addr@x>" → { email, name }. Accepts a bare address too.
 *
 * DEFENCE IN DEPTH (js/polynomial-redos class). The pattern below interleaves
 * three quantifiers that all match whitespace — `\s*`, `[^"<]*?`, `\s*` — so on
 * a long whitespace run with no `<` it is CUBIC: measured 320 chars 83.5 ms,
 * 2 000 chars 2.6 s, 4 000 chars 25.3 s.
 *
 * Reachability, stated honestly rather than assumed: the live feed
 * (`outlookGrantFeeder.messageToEmail`) supplies `m.from.emailAddress.address`,
 * a Graph-PARSED address, and a realistic 320-char address with no spaces costs
 * 0.072 ms — so the live path is not demonstrably exploitable. The only entry
 * accepting an arbitrary unbounded `from` is `POST /api/email-grants/ingest`,
 * which in production is admin-only (`EMAIL_GRANTS_INGEST_TOKEN` is unset, so
 * `ingestAuth` rejects everyone else). The cap is therefore defence in depth for
 * an authenticated-trigger path, NOT a fix for an anonymous DoS — a length
 * bound is simply correct here regardless of who can reach it.
 */
function parseFromHeader(from) {
  const raw = str(from, MAX_FROM_HEADER_LENGTH)
  if (!raw) return { email: null, name: null }
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<\s*([^>]+?)\s*>\s*$/)
  if (m) return { name: str(m[1]), email: str(m[2])?.toLowerCase() ?? null }
  if (raw.includes('@')) return { email: raw.toLowerCase(), name: null }
  return { email: null, name: raw }
}

const EMAIL_PARSE_SYSTEM = `You extract grant / funding-opportunity details from an email a nonprofit owner received.
Return ONLY JSON with this exact shape:
{
  "is_grant": boolean,            // true ONLY if the email announces a specific, real funding opportunity the recipient could apply for
  "confidence": number,          // 0-100
  "title": string|null,          // the program/opportunity name
  "sponsor": string|null,        // the funder / organization offering it
  "description": string|null,    // 1-3 sentence summary
  "url": string|null,            // the BEST application or details URL found in the email (must be http/https)
  "deadline": string|null,       // ISO date YYYY-MM-DD if a clear application deadline is stated, else null
  "amount_min": number|null,     // award floor in USD if stated
  "amount_max": number|null,     // award ceiling in USD if stated
  "eligibility": string[]        // short eligibility bullet strings, may be empty
}
Rules:
- Newsletters, receipts, marketing, webinars, loans, and "matching funds required" programs are NOT grants → is_grant:false.
- Never invent a URL, deadline, or amount. If it is not in the email, use null.
- If unsure whether it is a real applyable opportunity, set is_grant:false.`

/**
 * Ask the AI to extract a grant from the email body. Returns the parsed object
 * plus the provider used, or { json: null } when no provider is available.
 */
async function parseGrantFromEmail({ subject, body, fromName }) {
  const openai = getOpenAIOptional()
  const prompt = [
    `From: ${fromName || 'unknown'}`,
    `Subject: ${subject || '(no subject)'}`,
    '',
    'Email body:',
    String(body || '').slice(0, 12000),
  ].join('\n')

  const result = await invokeJsonWithFallback({
    openai,
    system: EMAIL_PARSE_SYSTEM,
    prompt,
    temperature: 0,
    maxTokens: 900,
  })
  if (!result.ok || !result.json || typeof result.json !== 'object') {
    return { json: null, provider: result.provider ?? 'none' }
  }
  return { json: result.json, provider: result.provider }
}

async function recordIngestion(db, row) {
  const id = row.id || crypto.randomUUID()
  await db
    .prepare(
      `INSERT INTO email_grant_ingestions
         (id, source, message_id, from_email, from_name, subject, received_at,
          snippet, status, parse_provider, parsed_json, opportunity_id, profile_id, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      row.source,
      row.message_id ?? null,
      row.from_email ?? null,
      row.from_name ?? null,
      row.subject ?? null,
      row.received_at ?? null,
      row.snippet ?? null,
      row.status,
      row.parse_provider ?? null,
      row.parsed_json ?? null,
      row.opportunity_id ?? null,
      row.profile_id ?? null,
      row.reason ?? null,
    )
  return id
}

/**
 * Ingest one email. Returns a summary: { status, opportunity_id?, reason?, id }.
 *
 * @param {object} db
 * @param {object} email { messageId, from, fromName, subject, text|body|html, receivedAt, source, profileId }
 */
export async function ingestEmail(db, email = {}) {
  if (!db) return { status: 'error', reason: 'no_db' }
  await ensureEmailGrantSchema(db)

  const source = str(email.source, 64) || 'email_inbox'
  const messageId = str(email.messageId ?? email.message_id, 512)
  const fromHeader = parseFromHeader(email.from)
  const fromEmail = str(email.fromEmail) ?? fromHeader.email
  const fromName = str(email.fromName) ?? fromHeader.name
  const subject = str(email.subject, 998)
  const body = str(email.text ?? email.body ?? email.html ?? email.snippet) || ''
  const receivedAt = str(email.receivedAt ?? email.received_at)
  const profileId = str(email.profileId ?? email.profile_id)
  const snippet = body ? body.slice(0, 2000) : null

  // 1. Idempotency — already ingested this exact message?
  if (messageId) {
    try {
      const existing = await db
        .prepare('SELECT id, status, opportunity_id FROM email_grant_ingestions WHERE source = ? AND message_id = ? LIMIT 1')
        .get(source, messageId)
      if (existing) {
        return { status: 'duplicate', id: existing.id, opportunity_id: existing.opportunity_id ?? null, reason: 'already_ingested' }
      }
    } catch (err) {
      log.warn('idempotency check failed (continuing)', { error: String(err?.message || err) })
    }
  }

  const base = {
    source,
    message_id: messageId,
    from_email: fromEmail,
    from_name: fromName,
    subject,
    received_at: receivedAt,
    snippet,
    profile_id: profileId,
  }

  // 2. Sender denylist — never ingest from a blocked address (Keep-Me-Legal).
  if (fromEmail) {
    try {
      const blocked = await checkIdentity(db, { email: fromEmail })
      if (blocked) {
        const id = await recordIngestion(db, { ...base, status: 'rejected', reason: 'sender_blocklisted' })
        log.info('rejected email from blocklisted sender', { from: fromEmail })
        return { status: 'rejected', id, reason: 'sender_blocklisted' }
      }
    } catch (err) {
      // Recall over suppression — a denylist read failure must not silently
      // drop a legitimate grant; proceed but log.
      log.warn('blocklist check failed (continuing)', { error: String(err?.message || err) })
    }
  }

  if (!body) {
    const id = await recordIngestion(db, { ...base, status: 'skipped', reason: 'empty_body' })
    return { status: 'skipped', id, reason: 'empty_body' }
  }

  // 3. Parse.
  let parsed = null
  let provider = 'none'
  try {
    const out = await parseGrantFromEmail({ subject, body, fromName })
    parsed = out.json
    provider = out.provider
  } catch (err) {
    const id = await recordIngestion(db, { ...base, status: 'error', parse_provider: provider, reason: `parse_error:${err?.message || err}` })
    return { status: 'error', id, reason: 'parse_error' }
  }

  if (!parsed || parsed.is_grant !== true) {
    const id = await recordIngestion(db, {
      ...base,
      status: 'skipped',
      parse_provider: provider,
      parsed_json: parsed ? JSON.stringify(parsed) : null,
      reason: parsed ? 'not_a_grant' : 'parse_empty',
    })
    return { status: 'skipped', id, reason: parsed ? 'not_a_grant' : 'parse_empty' }
  }

  // 4. Persist through the canonical insert gate. Email grants are owner-
  //    curated but still pass the SAME reality/trust/URL/loan gate as crawlers.
  const opportunity = {
    title: str(parsed.title),
    sponsor: str(parsed.sponsor),
    description: str(parsed.description),
    url: str(parsed.url),
    source_url: str(parsed.url),
    application_url: str(parsed.url),
    deadline: str(parsed.deadline),
    amount_min: typeof parsed.amount_min === 'number' ? parsed.amount_min : null,
    amount_max: typeof parsed.amount_max === 'number' ? parsed.amount_max : null,
    eligibility_bullets: Array.isArray(parsed.eligibility) ? parsed.eligibility.filter(Boolean) : [],
    source: 'email_inbox',
    record_origin: 'url_import', // trusted origin → surfaces in Smart Match / Discover
    opportunity_type: 'grant',
  }

  let insertResult
  try {
    insertResult = await upsertFundingOpportunity(db, opportunity, { allowDirectories: true })
  } catch (err) {
    const id = await recordIngestion(db, {
      ...base,
      status: 'error',
      parse_provider: provider,
      parsed_json: JSON.stringify(parsed),
      reason: `insert_error:${err?.message || err}`,
    })
    return { status: 'error', id, reason: 'insert_error' }
  }

  if (!insertResult?.id) {
    const id = await recordIngestion(db, {
      ...base,
      status: 'skipped',
      parse_provider: provider,
      parsed_json: JSON.stringify(parsed),
      reason: insertResult?.reason ? `gate:${insertResult.reason}` : 'insert_skipped',
    })
    return { status: 'skipped', id, reason: insertResult?.reason ?? 'insert_skipped' }
  }

  const id = await recordIngestion(db, {
    ...base,
    status: 'imported',
    parse_provider: provider,
    parsed_json: JSON.stringify(parsed),
    opportunity_id: insertResult.id,
    reason: insertResult.updated ? 'updated_existing' : 'imported',
  })
  log.info('imported grant from email', { from: fromEmail, subject, opportunity_id: insertResult.id })
  return { status: 'imported', id, opportunity_id: insertResult.id, title: opportunity.title }
}

/**
 * Ingest a batch. Each email is processed independently; one failure never
 * aborts the rest. Returns per-email results + a tallied summary.
 */
export async function ingestEmails(db, emails = []) {
  const list = Array.isArray(emails) ? emails : []
  const results = []
  const summary = { received: list.length, imported: 0, skipped: 0, rejected: 0, duplicate: 0, error: 0 }
  for (const email of list) {
    let r
    try {
      r = await ingestEmail(db, email)
    } catch (err) {
      r = { status: 'error', reason: String(err?.message || err) }
    }
    if (summary[r.status] !== undefined) summary[r.status] += 1
    results.push(r)
  }
  return { summary, results }
}

/**
 * Diagnostics for Sam / Anya / admin: recent ingestions + status tallies.
 */
export async function getEmailGrantHealth(db, { limit = 20 } = {}) {
  if (!db) return { installed: false, reason: 'no_db' }
  try {
    await ensureEmailGrantSchema(db)
    const counts = await db
      .prepare('SELECT status, COUNT(*) AS n FROM email_grant_ingestions GROUP BY status')
      .all()
    const recent = await db
      .prepare(
        `SELECT id, source, from_email, subject, status, opportunity_id, reason, created_at
           FROM email_grant_ingestions
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(Math.max(1, Math.min(100, Number(limit) || 20)))
    const tally = {}
    for (const row of counts || []) tally[row.status] = Number(row.n) || 0
    return { installed: true, tally, recent: recent || [] }
  } catch (err) {
    return { installed: false, reason: String(err?.message || err) }
  }
}
