import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import chromiumBinary from '@sparticuz/chromium'
import { chromium as playwrightChromium } from 'playwright-core'

const BASE_URL = 'https://app.axiombiolabs.org'
const EXPECTED_SHA = '12ee0af3be440c093f0daf50eedd573d504ee317'
const AUDIT_EMAIL = 'buckeye7066+grantflow-production-audit@gmail.com'
const PROFILE_IDS = Object.freeze([
  'profile-hollie-knox',
  '6b3c75ec-dc56-46f9-b380-394172688175',
  'c4a92724-9cee-416f-ba30-e91b9b5cd885',
  'profile-olivia-beltran',
  'profile-john-white',
])
const PROOF_FILE = path.resolve('audit-input/final-authenticated-proof.json')
const OUT_DIR = path.resolve('audit-dist')

const b64u = (value) => Buffer.from(value).toString('base64url')
const unb64u = (value) => Buffer.from(String(value || ''), 'base64url')
const clean = (value, max = 500) => String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, max)
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')
const secretKey = () => {
  const secret = String(process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN || '').trim()
  if (!secret) throw new Error('ADMIN_TOKEN/ANYA_ADMIN_TOKEN unavailable to protected audit build')
  return crypto.createHash('sha256').update(secret).digest()
}

async function requestJson(pathname, {
  method = 'GET', body, token = null, admin = false, timeoutMs = 120_000,
} = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${BASE_URL}${pathname}`, {
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
    return {
      ok: response.ok,
      status: response.status,
      json,
      error: response.ok ? null : clean(json?.error || json?.message || text || response.statusText),
    }
  } catch (error) {
    return { ok: false, status: 0, json: null, error: clean(error?.message || error) }
  } finally {
    clearTimeout(timer)
  }
}

function decryptResetToken(proof) {
  if (proof?.v !== 2 || proof?.expected_sha !== EXPECTED_SHA) throw new Error('encrypted proof contract mismatch')
  const payload = JSON.parse(unb64u(proof.challenge).toString('utf8'))
  if (
    payload?.v !== 2 ||
    payload?.purpose !== 'password_reset_token' ||
    !Number.isFinite(Number(payload?.exp)) ||
    Date.now() > Number(payload.exp)
  ) throw new Error('encrypted audit challenge expired or invalid')

  const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), unb64u(payload.iv))
  decipher.setAuthTag(unb64u(payload.tag))
  const privateKey = Buffer.concat([
    decipher.update(unb64u(payload.ct)),
    decipher.final(),
  ]).toString('utf8')
  const token = crypto.privateDecrypt({
    key: privateKey,
    oaepHash: 'sha256',
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
  }, unb64u(proof.ciphertext)).toString('utf8')
  const expectedProof = b64u(crypto.createHash('sha256').update(`${proof.challenge}:${token}`).digest())
  const actual = Buffer.from(String(proof.proof || ''))
  const expected = Buffer.from(expectedProof)
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new Error('encrypted audit proof mismatch')
  }
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error('decrypted reset token shape is invalid')
  return token
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
  const runtimeSecret = mission.json?.production_readiness?.checks?.find(
    (entry) => entry?.id === 'runtime_secret_key_security',
  ) || null
  const result = {
    exact_sha: build.json?.sha || null,
    ready_status: ready.status,
    ready: ready.ok && ready.json?.ok === true,
    health_status: health.status,
    storage_status: storage.status,
    storage_ok: storage.json?.ok === true,
    storage_persistent: storage.json?.likely_persistent === true,
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
    retired: Number(counts.retired_broken_direct_opportunities || 0),
    verified_pct: Number(rates.verified_pct || 0),
    broken_pct: Number(rates.broken_pct || 0),
    runtime_secret_key: runtimeSecret
      ? { ok: runtimeSecret.ok === true, level: runtimeSecret.level || null, detail: clean(runtimeSecret.detail, 180) }
      : null,
  }
  if (result.exact_sha !== EXPECTED_SHA) throw new Error(`deployed SHA mismatch: ${result.exact_sha || 'missing'}`)
  if (!result.ready || result.health_status !== 200) throw new Error('live readiness or health failed')
  if (!result.storage_ok || !result.storage_persistent) throw new Error('persistent storage gate failed')
  if (result.data_readiness_status !== 200 || result.data_readiness !== 'ready') throw new Error('data readiness gate failed')
  if (result.alerts_status !== 200 || result.alert_count !== 0) throw new Error('live alerts gate failed')
  if (result.production_gate !== true || blockers.length > 0) throw new Error('mission production gate failed')
  if (result.direct_broken !== 0 || result.quarantined !== 0 || result.repair_pending !== 0) {
    throw new Error('unsafe broken-link lifecycle counters are nonzero')
  }
  if (result.verified_pct < 95 || result.broken_pct > 5) throw new Error('mission verification thresholds failed')
  if (!result.runtime_secret_key?.ok) throw new Error('persistent runtime-secret key is not healthy')
  return result
}

function compactBody(body) {
  if (!body || typeof body !== 'object') return { count: null, keys: [] }
  const arrayCandidates = [body, body.items, body.results, body.sources, body.tasks, body.runs, body.data]
  const array = arrayCandidates.find(Array.isArray)
  const count = Array.isArray(array)
    ? array.length
    : (Number.isFinite(Number(body.total)) ? Number(body.total) : null)
  return { count, keys: Object.keys(body).slice(0, 24) }
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
    const request = route.request()
    const method = request.method().toUpperCase()
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return route.continue()
    let pathname = clean(request.url(), 300)
    try { pathname = new URL(request.url()).pathname } catch { /* keep redacted fallback */ }
    const redFlag = /submit|attest|authoriz|payment|billing|purchase|checkout|portal-sync\/(?:write|sync)|auto-?submit|\/approve|credential|vault/i.test(pathname)
    blocked.push({ method, pathname, red_flag: redFlag })
    return route.abort('blockedbyclient')
  })

  const page = await context.newPage()
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(clean(message.text()))
  })
  page.on('requestfailed', (request) => {
    const error = request.failure()?.errorText || ''
    if (!error.includes('blockedbyclient')) {
      let pathname = clean(request.url(), 300)
      try { pathname = new URL(request.url()).pathname } catch { /* keep fallback */ }
      failedRequests.push({ method: request.method(), pathname, error: clean(error) })
    }
  })

  const steps = []
  const step = async (name, operation) => {
    try {
      const value = await operation()
      steps.push({ name, ok: true, value: value ?? null })
      return value
    } catch (error) {
      steps.push({ name, ok: false, error: clean(error?.message || error) })
      return null
    }
  }
  const pageEvidence = async (route) => {
    await page.goto(`${BASE_URL}${route}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {})
    const text = await page.locator('body').innerText().catch(() => '')
    return {
      route,
      final_path: new URL(page.url()).pathname,
      title: clean(await page.title(), 160),
      body_chars: text.length,
      body_sha256: sha256(text),
    }
  }
  const apiGet = async (pathname, profileId = null) => page.evaluate(async ({ pathname, profileId }) => {
    try {
      const token = window.localStorage.getItem('grantflow:access-token')
      const headers = { Accept: 'application/json' }
      if (token) headers.Authorization = `Bearer ${token}`
      if (profileId) headers['X-Profile-Id'] = profileId
      const response = await fetch(pathname, { credentials: 'include', headers })
      const text = await response.text()
      let body = null
      try { body = text ? JSON.parse(text) : null } catch { body = null }
      const candidates = [body, body?.items, body?.results, body?.sources, body?.tasks, body?.runs, body?.data]
      const array = candidates.find(Array.isArray)
      const count = Array.isArray(array)
        ? array.length
        : (Number.isFinite(Number(body?.total)) ? Number(body.total) : null)
      return {
        status: response.status,
        ok: response.ok,
        count,
        keys: body && typeof body === 'object' ? Object.keys(body).slice(0, 24) : [],
      }
    } catch (error) {
      return { status: 0, ok: false, count: null, keys: [], error: String(error?.message || error).slice(0, 300) }
    }
  }, { pathname, profileId })

  const landing = await step('load authenticated app', () => pageEvidence('/'))
  const identity = await step('identity and scope', () => apiGet('/api/auth/me'))
  const profiles = []
  for (const profileId of PROFILE_IDS) {
    const capture = {
      profile_id: profileId,
      funding_sources: await step(`${profileId}: funding sources`, () => apiGet(`/api/profiles/${profileId}/funding-sources`, profileId)),
      hamilton_tasks: await step(`${profileId}: hamilton tasks`, () => apiGet(`/api/hamilton/automation/tasks?profileId=${profileId}`, profileId)),
      hamilton_readiness: await step(`${profileId}: hamilton readiness`, () => apiGet(`/api/hamilton/automation/readiness?profileId=${profileId}`, profileId)),
      portal_sync_runs: await step(`${profileId}: portal sync runs`, () => apiGet(`/api/hamilton/portal-sync/runs?profileId=${profileId}`, profileId)),
    }
    await page.evaluate((id) => window.localStorage.setItem('grantflow:active-profile-id', id), profileId)
    capture.funding_view = await step(`${profileId}: funding view`, () => pageEvidence('/FundingResults'))
    profiles.push(capture)
  }

  const surfaces = []
  for (const route of ['/MyProfiles', '/Pipeline', '/HamiltonProcessing']) {
    surfaces.push(await step(`surface ${route}`, () => pageEvidence(route)))
  }
  const mission = await step('authenticated mission status', () => apiGet('/api/health/mission'))
  await browser.close()

  const profileEvidenceCount = profiles.filter((profile) => [
    profile.funding_sources,
    profile.hamilton_tasks,
    profile.hamilton_readiness,
    profile.portal_sync_runs,
  ].some((entry) => entry?.ok === true)).length
  return {
    signed_in: identity?.status === 200 && identity?.ok === true,
    non_admin: userPayload?.is_admin !== true && userPayload?.role !== 'admin',
    accessible_profile_count: Array.isArray(userPayload?.profiles) ? userPayload.profiles.length : null,
    landing,
    identity,
    profiles,
    profile_evidence_count: profileEvidenceCount,
    surfaces,
    mission,
    steps,
    step_failures: steps.filter((entry) => !entry.ok),
    mutations_blocked: blocked,
    red_flag_attempts: blocked.filter((entry) => entry.red_flag),
    console_errors: consoleErrors.slice(0, 100),
    failed_requests: failedRequests.slice(0, 100),
  }
}

function summarizeSnapshot(snapshot) {
  const json = snapshot?.json || {}
  return {
    status: snapshot?.status || 0,
    ok: snapshot?.ok === true && json?.ok === true,
    contract: json?.contract || null,
    generated_at: json?.generated_at || null,
    payload_sha256: sha256(JSON.stringify(json)),
    deployment: json?.deployment || null,
    safety: json?.safety || null,
    scope: {
      requested_count: Array.isArray(json?.scope?.requested_profile_ids) ? json.scope.requested_profile_ids.length : null,
      resolved_count: Array.isArray(json?.scope?.resolved_profiles) ? json.scope.resolved_profiles.length : null,
      missing_count: Array.isArray(json?.scope?.missing_profile_ids) ? json.scope.missing_profile_ids.length : null,
    },
    matches: {
      store_available: json?.matches?.store_available ?? null,
      totals: json?.matches?.totals || null,
    },
    hamilton: {
      cross_scope_task_rows: Number(json?.hamilton?.cross_scope_task_rows || 0),
      profile_count: json?.hamilton?.integrity_by_profile && typeof json.hamilton.integrity_by_profile === 'object'
        ? Object.keys(json.hamilton.integrity_by_profile).length
        : null,
    },
    automation_posture: json?.automation_posture || null,
    amy: json?.amy || null,
    error: snapshot?.ok ? null : snapshot?.error,
  }
}

const evidence = {
  audit: 'grantflow-final-authenticated-production-audit-v3',
  expected_sha: EXPECTED_SHA,
  generated_at: new Date().toISOString(),
  account: '<dedicated-non-admin-audit-account>',
  safety_model: 'Production audit snapshot is transaction-read-only; browser allows GET/HEAD/OPTIONS only; all other browser mutations abort before network.',
  values_exposed: false,
  live_before: null,
  browser: null,
  snapshot: null,
  live_after: null,
  cleanup: null,
  fatal: [],
}

let accessToken = null
let refreshToken = null
let resetToken = null
let temporaryPassword = null
try {
  const proof = JSON.parse(fs.readFileSync(PROOF_FILE, 'utf8'))
  resetToken = decryptResetToken(proof)
  temporaryPassword = `${crypto.randomBytes(36).toString('base64url')}Aa1!`
  evidence.live_before = await verifyLiveGate()

  const auth = await requestJson('/api/auth/password/setup/complete', {
    method: 'POST',
    body: { token: resetToken, password: temporaryPassword },
    timeoutMs: 180_000,
  })
  if (!auth.ok || !auth.json?.accessToken || !auth.json?.refreshToken) {
    throw new Error(`dedicated audit sign-in failed (${auth.status}): ${auth.error || 'tokens missing'}`)
  }
  accessToken = auth.json.accessToken
  refreshToken = auth.json.refreshToken
  if (auth.json?.user?.is_admin === true || auth.json?.user?.role === 'admin') {
    throw new Error('dedicated audit account unexpectedly has admin privileges')
  }

  evidence.browser = await runBrowserAudit(accessToken, refreshToken, auth.json.user)
  const params = new URLSearchParams({ profiles: PROFILE_IDS.join(','), match_limit: '100' })
  const snapshotResponse = await requestJson(`/api/admin/queue/production-audit/snapshot?${params}`, {
    admin: true,
    timeoutMs: 180_000,
  })
  evidence.snapshot = summarizeSnapshot(snapshotResponse)
  evidence.live_after = await verifyLiveGate()

  const snapshotTotals = evidence.snapshot?.matches?.totals || {}
  const automation = evidence.snapshot?.automation_posture || {}
  const safety = evidence.snapshot?.safety || {}
  if (!evidence.browser?.signed_in) evidence.fatal.push('authenticated browser identity failed')
  if (!evidence.browser?.non_admin) evidence.fatal.push('audit account was not non-admin')
  if (evidence.browser?.profile_evidence_count !== PROFILE_IDS.length) evidence.fatal.push('not every scoped profile yielded authenticated evidence')
  if (evidence.browser?.red_flag_attempts?.length > 0) evidence.fatal.push('red-flag browser mutation attempts were generated')
  if (!evidence.snapshot?.ok) evidence.fatal.push('read-only production snapshot failed')
  if (safety.transaction_read_only !== 'on') evidence.fatal.push('snapshot transaction was not read-only')
  if (safety.sensitive_tables_read !== false) evidence.fatal.push('snapshot read a sensitive table')
  if (evidence.snapshot?.scope?.resolved_count !== PROFILE_IDS.length || evidence.snapshot?.scope?.missing_count !== 0) {
    evidence.fatal.push('snapshot profile scope was incomplete')
  }
  if (Number(snapshotTotals.visible_direct_rejects || 0) !== 0) evidence.fatal.push('visible direct REJECT rows remain')
  if (Number(snapshotTotals.visible_resource_non_review || 0) !== 0) evidence.fatal.push('resource rows surfaced outside REVIEW')
  if (Number(snapshotTotals.canonical_reject_relabelled || 0) !== 0) evidence.fatal.push('canonical REJECT rows were relabelled')
  if (Number(evidence.snapshot?.hamilton?.cross_scope_task_rows || 0) !== 0) evidence.fatal.push('Hamilton cross-profile task leakage detected')
  if (automation.allow_auto_submit !== false || automation.matches_current_boot !== true) {
    evidence.fatal.push('live auto-submit posture is not safely disabled on the current boot')
  }

  const logout = await requestJson('/api/auth/logout', {
    method: 'POST',
    body: { refreshToken },
    token: accessToken,
    timeoutMs: 30_000,
  })
  evidence.cleanup = { logout_status: logout.status, session_revoked: logout.status === 204 }
  if (!evidence.cleanup.session_revoked) evidence.fatal.push('audit session logout/revocation failed')

  evidence.ok = evidence.fatal.length === 0
} catch (error) {
  evidence.ok = false
  evidence.failed_at = new Date().toISOString()
  evidence.error = clean(error?.message || error, 1200)
  evidence.fatal.push('audit execution failed')
  if (refreshToken) {
    const logout = await requestJson('/api/auth/logout', {
      method: 'POST', body: { refreshToken }, token: accessToken, timeoutMs: 30_000,
    })
    evidence.cleanup = { logout_status: logout.status, session_revoked: logout.status === 204 }
  }
} finally {
  resetToken = null
  temporaryPassword = null
  accessToken = null
  refreshToken = null
}

const serialized = JSON.stringify(evidence, null, 2) + '\n'
for (const secret of [
  String(process.env.ADMIN_TOKEN || ''),
  String(process.env.ANYA_ADMIN_TOKEN || ''),
]) {
  if (secret && serialized.includes(secret)) throw new Error('secret leak detected in final audit evidence')
}
fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(path.join(OUT_DIR, 'final-audit.json'), serialized)
fs.writeFileSync(
  path.join(OUT_DIR, 'index.html'),
  '<!doctype html><meta charset="utf-8"><title>GrantFlow final authenticated audit</title><pre id="o">Loading…</pre><script>fetch("./final-audit.json").then(r=>r.json()).then(v=>o.textContent=JSON.stringify(v,null,2)).catch(e=>o.textContent=String(e))</script>',
)
const finalLine = {
  ok: evidence.ok,
  exact_sha: evidence.live_after?.exact_sha || evidence.live_before?.exact_sha || null,
  production_gate: evidence.live_after?.production_gate ?? evidence.live_before?.production_gate ?? null,
  direct_broken: evidence.live_after?.direct_broken ?? null,
  quarantined: evidence.live_after?.quarantined ?? null,
  repair_pending: evidence.live_after?.repair_pending ?? null,
  scheduled_retry: evidence.live_after?.scheduled_retry ?? null,
  verified_pct: evidence.live_after?.verified_pct ?? null,
  non_admin: evidence.browser?.non_admin ?? null,
  profiles_scoped: PROFILE_IDS.length,
  profile_evidence_count: evidence.browser?.profile_evidence_count ?? null,
  browser_step_failures: evidence.browser?.step_failures?.length ?? null,
  mutations_blocked: evidence.browser?.mutations_blocked?.length ?? null,
  red_flag_attempts: evidence.browser?.red_flag_attempts?.length ?? null,
  console_errors: evidence.browser?.console_errors?.length ?? null,
  failed_requests: evidence.browser?.failed_requests?.length ?? null,
  snapshot_ok: evidence.snapshot?.ok ?? null,
  transaction_read_only: evidence.snapshot?.safety?.transaction_read_only ?? null,
  visible_direct_rejects: evidence.snapshot?.matches?.totals?.visible_direct_rejects ?? null,
  visible_resource_non_review: evidence.snapshot?.matches?.totals?.visible_resource_non_review ?? null,
  hamilton_cross_scope: evidence.snapshot?.hamilton?.cross_scope_task_rows ?? null,
  auto_submit: evidence.snapshot?.automation_posture?.allow_auto_submit ?? null,
  session_revoked: evidence.cleanup?.session_revoked ?? null,
  fatal: evidence.fatal,
}
console.log(`[final-authenticated-audit] FINAL ${JSON.stringify(finalLine)}`)
if (!evidence.ok) process.exitCode = 1
