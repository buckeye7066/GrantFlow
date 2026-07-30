import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const BASE_URL = 'https://app.axiombiolabs.org'
const EXPECTED_SHA = '12ee0af3be440c093f0daf50eedd573d504ee317'
const AUDIT_EMAIL = 'buckeye7066+grantflow-production-audit@gmail.com'
const OUT_DIR = path.resolve('audit-dist')
const CHALLENGE_TTL_MS = 25 * 60 * 1000

const b64u = (value) => Buffer.from(value).toString('base64url')
const secretKey = () => {
  const secret = String(process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN || '').trim()
  if (!secret) throw new Error('ADMIN_TOKEN/ANYA_ADMIN_TOKEN unavailable to protected audit build')
  return crypto.createHash('sha256').update(secret).digest()
}

async function requestJson(pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    method,
    redirect: 'follow',
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-store',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}: ${json?.error || text}`)
  return json
}

const fresh = Date.now()
const [build, mission] = await Promise.all([
  requestJson(`/api/meta/build?fresh=${fresh}`),
  requestJson(`/api/health/mission?fresh=${fresh}`),
])
const counts = mission?.counts || {}
const blockers = Array.isArray(mission?.release_blockers) ? mission.release_blockers : []
if (build?.sha !== EXPECTED_SHA) throw new Error(`deployed SHA mismatch: ${build?.sha || 'missing'}`)
if (mission?.production_gate !== true || blockers.length > 0) throw new Error('production mission gate is not clean')
if (
  Number(counts.direct_opportunities_broken || 0) !== 0 ||
  Number(counts.quarantined_broken_direct_opportunities || 0) !== 0 ||
  Number(counts.repair_pending_broken_direct_opportunities || 0) !== 0
) throw new Error('unsafe link lifecycle counters are nonzero')

const start = await requestJson('/api/auth/password/reset/start', {
  method: 'POST',
  body: { email: AUDIT_EMAIL },
})

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
const iv = crypto.randomBytes(12)
const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv)
const encrypted = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()])
const payload = {
  v: 2,
  purpose: 'password_reset_token',
  exp: Date.now() + CHALLENGE_TTL_MS,
  iv: b64u(iv),
  tag: b64u(cipher.getAuthTag()),
  ct: b64u(encrypted),
}
const challenge = b64u(JSON.stringify(payload))
const output = {
  audit: 'grantflow-final-authenticated-audit-challenge-v2',
  expected_sha: EXPECTED_SHA,
  generated_at: new Date().toISOString(),
  expires_at: new Date(payload.exp).toISOString(),
  challenge,
  public_key_b64u: b64u(publicKey),
  email_sent: start?.email_sent === true,
  account: '<dedicated-non-admin-audit-account>',
  values_exposed: false,
}

fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(path.join(OUT_DIR, 'challenge.json'), JSON.stringify(output, null, 2) + '\n')
fs.writeFileSync(
  path.join(OUT_DIR, 'index.html'),
  '<!doctype html><meta charset="utf-8"><title>GrantFlow audit challenge</title><p>Protected audit challenge generated.</p>',
)
console.log(`[final-audit-challenge] READY ${JSON.stringify(output)}`)
