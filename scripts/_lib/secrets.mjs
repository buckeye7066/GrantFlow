export function redactSecret(_value) {
  return '[REDACTED]'
}

export function hasSecret(value) {
  return Boolean(typeof value === 'string' && value.trim())
}

export function requireEnv(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) {
    const err = new Error(`Missing required environment variable: ${name}`)
    err.code = 'MISSING_ENV'
    throw err
  }
  return value
}

export function resolveAdminToken({ required = false } = {}) {
  const token =
    String(process.env.ADMIN_TOKEN || '').trim() ||
    String(process.env.ANYA_ADMIN_TOKEN || '').trim() ||
    null

  if (!token && required) {
    const err = new Error('Missing admin token. Set ADMIN_TOKEN or ANYA_ADMIN_TOKEN.')
    err.code = 'MISSING_ADMIN_TOKEN'
    throw err
  }

  return token
}

