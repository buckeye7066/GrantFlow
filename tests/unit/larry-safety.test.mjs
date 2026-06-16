/**
 * Larry — safety predicates and config defaults.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getLarryConfig,
  classifyEmail,
  classifyPhone,
  isPlaceholderUrl,
  isSearchEngineUrl,
  maskSecrets,
  checkSendIsAllowed,
} from '../../backend/services/larry/larrySafety.js'

const ENV_KEYS = [
  'LARRY_ENABLED',
  'LARRY_RUN_ON_STARTUP',
  'LARRY_RUN_ON_SCHEDULE',
  'LARRY_MODE',
  'LARRY_ALLOW_LIVE_WEB',
  'LARRY_AUTO_SEND_OUTREACH',
  'LARRY_REQUIRE_APPROVAL_TO_SEND',
  'LARRY_FROM_EMAIL',
  'FROM_EMAIL',
  'EMAIL_FROM',
]

function withEnv(overrides, fn) {
  const saved = {}
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  for (const [k, v] of Object.entries(overrides)) {
    process.env[k] = v
  }
  try {
    return fn()
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

test('Larry is DISABLED by default', () => {
  const cfg = withEnv({}, () => getLarryConfig())
  assert.equal(cfg.enabled, false, 'LARRY_ENABLED defaults to false')
  assert.equal(cfg.mode, 'observe', 'default mode is observe')
  assert.equal(cfg.allowLiveWeb, false, 'live web is off by default')
  assert.equal(cfg.autoSendOutreach, false, 'auto-send is off by default')
  assert.equal(cfg.requireApprovalToSend, true, 'approval gate is on by default')
})

test('classifyEmail flags disposable, role, and generic providers', () => {
  assert.deepEqual(classifyEmail('throwaway@mailinator.com').is_disposable, true)
  assert.deepEqual(classifyEmail('info@grantflow.app').is_role, true)
  assert.deepEqual(classifyEmail('exec@grantflow.app').is_org_email, true)
  assert.deepEqual(classifyEmail('exec@gmail.com').is_generic_provider, true)
  assert.equal(classifyEmail('not-an-email').valid, false)
})

test('classifyPhone accepts 10 and 11 digit US-style numbers', () => {
  assert.equal(classifyPhone('(555) 123-4567').valid, true)
  assert.equal(classifyPhone('+1 555-123-4567').valid, true)
  assert.equal(classifyPhone('1234').valid, false)
})

test('isPlaceholderUrl rejects example/localhost hosts', () => {
  assert.equal(isPlaceholderUrl('https://example.com/about'), true)
  assert.equal(isPlaceholderUrl('http://localhost:3000'), true)
  assert.equal(isPlaceholderUrl('https://grantflow.app'), false)
  assert.equal(isPlaceholderUrl(null), true)
  assert.equal(isPlaceholderUrl('not a url'), true)
})

test('isSearchEngineUrl flags Google/Bing/etc', () => {
  assert.equal(isSearchEngineUrl('https://www.google.com/search?q=foo'), true)
  assert.equal(isSearchEngineUrl('https://duckduckgo.com/?q=foo'), true)
  assert.equal(isSearchEngineUrl('https://grantflow.app'), false)
})

test('maskSecrets redacts api keys and bearer tokens', () => {
  const masked = maskSecrets({
    api_key: 'sk-abcdefghijklmnopqrstuv',
    note: 'Bearer abcdefghij1234567890',
    token: 'something-secret',
  })
  assert.match(masked.api_key, /\*{3}/)
  assert.match(masked.note, /Bearer \*{3}/)
  assert.match(masked.token, /\*{3}/)
})

test('checkSendIsAllowed: refuses when agent disabled', () => {
  const verdict = checkSendIsAllowed({
    attempt: { id: 'a1', channel: 'email', approved_by_user_id: 'u1' },
    prospect: { primary_contact_email: 'foo@bar.org' },
    config: { ...getLarryConfig(), enabled: false, requireApprovalToSend: true, fromEmail: 'a@b.c' },
  })
  assert.equal(verdict?.reason, 'agent_disabled')
})

test('checkSendIsAllowed: refuses without approval when required', () => {
  const verdict = checkSendIsAllowed({
    attempt: { id: 'a1', channel: 'email' },
    prospect: { primary_contact_email: 'foo@bar.org' },
    config: { ...getLarryConfig(), enabled: true, requireApprovalToSend: true, fromEmail: 'a@b.c' },
  })
  assert.equal(verdict?.reason, 'send_not_approved')
})

test('checkSendIsAllowed: refuses suppressed recipients', () => {
  const verdict = checkSendIsAllowed({
    attempt: { id: 'a1', channel: 'email', approved_by_user_id: 'u1', sent_to_email: 'foo@bar.org' },
    prospect: { primary_contact_email: 'foo@bar.org' },
    suppressionHits: [{ identifier_type: 'email', identifier_value: 'foo@bar.org' }],
    config: { ...getLarryConfig(), enabled: true, requireApprovalToSend: true, fromEmail: 'a@b.c' },
  })
  assert.equal(verdict?.reason, 'on_suppression_list')
})

test('checkSendIsAllowed: refuses DNC relationship', () => {
  const verdict = checkSendIsAllowed({
    attempt: { id: 'a1', channel: 'email', approved_by_user_id: 'u1', sent_to_email: 'foo@bar.org' },
    prospect: { primary_contact_email: 'foo@bar.org' },
    relationship: { do_not_contact: true, do_not_contact_reason: 'admin' },
    config: { ...getLarryConfig(), enabled: true, requireApprovalToSend: true, fromEmail: 'a@b.c' },
  })
  assert.equal(verdict?.reason, 'relationship_do_not_contact')
})

test('checkSendIsAllowed: refuses cooldown active', () => {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const verdict = checkSendIsAllowed({
    attempt: { id: 'a1', channel: 'email', approved_by_user_id: 'u1', sent_to_email: 'foo@bar.org' },
    prospect: { primary_contact_email: 'foo@bar.org' },
    relationship: { cooldown_until: future },
    config: { ...getLarryConfig(), enabled: true, requireApprovalToSend: true, fromEmail: 'a@b.c' },
  })
  assert.equal(verdict?.reason, 'cooldown_active')
})

test('checkSendIsAllowed: PASSES on healthy attempt', () => {
  const verdict = checkSendIsAllowed({
    attempt: { id: 'a1', channel: 'email', approved_by_user_id: 'u1', sent_to_email: 'foo@bar.org' },
    prospect: { primary_contact_email: 'foo@bar.org' },
    config: { ...getLarryConfig(), enabled: true, requireApprovalToSend: true, fromEmail: 'a@b.c' },
  })
  assert.equal(verdict, null, `expected null, got ${JSON.stringify(verdict)}`)
})
