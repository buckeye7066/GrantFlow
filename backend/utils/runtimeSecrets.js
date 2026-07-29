import crypto from 'node:crypto'

let warnedLegacyFallback = false

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

function legacyFallbackKey(env = process.env) {
  const candidates = [
    ['AUTH_JWT_SECRET', env.AUTH_JWT_SECRET],
    ['JWT_SECRET', env.JWT_SECRET],
    ['SESSION_SECRET', env.SESSION_SECRET],
  ]
  const found = candidates.find(([, value]) => String(value || '').trim())
  if (!found) {
    if (String(env.NODE_ENV || '').toLowerCase() === 'production') {
      throw new Error(
        '[runtimeSecrets] No encryption key material is available. Set RUNTIME_SECRETS_KEY.',
      )
    }
    return crypto.createHash('sha256').update('grantflow-dev-secret').digest()
  }

  if (!warnedLegacyFallback) {
    warnedLegacyFallback = true
    console.warn(
      `[runtimeSecrets] LEGACY FALLBACK: deriving encryption from ${found[0]}. ` +
      'Set RUNTIME_SECRETS_KEY and retain the old auth key temporarily in ' +
      'RUNTIME_SECRETS_KEY_PREVIOUS during rotation.',
    )
  }
  return crypto.createHash('sha256').update(String(found[1])).digest()
}

function keyCandidates(env = process.env) {
  const candidates = []
  const current = decodeKeyMaterial(env.RUNTIME_SECRETS_KEY, 'RUNTIME_SECRETS_KEY')
  if (current) candidates.push({ name: 'dedicated-current', key: current })

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

export function runtimeSecretKeyPosture(env = process.env) {
  return {
    dedicated_key_configured: Boolean(String(env.RUNTIME_SECRETS_KEY || '').trim()),
    previous_key_configured: Boolean(String(env.RUNTIME_SECRETS_KEY_PREVIOUS || '').trim()),
    legacy_fallback_available: Boolean(
      String(env.AUTH_JWT_SECRET || env.JWT_SECRET || env.SESSION_SECRET || '').trim(),
    ),
  }
}

export function encryptRuntimeSecret(plaintext) {
  const [{ key }] = keyCandidates()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return {
    value_ciphertext: `v1:${ciphertext.toString('base64')}`,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  }
}

function decryptWithKey({ ciphertext, iv, tag, key }) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

export function decryptRuntimeSecret({ value_ciphertext, iv, tag }) {
  const encoded = String(value_ciphertext || '')
  const payload = encoded.startsWith('v1:') ? encoded.slice(3) : encoded
  const ivBuf = Buffer.from(String(iv), 'base64')
  const tagBuf = Buffer.from(String(tag), 'base64')
  const cipherBuf = Buffer.from(payload, 'base64')

  let lastError = null
  for (const candidate of keyCandidates()) {
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
    `[runtimeSecrets] Unable to decrypt with current, previous, or legacy key material: ` +
    `${lastError?.message || 'authentication failed'}`,
  )
}
