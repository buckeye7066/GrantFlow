import { describe, expect, it, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

import {
  CONSENT_STATUS,
  classifyConsentReply,
  setConsentStatus,
  getPhoneConsent,
  applyInboundReply,
  runConsentCampaign,
  getConsentStatusCounts,
  expirePendingConsent,
  requestConsentForProfile,
  consentMessageBody,
} from '../services/comms/smsConsentService.js'
import { addProfilePhone, setPhoneOptIn, _ensuredReset } from '../services/comms/commsService.js'

// ---------------------------------------------------------------------------
// SMS sending is mocked so tests never hit Twilio. We control isSmsConfigured
// per test via the mock's internal flag.
// ---------------------------------------------------------------------------
let smsConfigured = true
const sentMessages = []
vi.mock('../services/sms.js', async () => {
  // Re-use the real normalizePhone (pure) so number matching is realistic.
  const real = await vi.importActual('../services/sms.js')
  return {
    ...real,
    isSmsConfigured: () => smsConfigured,
    sendSms: vi.fn(async ({ to, body }) => {
      sentMessages.push({ to, body })
      return { ok: true, id: `SM${sentMessages.length}` }
    }),
  }
})

// Blocklist is stubbed so we can flip a number to suppressed in one test.
let suppressedPhones = new Set()
vi.mock('../services/blocklist/ownerBlocklistService.js', () => ({
  checkIdentity: async (_db, { phone }) => {
    const digits = String(phone || '').replace(/\D/g, '').slice(-10)
    return { blocked: suppressedPhones.has(digits), enforcement: null, matches: [] }
  },
}))

function makeDb() {
  const db = new Database(':memory:')
  // commsService.ensureCommsSchema creates profile_phones; we only need profiles
  // + profile_emails to exist for its other DDL/queries.
  db.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, display_name TEXT, status TEXT);
    CREATE TABLE profile_emails (id TEXT PRIMARY KEY, profile_id TEXT, email TEXT);
  `)
  return db
}

async function seedProfile(db, id, name = id) {
  db.prepare('INSERT INTO profiles (id, display_name, status) VALUES (?, ?, ?)').run(id, name, 'active')
}

beforeEach(() => {
  smsConfigured = true
  sentMessages.length = 0
  suppressedPhones = new Set()
  // commsService caches "_ensured" at module scope; reset it between in-memory DBs.
  if (typeof _ensuredReset === 'function') _ensuredReset()
})

// ---------------------------------------------------------------------------
// Reply parsing
// ---------------------------------------------------------------------------
describe('classifyConsentReply', () => {
  it('treats YES-family keywords as opt-in', () => {
    for (const w of ['YES', 'y', 'Yeah', 'ok', 'sure', 'START', 'subscribe', 'YES please']) {
      expect(classifyConsentReply(w)).toBe('opt_in')
    }
  })

  it('treats STOP-family keywords as opt-out', () => {
    for (const w of ['STOP', 'no', 'Unsubscribe', 'cancel', 'quit', 'END', 'stopall', 'STOP.']) {
      expect(classifyConsentReply(w)).toBe('opt_out')
    }
  })

  it('STOP wins even when other words surround it', () => {
    expect(classifyConsentReply('please STOP')).toBe('opt_out')
    expect(classifyConsentReply('STOP texting me')).toBe('opt_out')
  })

  it('returns unknown for a non-keyword reply', () => {
    expect(classifyConsentReply('what is this?')).toBe('unknown')
    expect(classifyConsentReply('')).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// State transitions + effective boolean
// ---------------------------------------------------------------------------
describe('consent state transitions', () => {
  it('none → pending → opted_in keeps sms_opt_in TRUE only when opted_in', async () => {
    const db = makeDb()
    await seedProfile(db, 'p1')
    // none (added without explicit consent)
    await addProfilePhone(db, { profileId: 'p1', phone: '931-314-0866', optIn: false })
    let row = await getPhoneConsent(db, { profileId: 'p1', phone: '9313140866' })
    expect(row.consent_status).toBe(CONSENT_STATUS.NONE)
    expect(Boolean(row.sms_opt_in)).toBe(false)

    // pending
    await setConsentStatus(db, { profileId: 'p1', phone: '9313140866', status: CONSENT_STATUS.PENDING })
    row = await getPhoneConsent(db, { profileId: 'p1', phone: '9313140866' })
    expect(row.consent_status).toBe(CONSENT_STATUS.PENDING)
    expect(Boolean(row.sms_opt_in)).toBe(false) // pending is OFF
    expect(row.consent_requested_at).toBeTruthy()

    // opted_in
    await setConsentStatus(db, { profileId: 'p1', phone: '9313140866', status: CONSENT_STATUS.OPTED_IN })
    row = await getPhoneConsent(db, { profileId: 'p1', phone: '9313140866' })
    expect(row.consent_status).toBe(CONSENT_STATUS.OPTED_IN)
    expect(Boolean(row.sms_opt_in)).toBe(true) // ON only here
  })

  it('opted_out sets sms_opt_in FALSE', async () => {
    const db = makeDb()
    await seedProfile(db, 'p1')
    await addProfilePhone(db, { profileId: 'p1', phone: '9313140866', optIn: true })
    expect(Boolean((await getPhoneConsent(db, { profileId: 'p1', phone: '9313140866' })).sms_opt_in)).toBe(true)
    await setConsentStatus(db, { profileId: 'p1', phone: '9313140866', status: CONSENT_STATUS.OPTED_OUT })
    const row = await getPhoneConsent(db, { profileId: 'p1', phone: '9313140866' })
    expect(row.consent_status).toBe(CONSENT_STATUS.OPTED_OUT)
    expect(Boolean(row.sms_opt_in)).toBe(false)
  })

  it('admin addProfilePhone with optIn:true is opted_in; optIn:false is none', async () => {
    const db = makeDb()
    await seedProfile(db, 'p1')
    await addProfilePhone(db, { profileId: 'p1', phone: '1111111111', optIn: true })
    await addProfilePhone(db, { profileId: 'p1', phone: '2222222222', optIn: false })
    expect((await getPhoneConsent(db, { profileId: 'p1', phone: '1111111111' })).consent_status).toBe('opted_in')
    expect((await getPhoneConsent(db, { profileId: 'p1', phone: '2222222222' })).consent_status).toBe('none')
  })

  it('setPhoneOptIn keeps consent_status in lockstep', async () => {
    const db = makeDb()
    await seedProfile(db, 'p1')
    await addProfilePhone(db, { profileId: 'p1', phone: '3333333333', optIn: false })
    await setPhoneOptIn(db, { profileId: 'p1', phone: '3333333333', optIn: true })
    expect((await getPhoneConsent(db, { profileId: 'p1', phone: '3333333333' })).consent_status).toBe('opted_in')
    await setPhoneOptIn(db, { profileId: 'p1', phone: '3333333333', optIn: false })
    expect((await getPhoneConsent(db, { profileId: 'p1', phone: '3333333333' })).consent_status).toBe('opted_out')
  })
})

// ---------------------------------------------------------------------------
// Inbound reply handling
// ---------------------------------------------------------------------------
describe('applyInboundReply', () => {
  it('YES opts in every matching profile_phones row', async () => {
    const db = makeDb()
    await seedProfile(db, 'p1'); await seedProfile(db, 'p2')
    await addProfilePhone(db, { profileId: 'p1', phone: '9313140866', optIn: false })
    await addProfilePhone(db, { profileId: 'p2', phone: '9313140866', optIn: false })
    const res = await applyInboundReply(db, { from: '+19313140866', body: 'YES' })
    expect(res.intent).toBe('opt_in')
    expect(res.matched).toBe(2)
    expect(res.updated).toBe(2)
    expect((await getPhoneConsent(db, { profileId: 'p1', phone: '9313140866' })).consent_status).toBe('opted_in')
    expect((await getPhoneConsent(db, { profileId: 'p2', phone: '9313140866' })).consent_status).toBe('opted_in')
  })

  it('STOP always opts out, even from an opted_in number', async () => {
    const db = makeDb()
    await seedProfile(db, 'p1')
    await addProfilePhone(db, { profileId: 'p1', phone: '9313140866', optIn: true })
    const res = await applyInboundReply(db, { from: '+1 (931) 314-0866', body: 'STOP' })
    expect(res.intent).toBe('opt_out')
    const row = await getPhoneConsent(db, { profileId: 'p1', phone: '9313140866' })
    expect(row.consent_status).toBe('opted_out')
    expect(Boolean(row.sms_opt_in)).toBe(false)
  })

  it('an unknown reply does NOT change state', async () => {
    const db = makeDb()
    await seedProfile(db, 'p1')
    await addProfilePhone(db, { profileId: 'p1', phone: '9313140866', optIn: false })
    await setConsentStatus(db, { profileId: 'p1', phone: '9313140866', status: CONSENT_STATUS.PENDING })
    const res = await applyInboundReply(db, { from: '+19313140866', body: 'huh?' })
    expect(res.intent).toBe('unknown')
    expect((await getPhoneConsent(db, { profileId: 'p1', phone: '9313140866' })).consent_status).toBe('pending')
  })
})

// ---------------------------------------------------------------------------
// Campaign: dry-run default, idempotency, blocklist suppression
// ---------------------------------------------------------------------------
describe('runConsentCampaign', () => {
  it('DEFAULTS to dry-run and sends nothing', async () => {
    const db = makeDb()
    await seedProfile(db, 'p1')
    await addProfilePhone(db, { profileId: 'p1', phone: '9313140866', optIn: false })
    const summary = await runConsentCampaign(db) // no confirm
    expect(summary.dry_run).toBe(true)
    expect(summary.sent).toBe(0)
    expect(summary.candidates).toBe(1)
    expect(sentMessages.length).toBe(0)
    // Still in `none` — dry-run does not mutate state.
    expect((await getPhoneConsent(db, { profileId: 'p1', phone: '9313140866' })).consent_status).toBe('none')
  })

  it('with confirm:true sends and moves none → pending', async () => {
    const db = makeDb()
    await seedProfile(db, 'p1')
    await addProfilePhone(db, { profileId: 'p1', phone: '9313140866', optIn: false })
    const summary = await runConsentCampaign(db, { confirm: true })
    expect(summary.dry_run).toBe(false)
    expect(summary.sent).toBe(1)
    expect(sentMessages.length).toBe(1)
    expect(sentMessages[0].body).toBe(consentMessageBody())
    expect((await getPhoneConsent(db, { profileId: 'p1', phone: '9313140866' })).consent_status).toBe('pending')
  })

  it('is idempotent — never re-asks a pending/opted_in/opted_out number', async () => {
    const db = makeDb()
    await seedProfile(db, 'p1')
    await addProfilePhone(db, { profileId: 'p1', phone: '1111111111', optIn: false }) // none
    await addProfilePhone(db, { profileId: 'p1', phone: '2222222222', optIn: true })  // opted_in
    await setConsentStatus(db, { profileId: 'p1', phone: '1111111111', status: CONSENT_STATUS.PENDING }) // pending
    const summary = await runConsentCampaign(db, { confirm: true })
    expect(summary.candidates).toBe(0) // nothing in `none`
    expect(summary.sent).toBe(0)
    expect(sentMessages.length).toBe(0)
  })

  it('never texts a blocklisted number', async () => {
    const db = makeDb()
    await seedProfile(db, 'p1')
    await addProfilePhone(db, { profileId: 'p1', phone: '9313140866', optIn: false })
    suppressedPhones.add('9313140866')
    const summary = await runConsentCampaign(db, { confirm: true })
    expect(summary.suppressed).toBe(1)
    expect(summary.sent).toBe(0)
    expect(sentMessages.length).toBe(0)
    // Stays `none` (never asked) — not flipped to pending.
    expect((await getPhoneConsent(db, { profileId: 'p1', phone: '9313140866' })).consent_status).toBe('none')
  })

  it('when SMS not configured, confirm send leaves numbers in none (not pending)', async () => {
    smsConfigured = false
    const db = makeDb()
    await seedProfile(db, 'p1')
    await addProfilePhone(db, { profileId: 'p1', phone: '9313140866', optIn: false })
    const summary = await runConsentCampaign(db, { confirm: true })
    expect(summary.sent).toBe(0)
    expect((await getPhoneConsent(db, { profileId: 'p1', phone: '9313140866' })).consent_status).toBe('none')
  })
})

// ---------------------------------------------------------------------------
// Status counts + expiry + new-profile enqueue
// ---------------------------------------------------------------------------
describe('getConsentStatusCounts', () => {
  it('tallies each consent state', async () => {
    const db = makeDb()
    await seedProfile(db, 'p1')
    await addProfilePhone(db, { profileId: 'p1', phone: '1111111111', optIn: false }) // none
    await addProfilePhone(db, { profileId: 'p1', phone: '2222222222', optIn: true })  // opted_in
    await setConsentStatus(db, { profileId: 'p1', phone: '1111111111', status: CONSENT_STATUS.PENDING })
    const counts = await getConsentStatusCounts(db)
    expect(counts.pending).toBe(1)
    expect(counts.opted_in).toBe(1)
    expect(counts.total).toBe(2)
  })
})

describe('expirePendingConsent', () => {
  it('turns stale pending into opted_out (stays OFF)', async () => {
    const db = makeDb()
    await seedProfile(db, 'p1')
    await addProfilePhone(db, { profileId: 'p1', phone: '9313140866', optIn: false })
    // Force an old consent_requested_at.
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    db.prepare(`UPDATE profile_phones SET consent_status='pending', consent_requested_at=? WHERE phone=?`).run(old, '+19313140866')
    const res = await expirePendingConsent(db, { days: 14 })
    expect(res.expired).toBe(1)
    const row = await getPhoneConsent(db, { profileId: 'p1', phone: '9313140866' })
    expect(row.consent_status).toBe('opted_out')
    expect(Boolean(row.sms_opt_in)).toBe(false)
  })

  it('does NOT expire a recent pending', async () => {
    const db = makeDb()
    await seedProfile(db, 'p1')
    await addProfilePhone(db, { profileId: 'p1', phone: '9313140866', optIn: false })
    await setConsentStatus(db, { profileId: 'p1', phone: '9313140866', status: CONSENT_STATUS.PENDING })
    const res = await expirePendingConsent(db, { days: 14 })
    expect(res.expired).toBe(0)
    expect((await getPhoneConsent(db, { profileId: 'p1', phone: '9313140866' })).consent_status).toBe('pending')
  })
})

describe('requestConsentForProfile (new-profile enqueue)', () => {
  it('sends the consent ask for a none-state phone when configured', async () => {
    const db = makeDb()
    await seedProfile(db, 'p1')
    await addProfilePhone(db, { profileId: 'p1', phone: '9313140866', optIn: false })
    const res = await requestConsentForProfile(db, { profileId: 'p1' })
    expect(res.asked).toBe(1)
    expect(sentMessages.length).toBe(1)
    expect((await getPhoneConsent(db, { profileId: 'p1', phone: '9313140866' })).consent_status).toBe('pending')
  })

  it('leaves the number in none (no send) when SMS not configured', async () => {
    smsConfigured = false
    const db = makeDb()
    await seedProfile(db, 'p1')
    await addProfilePhone(db, { profileId: 'p1', phone: '9313140866', optIn: false })
    const res = await requestConsentForProfile(db, { profileId: 'p1' })
    expect(res.asked).toBe(0)
    expect((await getPhoneConsent(db, { profileId: 'p1', phone: '9313140866' })).consent_status).toBe('none')
  })

  it('does not re-ask an already opted_in number', async () => {
    const db = makeDb()
    await seedProfile(db, 'p1')
    await addProfilePhone(db, { profileId: 'p1', phone: '9313140866', optIn: true })
    const res = await requestConsentForProfile(db, { profileId: 'p1' })
    expect(res.asked).toBe(0)
    expect(sentMessages.length).toBe(0)
  })
})
