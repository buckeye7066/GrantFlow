/**
 * E-SIGNATURE UNDER FULL AUTOMATION (owner goal 2026-08-21, reaffirmed twice:
 * "Hamilton will be able to finish submissions in every portal e2e completely
 * autonomous if the profile has full automation toggled on").
 *
 * Before this change an electronic-signature field or checkbox was an
 * UNCONDITIONAL hand-off: `detectAttestationGate` returned `signature` for any
 * HARD_ATTESTATION checkbox regardless of consent, the fill loop skipped every
 * hard box, no code path ever typed a name into a "signature" text input, and
 * `resolveDigitalSignature` always escalated. So a profile with every consent
 * granted still stopped one click short of submitting.
 *
 * The rule now: the applicant's electronic signature is performed ONLY when
 * all three hold — full-automation verdict, `use_standing_attestation` +
 * `submit_applications` granted, and a real applicant name to sign with — and
 * each signature is traced. With any one absent, behaviour is exactly what it
 * was (every "stays a blocker" test below passes on the pre-change code; every
 * "signs" test fails on it).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'
import { _internal } from '../services/hamilton/hamiltonAutopilotEngine.js'
import { resolveBlocker } from '../services/hamilton/hamiltonHardStopResolver.js'
import { _resetAuthSchemaCache, recordAuthorizations } from '../services/hamilton/hamiltonAuthorizationStore.js'

const { isTypedSignatureField, signatureConsentFor, detectAttestationGate } = _internal

const FULL = { use_standing_attestation: true, submit_applications: true, complete_forms: true }

function fakeCheckboxPage(items) {
  return { $$eval: async (_sel, fn) => items.map((it) => ({ id: it.id || '', name: it.name || '', label: it.label || '' })) }
}

describe('signatureConsentFor — three consents, all required', () => {
  it('grants only with full automation + both types + a real name', () => {
    expect(signatureConsentFor({ fullAutomation: true, authorizations: FULL, signerName: 'Jane Q. Applicant' })).toEqual({ name: 'Jane Q. Applicant' })
  })
  it.each([
    ['full automation off', { fullAutomation: false, authorizations: FULL, signerName: 'Jane' }],
    ['no standing attestation', { fullAutomation: true, authorizations: { ...FULL, use_standing_attestation: false }, signerName: 'Jane' }],
    ['no submit authority', { fullAutomation: true, authorizations: { ...FULL, submit_applications: false }, signerName: 'Jane' }],
    ['no name to sign with', { fullAutomation: true, authorizations: FULL, signerName: '  ' }],
  ])('refuses when %s', (_label, args) => {
    expect(signatureConsentFor(args)).toBeNull()
  })
})

describe('isTypedSignatureField — a signature input is not a name input', () => {
  it('recognises the real shapes portals use', () => {
    expect(isTypedSignatureField({ tag: 'input', type: 'text', label: 'Electronic Signature' })).toBe(true)
    expect(isTypedSignatureField({ tag: 'input', type: 'text', placeholder: 'Type your full legal name to sign' })).toBe(true)
    expect(isTypedSignatureField({ tag: 'input', type: 'text', name: 'applicant_esignature' })).toBe(true)
    expect(isTypedSignatureField({ tag: 'input', type: '', label: 'Sign your name' })).toBe(true)
  })
  it('does NOT treat an ordinary identity field, a checkbox, a file, or a select as a signature', () => {
    expect(isTypedSignatureField({ tag: 'input', type: 'text', label: 'Full name' })).toBe(false)
    expect(isTypedSignatureField({ tag: 'input', type: 'checkbox', label: 'Electronic signature' })).toBe(false)
    expect(isTypedSignatureField({ tag: 'input', type: 'file', label: 'Upload signature' })).toBe(false)
    expect(isTypedSignatureField({ tag: 'select', label: 'Signature type' })).toBe(false)
  })
})

describe('detectAttestationGate — an e-sign checkbox', () => {
  const esignBox = [{ id: 'sig', label: 'By checking this box I provide my electronic signature' }]
  it('is a hard blocker WITHOUT signature consent (unchanged behaviour)', async () => {
    const gate = await detectAttestationGate(fakeCheckboxPage(esignBox), { authorizations: FULL })
    expect(gate?.kind).toBe('signature')
  })
  it('is NOT a gate under signature consent (the fill loop ticks it instead)', async () => {
    const gate = await detectAttestationGate(fakeCheckboxPage(esignBox), { authorizations: FULL, signatureConsent: { name: 'Jane' } })
    expect(gate).toBeNull()
  })
  it('still reports a plain attestation when standing attestation is NOT granted, consent or not', async () => {
    const box = [{ id: 'a', label: 'I certify the information is true and accurate to the best of my knowledge' }]
    const gate = await detectAttestationGate(fakeCheckboxPage(box), { authorizations: { ...FULL, use_standing_attestation: false }, signatureConsent: { name: 'Jane' } })
    expect(gate?.kind).toBe('attestation')
  })
})

describe('resolveDigitalSignature — the resolver path', () => {
  let db
  const PROFILE = 'p-esign'
  beforeAll(async () => {
    const sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, display_name TEXT, name TEXT);
      CREATE TABLE users (id TEXT PRIMARY KEY, is_admin INTEGER DEFAULT 0);
      CREATE TABLE notifications (id TEXT PRIMARY KEY, user_id TEXT, type TEXT, title TEXT, message TEXT, severity TEXT, data TEXT, read INTEGER DEFAULT 0, resolved INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    `)
    db = wrapSqlite(sqlite)
    await db.prepare('INSERT INTO profiles (id, user_id, display_name) VALUES (?, ?, ?)').run(PROFILE, 'u1', 'Jane Q. Applicant')
    await db.prepare('INSERT INTO users (id) VALUES (?)').run('u1')
  })
  beforeEach(async () => {
    _resetAuthSchemaCache()
    try { await db.prepare('DELETE FROM hamilton_authorizations').run() } catch { /* first run */ }
  })
  const input = { kind: 'digital_signature', text: 'Electronic signature required', detail: 'Electronic signature required' }

  it('escalates to the user WITHOUT full automation (unchanged behaviour)', async () => {
    await recordAuthorizations(db, { userId: 'u1', profileId: PROFILE, scope: 'profile', authorizationTypes: ['use_standing_attestation', 'submit_applications'], authorizationText: 'c' })
    const d = await resolveBlocker(db, { taskId: 't1', profileId: PROFILE, userId: 'u1', portalUrl: 'https://portal.example.org/apply' }, input)
    expect(d.outcome).toBe('escalated')
    expect(d.strategy).toBe('ask_user_to_esign')
  })
  it('escalates under full automation when standing attestation was NOT granted', async () => {
    await recordAuthorizations(db, { userId: 'u1', profileId: PROFILE, scope: 'profile', authorizationTypes: ['submit_applications'], authorizationText: 'c' })
    const d = await resolveBlocker(db, { taskId: 't1', profileId: PROFILE, userId: 'u1', portalUrl: 'https://portal.example.org/apply', fullAutomation: true }, input)
    expect(d.outcome).toBe('escalated')
  })
  it('resolves with a retry under full automation + standing attestation', async () => {
    await recordAuthorizations(db, { userId: 'u1', profileId: PROFILE, scope: 'profile', authorizationTypes: ['use_standing_attestation', 'submit_applications'], authorizationText: 'c' })
    const d = await resolveBlocker(db, { taskId: 't1', profileId: PROFILE, userId: 'u1', portalUrl: 'https://portal.example.org/apply', fullAutomation: true }, input)
    expect(d.outcome).toBe('resolved')
    expect(d.retry).toBe(true)
    expect(d.strategy).toBe('apply_applicant_esignature')
    expect(d.payload.consent).toBe('full_automation+use_standing_attestation')
  })
  it('a WET (ink) signature still degrades to the printable packet — no automation can sign on paper', async () => {
    await recordAuthorizations(db, { userId: 'u1', profileId: PROFILE, scope: 'profile', authorizationTypes: ['use_standing_attestation', 'submit_applications'], authorizationText: 'c' })
    const d = await resolveBlocker(db, { taskId: 't1', profileId: PROFILE, userId: 'u1', portalUrl: 'https://portal.example.org/apply', fullAutomation: true }, { kind: 'signature', text: 'Wet signature required — print, sign in ink and mail' })
    expect(d.outcome).toBe('degraded')
    expect(d.fallback).toBe('pdf_docx')
  })
})
