import test from 'node:test'
import assert from 'node:assert/strict'
import { redactDiagnosticText, redactDiagnosticValue } from '../src/redact.mjs'

test('diagnostic redaction removes exact launch secrets and credential patterns', () => {
  const opaque = 'opaque-generated-value-123456'
  const input = [
    `JWT_SECRET=${opaque}`,
    'DATABASE_URL=postgresql://eva:db-password@127.0.0.1:5432/app',
    'Authorization: Bearer abc.def-secret_123',
    'GET /callback?token=query-secret&safe=1',
  ].join(' | ')
  const output = redactDiagnosticText(input, { sensitiveValues: [opaque] })
  for (const secret of [opaque, 'db-password', 'abc.def-secret_123', 'query-secret']) {
    assert.doesNotMatch(output, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.match(output, /127[.]0[.]0[.]1:5432\/app/, 'host/port/path context remains actionable')
  assert.match(output, /safe=1/)
})

test('private workstation identities are removed recursively from payload values', () => {
  const value = {
    blocker_reason: 'spawn failed at C:\\Users\\Alice\\GrantFlow\\app.js',
    journeys: [{ observed_behavior: 'also /home/bob/repo/src.js and bob@example.com' }],
  }
  const redacted = redactDiagnosticValue(value)
  assert.doesNotMatch(JSON.stringify(redacted), /Alice|\/home\/bob|bob@example[.]com/i)
  assert.match(redacted.blocker_reason, /Users\\[[]user]/)
  assert.match(redacted.journeys[0].observed_behavior, /\/home\/\[user]/)
})

