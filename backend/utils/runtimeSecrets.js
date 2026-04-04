import crypto from 'crypto'

function deriveKey() {
  const explicit = process.env.RUNTIME_SECRETS_KEY
  if (explicit && typeof explicit === 'string' && explicit.trim()) {
    // Accept base64 or hex; fall back to utf8.
    const raw = explicit.trim()
    try {
      const isHex = /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0
if (!isHex && !/^[A-Za-z0-9+/]+=*$/.test(raw)) {
  throw new Error(
    `[runtimeSecrets] RUNTIME_SECRETS_KEY does not look like valid hex or base64. ` +
    'Provide a 32-byte value encoded as 64 hex chars or 44 base64 chars.'
  )
}
const buf = isHex ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
      if (buf.length >= 32) return buf.subarray(0, 32)
      // Key material decoded but too short â hash-stretch it so the explicit key is still used
      return crypto.createHash('sha256').update(buf).digest()
    } catch (err) {
      // Explicit key could not be parsed â fail loudly rather than silently downgrading
      throw new Error(
        `[runtimeSecrets] RUNTIME_SECRETS_KEY is set but could not be parsed (${err.message}). ` +
        'Refusing to fall back to weaker key material. Fix the env var or remove it to use the automatic fallback.'
      )
    }
  }

  // Fallback to existing secrets in prod. These should already be set.
  const KEY_CANDIDATES = [
    ['AUTH_JWT_SECRET', process.env.AUTH_JWT_SECRET],
    ['JWT_SECRET', process.env.JWT_SECRET],
    ['SESSION_SECRET', process.env.SESSION_SECRET],
  ]
  const found = KEY_CANDIDATES.find(([, v]) => v)
  const material = found ? found[1] : undefined
  if (found) {
    console.warn(
      `[runtimeSecrets] Using ${found[0]} as fallback key material. ` +
      'Set RUNTIME_SECRETS_KEY explicitly to avoid silent key changes on secret rotation.'
    )
  }

  if (!material) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        '[runtimeSecrets] No key material available in production. ' +
        'Set RUNTIME_SECRETS_KEY, AUTH_JWT_SECRET, JWT_SECRET, or SESSION_SECRET.'
      )
    }
    // Dev/test only â predictable key is acceptable outside production
    return crypto.createHash('sha256').update('grantflow-dev-secret').digest()
  }

  return crypto.createHash('sha256').update(String(material)).digest()
}

export function encryptRuntimeSecret(plaintext) {
  const key = deriveKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return {
    value_ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  }
}

export function decryptRuntimeSecret({ value_ciphertext, iv, tag }) {
  const key = deriveKey()
  const ivBuf = Buffer.from(String(iv), 'base64')
  const tagBuf = Buffer.from(String(tag), 'base64')
  const cipherBuf = Buffer.from(String(value_ciphertext), 'base64')

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, ivBuf)
  decipher.setAuthTag(tagBuf)
  const plaintext = Buffer.concat([decipher.update(cipherBuf), decipher.final()])
  return plaintext.toString('utf8')
}

