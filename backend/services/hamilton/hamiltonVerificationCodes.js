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

/** The channels the owner's phone can forward. */
export const FORWARDED_CHANNELS = Object.freeze(['sms', 'email'])

/**
 * Newest code the owner's PHONE forwarded, across either channel.
 *
 * Tasker forwards two things to `POST /api/hamilton/automation/sms-inbox`:
 * inbound TEXTS (a `Received Text` event) and Outlook NOTIFICATIONS for
 * Hamilton's own mailbox (a `Notification` event). Both land in
 * `hamilton_inbound_sms`, distinguished by `channel`.
 *
 * SUBJECT IS SEARCHED, NOT JUST BODY. Portals very often put the code in the
 * subject line ("481920 is your AwardSpring code"), and an Outlook notification
 * surfaces the subject as its title, so a reader that only looked at the body
 * would miss the most common shape of the thing it exists to find. The subject
 * is searched FIRST for the same reason.
 *
 * Reads only rows the phone actually posted; there is no path here that can
 * reach the handset, and none that can send anything.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {string[]} [opts.channels] restrict to these channels (default: both)
 */
export async function readForwardedCode(db, {
  channels = null,
  maxAgeMs = CODE_MAX_AGE_MS,
  now = null,
  max = 25,
} = {}) {
  if (!db) return { code: null, reason: 'no database handle' }
  const stamp = Number.isFinite(now) ? now : Date.now()
  const cutoff = new Date(stamp - maxAgeMs).toISOString()
  const wanted = Array.isArray(channels) && channels.length
    ? channels.map((c) => String(c).toLowerCase()).filter((c) => FORWARDED_CHANNELS.includes(c))
    : null
  const limit = Math.max(1, Math.min(50, max))
  const label = wanted && wanted.length ? wanted.join('+') : FORWARDED_CHANNELS.join('+')

  // STATIC SQL. The clause list used to be assembled with
  // `WHERE ${where.join(' AND ')}` and `channel IN (${...})`, which tripped
  // `npm run safe-sql:check` as a NEW dynamic-SQL interpolation. The frozen
  // baseline in scripts/codemod/safe-sql.mjs may only ever SHRINK, so the fix
  // is a fixed statement, not a widened inventory and not an
  // `// audit:allow dynamic-sql` annotation.
  //
  // The channel vocabulary is FORWARDED_CHANNELS, exactly two entries, so the
  // filter fits two bound parameters plus an "any channel" sentinel. Filtering
  // in JS after the query was rejected deliberately: that is the post-LIMIT
  // filter anti-pattern this repo documents — asking for 'email' when the
  // newest 50 rows are all 'sms' would return nothing while the real row sat
  // just outside the bound.
  const anyChannel = wanted && wanted.length ? 0 : 1
  // Duplicating a single requested channel is harmless and keeps the statement
  // fixed-arity. An unused slot never matches, because '' is not a channel.
  const ch1 = anyChannel ? '' : wanted[0]
  const ch2 = anyChannel ? '' : (wanted[1] ?? wanted[0])

  let rows
  try {
    rows = await db.prepare(
      `SELECT id, channel, sender, subject, body, received_at
         FROM hamilton_inbound_sms
        WHERE received_at >= ?
          AND (? = 1 OR channel = ? OR channel = ?)
        ORDER BY received_at DESC
        LIMIT ?`,
    ).all(cutoff, anyChannel, ch1, ch2, limit)
  } catch (err) {
    // A missing table means the phone has never forwarded anything yet.
    return { code: null, reason: `forwarded inbox unavailable: ${err?.message || err}` }
  }

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isFresh(row?.received_at, stamp, maxAgeMs)) continue
    const channel = String(row?.channel || 'sms').toLowerCase()
    // Subject first, then body — see the note above.
    const code = extractVerificationCode(`${row?.subject || ''}\n${row?.body || ''}`)
    if (code) {
      log.info('forwarded_code_found', { channel, receivedAt: row?.received_at })
      return {
        code,
        // 'email_forwarded' is deliberately DISTINCT from the Graph reader's
        // 'email': one came off the phone's notification shade, the other out of
        // the mailbox itself, and an audit trail should not conflate them.
        source: channel === 'email' ? 'email_forwarded' : 'sms',
        channel,
        receivedAt: row?.received_at || null,
        sender: row?.sender || null,
        subject: row?.subject || null,
      }
    }
  }
  return { code: null, reason: `no fresh verification code forwarded by the phone (${label})` }
}

/**
 * SMS-only view of the forwarded inbox. Kept as its own export because it is the
 * existing published contract; `readForwardedCode` is the general one.
 */
export async function readSmsCode(db, opts = {}) {
  return readForwardedCode(db, { ...opts, channels: ['sms'] })
}

/** Email-only view of the forwarded inbox (Outlook notifications via Tasker). */
export async function readForwardedEmailCode(db, opts = {}) {
  return readForwardedCode(db, { ...opts, channels: ['email'] })
}

/**
 * Try every channel and return whichever has a fresh code.
 *
 * ORDER: rows the PHONE forwarded first (sms AND email together, newest first),
 * then Microsoft Graph. The phone is first because it needs no app
 * registration, no `Mail.Read` grant and no token - it is the path that works
 * today. Graph is the FALLBACK for the one case the phone cannot cover: an
 * Outlook notification carries a truncated PREVIEW, so a code buried below the
 * fold never reaches the forwarded row, while Graph reads the message itself.
 *
 * Because the forwarded rows are walked newest-first and each is only accepted
 * when it actually YIELDS a code, a truncated copy of a message is simply
 * skipped in favour of a fuller copy (or of Graph) rather than shadowing it.
 *
 * A portal does not tell you which channel it used, so all are consulted and
 * every failure REASON is carried back - a caller that finds no code must be
 * able to say why, rather than reporting a bare "no code".
 */
export async function findVerificationCode(db, opts = {}) {
  const reasons = []
  const forwarded = await readForwardedCode(db, opts)
  if (forwarded.code) return forwarded
  reasons.push(`phone (sms+email): ${forwarded.reason}`)

  // Optional fallback. With no token provider configured this returns its
  // honest reason string and never throws, so an absent Graph registration
  // degrades the ladder instead of breaking it.
  const email = await readEmailCode(opts)
  if (email.code) return email
  reasons.push(`graph email: ${email.reason}`)

  return { code: null, reason: reasons.join(' | ') }
}
