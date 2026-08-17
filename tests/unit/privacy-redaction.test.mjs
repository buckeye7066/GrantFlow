import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isSensitiveTelemetryKey,
  redactTelemetryString,
  sanitizeTelemetryEvent,
  sanitizeTelemetryValue,
} from '../../shared/privacyRedaction.js'
import { buildSafeErrorContext } from '../../backend/services/errorReporter.js'

test('telemetry redaction removes credentials and applicant identifiers from nested events', () => {
  const event = {
    request: {
      headers: {
        authorization: 'Bearer secret-token-value',
        cookie: 'session=abc123',
      },
      url: 'https://example.test/callback?code=oauth-code&token=access-token',
    },
    user: {
      email: 'person@example.org',
      phone: '(614) 555-1212',
    },
    apiKey: 'sk-live-secret',
  }

  const safe = sanitizeTelemetryEvent(event)
  const serialized = JSON.stringify(safe)

  assert.equal(safe.request.headers, undefined)
  assert.equal(safe.user, undefined)
  assert.equal(safe.request.url, 'https://example.test/callback')
  assert.equal(safe.apiKey, '[REDACTED]')
  assert.doesNotMatch(serialized, /secret-token|abc123|oauth-code|access-token|person@example|614|sk-live/)
})

test('redaction is bounded and circular-safe', () => {
  const value = { message: `Contact a@example.org ${'x'.repeat(100)}` }
  value.self = value
  const safe = sanitizeTelemetryValue(value, { maxStringLength: 40 })

  assert.equal(safe.self, '[CIRCULAR]')
  assert.ok(safe.message.length <= 40)
  assert.doesNotMatch(safe.message, /a@example\.org/)
})

test('sensitive key and inline secret patterns cover camelCase and query values', () => {
  assert.equal(isSensitiveTelemetryKey('refreshToken'), true)
  assert.equal(isSensitiveTelemetryKey('primary_email'), true)
  assert.equal(
    redactTelemetryString('password=hunter2 url=https://x.test/?signature=abc'),
    'password=[REDACTED] url=https://x.test/?signature=[REDACTED]',
  )
})

test('event sanitation drops SDK-added request payloads and network identity', () => {
  const event = sanitizeTelemetryEvent({
    user: { id: 'applicant-7', email: 'person@example.org', ip_address: '192.0.2.7' },
    request: {
      method: 'POST',
      url: 'https://grantflow.example/api/profiles/applicant-7?token=secret',
      headers: { authorization: 'Bearer abc.def.ghi' },
      cookies: { session: 'private' },
      data: { legal_name: 'Private Person' },
      query_string: 'token=secret',
      env: { REMOTE_ADDR: '192.0.2.7' },
    },
  })

  assert.equal(event.user, undefined)
  assert.deepEqual({ ...event.request }, {
    method: 'POST',
    url: 'https://grantflow.example/api/profiles/applicant-7',
  })
})

test('the production owner-report path redacts error and route payloads', () => {
  const safe = buildSafeErrorContext(
    new Error('Applicant person@example.org sent password=hunter2 from 192.0.2.7'),
    {
      source: 'backend',
      route: '/api/profiles/private-profile-id?token=oauth-secret',
      method: 'POST',
      statusCode: 500,
    },
  )
  const serialized = JSON.stringify(safe)

  assert.doesNotMatch(serialized, /person@example|hunter2|192\.0\.2\.7|oauth-secret/)
  assert.match(safe.message, /\[REDACTED_EMAIL\]/)
  assert.match(safe.message, /password=\[REDACTED\]/)
  assert.match(safe.route, /token=\[REDACTED\]/)
})
