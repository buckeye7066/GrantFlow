import crypto from 'node:crypto'

const ISSUER = 'https://token.actions.githubusercontent.com'
const JWKS_URL = `${ISSUER}/.well-known/jwks`
export const ZIP_CLOSURE_AUDIENCE = 'grantflow-production-zip-closure'
const EXPECTED_REPOSITORY = 'buckeye7066/GrantFlow'
const EXPECTED_WORKFLOW = `${EXPECTED_REPOSITORY}/.github/workflows/nationwide-zip-closure.yml@refs/heads/main`
const ALLOWED_REQUESTS = new Set([
  'GET /api/admin/geo/crawl/status',
  'GET /api/admin/geo/zip-coverage',
  'POST /api/admin/geo/crawl/start',
])
let cachedKeys = null
let cachedAt = 0

function decodePart(part) {
  return JSON.parse(Buffer.from(String(part), 'base64url').toString('utf8'))
}

async function loadKeys(fetchImpl) {
  if (cachedKeys && Date.now() - cachedAt < 60 * 60 * 1000) return cachedKeys
  const response = await fetchImpl(JWKS_URL, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`github_oidc_jwks_http_${response.status}`)
  const body = await response.json()
  if (!Array.isArray(body?.keys)) throw new Error('github_oidc_jwks_invalid')
  cachedKeys = body.keys
  cachedAt = Date.now()
  return cachedKeys
}

export async function verifyZipClosureOidc(token, { fetchImpl = fetch, now = Date.now() } = {}) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) return null
  let header
  let claims
  try {
    header = decodePart(parts[0])
    claims = decodePart(parts[1])
  } catch {
    return null
  }
  if (header.alg !== 'RS256' || !header.kid) return null
  const keys = await loadKeys(fetchImpl)
  const jwk = keys.find((candidate) => candidate?.kid === header.kid && candidate?.kty === 'RSA')
  if (!jwk) return null
  const validSignature = crypto.verify(
    'RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`),
    crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'),
  )
  if (!validSignature) return null
  const seconds = Math.floor(now / 1000)
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  const authorized = claims.iss === ISSUER && audiences.includes(ZIP_CLOSURE_AUDIENCE) &&
    Number(claims.nbf || 0) <= seconds + 30 && Number(claims.exp || 0) >= seconds - 30 &&
    claims.repository === EXPECTED_REPOSITORY && claims.ref === 'refs/heads/main' &&
    claims.event_name === 'workflow_dispatch' && claims.job_workflow_ref === EXPECTED_WORKFLOW &&
    claims.environment === 'production-audit'
  return authorized ? claims : null
}

export function isZipClosureRequest(method, originalUrl) {
  const path = String(originalUrl || '').split('?')[0]
  return ALLOWED_REQUESTS.has(`${String(method || '').toUpperCase()} ${path}`)
}

export function _resetGithubActionsOidcForTests() {
  cachedKeys = null
  cachedAt = 0
}
