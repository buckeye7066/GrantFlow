import test from 'node:test'
import assert from 'node:assert/strict'
import { checkTwilioWebhookSecurity } from '../../backend/services/productionReadinessChecks.js'

test('production readiness rejects configured Twilio without a signing token', () => {
  const check = checkTwilioWebhookSecurity({
    env: { NODE_ENV: 'production', TWILIO_ACCOUNT_SID: 'AC123' },
  })
  assert.equal(check.ok, false)
  assert.equal(check.level, 'error')
})

test('production readiness rejects signature bypass even with a token', () => {
  const check = checkTwilioWebhookSecurity({
    env: {
      NODE_ENV: 'production',
      TWILIO_ACCOUNT_SID: 'AC123',
      TWILIO_AUTH_TOKEN: 'secret',
      TWILIO_VALIDATE_SIGNATURE: 'false',
    },
  })
  assert.equal(check.ok, false)
})

test('production readiness accepts signed Twilio configuration', () => {
  const check = checkTwilioWebhookSecurity({
    env: {
      NODE_ENV: 'production',
      TWILIO_ACCOUNT_SID: 'AC123',
      TWILIO_AUTH_TOKEN: 'secret',
    },
  })
  assert.equal(check.ok, true)
})
