import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decryptRuntimeSecret,
  encryptRuntimeSecret,
  runtimeSecretKeyPosture,
} from '../../backend/utils/runtimeSecrets.js'

function withEnv(values, fn) {
  const prior = {}
  for (const [key, value] of Object.entries(values)) {
    prior[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return fn()
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('runtime secrets use versioned ciphertext with a dedicated key', () => withEnv({
  RUNTIME_SECRETS_KEY: '11'.repeat(32),
  RUNTIME_SECRETS_KEY_PREVIOUS: undefined,
  AUTH_JWT_SECRET: 'jwt-fallback',
}, () => {
  const encrypted = encryptRuntimeSecret('secret-value')
  assert.match(encrypted.value_ciphertext, /^v1:/)
  assert.equal(decryptRuntimeSecret(encrypted), 'secret-value')
  assert.equal(runtimeSecretKeyPosture().dedicated_key_configured, true)
}))

test('runtime secret rotation can decrypt with the previous dedicated key', () => {
  let encrypted
  withEnv({
    RUNTIME_SECRETS_KEY: '22'.repeat(32),
    RUNTIME_SECRETS_KEY_PREVIOUS: undefined,
    AUTH_JWT_SECRET: 'jwt-fallback',
  }, () => {
    encrypted = encryptRuntimeSecret('rotate-me')
  })

  withEnv({
    RUNTIME_SECRETS_KEY: '33'.repeat(32),
    RUNTIME_SECRETS_KEY_PREVIOUS: '22'.repeat(32),
    AUTH_JWT_SECRET: 'jwt-fallback',
  }, () => {
    assert.equal(decryptRuntimeSecret(encrypted), 'rotate-me')
  })
})
