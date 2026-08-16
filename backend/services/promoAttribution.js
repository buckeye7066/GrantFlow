/**
 * promoAttribution.js — fire-and-forget conversion reporting to PromoPilot.
 *
 * PromoPilot (the owner's promotion engine) mints a random touch id on every
 * promoted click (its /r/<productId> redirect appends `pp_touch=<id>` to the
 * destination URL). When a promoted visitor later converts inside GrantFlow —
 * signs up, submits an application, records an award — we POST that touch id
 * back to PromoPilot's `/attribution/events` receiver so its Brand Pulse
 * dashboard can close the promotion→outcome loop.
 *
 * HARD CONTRACT (owner order 2026-08-16: "as long as it doesn't interfere with
 * the purpose of the apps or production"):
 *   - NEVER throws and NEVER blocks a user request. Every public function
 *     resolves with `{ sent|ok, reason }` — callers fire-and-forget.
 *   - Short timeout (2s) with AbortController; the timer is unref'd so it can
 *     never hold the process open.
 *   - Env-gated: PROMOPILOT_ATTRIBUTION_URL + PROMOPILOT_ATTRIBUTION_SECRET.
 *     Missing config is a clean no-op, logged ONCE, never a crash.
 *   - Minimal payload, no PII: event type, the PromoPilot-minted touch id
 *     (random, carries no identity), an idempotency key built from a SHA-256
 *     hash of the internal subject id, and a timestamp. No emails, no names.
 *
 * Receiver contract (promopilot/server.js POST /attribution/events):
 *   Authorization: Bearer <ATTRIBUTION_INGEST_SECRET>
 *   { event_type: 'signup'|'activation', touch_id, event_key?, occurred_at? }
 *   An event without a known touch id is meaningless to the receiver (404
 *   unknown_touch), so a user with no stored touch is a silent no-op here.
 *
 * Touch storage: `system_kv` key `promo_attribution_touch:user:<userId>` —
 * deliberately no schema migration; the table already exists everywhere and
 * the adversarialRepairSettings CREATE-IF-NOT-EXISTS pattern covers fresh DBs.
 */

import crypto from 'crypto'

const TOUCH_KV_PREFIX = 'promo_attribution_touch:user:'
// Mirrors PromoPilot's own cookie/touch shape ([A-Za-z0-9_-]{16,128}).
const TOUCH_ID_RX = /^[A-Za-z0-9_-]{16,128}$/
// GrantFlow conversion moments → the receiver's two-event vocabulary.
const EVENT_CLASS_TO_TYPE = Object.freeze({
  signup: 'signup',
  submitted: 'activation',
  awarded: 'activation',
})
const REQUEST_TIMEOUT_MS = 2000
// A touch claim only counts as a SIGNUP conversion when the user account is
// genuinely new — an old account clicking a promo link is not a sign-up.
const SIGNUP_ATTRIBUTION_WINDOW_MS = 48 * 60 * 60 * 1000

let loggedDisabledOnce = false

export function getPromoAttributionConfig() {
  // Read at call time (not module load) so Railway env updates apply on the
  // next event without a code change. NOTE: keep these as literal
  // `process.env.NAME` references — scripts/generate-env-examples.mjs scans
  // for exactly that shape to keep the env contract traceable.
  const url = String(process.env.PROMOPILOT_ATTRIBUTION_URL || '').trim()
  const secret = String(process.env.PROMOPILOT_ATTRIBUTION_SECRET || '').trim()
  const enabled = url.length > 0 && secret.length > 0
  if (!enabled && !loggedDisabledOnce) {
    loggedDisabledOnce = true
    console.warn(
      '[promoAttribution] disabled — PROMOPILOT_ATTRIBUTION_URL / PROMOPILOT_ATTRIBUTION_SECRET not set; conversion events are a no-op',
    )
  }
  return { url, secret, enabled }
}

/** Test hook: reset the log-once latch so tests can assert the single log. */
export function _resetPromoAttributionLogOnce() {
  loggedDisabledOnce = false
}

export function isValidPromoTouchId(value) {
  return TOUCH_ID_RX.test(String(value ?? ''))
}

/** Internal ids never leave GrantFlow raw — hash them for the idempotency key. */
export function hashAttributionSubject(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 32)
}

async function ensureSystemKv(db) {
  await db
    .prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)')
    .run()
}

export async function storePromoTouchForUser(db, userId, touchId) {
  try {
    if (!db || !userId || !isValidPromoTouchId(touchId)) return false
    await ensureSystemKv(db)
    const key = TOUCH_KV_PREFIX + String(userId)
    const now = new Date().toISOString()
    await db
      .prepare(
        `INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, String(touchId), now)
    return true
  } catch {
    return false
  }
}

export async function getPromoTouchForUser(db, userId) {
  try {
    if (!db || !userId) return null
    await ensureSystemKv(db)
    const row = await db
      .prepare('SELECT value FROM system_kv WHERE key = ? LIMIT 1')
      .get(TOUCH_KV_PREFIX + String(userId))
    const value = String(row?.value ?? '')
    return isValidPromoTouchId(value) ? value : null
  } catch {
    return null
  }
}

/**
 * SQLite writes bare 'YYYY-MM-DD HH:MM:SS' UTC strings with no zone marker;
 * Date.parse reads those as LOCAL time. Pin zone-less timestamps to UTC
 * (the samRegistry/brand-pulse trap). Postgres hands back Date objects.
 */
export function parseDbTimestampMs(value) {
  if (value === null || value === undefined) return NaN
  if (value instanceof Date) return value.getTime()
  const str = String(value).trim()
  if (!str) return NaN
  const zoneless = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/
  if (zoneless.test(str)) return Date.parse(str.replace(' ', 'T') + 'Z')
  return Date.parse(str)
}

/**
 * POST one conversion event to PromoPilot. NEVER throws; resolves
 * `{ sent, reason }`. Callers on hot paths must not await this.
 */
export async function sendPromoConversionEvent({ eventClass, touchId, subjectId, occurredAt, fetchImpl } = {}) {
  try {
    const cfg = getPromoAttributionConfig()
    if (!cfg.enabled) return { sent: false, reason: 'disabled' }
    const eventType = EVENT_CLASS_TO_TYPE[String(eventClass ?? '')]
    if (!eventType) return { sent: false, reason: 'unsupported_event_class' }
    if (!isValidPromoTouchId(touchId)) return { sent: false, reason: 'no_touch' }
    const doFetch = fetchImpl ?? globalThis.fetch
    if (typeof doFetch !== 'function') return { sent: false, reason: 'no_fetch' }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    if (typeof timer?.unref === 'function') timer.unref()
    try {
      const res = await doFetch(cfg.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.secret}`,
        },
        body: JSON.stringify({
          event_type: eventType,
          touch_id: String(touchId),
          // Namespaced idempotency: the receiver folds this into
          // `${touchId}:${eventType}:${event_key}`, so one real-world
          // conversion can never double-count no matter how often we fire.
          event_key: `${eventClass}:${hashAttributionSubject(subjectId ?? 'default')}`,
          occurred_at: occurredAt || new Date().toISOString(),
        }),
        signal: controller.signal,
      })
      return { sent: res?.ok === true, reason: res?.ok ? 'ok' : `http_${res?.status ?? 'unknown'}` }
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    return { sent: false, reason: `error:${err?.name || 'unknown'}` }
  }
}

/**
 * Report a conversion for a user with a stored promo touch. No stored touch
 * (i.e. the user never arrived through a promoted link) is a silent no-op.
 */
export async function reportUserConversion(db, { userId, eventClass, subjectId } = {}) {
  try {
    if (!getPromoAttributionConfig().enabled) return { sent: false, reason: 'disabled' }
    const touchId = await getPromoTouchForUser(db, userId)
    if (!touchId) return { sent: false, reason: 'no_touch' }
    return await sendPromoConversionEvent({ eventClass, touchId, subjectId: subjectId ?? userId })
  } catch {
    return { sent: false, reason: 'error' }
  }
}

/**
 * Report a grant-linked conversion (submitted/awarded). Resolves the grant's
 * profile → owning user → stored touch; any missing link is a silent no-op.
 */
export async function reportGrantConversion(db, { grantId, profileId, eventClass } = {}) {
  try {
    if (!getPromoAttributionConfig().enabled) return { sent: false, reason: 'disabled' }
    if (!db) return { sent: false, reason: 'no_db' }
    let pid = profileId ?? null
    if (!pid && grantId) {
      const grant = await db.prepare('SELECT profile_id FROM grants WHERE id = ? LIMIT 1').get(String(grantId))
      pid = grant?.profile_id ?? null
    }
    if (!pid) return { sent: false, reason: 'no_profile' }
    const profile = await db.prepare('SELECT user_id FROM profiles WHERE id = ? LIMIT 1').get(String(pid))
    const userId = profile?.user_id ?? null
    if (!userId) return { sent: false, reason: 'no_user' }
    return await reportUserConversion(db, { userId, eventClass, subjectId: grantId ?? pid })
  } catch {
    return { sent: false, reason: 'error' }
  }
}

/**
 * Associate a promo touch with a signed-in user, and report a SIGNUP
 * conversion when the account is genuinely new. `awaitSend` exists for tests;
 * production callers leave it false so the network send never blocks.
 */
export async function claimPromoTouchForUser(db, { userId, touchId, awaitSend = false } = {}) {
  try {
    if (!userId || !isValidPromoTouchId(touchId)) return { ok: false, reason: 'invalid' }
    const stored = await storePromoTouchForUser(db, userId, touchId)
    if (!stored) return { ok: false, reason: 'store_failed' }

    let isNewUser = false
    try {
      const row = await db.prepare('SELECT created_at FROM users WHERE id = ? LIMIT 1').get(String(userId))
      const createdMs = parseDbTimestampMs(row?.created_at)
      isNewUser = Number.isFinite(createdMs) && Date.now() - createdMs <= SIGNUP_ATTRIBUTION_WINDOW_MS
    } catch {
      isNewUser = false
    }

    if (!isNewUser) return { ok: true, signupQueued: false }
    const sendPromise = sendPromoConversionEvent({ eventClass: 'signup', touchId, subjectId: userId })
    if (awaitSend) {
      const signup = await sendPromise
      return { ok: true, signupQueued: true, signup }
    }
    sendPromise.catch(() => {})
    return { ok: true, signupQueued: true }
  } catch {
    return { ok: false, reason: 'error' }
  }
}

export default {
  getPromoAttributionConfig,
  isValidPromoTouchId,
  hashAttributionSubject,
  storePromoTouchForUser,
  getPromoTouchForUser,
  parseDbTimestampMs,
  sendPromoConversionEvent,
  reportUserConversion,
  reportGrantConversion,
  claimPromoTouchForUser,
}
