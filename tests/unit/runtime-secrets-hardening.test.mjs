import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import {
  decryptRuntimeSecret,
  encryptRuntimeSecret,
  ensureRuntimeSecretKeyMaterial,
  migrateRuntimeSecretRows,
  resetRuntimeSecretKeyCacheForTests,
  runtimeSecretKeyPosture,
} from '../../backend/utils/runtimeSecrets.js'

function withEnv(values, fn) {
  const prior = {}
  for (const [key, value] of Object.entries(values)) {
    prior[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const finish = () => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetRuntimeSecretKeyCacheForTests()
  }
  try {
    const result = fn()
    if (result && typeof result.then === 'function') return result.finally(finish)
    finish()
    return result
  } catch (error) {
    finish()
    throw error
  }
}

function legacyCiphertext(plaintext, authSecret) {
  const key = crypto.createHash('sha256').update(String(authSecret)).digest()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  return {
    value_ciphertext: `v1:${ciphertext.toString('base64')}`,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  }
}

function wrapDb(raw) {
  return {
    prepare(sql) {
      const stmt = raw.prepare(sql)
      return {
        async all(...args) { return stmt.all(...args) },
        async run(...args) { return stmt.run(...args) },
      }
    },
  }
}

test('runtime secrets use versioned v2 ciphertext with a dedicated environment key', () => withEnv({
  NODE_ENV: 'production',
  RUNTIME_SECRETS_KEY: '11'.repeat(32),
  RUNTIME_SECRETS_KEY_FILE: undefined,
  RUNTIME_SECRETS_KEY_PREVIOUS: undefined,
  AUTH_JWT_SECRET: 'jwt-fallback',
}, () => {
  const encrypted = encryptRuntimeSecret('secret-value')
  assert.match(encrypted.value_ciphertext, /^v2:/)
  assert.equal(decryptRuntimeSecret(encrypted), 'secret-value')
  const posture = runtimeSecretKeyPosture()
  assert.equal(posture.dedicated_key_configured, true)
  assert.equal(posture.dedicated_key_source, 'environment')
}))

test('runtime secret rotation can decrypt with the previous dedicated key', () => {
  let encrypted
  withEnv({
    NODE_ENV: 'production',
    RUNTIME_SECRETS_KEY: '22'.repeat(32),
    RUNTIME_SECRETS_KEY_FILE: undefined,
    RUNTIME_SECRETS_KEY_PREVIOUS: undefined,
    AUTH_JWT_SECRET: 'jwt-fallback',
  }, () => {
    encrypted = encryptRuntimeSecret('rotate-me')
  })

  withEnv({
    NODE_ENV: 'production',
    RUNTIME_SECRETS_KEY: '33'.repeat(32),
    RUNTIME_SECRETS_KEY_FILE: undefined,
    RUNTIME_SECRETS_KEY_PREVIOUS: '22'.repeat(32),
    AUTH_JWT_SECRET: 'jwt-fallback',
  }, () => {
    assert.equal(decryptRuntimeSecret(encrypted), 'rotate-me')
  })
})

test('production creates and reuses a 0600 dedicated key on persistent storage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grantflow-runtime-key-'))
  const keyFile = path.join(dir, 'runtime.key')
  try {
    withEnv({
      NODE_ENV: 'production',
      RUNTIME_SECRETS_KEY: undefined,
      RUNTIME_SECRETS_KEY_FILE: keyFile,
      RUNTIME_SECRETS_KEY_PREVIOUS: undefined,
      AUTH_JWT_SECRET: 'legacy-auth-key',
      SMOKE_MODE: undefined,
      ALLOW_EPHEMERAL_SQLITE: undefined,
    }, () => {
      const material = ensureRuntimeSecretKeyMaterial()
      assert.equal(material.source, 'dedicated-file')
      assert.equal(material.key_file, keyFile)
      assert.equal(fs.existsSync(keyFile), true)
      if (process.platform !== 'win32') {
        assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600)
      }
      const first = encryptRuntimeSecret('persisted')
      resetRuntimeSecretKeyCacheForTests()
      assert.equal(decryptRuntimeSecret(first), 'persisted')
      const posture = runtimeSecretKeyPosture()
      assert.equal(posture.dedicated_key_source, 'persistent_file')
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('legacy database ciphertext is migrated idempotently to the dedicated v2 key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grantflow-runtime-migrate-'))
  const keyFile = path.join(dir, 'runtime.key')
  const authSecret = 'legacy-auth-key'
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE app_runtime_secrets (
      key TEXT PRIMARY KEY,
      value_ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      tag TEXT NOT NULL,
      updated_at TEXT
    )
  `)
  const legacy = legacyCiphertext('provider-secret', authSecret)
  raw.prepare(`
    INSERT INTO app_runtime_secrets (key, value_ciphertext, iv, tag, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run('OPENAI_API_KEY', legacy.value_ciphertext, legacy.iv, legacy.tag)

  try {
    await withEnv({
      NODE_ENV: 'production',
      RUNTIME_SECRETS_KEY: undefined,
      RUNTIME_SECRETS_KEY_FILE: keyFile,
      RUNTIME_SECRETS_KEY_PREVIOUS: undefined,
      AUTH_JWT_SECRET: authSecret,
      SMOKE_MODE: undefined,
      ALLOW_EPHEMERAL_SQLITE: undefined,
    }, async () => {
      const db = wrapDb(raw)
      const first = await migrateRuntimeSecretRows(db, { logger: { info() {} } })
      assert.equal(first.migrated, 1)
      const migrated = raw.prepare('SELECT * FROM app_runtime_secrets WHERE key = ?').get('OPENAI_API_KEY')
      assert.match(migrated.value_ciphertext, /^v2:/)
      assert.equal(decryptRuntimeSecret(migrated), 'provider-secret')

      const second = await migrateRuntimeSecretRows(db, { logger: { info() {} } })
      assert.equal(second.migrated, 0)
      assert.equal(second.skipped, 1)
    })
  } finally {
    raw.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
