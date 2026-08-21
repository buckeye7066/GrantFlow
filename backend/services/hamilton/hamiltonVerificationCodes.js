/**
 * hamiltonVerificationCodes.js
 *
 * Where Hamilton READS the one-time codes that portal signup sends him.
 *
 * WHY THIS EXISTS
 * ---------------
 * Owner order 2026-08-20: "Make sure Hamilton can access a 2FA that goes to
 * Hamilton@axiombiolabs.org and 423 504 7778."
 *
 * `hamiltonIdentity.js` decides that unattended signup registers under
 * Hamilton's OWN email and phone. That is only half the mechanism: a code sent
 * to a mailbox nobody reads is the same dead end as a code sent to the
 * applicant. This module is the reading half - two channels, one extractor.
 *
 *   EMAIL - Microsoft Graph against Hamilton's own mailbox. Deliberately NOT
 *   `robertMailboxReaders.makeGraphReader`, whose `$select` carries the comment
 *   "NO body in $select - headers only, by design": that reader harvests
 *   CONTACTS and its privacy posture must not be widened to fetch bodies. This
 *   one reads Hamilton's own mailbox only, and only recent messages.
 *
 *   SMS - the owner's phone runs Tasker and forwards inbound texts to
 *   `POST /api/hamilton/sms-inbox`, which stores them in `hamilton_inbound_sms`.
 *   Hamilton reads that table. Nothing here can send a text or read anything
 *   the phone did not forward.
 *
 * WHAT THIS MODULE WILL NOT DO
 * ----------------------------
 * It never fabricates a code. Every function returns `null` when it did not
 * find one, and the caller's existing `needs_user` handoff still applies - a
 * missing code is a handoff, never a guess. It never bypasses identity
 * PROOFING (SSN, government ID, FSA ID, Login.gov, ID.me): reading a
 * verification code sent to your own address is not the same act, and the
 * portal-identity state machine keeps that line.
 */
import { HAMILTON_IDENTITY } from '../../config/hamiltonIdentity.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:hamilton-verification-codes')

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

/** How far back a code is allowed to be. A stale code is worse than none. */
export const CODE_MAX_AGE_MS = 10 * 60 * 1000

/**
 * Phrases that mark a number as a one-time code. A bare digit run is NOT a
 * code - portal mail is full of amounts, dates, ZIPs, phone numbers and case
 * ids, and treating any 6 digits as a code is how the wrong number gets typed
 * into an auth form.
 */
const CODE_CUE = new RegExp(
  '(?:'
  + 'verification\\s+code|security\\s+code|one[-\\s]?time\\s+(?:code|passcode|password)'
  + '|access\\s+code|confirmation\\s+code|authentication\\s+code|login\\s+code'
  + '|passcode|otp|2fa\\s+code|your\\s+code(?:\\s+is)?|code\\s+is'
  + ')',
  'i',
)

/** A code is 4-8 digits, or 6-8 alphanumerics that contain at least one digit. */
const NUMERIC_CODE = /\b(\d{4,8})\b/
const ALNUM_CODE = /\b(?=[A-Z0-9]{6,8}\b)(?=[A-Z0-9]*\d)[A-Z0-9]{6,8}\b/

/**
 * Pull a one-time code out of a message body.
 *
 * Returns the code string, or null. The cue must appear WITHIN
 * `windowChars` of the digits, so "your verification code is 481920" matches
 * while a message mentioning a code and, three paragraphs later, an award of
 * "$25,000" does not.
 */
export function extractVerificationCode(text, { windowChars = 60 } = {}) {
  const body = String(text || '')
  if (!body) return null

  const cue = CODE_CUE.exec(body)
  if (!cue) return null

  // Search the window AFTER the cue first (the overwhelmingly common shape),
  // then a shorter window before it ("481920 is your code").
  const after = body.slice(cue.index, cue.index + cue[0].length + windowChars)
  const before = body.slice(Math.max(0, cue.index - windowChars), cue.index)

  for (const chunk of [after, before]) {
    const numeric = NUMERIC_CODE.exec(chunk)
    if (numeric) return numeric[1]
    const alnum = ALNUM_CODE.exec(chunk)
    if (alnum) return alnum[0]
  }
  return null
}

function isFresh(receivedAt, now, maxAgeMs) {
  const ts = Date.parse(String(receivedAt || ''))
  if (!Number.isFinite(ts)) return false
  const age = now - ts
  return age >= 0 - 60_000 && age <= maxAgeMs   // 60s of clock skew tolerated
}

/**
 * Read recent messages from Hamilton's own mailbox and return the newest code.
 *
 * `getToken` is injected so tests never touch the network and so this module
 * never owns a credential. Returns `{code, source, receivedAt, subject}` or
 * `{code: null, reason}` - never throws.
 */
export async function readEmailCode({
  getToken,
  fetchImpl = null,
  mailbox = HAMILTON_IDENTITY.email,
  maxAgeMs = CODE_MAX_AGE_MS,
  now = null,
  max = 25,
} = {}) {
  const fetcher = fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)
  if (!fetcher) return { code: null, reason: 'no fetch implementation available' }
  if (typeof getToken !== 'function') return { code: null, reason: 'no Graph token provider configured' }

  const stamp = Number.isFinite(now) ? now : Date.now()
  const since = new Date(stamp - maxAgeMs).toISOString()
  let token
  try {
    token = await getToken()
  } catch (err) {
    return { code: null, reason: `graph token failed: ${err?.message || err}` }
  }
  if (!token) return { code: null, reason: 'graph token unavailable' }

  const url = `${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/messages`
    + '?$select=subject,bodyPreview,receivedDateTime,from'
    + `&$filter=receivedDateTime ge ${since}`
    + `&$orderby=receivedDateTime desc&$top=${Math.max(1, Math.min(50, max))}`

  let payload
  try {
    const res = await fetcher(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res?.ok) return { code: null, reason: `graph ${res?.status ?? 'error'}` }
    payload = await res.json()
  } catch (err) {
    return { code: null, reason: `graph read failed: ${err?.message || err}` }
  }

  for (const m of Array.isArray(payload?.value) ? payload.value : []) {
    if (!isFresh(m?.receivedDateTime, stamp, maxAgeMs)) continue
    const code = extractVerificationCode(`${m?.subject || ''}\n${m?.bodyPreview || ''}`)
    if (code) {
      log.info('email_code_found', { mailbox, receivedAt: m?.receivedDateTime })
      return {
        code,
        source: 'email',
        receivedAt: m?.receivedDateTime || null,
        subject: m?.subject || null,
      }
    }
  }
  return { code: null, reason: 'no fresh verification code in the mailbox' }
}

/**
 * Newest code forwarded by the owner's phone (Tasker -> /api/hamilton/sms-inbox).
 *
 * Reads only rows the phone actually posted; there is no path here that can
 * reach the handset.
 */
export async function readSmsCode(db, {
  maxAgeMs = CODE_MAX_AGE_MS,
  now = null,
  max = 25,
} = {}) {
  if (!db) return { code: null, reason: 'no database handle' }
  const stamp = Number.isFinite(now) ? now : Date.now()
  const cutoff = new Date(stamp - maxAgeMs).toISOString()
  let rows
  try {
    // The db handle exposes prepare(sql).all(...params); there is NO
    // db.all(sql, paramsArray). The original spelling threw
    // "db.all is not a function" on EVERY call and the catch below turned it
    // into the innocuous-looking "inbound sms unavailable" - so the SMS lane
    // read as "the phone has not forwarded anything yet" while in fact no code
    // could ever be read, no matter how many the phone forwarded. Verified live
    // 2026-08-20 against a row the Tasker route had just stored.
    rows = await db.prepare(
      `SELECT id, sender, body, received_at
         FROM hamilton_inbound_sms
        WHERE received_at >= ?
        ORDER BY received_at DESC
        LIMIT ?`,
    ).all(cutoff, Math.max(1, Math.min(50, max)))
  } catch (err) {
    // A missing table means the phone has never forwarded anything yet.
    return { code: null, reason: `inbound sms unavailable: ${err?.message || err}` }
  }

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isFresh(row?.received_at, stamp, maxAgeMs)) continue
    const code = extractVerificationCode(String(row?.body || ''))
    if (code) {
      log.info('sms_code_found', { sender: row?.sender, receivedAt: row?.received_at })
      return { code, source: 'sms', receivedAt: row?.received_at || null, sender: row?.sender || null }
    }
  }
  return { code: null, reason: 'no fresh verification code from the phone' }
}

/**
 * Try BOTH channels and return whichever has a fresh code.
 *
 * A portal does not tell you which channel it used, so both are consulted and
 * every failure REASON is carried back - a caller that finds no code must be
 * able to say why, rather than reporting a bare "no code".
 */
export async function findVerificationCode(db, opts = {}) {
  const reasons = []
  const sms = await readSmsCode(db, opts)
  if (sms.code) return sms
  reasons.push(`sms: ${sms.reason}`)

  const email = await readEmailCode(opts)
  if (email.code) return email
  reasons.push(`email: ${email.reason}`)

  return { code: null, reason: reasons.join(' | ') }
}
