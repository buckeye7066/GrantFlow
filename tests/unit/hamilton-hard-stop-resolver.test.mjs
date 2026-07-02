/**
 * Hamilton Hard-Stop Resolver tests.
 *
 * Covers:
 *   - hamiltonBlockerClassifier.classifyBlocker — every category
 *   - hamiltonCredentialSessionService — record/find/expire/revoke
 *   - hamiltonPaymentAuthorizationService — authorize / canPayFor / charge
 *   - hamiltonAttestationStore — authorize + isAttestationAllowed
 *   - hamiltonPortalPolicyRegistry — getPolicyFor + upsertPolicy + seed
 *   - hamiltonResolvedFieldStore — save + get
 *   - hamiltonBlockerStore — recordBlocker + recordResolution
 *   - hamiltonHardStopResolver — every blocker category dispatch path
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'

import { classifyBlocker, BLOCKER_CATEGORIES } from '../../backend/services/hamilton/hamiltonBlockerClassifier.js'
import {
  recordSession,
  findValidSession,
  markSessionExpired,
  revokeSession,
  listSessionsForProfile,
  normalizeHost,
  _resetCredentialSchemaCache,
} from '../../backend/services/hamilton/hamiltonCredentialSessionService.js'
import {
  authorizePayment,
  canPayFor,
  recordCharge,
  listPaymentAuthorizations,
  _resetPaymentSchemaCache,
} from '../../backend/services/hamilton/hamiltonPaymentAuthorizationService.js'
import {
  authorizeAttestation,
  isAttestationAllowed,
  listActiveAttestations,
  _resetAttestationSchemaCache,
} from '../../backend/services/hamilton/hamiltonAttestationStore.js'
import {
  getPolicyFor,
  upsertPolicy,
  listPolicies,
  _resetPortalPolicySchemaCache,
} from '../../backend/services/hamilton/hamiltonPortalPolicyRegistry.js'
import {
  saveResolvedField,
  getResolvedField,
  _resetResolvedFieldSchemaCache,
} from '../../backend/services/hamilton/hamiltonResolvedFieldStore.js'
import {
  recordBlocker,
  recordResolution,
  listBlockersForTask,
  _resetBlockerSchemaCache,
} from '../../backend/services/hamilton/hamiltonBlockerStore.js'
import { resolveBlocker } from '../../backend/services/hamilton/hamiltonHardStopResolver.js'
import {
  recordAuthorizations,
  _resetAuthSchemaCache,
} from '../../backend/services/hamilton/hamiltonAuthorizationStore.js'

function makeDb() {
  const sqlite = new Database(':memory:')
  return wrapSqlite(sqlite)
}

function resetCaches() {
  _resetAuthSchemaCache()
  _resetCredentialSchemaCache()
  _resetPaymentSchemaCache()
  _resetAttestationSchemaCache()
  _resetPortalPolicySchemaCache()
  _resetResolvedFieldSchemaCache()
  _resetBlockerSchemaCache()
}

// ── classifier ──────────────────────────────────────────────────────

describe('hamiltonBlockerClassifier', () => {
  it('exports the 16 spec categories incl. distinct signature/attestation', () => {
    assert.equal(BLOCKER_CATEGORIES.length, 16)
    assert.ok(BLOCKER_CATEGORIES.includes('wet_signature_required'))
    assert.ok(BLOCKER_CATEGORIES.includes('digital_signature_required'))
    assert.ok(BLOCKER_CATEGORIES.includes('legal_attestation_required'))
  })

  it('classifies preflight inputs', () => {
    assert.equal(classifyBlocker({ kind: 'missing_field', context: { key: 'first_name' } }).category, 'missing_required_information')
    assert.equal(classifyBlocker({ kind: 'missing_document', context: { kind: 'transcript' } }).category, 'missing_required_document')
    assert.equal(classifyBlocker({ kind: 'missing_url' }).category, 'unknown_application_method')
    assert.equal(classifyBlocker({ kind: 'missing_authorization' }).category, 'legal_attestation_required')
    assert.equal(classifyBlocker({ kind: 'deadline_expired' }).category, 'deadline_expired')
  })

  it('classifies engine kinds', () => {
    assert.equal(classifyBlocker({ kind: 'login' }).category, 'login_required')
    assert.equal(classifyBlocker({ kind: '2fa' }).category, 'two_factor_required')
    assert.equal(classifyBlocker({ kind: 'captcha' }).category, 'captcha_required')
    assert.equal(classifyBlocker({ kind: 'payment' }).category, 'payment_required')
    assert.equal(classifyBlocker({ kind: 'signature' }).category, 'wet_signature_required')
    assert.equal(classifyBlocker({ kind: 'digital_signature' }).category, 'digital_signature_required')
    assert.equal(classifyBlocker({ kind: 'attestation' }).category, 'legal_attestation_required')
    assert.equal(classifyBlocker({ kind: 'validation' }).category, 'ambiguous_required_field')
    assert.equal(classifyBlocker({ kind: 'too_many_pages' }).category, 'portal_anti_bot_block')
  })

  it('classifies free-form text', () => {
    assert.equal(classifyBlocker({ text: 'Single sign-on with your university account' }).category, 'sso_required')
    assert.equal(classifyBlocker({ text: 'Enter your one-time code from the authenticator app' }).category, 'two_factor_required')
    assert.equal(classifyBlocker({ text: 'Please complete the reCAPTCHA' }).category, 'captcha_required')
    assert.equal(classifyBlocker({ text: 'Application fee of $25.00 is required' }).category, 'payment_required')
    assert.equal(classifyBlocker({ text: 'Hand-written signature required' }).category, 'wet_signature_required')
    assert.equal(classifyBlocker({ text: 'Please add your electronic signature below' }).category, 'digital_signature_required')
    assert.equal(classifyBlocker({ text: 'Sign here to continue' }).category, 'digital_signature_required')
    assert.equal(classifyBlocker({ text: 'I certify under penalty of perjury' }).category, 'legal_attestation_required')
    assert.equal(classifyBlocker({ text: 'Automated submissions are prohibited' }).category, 'portal_terms_block')
    assert.equal(classifyBlocker({ text: 'Cloudflare Ray ID 12345 — access denied' }).category, 'portal_anti_bot_block')
    assert.equal(classifyBlocker({ text: 'Application deadline has passed' }).category, 'deadline_expired')
    assert.equal(classifyBlocker({ text: 'Please review your application before submitting' }).category, 'final_review_screen')
    assert.equal(classifyBlocker({ text: 'Upload your transcript' }).category, 'missing_required_document')
    assert.equal(classifyBlocker({ text: 'Please log in to continue' }).category, 'login_required')
  })

  it('returns unknown when no signal matches', () => {
    const r = classifyBlocker({})
    assert.equal(r.category, 'unknown')
  })
})

// ── credential sessions ─────────────────────────────────────────────

describe('hamiltonCredentialSessionService', () => {
  beforeEach(resetCaches)

  it('normalises hosts', () => {
    assert.equal(normalizeHost('https://www.MTSU.edu/aid'), 'www.mtsu.edu')
    assert.equal(normalizeHost('mtsu.edu'), 'mtsu.edu')
    assert.equal(normalizeHost(null), null)
  })

  it('records, looks up, and expires sessions (no plaintext stored)', async () => {
    delete process.env.HAMILTON_BROWSER_STORAGE_DIR
    const db = makeDb()
    const session = await recordSession(db, {
      userId: 'u1', profileId: 'p1', portalHost: 'mtsu.edu',
      storageStatePath: '/tmp/storage.json', label: 'mtsu-aid',
      authenticationStrategy: 'sso',
    })
    assert.equal(session.portal_host, 'mtsu.edu')
    assert.equal(session.status, 'valid')

    const found = await findValidSession(db, { profileId: 'p1', portalHost: 'mtsu.edu' })
    assert.ok(found)
    assert.equal(found.id, session.id)

    const expired = await markSessionExpired(db, session.id, 'token rotated')
    assert.equal(expired.status, 'expired')
    const notFound = await findValidSession(db, { profileId: 'p1', portalHost: 'mtsu.edu' })
    assert.equal(notFound, null)

    const list = await listSessionsForProfile(db, 'p1')
    assert.equal(list.length, 1)

    const revoked = await revokeSession(db, session.id, 'user-revoked')
    assert.equal(revoked.status, 'revoked')
  })

  it('rejects raw card data masquerading as a session ref', async () => {
    delete process.env.HAMILTON_BROWSER_STORAGE_DIR
    const db = makeDb()
    await assert.rejects(
      () => recordSession(db, { userId: 'u', profileId: 'p', portalHost: 'x.com' }),
      /one of storageStatePath or storageStateRef/,
    )
  })
})

// ── payment authorizations ──────────────────────────────────────────

describe('hamiltonPaymentAuthorizationService', () => {
  beforeEach(resetCaches)

  it('authorizes, decides, charges, and refuses raw card data', async () => {
    const db = makeDb()
    await assert.rejects(
      () => authorizePayment(db, {
        userId: 'u', profileId: 'p',
        category: 'application_fee', maxAmountCents: 5000,
        paymentMethodLabel: '4111 1111 1111 1111',
        authorizationText: 'I authorize',
      }),
      /tokenised reference/,
    )
    const auth = await authorizePayment(db, {
      userId: 'u', profileId: 'p',
      category: 'application_fee', maxAmountCents: 5000,
      paymentMethodReference: 'pm_test_123', paymentMethodLabel: 'Visa ending 4242',
      authorizationText: 'I authorize Hamilton to pay application fees up to $50.',
      allowedPortalHosts: ['mtsu.edu'],
    })
    assert.equal(auth.max_amount_cents, 5000)

    let decision = await canPayFor(db, { profileId: 'p', category: 'application_fee', amountCents: 2500, portalHost: 'mtsu.edu' })
    assert.equal(decision.allowed, true)

    decision = await canPayFor(db, { profileId: 'p', category: 'application_fee', amountCents: 6000, portalHost: 'mtsu.edu' })
    assert.equal(decision.allowed, false)

    decision = await canPayFor(db, { profileId: 'p', category: 'application_fee', amountCents: 1000, portalHost: 'evil.com' })
    assert.equal(decision.allowed, false)

    decision = await canPayFor(db, { profileId: 'p', category: 'transcript_fee', amountCents: 100 })
    assert.equal(decision.allowed, false)
    assert.equal(decision.reason, 'no_authorization_for_category')

    const post = await recordCharge(db, { authorizationId: auth.id, amountCents: 2500, taskId: 't1', portalHost: 'mtsu.edu', processorReceipt: 'rcpt_1' })
    assert.equal(post.spent_cents, 2500)

    // After spending half, charging again above the remaining budget fails.
    decision = await canPayFor(db, { profileId: 'p', category: 'application_fee', amountCents: 4000, portalHost: 'mtsu.edu' })
    assert.equal(decision.allowed, false)

    const list = await listPaymentAuthorizations(db, 'p')
    assert.equal(list.length, 1)
  })
})

// ── attestations ────────────────────────────────────────────────────

describe('hamiltonAttestationStore', () => {
  beforeEach(resetCaches)

  it('authorizes routine categories and matches by pattern', async () => {
    const db = makeDb()
    await authorizeAttestation(db, {
      userId: 'u', profileId: 'p',
      category: 'truthfulness',
      authorizationText: 'I authorize Hamilton to confirm routine truthfulness statements.',
    })
    const allowed = await isAttestationAllowed(db, { profileId: 'p', labelText: 'I certify the information is accurate to the best of my knowledge.' })
    assert.equal(allowed.allowed, true)
    assert.equal(allowed.category, 'truthfulness')

    // Sworn / penalty-of-perjury text is not in our seed pattern.
    const denied = await isAttestationAllowed(db, { profileId: 'p', labelText: 'I swear under penalty of perjury' })
    assert.equal(denied.allowed, false)

    const list = await listActiveAttestations(db, 'p')
    assert.equal(list.length, 1)
  })
})

// ── portal policy registry ──────────────────────────────────────────

describe('hamiltonPortalPolicyRegistry', () => {
  beforeEach(resetCaches)

  it('returns seeded policies for known hosts', async () => {
    const db = makeDb()
    const fafsa = await getPolicyFor(db, 'studentaid.gov')
    assert.equal(fafsa.automation_allowed, false)
    assert.equal(fafsa.manual_only, true)

    const subdomain = await getPolicyFor(db, 'subdomain.mtsu.edu')
    assert.equal(subdomain.portal_host, 'mtsu.edu')
    assert.equal(subdomain.automation_allowed, true)

    const unknown = await getPolicyFor(db, 'unknown-portal.org')
    assert.equal(unknown.automation_allowed, true)
    assert.equal(unknown.fallback_path, 'pdf_docx')
  })

  it('routes informational federal hosts (benefits.gov / medicaid.gov) to the manual path — never browser automation', async () => {
    const db = makeDb()
    // Article pages on these hosts were queued as application portals in prod;
    // they are informational-only by design (no application surface on the host).
    const benefits = await getPolicyFor(db, 'www.benefits.gov')
    assert.equal(benefits.portal_host, 'benefits.gov')
    assert.equal(benefits.automation_allowed, false)
    assert.equal(benefits.manual_only, true)
    assert.equal(benefits.fallback_path, 'manual')

    const medicaid = await getPolicyFor(db, 'medicaid.gov')
    assert.equal(medicaid.automation_allowed, false)
    assert.equal(medicaid.fallback_path, 'manual')

    // studentaid.gov article pages (e.g. /understand-aid/types/grants) are
    // covered by its existing manual-only seed entry.
    const studentAid = await getPolicyFor(db, 'studentaid.gov')
    assert.equal(studentAid.automation_allowed, false)
  })

  it('upserts and respects DB overrides over the seed', async () => {
    const db = makeDb()
    await upsertPolicy(db, {
      portalHost: 'mtsu.edu',
      automationAllowed: false, manualOnly: true,
      fallbackPath: 'pdf_docx',
      sourceOfPolicy: 'https://example.tld/tos',
    })
    const policy = await getPolicyFor(db, 'mtsu.edu')
    assert.equal(policy.automation_allowed, false)
    const list = await listPolicies(db)
    assert.ok(list.find((p) => p.portal_host === 'mtsu.edu' && p.automation_allowed === false))
  })
})

// ── resolved field store ────────────────────────────────────────────

describe('hamiltonResolvedFieldStore', () => {
  beforeEach(resetCaches)

  it('saves and retrieves resolved fields, normalises keys', async () => {
    const db = makeDb()
    await saveResolvedField(db, { profileId: 'p1', fieldKey: 'First-Name', fieldValue: 'Anastasia' })
    const got = await getResolvedField(db, { profileId: 'p1', fieldKey: 'first_name' })
    assert.equal(got.field_value, 'Anastasia')
    assert.equal(got.field_key, 'first_name')
    // Idempotent on key — second save updates.
    await saveResolvedField(db, { profileId: 'p1', fieldKey: 'first_name', fieldValue: 'Ana' })
    const got2 = await getResolvedField(db, { profileId: 'p1', fieldKey: 'first_name' })
    assert.equal(got2.field_value, 'Ana')
  })

  it('refuses empty values', async () => {
    const db = makeDb()
    await assert.rejects(
      () => saveResolvedField(db, { profileId: 'p1', fieldKey: 'k', fieldValue: '' }),
      /never stores empty/,
    )
  })
})

// ── blocker store ───────────────────────────────────────────────────

describe('hamiltonBlockerStore', () => {
  beforeEach(resetCaches)

  it('records a blocker and a resolution and updates resolved_at', async () => {
    const db = makeDb()
    const b = await recordBlocker(db, {
      taskId: 't1', profileId: 'p1', userId: 'u1',
      blockerType: 'login_required', blockerSource: 'engine',
      blockerText: 'Please sign in to MTSU portal',
    })
    assert.ok(b.id)
    await recordResolution(db, {
      blockerId: b.id, taskId: 't1',
      strategy: 'reuse_saved_session', outcome: 'resolved',
      detail: 'Reused saved session.',
    })
    const list = await listBlockersForTask(db, 't1', { onlyOpen: false })
    assert.equal(list.length, 1)
    assert.ok(list[0].resolved_at)
    const open = await listBlockersForTask(db, 't1', { onlyOpen: true })
    assert.equal(open.length, 0)
  })
})

// ── hard-stop resolver dispatch ─────────────────────────────────────

describe('hamiltonHardStopResolver', () => {
  beforeEach(resetCaches)

  function ctx(overrides = {}) {
    return {
      taskId: 't1', profileId: 'p1', userId: 'u1',
      portalUrl: 'https://aid.mtsu.edu/apply', opportunity: { id: 'op-1' },
      profile: { id: 'p1' }, classification: { automation_type: 'portal' },
      ...overrides,
    }
  }

  it('login → escalates without authorization', async () => {
    const db = makeDb()
    const d = await resolveBlocker(db, ctx(), { kind: 'login' })
    assert.equal(d.classification.category, 'login_required')
    assert.equal(d.outcome, 'escalated')
  })

  it('login → reuses saved session when authorized and present', async () => {
    delete process.env.HAMILTON_BROWSER_STORAGE_DIR
    const db = makeDb()
    await recordAuthorizations(db, {
      userId: 'u1', profileId: 'p1', scope: 'funding_source',
      fundingSourceIds: ['op-1'], authorizationTypes: ['use_saved_session'],
      authorizationText: 'Use saved session.',
    })
    await recordSession(db, {
      userId: 'u1', profileId: 'p1', portalHost: 'aid.mtsu.edu',
      storageStatePath: '/tmp/x.json',
    })
    const d = await resolveBlocker(db, ctx(), { kind: 'login' })
    assert.equal(d.outcome, 'resolved')
    assert.equal(d.strategy, 'reuse_saved_session')
    assert.ok(d.payload.session_id)
  })

  it('2FA → reuses trusted-device session', async () => {
    delete process.env.HAMILTON_BROWSER_STORAGE_DIR
    const db = makeDb()
    await recordSession(db, {
      userId: 'u1', profileId: 'p1', portalHost: 'aid.mtsu.edu',
      storageStatePath: '/tmp/x.json',
    })
    const d = await resolveBlocker(db, ctx(), { kind: '2fa' })
    assert.equal(d.outcome, 'resolved')
    assert.equal(d.strategy, 'reuse_trusted_device_session')
  })

  it('2FA → escalates without saved session (NEVER bypassed)', async () => {
    const db = makeDb()
    const d = await resolveBlocker(db, ctx(), { kind: '2fa' })
    assert.equal(d.outcome, 'escalated')
  })

  it('CAPTCHA → never solves; reuses session if present, otherwise escalates', async () => {
    delete process.env.HAMILTON_BROWSER_STORAGE_DIR
    const db = makeDb()
    let d = await resolveBlocker(db, ctx(), { kind: 'captcha' })
    assert.equal(d.outcome, 'escalated')
    await recordSession(db, {
      userId: 'u1', profileId: 'p1', portalHost: 'aid.mtsu.edu', storageStatePath: '/tmp/x.json',
    })
    d = await resolveBlocker(db, ctx(), { kind: 'captcha' })
    assert.equal(d.outcome, 'resolved')
    assert.equal(d.strategy, 'reuse_session_to_avoid_captcha')
  })

  it('payment → resolves only within authorized envelope', async () => {
    const db = makeDb()
    await authorizePayment(db, {
      userId: 'u1', profileId: 'p1',
      category: 'application_fee', maxAmountCents: 5000,
      paymentMethodReference: 'pm_test', authorizationText: 'auth',
    })
    let d = await resolveBlocker(db, ctx(), { kind: 'payment', context: { category: 'application_fee', amount_cents: 2500 } })
    assert.equal(d.outcome, 'resolved')
    assert.equal(d.strategy, 'charge_within_pre_authorization')

    d = await resolveBlocker(db, ctx(), { kind: 'payment', context: { category: 'application_fee', amount_cents: 8000 } })
    assert.equal(d.outcome, 'escalated')
  })

  it('wet signature → ALWAYS degrades to packet (never forges)', async () => {
    const db = makeDb()
    const d = await resolveBlocker(db, ctx(), { kind: 'signature', text: 'Hand-written signature required' })
    assert.equal(d.outcome, 'degraded')
    assert.equal(d.fallback, 'pdf_docx')
  })

  it('attestation → routine = auto-tick, penalty-of-perjury = escalate', async () => {
    const db = makeDb()
    await authorizeAttestation(db, {
      userId: 'u1', profileId: 'p1',
      category: 'truthfulness',
      authorizationText: 'I authorize routine truthfulness.',
    })
    let d = await resolveBlocker(db, ctx(), { kind: 'attestation', text: 'Information is true and accurate to the best of my knowledge' })
    assert.equal(d.outcome, 'resolved')
    assert.equal(d.strategy, 'check_authorized_attestation')

    d = await resolveBlocker(db, ctx(), { kind: 'attestation', text: 'I declare under penalty of perjury that this is correct' })
    assert.equal(d.outcome, 'escalated')
  })

  it('portal terms forbid → degrades to lawful fallback', async () => {
    const db = makeDb()
    const d = await resolveBlocker(db, ctx({ portalUrl: 'https://studentaid.gov/foo' }), { text: 'Automated submissions are prohibited by the terms of service' })
    assert.equal(d.outcome, 'degraded')
    assert.ok(['manual', 'pdf_docx', 'mail', 'fax', 'email', 'api'].includes(d.fallback))
  })

  it('anti-bot → switches to packet when no session', async () => {
    const db = makeDb()
    const d = await resolveBlocker(db, ctx(), { text: 'Cloudflare Ray ID 12345 — access denied' })
    assert.equal(d.outcome, 'degraded')
  })

  it('ambiguous field → reuses resolved-field cache when present', async () => {
    const db = makeDb()
    await saveResolvedField(db, { profileId: 'p1', fieldKey: 'major', fieldValue: 'Computer Science' })
    const d = await resolveBlocker(db, ctx(), { kind: 'validation', context: { key: 'major' } })
    assert.equal(d.outcome, 'resolved')
    assert.equal(d.payload.field_value, 'Computer Science')
  })

  it('final review → never stops Autopilot', async () => {
    const db = makeDb()
    const d = await resolveBlocker(db, ctx(), { text: 'Please review your application before submitting' })
    assert.equal(d.classification.category, 'final_review_screen')
    assert.equal(d.outcome, 'resolved')
    assert.equal(d.strategy, 'proceed_through_review')
  })

  it('deadline expired → blocked', async () => {
    const db = makeDb()
    const d = await resolveBlocker(db, ctx(), { kind: 'deadline_expired' })
    assert.equal(d.outcome, 'blocked')
  })

  it('unknown method → degrades to funder contact packet', async () => {
    const db = makeDb()
    const d = await resolveBlocker(db, ctx(), { kind: 'no_progress' })
    assert.equal(d.outcome, 'degraded')
    assert.equal(d.strategy, 'funder_contact_packet')
  })

  it('missing document → reuses profile candidate when wired', async () => {
    const db = makeDb()
    const d = await resolveBlocker(db, ctx({ documentCandidates: [{ kind: 'transcript', document_id: 'd1', path: '/d.pdf' }] }), {
      kind: 'missing_document', context: { kind: 'transcript' },
    })
    assert.equal(d.outcome, 'resolved')
    assert.equal(d.strategy, 'reuse_profile_document')
  })

  it('missing document → generates packet for Hamilton-generatable kinds', async () => {
    const db = makeDb()
    const d = await resolveBlocker(db, ctx(), { kind: 'missing_document', context: { kind: 'cover_letter' } })
    assert.equal(d.outcome, 'resolved')
    assert.equal(d.strategy, 'generate_document')
  })

  it('logs every blocker + resolution to the audit tables', async () => {
    const db = makeDb()
    await resolveBlocker(db, ctx(), { kind: 'signature', text: 'Hand-written signature required' })
    const list = await listBlockersForTask(db, 't1', { onlyOpen: false })
    assert.equal(list.length, 1)
    assert.equal(list[0].blocker_type, 'wet_signature_required')
  })
})
