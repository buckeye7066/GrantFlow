/**
 * promoAttribution — fire-and-forget conversion reporting to PromoPilot.
 *
 * The hard contract under test (owner order 2026-08-16: attribution must not
 * interfere with the purpose of the app or production):
 *   - env-gated: missing config = clean no-op (logged once), never a crash
 *   - never throws, even when fetch rejects or times out
 *   - non-blocking: the send is not awaited on product paths
 *   - minimal payload: hashed subject ids, no PII, receiver-vocabulary events
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const Database = (await import('better-sqlite3')).default
const {
  getPromoAttributionConfig,
  _resetPromoAttributionLogOnce,
  isValidPromoTouchId,
  hashAttributionSubject,
  storePromoTouchForUser,
  getPromoTouchForUser,
  parseDbTimestampMs,
  sendPromoConversionEvent,
  reportUserConversion,
  reportGrantConversion,
  claimPromoTouchForUser,
} = await import('../services/promoAttribution.js')

const TOUCH = 'a1b2c3d4e5f6a7b8c9d0e1f2'
const URL_ENV = 'https://promopilot.test.example/attribution/events'
const SECRET_ENV = 's'.repeat(48)

function enableEnv() {
  vi.stubEnv('PROMOPILOT_ATTRIBUTION_URL', URL_ENV)
  vi.stubEnv('PROMOPILOT_ATTRIBUTION_SECRET', SECRET_ENV)
}

function disableEnv() {
  vi.stubEnv('PROMOPILOT_ATTRIBUTION_URL', '')
  vi.stubEnv('PROMOPILOT_ATTRIBUTION_SECRET', '')
}

function okFetch() {
  return vi.fn(async () => ({ ok: true, status: 200 }))
}

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, created_at DATETIME);
    CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT);
    CREATE TABLE grants (id TEXT PRIMARY KEY, profile_id TEXT);
  `)
  return db
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('config gating', () => {
  it('missing env = disabled, and the no-op is logged exactly ONCE', () => {
    disableEnv()
    _resetPromoAttributionLogOnce()
    const logSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(getPromoAttributionConfig().enabled).toBe(false)
    expect(getPromoAttributionConfig().enabled).toBe(false)
    const attributionLogs = logSpy.mock.calls.filter((c) => String(c[0]).includes('[promoAttribution] disabled'))
    expect(attributionLogs.length).toBe(1)
  })

  it('disabled config makes sendPromoConversionEvent a no-op that never touches fetch', async () => {
    disableEnv()
    const fetchImpl = okFetch()
    const res = await sendPromoConversionEvent({ eventClass: 'signup', touchId: TOUCH, subjectId: 'u1', fetchImpl })
    expect(res).toEqual({ sent: false, reason: 'disabled' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('sendPromoConversionEvent', () => {
  it('posts the receiver-contract payload with the bearer secret', async () => {
    enableEnv()
    const fetchImpl = okFetch()
    const res = await sendPromoConversionEvent({
      eventClass: 'submitted',
      touchId: TOUCH,
      subjectId: 'grant-123',
      fetchImpl,
    })
    expect(res.sent).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchImpl.mock.calls[0]
    expect(url).toBe(URL_ENV)
    expect(opts.method).toBe('POST')
    expect(opts.headers.authorization).toBe(`Bearer ${SECRET_ENV}`)
    const body = JSON.parse(opts.body)
    // GrantFlow 'submitted' maps to the receiver's 'activation' vocabulary.
    expect(body.event_type).toBe('activation')
    expect(body.touch_id).toBe(TOUCH)
    // Subject ids are HASHED — the raw internal id never leaves GrantFlow.
    expect(body.event_key).toBe(`submitted:${hashAttributionSubject('grant-123')}`)
    expect(body.event_key).not.toContain('grant-123')
    expect(Date.parse(body.occurred_at)).not.toBeNaN()
    // Minimal payload: nothing but the four receiver fields.
    expect(Object.keys(body).sort()).toEqual(['event_key', 'event_type', 'occurred_at', 'touch_id'])
  })

  it("maps 'awarded' to 'activation' and 'signup' to 'signup'", async () => {
    enableEnv()
    const fetchImpl = okFetch()
    await sendPromoConversionEvent({ eventClass: 'awarded', touchId: TOUCH, subjectId: 'g', fetchImpl })
    await sendPromoConversionEvent({ eventClass: 'signup', touchId: TOUCH, subjectId: 'u', fetchImpl })
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).event_type).toBe('activation')
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).event_type).toBe('signup')
  })

  it('refuses an unknown event class and an invalid touch id without calling fetch', async () => {
    enableEnv()
    const fetchImpl = okFetch()
    expect(await sendPromoConversionEvent({ eventClass: 'purchase', touchId: TOUCH, fetchImpl })).toEqual({
      sent: false,
      reason: 'unsupported_event_class',
    })
    expect(await sendPromoConversionEvent({ eventClass: 'signup', touchId: 'short', fetchImpl })).toEqual({
      sent: false,
      reason: 'no_touch',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('NEVER throws when fetch rejects — resolves an error reason instead', async () => {
    enableEnv()
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('network down')
    })
    const res = await sendPromoConversionEvent({ eventClass: 'signup', touchId: TOUCH, fetchImpl })
    expect(res.sent).toBe(false)
    expect(res.reason).toMatch(/^error:/)
  })

  it('reports a non-2xx receiver answer honestly as not-sent', async () => {
    enableEnv()
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401 }))
    const res = await sendPromoConversionEvent({ eventClass: 'signup', touchId: TOUCH, fetchImpl })
    expect(res).toEqual({ sent: false, reason: 'http_401' })
  })

  it('aborts a hung receiver at the 2s timeout instead of hanging the caller', async () => {
    enableEnv()
    vi.useFakeTimers()
    const fetchImpl = vi.fn(
      (url, opts) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    const pending = sendPromoConversionEvent({ eventClass: 'signup', touchId: TOUCH, fetchImpl })
    await vi.advanceTimersByTimeAsync(2100)
    const res = await pending
    expect(res.sent).toBe(false)
    expect(res.reason).toMatch(/^error:/)
  })
})

describe('touch storage (system_kv, no migration)', () => {
  it('stores, reads back, and overwrites a touch; junk never validates', async () => {
    const db = makeDb()
    expect(await getPromoTouchForUser(db, 'u1')).toBe(null)
    expect(await storePromoTouchForUser(db, 'u1', TOUCH)).toBe(true)
    expect(await getPromoTouchForUser(db, 'u1')).toBe(TOUCH)
    const other = 'z9y8x7w6v5u4t3s2r1q0p9o8'
    expect(await storePromoTouchForUser(db, 'u1', other)).toBe(true)
    expect(await getPromoTouchForUser(db, 'u1')).toBe(other)
    // Invalid ids are refused at the boundary.
    expect(await storePromoTouchForUser(db, 'u1', 'nope')).toBe(false)
    expect(isValidPromoTouchId('nope')).toBe(false)
    expect(isValidPromoTouchId(TOUCH)).toBe(true)
  })

  it('a broken db never throws — reads resolve null, writes resolve false', async () => {
    const broken = { prepare() { throw new Error('boom') } }
    expect(await getPromoTouchForUser(broken, 'u1')).toBe(null)
    expect(await storePromoTouchForUser(broken, 'u1', TOUCH)).toBe(false)
  })
})

describe('parseDbTimestampMs', () => {
  it('pins zone-less SQLite timestamps to UTC (the brand-pulse trap)', () => {
    expect(parseDbTimestampMs('2026-08-16 03:00:00')).toBe(Date.parse('2026-08-16T03:00:00Z'))
    expect(parseDbTimestampMs(new Date(1700000000000))).toBe(1700000000000)
    expect(parseDbTimestampMs(null)).toBeNaN()
    expect(parseDbTimestampMs('')).toBeNaN()
    expect(parseDbTimestampMs('2026-08-16T03:00:00.000Z')).toBe(Date.parse('2026-08-16T03:00:00Z'))
  })
})

describe('claimPromoTouchForUser', () => {
  it('stores the touch and reports SIGNUP for a freshly-created user', async () => {
    enableEnv()
    const db = makeDb()
    const nowIso = new Date().toISOString().slice(0, 19).replace('T', ' ')
    db.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u-new', nowIso)
    const fetchSpy = okFetch()
    vi.stubGlobal('fetch', fetchSpy)
    const res = await claimPromoTouchForUser(db, { userId: 'u-new', touchId: TOUCH, awaitSend: true })
    expect(res.ok).toBe(true)
    expect(res.signupQueued).toBe(true)
    expect(res.signup.sent).toBe(true)
    expect(await getPromoTouchForUser(db, 'u-new')).toBe(TOUCH)
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.event_type).toBe('signup')
  })

  it('an OLD account clicking a promo link stores the touch but is NOT a signup', async () => {
    enableEnv()
    const db = makeDb()
    db.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u-old', '2020-01-01 00:00:00')
    const fetchSpy = okFetch()
    vi.stubGlobal('fetch', fetchSpy)
    const res = await claimPromoTouchForUser(db, { userId: 'u-old', touchId: TOUCH, awaitSend: true })
    expect(res.ok).toBe(true)
    expect(res.signupQueued).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
    // The touch IS stored — later submitted/awarded activations still attribute.
    expect(await getPromoTouchForUser(db, 'u-old')).toBe(TOUCH)
  })

  it('refuses an invalid touch id', async () => {
    const db = makeDb()
    expect(await claimPromoTouchForUser(db, { userId: 'u1', touchId: '<script>' })).toEqual({
      ok: false,
      reason: 'invalid',
    })
  })
})

describe('reportGrantConversion / reportUserConversion', () => {
  it('resolves grant → profile → user → touch and sends an activation', async () => {
    enableEnv()
    const db = makeDb()
    db.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u1', '2020-01-01 00:00:00')
    db.prepare('INSERT INTO profiles (id, user_id) VALUES (?, ?)').run('p1', 'u1')
    db.prepare('INSERT INTO grants (id, profile_id) VALUES (?, ?)').run('g1', 'p1')
    await storePromoTouchForUser(db, 'u1', TOUCH)
    const fetchSpy = okFetch()
    vi.stubGlobal('fetch', fetchSpy)
    const res = await reportGrantConversion(db, { grantId: 'g1', eventClass: 'awarded' })
    expect(res.sent).toBe(true)
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.event_type).toBe('activation')
    expect(body.touch_id).toBe(TOUCH)
    expect(body.event_key.startsWith('awarded:')).toBe(true)
  })

  it('every missing link is a SILENT no-op, never an error', async () => {
    enableEnv()
    const db = makeDb()
    const fetchSpy = okFetch()
    vi.stubGlobal('fetch', fetchSpy)
    // Unknown grant → no profile.
    expect((await reportGrantConversion(db, { grantId: 'nope', eventClass: 'submitted' })).reason).toBe('no_profile')
    // Profile with no owning user.
    db.prepare('INSERT INTO profiles (id, user_id) VALUES (?, ?)').run('p-orphan', null)
    db.prepare('INSERT INTO grants (id, profile_id) VALUES (?, ?)').run('g-orphan', 'p-orphan')
    expect((await reportGrantConversion(db, { grantId: 'g-orphan', eventClass: 'submitted' })).reason).toBe('no_user')
    // User with no stored touch (never arrived via a promoted link).
    db.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u2', '2020-01-01 00:00:00')
    db.prepare('INSERT INTO profiles (id, user_id) VALUES (?, ?)').run('p2', 'u2')
    db.prepare('INSERT INTO grants (id, profile_id) VALUES (?, ?)').run('g2', 'p2')
    expect((await reportGrantConversion(db, { grantId: 'g2', eventClass: 'submitted' })).reason).toBe('no_touch')
    expect(fetchSpy).not.toHaveBeenCalled()
    // A db that throws is still a resolved no-op, never a crash.
    const broken = { prepare() { throw new Error('boom') } }
    expect((await reportGrantConversion(broken, { grantId: 'g1', eventClass: 'submitted' })).sent).toBe(false)
    expect((await reportUserConversion(broken, { userId: 'u1', eventClass: 'signup' })).sent).toBe(false)
  })

  it('reportUserConversion resolves the stored touch directly', async () => {
    enableEnv()
    const db = makeDb()
    await storePromoTouchForUser(db, 'u9', TOUCH)
    const fetchSpy = okFetch()
    vi.stubGlobal('fetch', fetchSpy)
    const res = await reportUserConversion(db, { userId: 'u9', eventClass: 'signup' })
    expect(res.sent).toBe(true)
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).touch_id).toBe(TOUCH)
  })
})

describe('non-blocking discipline', () => {
  it('claim with awaitSend=false returns while the network send is still pending', async () => {
    enableEnv()
    const db = makeDb()
    const nowIso = new Date().toISOString().slice(0, 19).replace('T', ' ')
    db.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u-new', nowIso)
    let resolveFetch
    const hanging = new Promise((resolve) => {
      resolveFetch = resolve
    })
    vi.stubGlobal('fetch', vi.fn(() => hanging))
    const res = await claimPromoTouchForUser(db, { userId: 'u-new', touchId: TOUCH })
    // Resolved BEFORE the receiver ever answered.
    expect(res).toEqual({ ok: true, signupQueued: true })
    resolveFetch({ ok: true, status: 200 })
  })
})
