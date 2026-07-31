import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkRuntimeSecretKeySecurity,
  checkTwilioWebhookSecurity,
} from '../../backend/services/productionReadinessChecks.js'

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

test('production readiness rejects missing dedicated runtime-secret key', () => {
  const check = checkRuntimeSecretKeySecurity({
    env: {
      NODE_ENV: 'production',
      RUNTIME_SECRETS_KEY_FILE: '/definitely/not/present/grantflow-runtime.key',
      AUTH_JWT_SECRET: 'legacy-only',
    },
  })
  assert.equal(check.ok, false)
  assert.equal(check.level, 'error')
})

test('production readiness accepts a dedicated runtime-secret environment key', () => {
  const check = checkRuntimeSecretKeySecurity({
    env: {
      NODE_ENV: 'production',
      RUNTIME_SECRETS_KEY: '44'.repeat(32),
      AUTH_JWT_SECRET: 'legacy-for-migration-only',
    },
  })
  assert.equal(check.ok, true)
  assert.equal(check.level, 'info')
})
