import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_PRODUCTION_KEY_FILE = '/data/grantflow-runtime-secrets.key'
let warnedLegacyFallback = false
let cachedFileKey = null
let cachedFilePath = null

function isProduction(env = process.env) {
  return String(env.NODE_ENV || '').trim().toLowerCase() === 'production'
}

function isTestLikeRuntime(env = process.env) {
  const truthy = (value) => /^(1|true|yes|on)$/i.test(String(value || '').trim())
  return (
    String(env.NODE_ENV || '').trim().toLowerCase() === 'test' ||
    truthy(env.SMOKE_MODE) ||
    truthy(env.ALLOW_EPHEMERAL_SQLITE)
  )
}

function decodeKeyMaterial(rawValue, label) {
  const raw = String(rawValue || '').trim()
  if (!raw) return null

  const isHex = /^[0-9a-fA-F]{64,}$/.test(raw) && raw.length % 2 === 0
  const isBase64 = /^[A-Za-z0-9+/]+={0,2}$/.test(raw)

  if (!isHex && !isBase64) {
    throw new Error(
      `[runtimeSecrets] ${label} must be at least 32 bytes encoded as hex or base64.`,
    )
  }

  const decoded = isHex ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (decoded.length < 32) {
    throw new Error(`[runtimeSecrets] ${label} decodes to ${decoded.length} bytes; 32 are required.`)
  }
  return decoded.subarray(0, 32)
}

function keyFilePath(env = process.env) {
  const explicit = String(env.RUNTIME_SECRETS_KEY_FILE || '').trim()
  if (explicit) return path.resolve(explicit)
  if (!isProduction(env) || isTestLikeRuntime(env)) return null

  const uploadsDir = String(env.UPLOADS_DIR || '').trim()
  if (uploadsDir && path.isAbsolute(uploadsDir)) {
    const parent = path.dirname(uploadsDir)
    return path.join(parent, 'grantflow-runtime-secrets.key')
  }
  return DEFAULT_PRODUCTION_KEY_FILE
}

function readDedicatedFileKey(file) {
  if (!file || !fs.existsSync(file)) return null
  const raw = fs.readFileSync(file, 'utf8').trim()
  return decodeKeyMaterial(raw, `runtime secret key file ${file}`)
}

function loadOrCreateDedicatedFileKey(env = process.env, { create = true } = {}) {
  const file = keyFilePath(env)
  if (!file) return null
  if (cachedFileKey && cachedFilePath === file) return cachedFileKey

  let key = readDedicatedFileKey(file)
  if (!key && create) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const generated = crypto.randomBytes(32).toString('hex')
    try {
      fs.writeFileSync(file, `${generated}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    try {
      fs.chmodSync(file, 0o600)
    } catch (chmodError) {
      if (process.platform !== 'win32') throw chmodError
    }
    key = readDedicatedFileKey(file)
  }

  if (!key && create) {
    throw new Error(`[runtimeSecrets] Dedicated key file could not be created or read: ${file}`)
  }

  cachedFileKey = key
  cachedFilePath = file
  return key
}

function legacyFallbackKey(env = process.env) {
  const candidates = [
    ['AUTH_JWT_SECRET', env.AUTH_JWT_SECRET],
    ['JWT_SECRET', env.JWT_SECRET],
    ['SESSION_SECRET', env.SESSION_SECRET],
  ]
  const found = candidates.find(([, value]) => String(value || '').trim())
  if (!found) {
    if (isProduction(env) && !isTestLikeRuntime(env)) {
      throw new Error(
        '[runtimeSecrets] No legacy decryption material is available. Configure AUTH_JWT_SECRET during migration.',
      )
    }
    return crypto.createHash('sha256').update('grantflow-dev-secret').digest()
  }

  if (!warnedLegacyFallback) {
    warnedLegacyFallback = true
    console.warn(
      `[runtimeSecrets] LEGACY DECRYPTION FALLBACK enabled from ${found[0]}. ` +
      'New ciphertext uses the dedicated runtime-secrets key; legacy material is retained only for migration.',
    )
  }
  return crypto.createHash('sha256').update(String(found[1])).digest()
}

function currentEncryptionKey(env = process.env) {
  const explicit = decodeKeyMaterial(env.RUNTIME_SECRETS_KEY, 'RUNTIME_SECRETS_KEY')
  if (explicit) return { name: 'dedicated-env', key: explicit }

  const fileKey = loadOrCreateDedicatedFileKey(env, { create: true })
  if (fileKey) return { name: 'dedicated-file', key: fileKey }

  return { name: 'legacy-dev', key: legacyFallbackKey(env) }
}

function keyCandidates(env = process.env) {
  const candidates = []
  const current = decodeKeyMaterial(env.RUNTIME_SECRETS_KEY, 'RUNTIME_SECRETS_KEY')
  if (current) candidates.push({ name: 'dedicated-env', key: current })

  // Decryption NEVER creates key material. A freshly-minted random key cannot
  // decrypt pre-existing ciphertext, so creating one here bought nothing and
  // made a read path write to persistent storage — which hard-fails (EACCES)
  // anywhere the production key directory is not writable, e.g. CI runners.
  // The encrypt path (currentEncryptionKey) remains the sole creator.
  const fileKey = loadOrCreateDedicatedFileKey(env, { create: false })
  if (fileKey) candidates.push({ name: 'dedicated-file', key: fileKey })

  const previous = decodeKeyMaterial(
    env.RUNTIME_SECRETS_KEY_PREVIOUS,
    'RUNTIME_SECRETS_KEY_PREVIOUS',
  )
  if (previous) candidates.push({ name: 'dedicated-previous', key: previous })

  const hasLegacyMaterial = Boolean(
    String(env.AUTH_JWT_SECRET || env.JWT_SECRET || env.SESSION_SECRET || '').trim(),
  )
  if (hasLegacyMaterial || candidates.length === 0) {
    candidates.push({ name: 'legacy-auth-derived', key: legacyFallbackKey(env) })
  }
  return candidates
}

export function ensureRuntimeSecretKeyMaterial(env = process.env) {
  const current = currentEncryptionKey(env)
  return {
    source: current.name,
    key_file: current.name === 'dedicated-file' ? keyFilePath(env) : null,
  }
}

export function runtimeSecretKeyPosture(env = process.env) {
  const file = keyFilePath(env)
  const fileExists = Boolean(file && fs.existsSync(file))
  const envConfigured = Boolean(String(env.RUNTIME_SECRETS_KEY || '').trim())
  return {
    dedicated_key_configured: envConfigured || fileExists,
    dedicated_key_source: envConfigured ? 'environment' : fileExists ? 'persistent_file' : null,
    dedicated_key_file: file || null,
    dedicated_key_file_exists: fileExists,
    previous_key_configured: Boolean(String(env.RUNTIME_SECRETS_KEY_PREVIOUS || '').trim()),
    legacy_fallback_available: Boolean(
      String(env.AUTH_JWT_SECRET || env.JWT_SECRET || env.SESSION_SECRET || '').trim(),
    ),
  }
}

export function encryptRuntimeSecret(plaintext, env = process.env) {
  const { key } = currentEncryptionKey(env)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return {
    value_ciphertext: `v2:${ciphertext.toString('base64')}`,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  }
}

function decryptWithKey({ ciphertext, iv, tag, key }) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

export function decryptRuntimeSecret({ value_ciphertext, iv, tag }, env = process.env) {
  const encoded = String(value_ciphertext || '')
  const payload = /^(?:v1|v2):/.test(encoded) ? encoded.slice(3) : encoded
  const ivBuf = Buffer.from(String(iv), 'base64')
  const tagBuf = Buffer.from(String(tag), 'base64')
  const cipherBuf = Buffer.from(payload, 'base64')

  let lastError = null
  for (const candidate of keyCandidates(env)) {
    try {
      return decryptWithKey({
        ciphertext: cipherBuf,
        iv: ivBuf,
        tag: tagBuf,
        key: candidate.key,
      })
    } catch (error) {
      lastError = error
    }
  }

  throw new Error(
    `[runtimeSecrets] Unable to decrypt with current, previous, persistent-file, or legacy key material: ` +
    `${lastError?.message || 'authentication failed'}`,
  )
}

export async function migrateRuntimeSecretRows(db, { logger = console, env = process.env } = {}) {
  if (!db?.prepare) return { migrated: 0, skipped: 0 }
  ensureRuntimeSecretKeyMaterial(env)

  let rows
  try {
    rows = await db.prepare(`
      SELECT key, value_ciphertext, iv, tag
      FROM app_runtime_secrets
    `).all()
  } catch (error) {
    if (/does not exist|no such table/i.test(String(error?.message || error))) {
      return { migrated: 0, skipped: 0, table_missing: true }
    }
    throw error
  }

  let migrated = 0
  let skipped = 0
  for (const row of rows || []) {
    if (String(row?.value_ciphertext || '').startsWith('v2:')) {
      skipped += 1
      continue
    }
    const plaintext = decryptRuntimeSecret(row, env)
    const encrypted = encryptRuntimeSecret(plaintext, env)
    await db.prepare(`
      UPDATE app_runtime_secrets
      SET value_ciphertext = ?, iv = ?, tag = ?, updated_at = CURRENT_TIMESTAMP
      WHERE key = ?
    `).run(encrypted.value_ciphertext, encrypted.iv, encrypted.tag, row.key)
    migrated += 1
  }

  if (migrated > 0) {
    logger.info?.('[runtimeSecrets] migrated encrypted rows to dedicated v2 key', { migrated })
  }
  return { migrated, skipped }
}

export function resetRuntimeSecretKeyCacheForTests() {
  cachedFileKey = null
  cachedFilePath = null
  warnedLegacyFallback = false
}
