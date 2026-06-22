/**
 * commsLanguage.test.js — outbound comms are language-aware.
 *
 * Covers the owner requirement: text messages + emails to existing profiles
 * render in the recipient profile's stored language (profile_sections /
 * language_preferences), defaulting to English when unknown.
 *
 *   - consent SMS + opt-in confirmation render in es and zh,
 *   - a notification email renders in es and zh,
 *   - an unknown/unset language falls back to en,
 *   - a per-recipient broadcast picks each recipient's own language.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

// SMS + email are mocked so tests never hit Twilio/Resend; we capture sends.
let smsConfigured = true
const sentSms = []
const sentEmail = []
vi.mock('../services/sms.js', async () => {
  const real = await vi.importActual('../services/sms.js')
  return {
    ...real,
    isSmsConfigured: () => smsConfigured,
    sendSms: vi.fn(async ({ to, body }) => { sentSms.push({ to, body }); return { ok: true, id: `SM${sentSms.length}` } }),
  }
})
vi.mock('../services/email.js', () => ({
  sendEmail: vi.fn(async ({ to, subject, text, html }) => { sentEmail.push({ to, subject, text, html }); return { ok: true } }),
}))
vi.mock('../services/blocklist/ownerBlocklistService.js', () => ({
  checkIdentity: async () => ({ blocked: false, enforcement: null, matches: [] }),
}))

import {
  consentMessageBody,
  optInConfirmationBody,
  optOutConfirmationBody,
  unknownReplyBody,
  applyInboundReply,
  runConsentCampaign,
} from '../services/comms/smsConsentService.js'
import {
  addProfilePhone,
  notifyProfile,
  sendBroadcast,
  _ensuredReset,
} from '../services/comms/commsService.js'
import { getProfileLanguage } from '../services/comms/profileLanguage.js'
import { t } from '../services/comms/commsMessages.js'

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, display_name TEXT, status TEXT, user_id TEXT);
    CREATE TABLE profile_emails (id TEXT PRIMARY KEY, profile_id TEXT, email TEXT);
    CREATE TABLE profile_sections (
      profile_id TEXT, section_key TEXT, data TEXT, updated_by TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (profile_id, section_key)
    );
  `)
  return db
}

async function seedProfile(db, id, { name = id, lang = null, email = null } = {}) {
  db.prepare('INSERT INTO profiles (id, display_name, status) VALUES (?, ?, ?)').run(id, name, 'active')
  if (lang) {
    db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
      .run(id, 'language_preferences', JSON.stringify({ preferred_language: lang }))
  }
  if (email) {
    db.prepare('INSERT INTO profile_emails (id, profile_id, email) VALUES (?, ?, ?)').run(`${id}-e`, id, email)
  }
}

beforeEach(() => {
  smsConfigured = true
  sentSms.length = 0
  sentEmail.length = 0
  if (typeof _ensuredReset === 'function') _ensuredReset()
})

// ---------------------------------------------------------------------------
// getProfileLanguage — the source of truth read.
// ---------------------------------------------------------------------------
describe('getProfileLanguage', () => {
  it('reads the stored language_preferences section', async () => {
    const db = makeDb()
    await seedProfile(db, 'p_es', { lang: 'es' })
    await seedProfile(db, 'p_zh', { lang: 'zh' })
    expect(await getProfileLanguage(db, 'p_es')).toBe('es')
    expect(await getProfileLanguage(db, 'p_zh')).toBe('zh')
  })

  it('defaults to en when no preference / unknown profile / unsupported code', async () => {
    const db = makeDb()
    await seedProfile(db, 'p_none') // no section row
    await seedProfile(db, 'p_bad', { lang: 'xx' }) // normalizeLanguageCode -> en
    expect(await getProfileLanguage(db, 'p_none')).toBe('en')
    expect(await getProfileLanguage(db, 'p_bad')).toBe('en')
    expect(await getProfileLanguage(db, 'does-not-exist')).toBe('en')
  })
})

// ---------------------------------------------------------------------------
// Consent SMS + confirmations render in the recipient's language.
// ---------------------------------------------------------------------------
describe('localized SMS copy', () => {
  it('consent + confirmation bodies differ by language and match the catalog', () => {
    expect(consentMessageBody('es')).toBe(t('es', 'sms_consent_request'))
    expect(consentMessageBody('zh')).toBe(t('zh', 'sms_consent_request'))
    expect(consentMessageBody('es')).not.toBe(consentMessageBody('en'))
    // STOP keyword survives verbatim in every language (carrier keyword).
    expect(consentMessageBody('es')).toContain('STOP')
    expect(consentMessageBody('zh')).toContain('STOP')
    expect(optInConfirmationBody('es')).toBe(t('es', 'sms_opt_in_confirm'))
    expect(optOutConfirmationBody('zh')).toBe(t('zh', 'sms_opt_out_confirm'))
  })

  it('defaults to English for an unknown language', () => {
    expect(consentMessageBody('xx')).toBe(consentMessageBody('en'))
    expect(consentMessageBody()).toBe(consentMessageBody('en'))
    expect(unknownReplyBody('xx')).toBe(unknownReplyBody('en'))
  })

  it('consent campaign renders each candidate in THAT profile language', async () => {
    const db = makeDb()
    await seedProfile(db, 'p_es', { lang: 'es' })
    await seedProfile(db, 'p_en') // no language -> en
    await addProfilePhone(db, { profileId: 'p_es', phone: '1111111111', optIn: false })
    await addProfilePhone(db, { profileId: 'p_en', phone: '2222222222', optIn: false })
    const summary = await runConsentCampaign(db, { confirm: true })
    expect(summary.sent).toBe(2)
    const esMsg = sentSms.find((m) => m.to.endsWith('1111111111'))
    const enMsg = sentSms.find((m) => m.to.endsWith('2222222222'))
    expect(esMsg.body).toBe(consentMessageBody('es'))
    expect(enMsg.body).toBe(consentMessageBody('en'))
    expect(esMsg.body).not.toBe(enMsg.body)
  })

  it('inbound opt-in confirmation is rendered in the matched profile language', async () => {
    const db = makeDb()
    await seedProfile(db, 'p_zh', { lang: 'zh' })
    await addProfilePhone(db, { profileId: 'p_zh', phone: '9313140866', optIn: false })
    const res = await applyInboundReply(db, { from: '+19313140866', body: 'YES' })
    expect(res.intent).toBe('opt_in')
    expect(res.lang).toBe('zh')
    expect(optInConfirmationBody(res.lang)).toBe(t('zh', 'sms_opt_in_confirm'))
  })

  it('inbound reply for an unknown number falls back to en', async () => {
    const db = makeDb()
    const res = await applyInboundReply(db, { from: '+15550001111', body: 'STOP' })
    expect(res.lang).toBe('en')
  })
})

// ---------------------------------------------------------------------------
// notifyProfile email renders standard (catalog) copy in the profile language.
// ---------------------------------------------------------------------------
describe('localized notification email (notifyProfile)', () => {
  it('renders a catalog-backed email subject + body in es', async () => {
    const db = makeDb()
    await seedProfile(db, 'p_es', { lang: 'es', email: 'es@example.com' })
    const res = await notifyProfile(db, {
      profileId: 'p_es',
      channel: 'email',
      messageKey: 'deadline_email_body_review',
      subjectKey: 'deadline_email_subject',
      vars: { dayLabel: t('es', 'day_tomorrow'), grantTitle: 'Beca X', deadline: '2026-07-01' },
    })
    expect(res.lang).toBe('es')
    expect(sentEmail).toHaveLength(1)
    expect(sentEmail[0].subject).toBe(t('es', 'deadline_email_subject', { dayLabel: t('es', 'day_tomorrow'), grantTitle: 'Beca X', deadline: '2026-07-01' }))
    expect(sentEmail[0].text).toBe(t('es', 'deadline_email_body_review'))
  })

  it('renders a catalog-backed email in zh', async () => {
    const db = makeDb()
    await seedProfile(db, 'p_zh', { lang: 'zh', email: 'zh@example.com' })
    const res = await notifyProfile(db, {
      profileId: 'p_zh',
      channel: 'email',
      messageKey: 'deadline_email_body_review',
      subjectKey: 'deadline_email_heading',
    })
    expect(res.lang).toBe('zh')
    expect(sentEmail[0].text).toBe(t('zh', 'deadline_email_body_review'))
  })

  it('falls back to en for a profile with no stored language', async () => {
    const db = makeDb()
    await seedProfile(db, 'p_en', { email: 'en@example.com' })
    const res = await notifyProfile(db, {
      profileId: 'p_en',
      channel: 'email',
      messageKey: 'deadline_email_body_review',
      subjectKey: 'deadline_email_heading',
    })
    expect(res.lang).toBe('en')
    expect(sentEmail[0].text).toBe(t('en', 'deadline_email_body_review'))
  })
})

// ---------------------------------------------------------------------------
// Broadcast: PER-RECIPIENT localization (each recipient's own language).
// ---------------------------------------------------------------------------
describe('per-recipient broadcast localization', () => {
  it('catalog-backed broadcast renders each recipient in their own language', async () => {
    const db = makeDb()
    await seedProfile(db, 'p_es', { lang: 'es', email: 'es@example.com' })
    await seedProfile(db, 'p_zh', { lang: 'zh', email: 'zh@example.com' })
    await seedProfile(db, 'p_en', { email: 'en@example.com' }) // unknown -> en

    const result = await sendBroadcast(db, {
      profileIds: ['p_es', 'p_zh', 'p_en'],
      channel: 'email',
      messageKey: 'deadline_email_body_review',
      subjectKey: 'deadline_email_heading',
      kind: 'standard_notice',
    })
    expect(result.ok).toBe(true)
    expect(sentEmail).toHaveLength(3)

    const byTo = Object.fromEntries(sentEmail.map((m) => [m.to, m]))
    expect(byTo['es@example.com'].text).toBe(t('es', 'deadline_email_body_review'))
    expect(byTo['zh@example.com'].text).toBe(t('zh', 'deadline_email_body_review'))
    expect(byTo['en@example.com'].text).toBe(t('en', 'deadline_email_body_review'))
    // Each language is distinct (per-recipient, not one global language).
    expect(byTo['es@example.com'].text).not.toBe(byTo['zh@example.com'].text)
    expect(byTo['es@example.com'].text).not.toBe(byTo['en@example.com'].text)
  })

  it('free-form broadcast still sends the owner copy as typed (no machine translation)', async () => {
    const db = makeDb()
    await seedProfile(db, 'p_es', { lang: 'es', email: 'es@example.com' })
    const result = await sendBroadcast(db, {
      profileIds: ['p_es'],
      channel: 'email',
      subject: 'A sale!',
      body: 'Owner typed this.',
    })
    expect(result.ok).toBe(true)
    expect(sentEmail[0].subject).toBe('A sale!')
    expect(sentEmail[0].text).toBe('Owner typed this.')
  })
})
