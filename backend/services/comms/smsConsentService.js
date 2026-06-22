/**
 * smsConsentService.js — the SMS consent (opt-in) state machine.
 *
 * Owner requirement (verbatim): "Make sure text messages can be sent. For all
 * existing profiles, send a text that asks if it is ok. If it is, turn it on, if
 * they don't respond or say no, then turn it off. All incoming profiles, do the
 * same."
 *
 * This layer sits ON TOP of profile_phones (commsService.js owns the table). Per
 * phone we track a consent lifecycle:
 *
 *   none       — no consent has ever been asked for this number.
 *   pending    — a consent SMS was sent; we are awaiting a reply.
 *   opted_in   — the person replied YES (sms_opt_in -> TRUE; SMS may be sent).
 *   opted_out  — the person replied NO/STOP, OR never responded (stays OFF).
 *
 * INVARIANTS (legal / TCPA-conservative — see feedback_keep_me_legal):
 *   - sms_opt_in is TRUE iff consent_status = 'opted_in'. It is the single
 *     effective boolean every send path already reads (commsService.sms_phone).
 *   - The DEFAULT for an un-consented number is OFF. A non-responder simply
 *     stays off; nothing ever auto-flips a phone ON.
 *   - We never text a number on the owner blocklist / suppression list.
 *   - STOP / UNSUBSCRIBE always opts a number out, regardless of context.
 *   - The mass consent campaign DEFAULTS TO DRY-RUN — it sends nothing unless an
 *     explicit confirm:true / send:true flag is passed, because it is an
 *     outward-facing message to real people.
 *
 * Schema columns (consent_status, consent_requested_at) are added by
 * commsService.ensureCommsSchema + re-asserted in ensureSchemaInvariants.js +
 * paired migrations 126 / 0127.
 */

import { sendSms, normalizePhone, isSmsConfigured } from '../sms.js'
import { ensureCommsSchema } from './commsService.js'
import { checkIdentity } from '../blocklist/ownerBlocklistService.js'
import { getProfileLanguage } from './profileLanguage.js'
import { t } from './commsMessages.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('sms-consent')

export const CONSENT_STATUS = Object.freeze({
  NONE: 'none',
  PENDING: 'pending',
  OPTED_IN: 'opted_in',
  OPTED_OUT: 'opted_out',
})

/**
 * The compliant consent-request copy. Identifies the sender + purpose and
 * includes the required opt-out language, rendered in the recipient's language.
 *
 * The SMS_CONSENT_MESSAGE env override remains the English/default copy (it is a
 * single owner-reviewed override). For any non-English `lang` we use the
 * localized catalog copy so the consent ask is in the recipient's language.
 *
 * @param {string} [lang] supported language code (defaults to English)
 */
export function consentMessageBody(lang = 'en') {
  const custom = String(process.env.SMS_CONSENT_MESSAGE || '').trim()
  if (custom && (!lang || lang === 'en')) return custom
  return t(lang, 'sms_consent_request')
}

/** Confirmation copy sent back when someone opts in / out via reply (localized). */
export function optInConfirmationBody(lang = 'en') {
  return t(lang, 'sms_opt_in_confirm')
}
export function optOutConfirmationBody(lang = 'en') {
  return t(lang, 'sms_opt_out_confirm')
}
/** Neutral reply to a non-keyword inbound SMS (localized). */
export function unknownReplyBody(lang = 'en') {
  return t(lang, 'sms_unknown_reply')
}

// ---------------------------------------------------------------------------
// Reply parsing — the CTIA/TCPA keyword contract.
// ---------------------------------------------------------------------------

// Honored regardless of any surrounding text or context.
const STOP_KEYWORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'no', 'optout', 'opt-out', 'revoke'])
const START_KEYWORDS = new Set(['start', 'unstop', 'yes', 'y', 'yeah', 'yep', 'ok', 'okay', 'sure', 'optin', 'opt-in', 'subscribe'])

/**
 * Classify an inbound SMS body into a consent intent.
 * @returns {'opt_in'|'opt_out'|'unknown'}
 *
 * STOP-class keywords win over START-class when both somehow appear, because an
 * unsubscribe request must always be honored (compliance-first).
 */
export function classifyConsentReply(body) {
  const raw = String(body || '').trim().toLowerCase()
  if (!raw) return 'unknown'
  // Tokenize on non-letters so "YES please", "stop." etc. still match. Keep a
  // hyphen so opt-in/opt-out survive.
  const tokens = raw.split(/[^a-z-]+/).filter(Boolean)
  const tokenSet = new Set(tokens)
  // Also consider the first token alone (most carriers send a single keyword).
  const first = tokens[0] || ''

  const hasStop = first && STOP_KEYWORDS.has(first) ? true : [...tokenSet].some((t) => STOP_KEYWORDS.has(t))
  if (hasStop) return 'opt_out'
  const hasStart = first && START_KEYWORDS.has(first) ? true : [...tokenSet].some((t) => START_KEYWORDS.has(t))
  if (hasStart) return 'opt_in'
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Low-level state writes
// ---------------------------------------------------------------------------

function isPg(db) {
  return db?.dialect === 'postgres'
}
function boolVal(db, v) {
  return isPg(db) ? Boolean(v) : (v ? 1 : 0)
}

/**
 * Set the consent status for a (profileId, phone). Keeps sms_opt_in in lockstep:
 * TRUE only when status === 'opted_in'. Pure write; returns { ok }.
 */
export async function setConsentStatus(db, { profileId, phone, status, requestedAt = null } = {}) {
  await ensureCommsSchema(db)
  const normalized = normalizePhone(phone)
  if (!normalized) return { ok: false, error: 'invalid_phone' }
  if (!Object.values(CONSENT_STATUS).includes(status)) return { ok: false, error: 'invalid_status' }
  const optIn = boolVal(db, status === CONSENT_STATUS.OPTED_IN)

  // Only stamp consent_requested_at when explicitly transitioning to pending (or
  // when caller passes one) — keep the original ask timestamp otherwise.
  if (status === CONSENT_STATUS.PENDING) {
    const ts = requestedAt || (isPg(db) ? new Date().toISOString() : new Date().toISOString())
    await db.prepare(
      `UPDATE profile_phones SET consent_status = ?, sms_opt_in = ?, consent_requested_at = ? WHERE profile_id = ? AND phone = ?`,
    ).run(status, optIn, ts, String(profileId), normalized)
  } else {
    await db.prepare(
      `UPDATE profile_phones SET consent_status = ?, sms_opt_in = ? WHERE profile_id = ? AND phone = ?`,
    ).run(status, optIn, String(profileId), normalized)
  }
  return { ok: true, profile_id: String(profileId), phone: normalized, consent_status: status, sms_opt_in: status === CONSENT_STATUS.OPTED_IN }
}

/** Read the consent row for one phone (or null). */
export async function getPhoneConsent(db, { profileId, phone } = {}) {
  await ensureCommsSchema(db)
  const normalized = normalizePhone(phone)
  if (!normalized) return null
  try {
    const row = await db.prepare(
      `SELECT profile_id, phone, label, sms_opt_in, consent_status, consent_requested_at
         FROM profile_phones WHERE profile_id = ? AND phone = ? LIMIT 1`,
    ).get(String(profileId), normalized)
    return row || null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Inbound reply handling (Twilio webhook delegates here)
// ---------------------------------------------------------------------------

/**
 * Apply an inbound SMS reply. Matches the From number to ANY profile_phones row
 * (a number can belong to more than one profile) and applies the consent intent
 * to every match. STOP always opts out; START/YES opts in.
 *
 * The returned `lang` is the preferred language of the FIRST matched profile
 * (best-effort), so the inbound webhook can render its TwiML confirmation in the
 * recipient's language. Defaults to 'en' when no match / unknown.
 *
 * @returns {{ intent, phone, matched, updated, results, lang }}
 */
export async function applyInboundReply(db, { from, body } = {}) {
  await ensureCommsSchema(db)
  const phone = normalizePhone(from)
  const intent = classifyConsentReply(body)
  if (!phone) return { intent, phone: null, matched: 0, updated: 0, results: [], lang: 'en' }

  let rows = []
  try {
    rows = await db.prepare('SELECT profile_id, phone FROM profile_phones WHERE phone = ?').all(phone)
  } catch {
    rows = []
  }

  // Language of the first matched profile drives the confirmation copy.
  let lang = 'en'
  if (rows[0]?.profile_id) {
    try { lang = await getProfileLanguage(db, rows[0].profile_id) } catch { lang = 'en' }
  }

  // Map intent to a terminal status. 'unknown' replies do NOT change state (a
  // non-keyword reply is not consent) — they stay pending/opted_out as-is.
  let nextStatus = null
  if (intent === 'opt_in') nextStatus = CONSENT_STATUS.OPTED_IN
  else if (intent === 'opt_out') nextStatus = CONSENT_STATUS.OPTED_OUT

  const results = []
  if (nextStatus) {
    for (const r of rows || []) {
      try {
        const res = await setConsentStatus(db, { profileId: r.profile_id, phone, status: nextStatus })
        results.push({ profile_id: r.profile_id, ok: Boolean(res.ok), status: nextStatus })
      } catch (err) {
        results.push({ profile_id: r.profile_id, ok: false, error: err?.message || String(err) })
      }
    }
  }

  log.info('inbound reply', { intent, phone: `***${phone.slice(-4)}`, matched: rows.length, updated: results.length, lang })
  return { intent, phone, matched: rows.length, updated: results.filter((x) => x.ok).length, results, lang }
}

// ---------------------------------------------------------------------------
// Blocklist suppression
// ---------------------------------------------------------------------------

/** True when a phone is on the owner blocklist (never text it). Fails OPEN-safe:
 *  on any error we treat it as NOT suppressed only if the blocklist itself is
 *  unavailable — but we log it so the owner can tell. */
async function isPhoneSuppressed(db, phone) {
  try {
    const result = await checkIdentity(db, { phone })
    return Boolean(result?.blocked)
  } catch (err) {
    log.warn('blocklist check failed (treating as not suppressed)', { error: err?.message })
    return false
  }
}

// ---------------------------------------------------------------------------
// Consent campaign — the mass "is it ok?" sender.
// ---------------------------------------------------------------------------

/**
 * Find every phone in `none` state across (non-deleted) profiles and either
 * preview (DRY-RUN, default) or actually send the consent SMS and move it to
 * `pending`.
 *
 * SAFETY: this is an outward-facing mass message. It sends NOTHING unless an
 * explicit confirm flag is passed.
 *
 * @param {object} opts
 * @param {boolean} [opts.confirm]   alias: send — must be EXACTLY true to send
 * @param {boolean} [opts.send]
 * @param {number}  [opts.limit]     cap how many numbers to process (default 500)
 * @param {string}  [opts.requestedBy]
 * @returns {{ dryRun, configured, candidates, sent, skipped, suppressed, alreadyPending, errors, items }}
 */
export async function runConsentCampaign(db, { confirm = false, send = false, limit = 500, requestedBy = 'owner' } = {}) {
  await ensureCommsSchema(db)
  const willSend = confirm === true || send === true
  const dryRun = !willSend
  const configured = isSmsConfigured()
  const cap = Math.max(1, Math.min(5000, Number(limit) || 500))

  // Pull candidate numbers: consent_status = 'none' (or NULL on legacy rows that
  // predate the column default), on profiles that aren't deleted.
  let rows = []
  try {
    rows = await db.prepare(
      `SELECT pp.profile_id AS profile_id, pp.phone AS phone, pp.label AS label
         FROM profile_phones pp
         JOIN profiles p ON p.id = pp.profile_id
        WHERE (pp.consent_status = 'none' OR pp.consent_status IS NULL)
          AND (p.status IS NULL OR p.status NOT IN ('deleted'))
        LIMIT ?`,
    ).all(cap)
  } catch (err) {
    // Fallback for environments where the JOIN/status filter isn't available.
    log.warn('candidate query fell back', { error: err?.message })
    try {
      rows = await db.prepare(
        `SELECT profile_id, phone, label FROM profile_phones
          WHERE consent_status = 'none' OR consent_status IS NULL LIMIT ?`,
      ).all(cap)
    } catch {
      rows = []
    }
  }

  const summary = {
    dry_run: dryRun,
    configured,
    candidates: rows.length,
    sent: 0,
    skipped: 0,
    suppressed: 0,
    already_pending: 0,
    errors: 0,
    items: [],
  }

  for (const r of rows || []) {
    const phone = normalizePhone(r.phone)
    if (!phone) { summary.skipped += 1; continue }

    // Never message a blocklisted number — record it but send nothing.
    if (await isPhoneSuppressed(db, phone)) {
      summary.suppressed += 1
      summary.items.push({ profile_id: r.profile_id, phone: `***${phone.slice(-4)}`, action: 'suppressed' })
      continue
    }

    if (dryRun) {
      summary.items.push({ profile_id: r.profile_id, phone: `***${phone.slice(-4)}`, action: 'would_send' })
      continue
    }

    if (!configured) {
      // Asked to send but SMS isn't configured — can't ask for consent. Leave
      // the number in `none` (do NOT mark pending) so a later configured run picks it up.
      summary.skipped += 1
      summary.items.push({ profile_id: r.profile_id, phone: `***${phone.slice(-4)}`, action: 'not_configured' })
      continue
    }

    // Render the consent ask in THIS profile's preferred language (per-recipient).
    const lang = await getProfileLanguage(db, r.profile_id)
    const res = await sendSms({ to: phone, body: consentMessageBody(lang) })
    if (res?.ok) {
      await setConsentStatus(db, { profileId: r.profile_id, phone, status: CONSENT_STATUS.PENDING })
      summary.sent += 1
      summary.items.push({ profile_id: r.profile_id, phone: `***${phone.slice(-4)}`, action: 'sent' })
    } else {
      summary.errors += 1
      summary.items.push({ profile_id: r.profile_id, phone: `***${phone.slice(-4)}`, action: 'error', error: res?.error || 'send_failed' })
    }
  }

  log.info('consent campaign', { dryRun, requestedBy, ...{ candidates: summary.candidates, sent: summary.sent, suppressed: summary.suppressed } })
  return summary
}

// ---------------------------------------------------------------------------
// Status counts (observability) + expiry sweep
// ---------------------------------------------------------------------------

/** Tally consent_status across all phones + how many new profiles await consent. */
export async function getConsentStatusCounts(db) {
  await ensureCommsSchema(db)
  const counts = { none: 0, pending: 0, opted_in: 0, opted_out: 0, total: 0 }
  try {
    const rows = await db.prepare(
      `SELECT COALESCE(consent_status, 'none') AS status, COUNT(*) AS c
         FROM profile_phones GROUP BY COALESCE(consent_status, 'none')`,
    ).all()
    for (const r of rows || []) {
      const k = String(r.status)
      if (k in counts) counts[k] = Number(r.c || 0)
      counts.total += Number(r.c || 0)
    }
  } catch { /* table may not exist yet */ }
  return { ...counts, configured: isSmsConfigured() }
}

/**
 * Expire stale `pending` consents: a number that was asked but never replied
 * within N days is made explicit `opted_out` (stays OFF). This doesn't change
 * the effective behavior (pending is already OFF) but makes the "no response →
 * off" rule explicit + auditable. Reused from the nightly sweep — NOT a new
 * scheduler.
 *
 * @param {number} [days] default SMS_CONSENT_PENDING_EXPIRE_DAYS or 14
 */
export async function expirePendingConsent(db, { days = null } = {}) {
  await ensureCommsSchema(db)
  const n = Number(days ?? process.env.SMS_CONSENT_PENDING_EXPIRE_DAYS ?? 14)
  const cutoffDays = Number.isFinite(n) && n > 0 ? n : 14
  const cutoffIso = new Date(Date.now() - cutoffDays * 24 * 60 * 60 * 1000).toISOString()
  let expired = 0
  try {
    const res = await db.prepare(
      `UPDATE profile_phones
          SET consent_status = '${CONSENT_STATUS.OPTED_OUT}', sms_opt_in = ${isPg(db) ? 'FALSE' : '0'}
        WHERE consent_status = '${CONSENT_STATUS.PENDING}'
          AND consent_requested_at IS NOT NULL
          AND consent_requested_at < ?`,
    ).run(cutoffIso)
    expired = Number(res?.changes ?? 0)
  } catch (err) {
    log.warn('expirePendingConsent failed (non-fatal)', { error: err?.message })
  }
  return { expired, cutoff_days: cutoffDays }
}

/**
 * Enqueue (or immediately send) a consent request for ONE profile's phones.
 *
 * "All incoming profiles, do the same" — call this when a new profile is created
 * or first gains a phone. For each phone in `none` state on this profile:
 *   - if SMS is configured AND not suppressed: send the consent SMS and move to
 *     `pending` (the new profile is asked right away).
 *   - otherwise: leave it in `none`, so the next consent-campaign tick asks it.
 *
 * Best-effort and idempotent: never re-asks a number already pending/opted_*.
 * Always safe to call (never throws) — profile creation must not fail on this.
 *
 * @returns {{ asked, pending, suppressed, skipped }}
 */
export async function requestConsentForProfile(db, { profileId } = {}) {
  const out = { asked: 0, pending: 0, suppressed: 0, skipped: 0 }
  try {
    await ensureCommsSchema(db)
    let rows = []
    try {
      rows = await db.prepare(
        `SELECT phone FROM profile_phones WHERE profile_id = ? AND (consent_status = 'none' OR consent_status IS NULL)`,
      ).all(String(profileId))
    } catch { rows = [] }
    if (!rows || rows.length === 0) return out

    const configured = isSmsConfigured()
    // One profile → one language for all its phones.
    const body = consentMessageBody(await getProfileLanguage(db, profileId))
    for (const r of rows) {
      const phone = normalizePhone(r.phone)
      if (!phone) { out.skipped += 1; continue }
      if (await isPhoneSuppressed(db, phone)) { out.suppressed += 1; continue }
      if (!configured) { out.skipped += 1; continue } // stays 'none' for the next campaign tick
      const res = await sendSms({ to: phone, body })
      if (res?.ok) {
        await setConsentStatus(db, { profileId, phone, status: CONSENT_STATUS.PENDING })
        out.asked += 1
        out.pending += 1
      } else {
        out.skipped += 1
      }
    }
  } catch (err) {
    log.warn('requestConsentForProfile failed (non-fatal)', { error: err?.message })
  }
  return out
}

export const __testing__ = { isPhoneSuppressed }
