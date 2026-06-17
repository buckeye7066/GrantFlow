import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyDefaultJohnEnv,
  applyEnv,
  makeQualifiedLead,
} from './john-test-helpers.mjs'
import {
  assertDraftOnly,
  classifyBody,
  classifySubject,
  evaluateDraftSafety,
  getJohnConfig,
  isValidEmail,
  maskSecrets,
} from '../../backend/services/john/johnOutreachSafety.js'
import { BLOCK_REASONS, SAFETY_STATUS } from '../../backend/services/john/johnTypes.js'

test('John is disabled by default', () => {
  const restore = applyEnv({
    JOHN_ENABLED: undefined,
    JOHN_DRAFT_ONLY: undefined,
    JOHN_ALLOW_SEND: undefined,
    JOHN_MODE: undefined,
  })
  try {
    const cfg = getJohnConfig()
    assert.equal(cfg.enabled, false, 'JOHN_ENABLED defaults false')
    assert.equal(cfg.mode, 'observe', 'JOHN_MODE defaults observe')
    assert.equal(cfg.draftOnly, true, 'JOHN_DRAFT_ONLY defaults true')
    assert.equal(cfg.allowSend, false, 'JOHN_ALLOW_SEND defaults false')
  } finally {
    restore()
  }
})

test('JOHN_ALLOW_SEND can never coexist with JOHN_DRAFT_ONLY=true', () => {
  const restore = applyEnv({
    JOHN_ENABLED: 'true',
    JOHN_DRAFT_ONLY: 'true',
    JOHN_ALLOW_SEND: 'true',
  })
  try {
    const cfg = getJohnConfig()
    assert.equal(cfg.allowSend, false, 'allowSend collapses to false when draftOnly=true')
    // assertDraftOnly should NOT throw because draftOnly=true
    assert.doesNotThrow(() => assertDraftOnly(cfg))
  } finally {
    restore()
  }
})

test('assertDraftOnly throws when an operator turns draft-only off', () => {
  const restore = applyEnv({
    JOHN_DRAFT_ONLY: 'false',
    JOHN_ALLOW_SEND: 'true',
  })
  try {
    const cfg = getJohnConfig()
    assert.throws(
      () => assertDraftOnly(cfg),
      (err) => err && err.code === 'JOHN_DRAFT_ONLY_REQUIRED'
    )
  } finally {
    restore()
  }
})

test('classifySubject blocks deceptive subjects', () => {
  for (const bad of [
    'You have been approved for funding',
    'GRANT MONEY WAITING for you',
    'Urgent funding opportunity',
    'Re: Your grant application',
    'Guaranteed grants for your organization',
  ]) {
    const r = classifySubject(bad)
    assert.equal(r.ok, false, `expected ${JSON.stringify(bad)} to be blocked`)
    assert.deepEqual(r.reasons, [BLOCK_REASONS.DECEPTIVE_SUBJECT])
  }
})

test('classifySubject accepts approved subject patterns', () => {
  for (const good of [
    'Possible funding help for Riverbend VFD',
    'Funding discovery idea for Lakeside Pantry',
    'A possible GrantFlow fit for Hope Church',
    'Quick note about your station expansion',
  ]) {
    const r = classifySubject(good)
    assert.equal(r.ok, true, `expected ${JSON.stringify(good)} to pass`)
  }
})

test('classifyBody requires opt-out language and rejects funding guarantees', () => {
  const restore = applyDefaultJohnEnv()
  try {
    const cfg = getJohnConfig()
    const noOptOut = classifyBody('Just a quick hello.', { physicalAddress: cfg.physicalAddress, requirePhysicalAddress: true })
    assert.equal(noOptOut.ok, false)
    assert.ok(noOptOut.reasons.includes(BLOCK_REASONS.MISSING_OPT_OUT))
    assert.ok(noOptOut.reasons.includes(BLOCK_REASONS.MISSING_PHYSICAL_ADDRESS))

    const withGuarantee = classifyBody(
      `We guarantee funding. ${cfg.physicalAddress} reply "no thanks" to opt out`,
      { physicalAddress: cfg.physicalAddress, requirePhysicalAddress: true }
    )
    assert.equal(withGuarantee.ok, false)
    assert.ok(withGuarantee.reasons.includes(BLOCK_REASONS.GUARANTEES_FUNDING))

    const ok = classifyBody(
      `Hi team, brief note. ${cfg.physicalAddress} If this is not relevant reply "no thanks"`,
      { physicalAddress: cfg.physicalAddress, requirePhysicalAddress: true }
    )
    assert.equal(ok.ok, true)
  } finally {
    restore()
  }
})

test('evaluateDraftSafety blocks low-score, unqualified, suppressed leads', () => {
  const restore = applyDefaultJohnEnv()
  try {
    const cfg = getJohnConfig()
    const goodBody = `Hello. body... ${cfg.physicalAddress} reply "no thanks" to opt out`
    const goodSubject = 'Possible funding help for Riverbend VFD'
    const goodLead = makeQualifiedLead({})

    const passing = evaluateDraftSafety({
      lead: goodLead,
      draft: { subject: goodSubject, body: goodBody, recipient_email: 'chief@example.org' },
      config: cfg,
    })
    assert.equal(passing.status, SAFETY_STATUS.PASSED, JSON.stringify(passing.reasons))

    const lowScore = evaluateDraftSafety({
      lead: makeQualifiedLead({ lead_score: 40 }),
      draft: { subject: goodSubject, body: goodBody, recipient_email: 'chief@example.org' },
      config: cfg,
    })
    assert.equal(lowScore.status, SAFETY_STATUS.BLOCKED)
    assert.ok(lowScore.reasons.includes(BLOCK_REASONS.LOW_LEAD_SCORE))

    const unqualified = evaluateDraftSafety({
      lead: makeQualifiedLead({ qualified: false }),
      draft: { subject: goodSubject, body: goodBody, recipient_email: 'chief@example.org' },
      config: cfg,
    })
    assert.ok(unqualified.reasons.includes(BLOCK_REASONS.LEAD_NOT_QUALIFIED_BY_YANA))

    const suppressed = evaluateDraftSafety({
      lead: goodLead,
      draft: { subject: goodSubject, body: goodBody, recipient_email: 'chief@example.org' },
      suppression: { isSuppressed: ({ type, value }) => type === 'email' && value === 'chief@example.org' },
      config: cfg,
    })
    assert.ok(suppressed.reasons.includes(BLOCK_REASONS.SUPPRESSED_EMAIL))

    const dnc = evaluateDraftSafety({
      lead: makeQualifiedLead({ do_not_contact_flags: ['user_requested'] }),
      draft: { subject: goodSubject, body: goodBody, recipient_email: 'chief@example.org' },
      config: cfg,
    })
    assert.ok(dnc.reasons.includes(BLOCK_REASONS.DO_NOT_CONTACT))

    const noEvidence = evaluateDraftSafety({
      lead: makeQualifiedLead({ public_evidence: [] }),
      draft: { subject: goodSubject, body: goodBody, recipient_email: 'chief@example.org' },
      config: cfg,
    })
    assert.ok(noEvidence.reasons.includes(BLOCK_REASONS.MISSING_PUBLIC_EVIDENCE))

    const noContactSource = evaluateDraftSafety({
      lead: makeQualifiedLead({ source_urls: [] }),
      draft: { subject: goodSubject, body: goodBody, recipient_email: 'chief@example.org' },
      config: cfg,
    })
    assert.ok(noContactSource.reasons.includes(BLOCK_REASONS.MISSING_CONTACT_SOURCE))

    const invalidEmail = evaluateDraftSafety({
      lead: goodLead,
      draft: { subject: goodSubject, body: goodBody, recipient_email: 'not-an-email' },
      config: cfg,
    })
    assert.ok(invalidEmail.reasons.includes(BLOCK_REASONS.INVALID_RECIPIENT))
  } finally {
    restore()
  }
})

test('isValidEmail accepts realistic emails and rejects garbage', () => {
  assert.equal(isValidEmail('foo@bar.org'), true)
  assert.equal(isValidEmail('foo.bar+tag@sub.example.co'), true)
  assert.equal(isValidEmail(' '), false)
  assert.equal(isValidEmail('foo@bar'), false)
  assert.equal(isValidEmail(null), false)
})

test('maskSecrets redacts bearer tokens, JWT-ish strings, and secret-shaped keys', () => {
  const out = maskSecrets({
    Authorization: 'Bearer eyJabcdefghij1234567890abcdef',
    api_key: 'sk-something-secret-1234',
    nested: {
      access_token: 'token-1234',
      note: 'Authorization: Bearer eyJabcdefghij1234567890abcdef',
    },
    safe: 'hello world',
  })
  assert.equal(out.api_key, '***')
  assert.equal(out.nested.access_token, '***')
  assert.match(out.nested.note, /Bearer \*\*\*/)
  assert.equal(out.safe, 'hello world')
})
