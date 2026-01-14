import crypto from 'crypto'

function deriveKey() {
  const explicit = process.env.RUNTIME_SECRETS_KEY
  if (explicit && typeof explicit === 'string' && explicit.trim()) {
    // Accept base64 or hex; fall back to utf8.
    const raw = explicit.trim()
    try {
      const buf = raw.match(/^[0-9a-f]+$/i) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
      if (buf.length >= 32) return buf.subarray(0, 32)
    } catch {
      // ignore
    }
    return crypto.createHash('sha256').update(raw).digest()
  }

  // Fallback to existing secrets in prod. These should already be set.
  const material =
    process.env.AUTH_JWT_SECRET ||
    process.env.JWT_SECRET ||
    process.env.SESSION_SECRET ||
    'grantflow-dev-secret'

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

