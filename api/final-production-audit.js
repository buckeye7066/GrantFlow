import crypto from 'node:crypto'
import chromiumBinary from '@sparticuz/chromium'
import { chromium as playwrightChromium } from 'playwright-core'

export const config = { maxDuration: 300 }

const BASE_URL = 'https://app.axiombiolabs.org'
const EXPECTED_SHA = '12ee0af3be440c093f0daf50eedd573d504ee317'
const AUDIT_EMAIL = 'buckeye7066@gmail.com'
const PROFILE_IDS = [
  'profile-hollie-knox',
  '6b3c75ec-dc56-46f9-b380-394172688175',
  'c4a92724-9cee-416f-ba30-e91b9b5cd885',
  'profile-olivia-beltran',
  'profile-john-white',
]
const CHALLENGE_TTL_MS = 8 * 60 * 1000

const b64u = (value) => Buffer.from(value).toString('base64url')
const unb64u = (value) => Buffer.from(String(value || ''), 'base64url')
const clean = (value, max = 500) => String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, max)
const safeUrl = (value) => {
  try {
    const url = new URL(String(value || ''))
    return `${url.origin}${url.pathname}`
  } catch {
    return clean(value, 300)
  }
}

function secretKey() {
  const secret = String(process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN || '').trim()
  if (!secret) throw new Error('protected audit key unavailable')
  return crypto.createHash('sha256').update(secret).digest()
}

function sealPrivateKey(privateKey) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv)
  const encrypted = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()])
  const payload = {
    v: 1,
    exp: Date.now() + CHALLENGE_TTL_MS,
    iv: b64u(iv),
    tag: b64u(cipher.getAuthTag()),
    ct: b64u(encrypted),
  }
  return b64u(JSON.stringify(payload))
}

function openPrivateKey(challenge) {
  const payload = JSON.parse(unb64u(challenge).toString('utf8'))
  if (payload?.v !== 1 || !Number.isFinite(Number(payload?.exp)) || Date.now() > Number(payload.exp)) {
    throw new Error('audit challenge expired or invalid')
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), unb64u(payload.iv))
  decipher.setAuthTag(unb64u(payload.tag))
  return Buffer.concat([decipher.update(unb64u(payload.ct)), decipher.final()]).toString('utf8')
}

async function requestJson(path, { method = 'GET', body, token, admin = false, timeoutMs = 90_000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-store',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(admin ? { 'x-admin-token': String(process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN || '') } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    return { ok: response.ok, status: response.status, json, error: response.ok ? null : clean(json?.error || text) }
  } finally {
    clearTimeout(timer)
  }
}

function summarizeResponse(result) {
  const body = result?.json
  let count = null
  if (Array.isArray(body)) count = body.length
  else if (Array.isArray(body?.items)) count = body.items.length
  else if (Array.isArray(body?.results)) count = body.results.length
  else if (Array.isArray(body?.tasks)) count = body.tasks.length
  else if (Array.isArray(body?.runs)) count = body.runs.length
  else if (Number.isFinite(Number(body?.total))) count = Number(body.total)
  return {
    status: Number(result?.status || 0),
    ok: result?.ok === true,
    count,
    keys: body && typeof body === 'object' ? Object.keys(body).slice(0, 20) : [],
    error: result?.ok ? null : clean(result?.error || body?.error),
  }
}

async function verifyLiveGate() {
  const fresh = Date.now()
  const [build, ready, health, storage, dataReadiness, alerts, mission] = await Promise.all([
    requestJson(`/api/meta/build?fresh=${fresh}`),
    requestJson(`/readyz?fresh=${fresh}`),
    requestJson(`/api/health?fresh=${fresh}`),
    requestJson(`/api/health/storage?fresh=${fresh}`),
    requestJson(`/api/health/data-readiness?fresh=${fresh}`),
    requestJson(`/api/health/alerts?fresh=${fresh}`),
    requestJson(`/api/health/mission?fresh=${fresh}`),
  ])
  const counts = mission.json?.counts || {}
  const rates = mission.json?.rates || {}
  const blockers = Array.isArray(mission.json?.release_blockers) ? mission.json.release_blockers : []
  const result = {
    sha: build.json?.sha || null,
    ready: ready.ok && ready.json?.ok === true,
    health_status: health.status,
    storage_status: storage.status,
    storage_ok: storage.json?.ok === true,
    data_readiness_status: dataReadiness.status,
    data_readiness: dataReadiness.json?.status || null,
    alerts_status: alerts.status,
    alert_count: Array.isArray(alerts.json?.alerts) ? alerts.json.alerts.length : null,
    production_gate: mission.json?.production_gate ?? null,
    release_blockers: blockers,
    direct_broken: Number(counts.direct_opportunities_broken || 0),
    quarantined: Number(counts.quarantined_broken_direct_opportunities || 0),
    repair_pending: Number(counts.repair_pending_broken_direct_opportunities || 0),
    scheduled_retry: Number(counts.scheduled_retry_broken_direct_opportunities || 0),
    verified_pct: Number(rates.verified_pct || 0),
    broken_pct: Number(rates.broken_pct || 0),
    runtime_secret_key: mission.json?.production_readiness?.checks?.find((entry) => entry?.id === 'runtime_secret_key_security') || null,
  }
  if (result.sha !== EXPECTED_SHA) throw new Error(`deployed SHA mismatch: ${result.sha || 'missing'}`)
  if (!result.ready || !result.storage_ok) throw new Error('readiness or persistent storage failed')
  if (result.production_gate !== true || blockers.length) throw new Error('mission gate or release blockers failed')
  if (result.direct_broken !== 0 || result.quarantined !== 0 || result.repair_pending !== 0) {
    throw new Error('unsafe link lifecycle counters are nonzero')
  }
  if (result.verified_pct < 95 || result.alert_count !== 0) throw new Error('verification target or alert gate failed')
  return result
}

async function runBrowserAudit(accessToken, refreshToken, userPayload) {
  const executablePath = await chromiumBinary.executablePath()
  const browser = await playwrightChromium.launch({
    args: chromiumBinary.args,
    executablePath,
    headless: true,
  })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const blocked = []
  const consoleErrors = []
  const failedRequests = []

  await context.addInitScript(({ access, refresh, activeProfile }) => {
    window.localStorage.setItem('grantflow:access-token', access)
    if (refresh) window.localStorage.setItem('grantflow:refresh-token', refresh)
    if (activeProfile) window.localStorage.setItem('grantflow:active-profile-id', activeProfile)
  }, {
    access: accessToken,
    refresh: refreshToken,
    activeProfile: userPayload?.active_profile_id || null,
  })

  await context.route('**/*', async (route) => {
    const req = route.request()
    const method = req.method().toUpperCase()
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return route.continue()
    const url = safeUrl(req.url())
    const redFlag = /submit|attest|authoriz|payment|billing|purchase|checkout|portal-sync\/(?:write|sync)|auto-?submit|\/approve|credential|vault/i.test(url)
    blocked.push({ method, url, red_flag: redFlag })
    return route.abort('blockedbyclient')
  })

  const page = await context.newPage()
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(clean(message.text()))
  })
  page.on('requestfailed', (request) => {
    const error = request.failure()?.errorText || ''
    if (!error.includes('blockedbyclient')) failedRequests.push({ method: request.method(), url: safeUrl(request.url()), error: clean(error) })
  })

  const steps = []
  const step = async (name, fn) => {
    try {
      const value = await fn()
      steps.push({ name, ok: true, value: value ?? null })
      return value
    } catch (error) {
      steps.push({ name, ok: false, error: clean(error?.message || error) })
      return null
    }
  }
  const apiGet = async (path, profileId = null) => page.evaluate(async ({ path, profileId }) => {
    const token = window.localStorage.getItem('grantflow:access-token')
    const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` }
    if (profileId) headers['X-Profile-Id'] = profileId
    const response = await fetch(path, { credentials: 'include', headers })
    const text = await response.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    let count = null
    if (Array.isArray(json)) count = json.length
    else if (Array.isArray(json?.items)) count = json.items.length
    else if (Array.isArray(json?.results)) count = json.results.length
    else if (Array.isArray(json?.tasks)) count = json.tasks.length
    else if (Array.isArray(json?.runs)) count = json.runs.length
    else if (Number.isFinite(Number(json?.total))) count = Number(json.total)
    return { status: response.status, ok: response.ok, count, keys: json && typeof json === 'object' ? Object.keys(json).slice(0, 20) : [] }
  }, { path, profileId })

  const landing = await step('load authenticated app', async () => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {})
    return { url: page.url(), title: await page.title(), text: clean(await page.locator('body').innerText(), 700) }
  })
  const identity = await step('identity and scope', async () => apiGet('/api/auth/me'))
  const profiles = []
  for (const profileId of PROFILE_IDS) {
    const capture = { profile_id: profileId }
    capture.funding_sources = await step(`${profileId}: funding sources`, async () => apiGet(`/api/profiles/${profileId}/funding-sources`, profileId))
    capture.hamilton_tasks = await step(`${profileId}: hamilton tasks`, async () => apiGet(`/api/hamilton/automation/tasks?profileId=${profileId}`, profileId))
    capture.hamilton_readiness = await step(`${profileId}: hamilton readiness`, async () => apiGet(`/api/hamilton/automation/readiness?profileId=${profileId}`, profileId))
    capture.portal_sync_runs = await step(`${profileId}: portal sync runs`, async () => apiGet(`/api/hamilton/portal-sync/runs?profileId=${profileId}`, profileId))
    await step(`${profileId}: funding view`, async () => {
      await page.evaluate((id) => window.localStorage.setItem('grantflow:active-profile-id', id), profileId)
      await page.goto(`${BASE_URL}/FundingResults`, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
      return { url: page.url(), title: await page.title(), text: clean(await page.locator('body').innerText(), 500) }
    })
    profiles.push(capture)
  }

  const surfaces = []
  for (const route of ['/MyProfiles', '/Pipeline', '/HamiltonProcessing']) {
    surfaces.push(await step(`surface ${route}`, async () => {
      await page.goto(`${BASE_URL}${route}`, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
      return { route, url: page.url(), title: await page.title(), text: clean(await page.locator('body').innerText(), 500) }
    }))
  }
  const mission = await step('Amy visible mission status', async () => apiGet('/api/health/mission'))
  await browser.close()

  const profileEvidenceCount = profiles.filter((profile) =>
    [profile.funding_sources, profile.hamilton_tasks, profile.portal_sync_runs].some((entry) => entry?.status > 0)
  ).length
  return {
    signed_in: identity?.status === 200,
    account: {
      email: '<redacted>',
      is_admin: Boolean(userPayload?.is_admin),
      accessible_profile_count: Array.isArray(userPayload?.profiles) ? userPayload.profiles.length : null,
    },
    landing,
    identity,
    profiles,
    profile_evidence_count: profileEvidenceCount,
    surfaces,
    mission,
    steps,
    mutations_blocked: blocked,
    red_flag_attempts: blocked.filter((entry) => entry.red_flag),
    console_errors: consoleErrors.slice(0, 50),
    failed_requests: failedRequests.slice(0, 50),
  }
}

async function runFinalAudit(code, challenge, ciphertext) {
  const privateKey = openPrivateKey(challenge)
  const decrypted = crypto.privateDecrypt({
    key: privateKey,
    oaepHash: 'sha256',
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
  }, unb64u(ciphertext)).toString('utf8')
  if (decrypted !== code || !/^\d{6}$/.test(code)) throw new Error('encrypted verification code invalid')

  const auth = await requestJson('/api/auth/email/verify', {
    method: 'POST',
    body: { email: AUDIT_EMAIL, code },
    timeoutMs: 180_000,
  })
  if (!auth.ok || !auth.json?.accessToken) throw new Error(`email verification failed (${auth.status}): ${auth.error || 'no token'}`)

  const posture = await verifyLiveGate()
  const browser = await runBrowserAudit(auth.json.accessToken, auth.json.refreshToken, auth.json.user)
  const params = new URLSearchParams({ profiles: PROFILE_IDS.join(','), match_limit: '100' })
  const snapshot = await requestJson(`/api/admin/queue/production-audit/snapshot?${params}`, {
    admin: true,
    timeoutMs: 180_000,
  })
  const adminSnapshot = {
    status: snapshot.status,
    ok: snapshot.ok,
    keys: snapshot.json && typeof snapshot.json === 'object' ? Object.keys(snapshot.json).slice(0, 30) : [],
    generated_at: snapshot.json?.generated_at || null,
    profile_count: Array.isArray(snapshot.json?.profiles) ? snapshot.json.profiles.length : null,
    finding_count: Array.isArray(snapshot.json?.findings) ? snapshot.json.findings.length : null,
    safety: snapshot.json?.safety || null,
    error: snapshot.ok ? null : snapshot.error,
  }

  await requestJson('/api/auth/logout', {
    method: 'POST',
    body: { refreshToken: auth.json.refreshToken },
    token: auth.json.accessToken,
    timeoutMs: 30_000,
  }).catch(() => null)

  const fatal = []
  if (!browser.signed_in) fatal.push('authenticated browser identity failed')
  if (browser.profile_evidence_count === 0) fatal.push('no profile yielded authenticated evidence')
  if (browser.red_flag_attempts.length > 0) fatal.push('red-flag mutation attempts were generated')
  if (!adminSnapshot.ok) fatal.push('read-only production snapshot failed')

  return {
    ok: fatal.length === 0,
    audit: 'grantflow-final-authenticated-production-audit-v2',
    exact_deployed_sha: EXPECTED_SHA,
    generated_at: new Date().toISOString(),
    safety_model: 'GET/HEAD/OPTIONS allowed; all browser mutations blocked before network; authentication performed server-side; logout permitted as cleanup',
    posture,
    browser,
    admin_snapshot: adminSnapshot,
    fatal,
    values_exposed: false,
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  try {
    const action = String(req.query?.action || '')
    if (action === 'start') {
      await verifyLiveGate()
      const start = await requestJson('/api/auth/email/start', {
        method: 'POST',
        body: { email: AUDIT_EMAIL },
        timeoutMs: 90_000,
      })
      if (!start.ok) return res.status(start.status || 500).json({ ok: false, error: start.error || 'email start failed' })
      const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      })
      return res.status(200).json({
        ok: true,
        challenge: sealPrivateKey(privateKey),
        public_key: publicKey,
        expires_in_seconds: Math.floor(CHALLENGE_TTL_MS / 1000),
        email_sent: start.json?.email_sent === true,
        account: '<redacted>',
      })
    }
    if (action === 'verify') {
      const challenge = String(req.query?.challenge || '')
      const ciphertext = String(req.query?.ciphertext || '')
      const codeProof = String(req.query?.proof || '')
      if (!challenge || !ciphertext || !codeProof) return res.status(400).json({ ok: false, error: 'encrypted audit proof required' })
      const privateKey = openPrivateKey(challenge)
      const code = crypto.privateDecrypt({
        key: privateKey,
        oaepHash: 'sha256',
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      }, unb64u(ciphertext)).toString('utf8')
      const expectedProof = crypto.createHash('sha256').update(`${challenge}:${code}`).digest('base64url')
      if (!crypto.timingSafeEqual(Buffer.from(expectedProof), Buffer.from(codeProof))) {
        return res.status(400).json({ ok: false, error: 'audit proof mismatch' })
      }
      const report = await runFinalAudit(code, challenge, ciphertext)
      return res.status(report.ok ? 200 : 503).json(report)
    }
    return res.status(400).json({ ok: false, error: 'action must be start or verify' })
  } catch (error) {
    return res.status(500).json({ ok: false, error: clean(error?.message || error), values_exposed: false })
  }
}
