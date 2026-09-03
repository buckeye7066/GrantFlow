/**
 * commsService.js — the shared "talk to a profile" layer.
 *
 * One place that knows how to reach a profile (its emails + SMS phone), so that
 * every outbound owner-initiated message uses the same resolution + audit:
 *   - the admin Broadcast screen (promotions / changes / sales),
 *   - free-period announcements ("your free week started"),
 *   - the profile "Email us" contact form (inbound to the owner alias).
 *
 * Email goes out via Resend (backend/services/email.js); SMS via Twilio
 * (backend/services/sms.js). Owner-initiated email is sent FROM the configured
 * broadcast alias (default Annie@axiombiolabs.org) so recipients see the
 * human alias rather than the transactional FROM_EMAIL.
 *
 * Contact model:
 *   - profile_emails (existing): the multi-email allowlist. We add an `is_proxy`
 *     flag — an email that belongs to SOMEONE ELSE (e.g. a relative who manages
 *     the account). Proxy emails are NOT a "usable own email", so the auto
 *     channel routes such profiles to SMS instead.
 *   - profile_phones (new): SMS-capable numbers per profile.
 *   - Fallbacks: users.primary_email (profile owner) and
 *     basic_information.{email,phone,cell,sms_phone}.
 */

import crypto from 'crypto'
import { isAdminEmail } from '../../config/constants.js'
import { sendEmail } from '../email.js'
import { sendSms, normalizePhone } from '../sms.js'
import { getProfileLanguage } from './profileLanguage.js'
import { t } from './commsMessages.js'
import { createLogger } from '../../utils/logger.js'
import { isValidEmail } from '../../utils/validation.js'

const log = createLogger('comms')

/** The human alias owner-initiated email is sent from. */
export function broadcastFromEmail() {
  return (process.env.BROADCAST_FROM_EMAIL || 'Annie@axiombiolabs.org').trim()
}

/** The owner alias inbound "Email us" messages are delivered to. Independent
 *  of broadcastFromEmail() — that alias is not a provisioned mailbox, so
 *  inbound replies must keep landing at the real dr.johnwhite mailbox unless
 *  explicitly overridden. */
export function ownerAliasEmail() {
  return (process.env.OWNER_ALIAS_EMAIL || 'dr.johnwhite@axiombiolabs.org').trim()
}

let _ensured = false
/** Test-only: reset the once-per-process schema guard so a fresh in-memory DB
 *  re-runs ensureCommsSchema. No-op effect in production (called only by tests). */
export function _ensuredReset() { _ensured = false }
export async function ensureCommsSchema(db) {
  if (!db || _ensured) return
  const isPg = db?.dialect === 'postgres'
  const ts = isPg ? 'TIMESTAMPTZ' : 'TIMESTAMP'
  const nowDefault = isPg ? 'now()' : 'CURRENT_TIMESTAMP'

  // profile_phones — SMS-capable numbers, mirror of profile_emails.
  if (isPg) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS profile_phones (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        phone TEXT NOT NULL,
        label TEXT,
        sms_opt_in BOOLEAN DEFAULT TRUE,
        added_by TEXT,
        created_at ${ts} DEFAULT ${nowDefault}
      );
      CREATE INDEX IF NOT EXISTS idx_profile_phones_profile ON profile_phones(profile_id);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_profile_phones_profile_phone ON profile_phones(profile_id, phone);
    `)
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS profile_phones (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        phone TEXT NOT NULL,
        label TEXT,
        sms_opt_in BOOLEAN DEFAULT 1,
        added_by TEXT,
        created_at ${ts} DEFAULT ${nowDefault}
      );
      CREATE INDEX IF NOT EXISTS idx_profile_phones_profile ON profile_phones(profile_id);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_profile_phones_profile_phone ON profile_phones(profile_id, phone);
    `)
  }

  // is_proxy on profile_emails — additive; the column may already exist.
  try {
    await db.exec(`ALTER TABLE profile_emails ADD COLUMN is_proxy ${isPg ? 'BOOLEAN DEFAULT FALSE' : 'BOOLEAN DEFAULT 0'}`)
  } catch { /* exists */ }

  // SMS consent lifecycle columns on profile_phones (smsConsentService.js owns
  // the state machine): consent_status (none|pending|opted_in|opted_out) +
  // consent_requested_at. Additive — tolerated if already present. Default is
  // 'none' (no consent asked), the TCPA-safe OFF state.
  if (isPg) {
    try { await db.exec(`ALTER TABLE profile_phones ADD COLUMN IF NOT EXISTS consent_status TEXT DEFAULT 'none'`) } catch { /* exists */ }
    try { await db.exec(`ALTER TABLE profile_phones ADD COLUMN IF NOT EXISTS consent_requested_at ${ts}`) } catch { /* exists */ }
  } else {
    try { await db.exec(`ALTER TABLE profile_phones ADD COLUMN consent_status TEXT DEFAULT 'none'`) } catch { /* exists */ }
    try { await db.exec(`ALTER TABLE profile_phones ADD COLUMN consent_requested_at ${ts}`) } catch { /* exists */ }
  }
  // Backfill: any row that was EXPLICITLY admin-opted-in before consent tracking
  // existed (sms_opt_in true, status NULL) is treated as opted_in. Everything
  // else with a NULL/empty status becomes 'none' (safe — stays OFF until asked).
  try {
    await db.exec(`UPDATE profile_phones SET consent_status = 'opted_in' WHERE (consent_status IS NULL OR consent_status = '') AND (sms_opt_in = ${isPg ? 'TRUE' : '1'})`)
  } catch { /* best-effort */ }
  try {
    await db.exec(`UPDATE profile_phones SET consent_status = 'none' WHERE consent_status IS NULL OR consent_status = ''`)
  } catch { /* best-effort */ }

  // Audit: one row per broadcast send + one per recipient.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS comms_broadcasts (
      id TEXT PRIMARY KEY,
      created_at ${ts} DEFAULT ${nowDefault},
      sent_by TEXT,
      kind TEXT,
      channel TEXT,
      subject TEXT,
      body TEXT,
      profile_count INTEGER DEFAULT 0,
      sent_email INTEGER DEFAULT 0,
      sent_sms INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS comms_broadcast_recipients (
      id TEXT PRIMARY KEY,
      broadcast_id TEXT,
      profile_id TEXT,
      channel TEXT,
      target TEXT,
      status TEXT,
      error TEXT,
      created_at ${ts} DEFAULT ${nowDefault}
    );
    CREATE INDEX IF NOT EXISTS idx_comms_recipients_broadcast ON comms_broadcast_recipients(broadcast_id);
  `)
  _ensured = true
}

function parseSection(raw) {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try { return JSON.parse(raw) } catch { return {} }
}

function maskEmail(e) {
  const s = String(e || '')
  const [u, d] = s.split('@')
  if (!d) return s
  return `${u.slice(0, 2)}***@${d}`
}

/**
 * Reserved/placeholder domains (RFC 2606 / RFC 6761) that can never receive
 * mail: example.com/.org/.net, and the example/test/invalid/localhost TLDs.
 * Matched on the domain's TERMINAL labels only, so a real address like
 * jane@example-foundation.org is untouched.
 *
 * WHY (prod 2026-07-21): profiles seeded with `someone@example.com`
 * placeholder emails flowed into the Hamilton weekly digest, Resend rejected
 * the recipient, and each one surfaced as a SEND ERROR every week. A
 * placeholder is structurally "no email on file" — the honest outcome is
 * `skipped_no_email` (visible, actionable: collect a real address), not a
 * recurring delivery error. Enforced here at the single contact-resolution
 * choke point so every comms consumer (digest, portal reminders, broadcast)
 * inherits the rule; prod DATA is untouched.
 */
const RE_PLACEHOLDER_EMAIL_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net)|example|test|invalid|localhost)$/i

/** True when the address's domain is a reserved placeholder (undeliverable by design). Exported for tests. */
export function isPlaceholderEmail(email) {
  const s = String(email || '').trim()
  const at = s.lastIndexOf('@')
  if (at < 0) return false // malformed, but not this guard's claim to make
  const domain = s.slice(at + 1).trim().toLowerCase()
  if (!domain) return false
  return RE_PLACEHOLDER_EMAIL_DOMAIN.test(domain)
}
function maskPhone(p) {
  const s = String(p || '')
  return s.length > 4 ? `***${s.slice(-4)}` : s
}

/**
 * Resolve everything we know about how to reach a profile. Pure read.
 * Returns { profile_id, display_name, emails:[{email,is_proxy,source}],
 *           phones:[{phone,label,source}], primary_email, has_usable_email,
 *           sms_phone }.
 * has_usable_email = at least one non-proxy email.
 */
export async function resolveProfileContacts(db, profileId) {
  await ensureCommsSchema(db)
  const id = String(profileId)
  const out = { profile_id: id, display_name: null, emails: [], phones: [], primary_email: null, has_usable_email: false, sms_phone: null }

  const seenEmail = new Set()
  const addEmail = (email, { is_proxy = false, source } = {}) => {
    const e = String(email || '').trim()
    if (!e || seenEmail.has(e.toLowerCase())) return
    // Reject malformed addresses at the shared contact-resolution boundary.
    // Otherwise one bad profile field makes an entire multi-recipient Outlook
    // draft fail and Hamilton reports the same opaque draft error every week.
    if (!isValidEmail(e)) return
    // The operator (admin) is never a recipient of profile-directed mail. Admin
    // owns/created most profiles, so users.primary_email resolves to the admin
    // address on nearly every profile — without this guard the weekly digest /
    // portal reminders CC the operator alongside the real profile owner.
    if (isAdminEmail(e)) return
    // Non-routable RFC-6761 .invalid addresses (e.g. Amy synthetic profiles'
    // amy+<scenario>@synthetic.grantflow.invalid) must never be emailed.
    if (/\.invalid$/i.test(e)) return
    // Reserved placeholder domains (example.com/.org/.net, test, invalid,
    // localhost) are undeliverable by design: Resend rejects them, and each
    // one turned into a recurring weekly-digest SEND ERROR. Treat them as "no
    // email on file" so consumers report an honest skipped_no_email instead.
    if (isPlaceholderEmail(e)) return
    seenEmail.add(e.toLowerCase())
    out.emails.push({ email: e, is_proxy: Boolean(is_proxy), source })
  }
  const seenPhone = new Set()
  // opt_in defaults to FALSE for numbers we have no recorded consent for (e.g.
  // a phone typed into a profile section). SMS is only ever sent to numbers a
  // user/admin has explicitly opted in — this is both the user's choice and the
  // legally-safe default (TCPA: promotional SMS requires prior express consent).
  const addPhone = (phone, { label = null, source, opt_in = false } = {}) => {
    const p = normalizePhone(phone)
    if (!p || seenPhone.has(p)) return
    seenPhone.add(p)
    out.phones.push({ phone: p, label, source, opt_in: Boolean(opt_in) })
  }

  try {
    const profile = await db.prepare('SELECT display_name, user_id FROM profiles WHERE id = ? LIMIT 1').get(id)
    out.display_name = profile?.display_name || null
    if (profile?.user_id) {
      const u = await db.prepare('SELECT primary_email FROM users WHERE id = ? LIMIT 1').get(profile.user_id)
      if (u?.primary_email) addEmail(u.primary_email, { source: 'owner_user' })
    }
  } catch { /* best-effort */ }

  // profile_emails allowlist (with is_proxy when present).
  try {
    const rows = await db.prepare('SELECT email, is_proxy FROM profile_emails WHERE profile_id = ?').all(id)
    for (const r of rows || []) addEmail(r.email, { is_proxy: r.is_proxy, source: 'profile_emails' })
  } catch {
    try {
      const rows = await db.prepare('SELECT email FROM profile_emails WHERE profile_id = ?').all(id)
      for (const r of rows || []) addEmail(r.email, { source: 'profile_emails' })
    } catch { /* table may not exist */ }
  }

  // basic_information section fallbacks (email + phone-ish fields).
  try {
    const sec = await db.prepare(`SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = 'basic_information' LIMIT 1`).get(id)
    const d = parseSection(sec?.data)
    if (d?.email) addEmail(d.email, { source: 'basic_information' })
    for (const f of ['sms_phone', 'cell', 'cell_phone', 'mobile', 'phone']) {
      if (d?.[f]) addPhone(d[f], { label: f, source: 'basic_information' })
    }
  } catch { /* none */ }

  // profile_phones (canonical SMS numbers — carry their own opt-in state).
  try {
    const rows = await db.prepare('SELECT phone, label, sms_opt_in FROM profile_phones WHERE profile_id = ?').all(id)
    for (const r of rows || []) addPhone(r.phone, { label: r.label, source: 'profile_phones', opt_in: r.sms_opt_in === true || r.sms_opt_in === 1 })
  } catch { /* table may not exist */ }

  out.has_usable_email = out.emails.some((e) => !e.is_proxy)
  out.primary_email = out.emails.find((e) => !e.is_proxy)?.email || out.emails[0]?.email || null
  // Only an OPTED-IN phone counts as an SMS target.
  out.sms_phone = out.phones.find((p) => p.opt_in)?.phone || null
  out.sms_opt_in = Boolean(out.sms_phone)
  return out
}

/** List contacts for every (non-deleted) profile — powers the broadcast screen. */
export async function listProfileContacts(db) {
  await ensureCommsSchema(db)
  let profiles = []
  try {
    profiles = await db.prepare(`SELECT id FROM profiles WHERE status IS NULL OR status NOT IN ('deleted') ORDER BY display_name`).all()
  } catch {
    try { profiles = await db.prepare('SELECT id FROM profiles').all() } catch { profiles = [] }
  }
  const result = []
  for (const p of profiles || []) {
    try { result.push(await resolveProfileContacts(db, p.id)) } catch { /* skip one */ }
  }
  return result
}

/**
 * Add (or re-opt-in) an SMS phone for a profile. opt_in defaults to true.
 *
 * consent_status is derived from optIn so the consent state machine stays in
 * lockstep: an explicit opt-in (admin captured verbal consent, or the user's own
 * choice) is 'opted_in'; otherwise the number lands in 'none' so the consent
 * campaign will ask "is it ok?" before any text is sent (TCPA-safe). Callers that
 * want to force the asked state can pass consentStatus explicitly.
 */
export async function addProfilePhone(db, { profileId, phone, label = null, optIn = true, addedBy = 'admin', consentStatus = null } = {}) {
  await ensureCommsSchema(db)
  const normalized = normalizePhone(phone)
  if (!normalized) return { ok: false, error: 'invalid_phone' }
  const status = consentStatus || (optIn ? 'opted_in' : 'none')
  const effectiveOptIn = status === 'opted_in'
  const optVal = db?.dialect === 'postgres' ? Boolean(effectiveOptIn) : (effectiveOptIn ? 1 : 0)
  try {
    if (db?.dialect === 'postgres') {
      await db.prepare(
        `INSERT INTO profile_phones (id, profile_id, phone, label, sms_opt_in, consent_status, added_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (profile_id, phone) DO UPDATE SET label = EXCLUDED.label, sms_opt_in = EXCLUDED.sms_opt_in, consent_status = EXCLUDED.consent_status`,
      ).run(crypto.randomUUID(), String(profileId), normalized, label, optVal, status, addedBy)
    } else {
      await db.prepare(
        `INSERT INTO profile_phones (id, profile_id, phone, label, sms_opt_in, consent_status, added_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (profile_id, phone) DO UPDATE SET label = excluded.label, sms_opt_in = excluded.sms_opt_in, consent_status = excluded.consent_status`,
      ).run(crypto.randomUUID(), String(profileId), normalized, label, optVal, status, addedBy)
    }
  } catch (err) {
    return { ok: false, error: err?.message || 'insert_failed' }
  }
  return { ok: true, profile_id: String(profileId), phone: normalized, opt_in: effectiveOptIn, consent_status: status }
}

/**
 * Set the SMS opt-in flag for a profile's phone (the user's own explicit choice).
 * Keeps consent_status in lockstep: opting in is explicit consent (opted_in),
 * opting out is an explicit withdrawal (opted_out).
 */
export async function setPhoneOptIn(db, { profileId, phone, optIn } = {}) {
  await ensureCommsSchema(db)
  const normalized = normalizePhone(phone)
  if (!normalized) return { ok: false, error: 'invalid_phone' }
  const optVal = db?.dialect === 'postgres' ? Boolean(optIn) : (optIn ? 1 : 0)
  const status = optIn ? 'opted_in' : 'opted_out'
  const res = await db.prepare('UPDATE profile_phones SET sms_opt_in = ?, consent_status = ? WHERE profile_id = ? AND phone = ?')
    .run(optVal, status, String(profileId), normalized)
  // If the phone wasn't recorded yet but the user is opting in, create it.
  if ((res?.changes ?? 0) === 0 && optIn) {
    return addProfilePhone(db, { profileId, phone: normalized, optIn: true, addedBy: 'user', consentStatus: 'opted_in' })
  }
  return { ok: true, profile_id: String(profileId), phone: normalized, opt_in: Boolean(optIn), consent_status: status }
}

export async function removeProfilePhone(db, { profileId, phone } = {}) {
  await ensureCommsSchema(db)
  const normalized = normalizePhone(phone)
  if (!normalized) return { ok: false, error: 'invalid_phone' }
  await db.prepare('DELETE FROM profile_phones WHERE profile_id = ? AND phone = ?').run(String(profileId), normalized)
  return { ok: true }
}

/** Flag (or unflag) a profile_emails address as a proxy (belongs to someone else). */
export async function setEmailProxy(db, { profileId, email, isProxy } = {}) {
  await ensureCommsSchema(db)
  const proxyVal = db?.dialect === 'postgres' ? Boolean(isProxy) : (isProxy ? 1 : 0)
  await db.prepare('UPDATE profile_emails SET is_proxy = ? WHERE profile_id = ? AND lower(email) = lower(?)')
    .run(proxyVal, String(profileId), String(email))
  return { ok: true }
}

/**
 * Decide the channel for one profile under an `auto` policy:
 *   usable (non-proxy) email -> 'email'; else a phone -> 'sms'; else 'none'.
 */
function autoChannel(contacts) {
  if (contacts.has_usable_email) return 'email'
  if (contacts.sms_phone) return 'sms'
  return 'none'
}

/**
 * Send one message to one profile. `channel` is 'email' | 'sms' | 'auto'.
 * Email is sent to ALL usable emails (or all emails if none are usable and the
 * caller forced email). Returns { channelsUsed, results, lang }.
 *
 * Language-aware: the recipient profile's preferred language (getProfileLanguage,
 * default 'en') is resolved and exposed as `lang`. Callers that send STANDARD
 * (catalog-backed) copy pass `messageKey` (+ optional `subjectKey` and `vars`):
 * the subject/body are then rendered from commsMessages in the recipient's
 * language. Callers that send FREE-FORM owner copy (e.g. an admin broadcast the
 * owner typed in one language) pass `subject`/`text` directly — those are sent
 * verbatim, but `localePrefix:true` prepends the localized language tag so the
 * recipient at least sees the SMS framing in their language. The choice of
 * channel + the consent/opt-in gating are unchanged.
 */
export async function notifyProfile(db, {
  profileId, subject, text, html = null, channel = 'auto', from = null,
  messageKey = null, subjectKey = null, vars = null, lang = null,
} = {}) {
  const contacts = await resolveProfileContacts(db, profileId)
  const profileLang = lang || (await getProfileLanguage(db, profileId))
  // Catalog-backed standard copy: render subject + body in the profile's language.
  let effSubject = subject
  let effText = text
  if (messageKey) effText = t(profileLang, messageKey, vars)
  if (subjectKey) effSubject = t(profileLang, subjectKey, vars)
  subject = effSubject
  text = effText
  const chosen = channel === 'auto' ? autoChannel(contacts) : channel
  const results = []

  if (chosen === 'email' || channel === 'email') {
    // Prefer non-proxy emails; if forced email and only proxy exists, use them.
    let targets = contacts.emails.filter((e) => !e.is_proxy).map((e) => e.email)
    if (targets.length === 0 && channel === 'email') targets = contacts.emails.map((e) => e.email)
    for (const to of targets) {
      const r = await sendEmail({ to, from: from || broadcastFromEmail(), subject, html: html || undefined, text })
      results.push({ channel: 'email', target: to, ok: Boolean(r?.ok), error: r?.error || null })
    }
  }

  if (chosen === 'sms' || channel === 'sms') {
    const smsBody = [subject, text].filter(Boolean).join(' — ').slice(0, 600)
    if (contacts.sms_phone) {
      const r = await sendSms({ to: contacts.sms_phone, body: smsBody })
      results.push({ channel: 'sms', target: contacts.sms_phone, ok: Boolean(r?.ok), error: r?.error || null })
    } else {
      // Either no number on file, or the number exists but hasn't opted in.
      const reason = contacts.phones.length > 0 ? 'not_opted_in' : 'no_phone'
      results.push({ channel: 'sms', target: null, ok: false, error: reason })
    }
  }

  if (chosen === 'none' && channel === 'auto') {
    results.push({ channel: 'none', target: null, ok: false, error: 'no_contact' })
  }

  return { profile_id: String(profileId), channelsUsed: chosen, results, lang: profileLang }
}

/**
 * Broadcast a message to many profiles and persist an audit row. `channel`:
 *   'email' | 'sms' | 'auto'. Returns a summary { broadcast_id, profile_count,
 *   sent_email, sent_sms, failed, recipients }.
 *
 * PER-RECIPIENT LANGUAGE: each recipient's message is rendered in THAT
 * recipient's preferred language (not one global language). For a STANDARD
 * (catalog-backed) broadcast — pass `messageKey` (+ optional `subjectKey`/`vars`)
 * — notifyProfile renders subject + body from commsMessages for each recipient.
 * For a FREE-FORM broadcast (the owner typed `subject`/`body` themselves), that
 * exact copy is sent as typed (we don't machine-translate arbitrary owner copy),
 * but the per-recipient language is still resolved + audited so the owner can see
 * which language each recipient prefers. The body/subject validation, channel
 * choice, and consent/opt-in gating are unchanged.
 */
export async function sendBroadcast(db, { profileIds = [], channel = 'auto', subject, body, html = null, sentBy = 'admin', kind = 'broadcast', from = null, messageKey = null, subjectKey = null, vars = null } = {}) {
  await ensureCommsSchema(db)
  if (!Array.isArray(profileIds) || profileIds.length === 0) return { ok: false, error: 'no_recipients' }
  // Catalog-backed broadcasts supply the copy via keys; only require subject/body
  // for the free-form path.
  if (!messageKey) {
    if (!subject && channel !== 'sms') return { ok: false, error: 'subject_required' }
    if (!body) return { ok: false, error: 'body_required' }
  }

  const broadcastId = crypto.randomUUID()
  let sentEmail = 0, sentSms = 0, failed = 0
  const recipients = []

  for (const profileId of profileIds) {
    let res
    try {
      res = await notifyProfile(db, { profileId, subject, text: body, html, channel, from, messageKey, subjectKey, vars })
    } catch (err) {
      failed += 1
      recipients.push({ profile_id: String(profileId), channel: 'error', ok: false, error: err?.message })
      continue
    }
    for (const r of res.results) {
      if (r.ok && r.channel === 'email') sentEmail += 1
      else if (r.ok && r.channel === 'sms') sentSms += 1
      else failed += 1
      recipients.push({ profile_id: res.profile_id, channel: r.channel, target: r.target, ok: r.ok, error: r.error })
      try {
        await db.prepare(
          `INSERT INTO comms_broadcast_recipients (id, broadcast_id, profile_id, channel, target, status, error)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(crypto.randomUUID(), broadcastId, res.profile_id, r.channel,
          r.channel === 'sms' ? maskPhone(r.target) : maskEmail(r.target), r.ok ? 'sent' : 'failed', r.error || null)
      } catch { /* audit best-effort */ }
    }
  }

  try {
    await db.prepare(
      `INSERT INTO comms_broadcasts (id, sent_by, kind, channel, subject, body, profile_count, sent_email, sent_sms, failed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(broadcastId, sentBy, kind, channel, subject || null, body, profileIds.length, sentEmail, sentSms, failed)
  } catch (err) { log.warn('broadcast audit insert failed', { error: err?.message }) }

  log.info('broadcast sent', { broadcast_id: broadcastId, kind, channel, profiles: profileIds.length, sentEmail, sentSms, failed })
  return { ok: true, broadcast_id: broadcastId, profile_count: profileIds.length, sent_email: sentEmail, sent_sms: sentSms, failed, recipients }
}
