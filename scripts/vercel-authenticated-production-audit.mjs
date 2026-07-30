import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const BASE_URL = String(process.env.GRANTFLOW_PROD_BASE_URL || 'https://app.axiombiolabs.org').replace(/\/$/, '')
const EXPECTED_SHA = '12ee0af3be440c093f0daf50eedd573d504ee317'
const PROFILES = [
  'profile-hollie-knox',
  '6b3c75ec-dc56-46f9-b380-394172688175',
  'c4a92724-9cee-416f-ba30-e91b9b5cd885',
  'profile-olivia-beltran',
  'profile-john-white',
]
const OUT_DIR = path.resolve('audit-dist')
const REQUIRED = [
  'GRANTFLOW_PROD_AUDIT_DATABASE_URL',
  'GRANTFLOW_AUDIT_EMAIL',
  'GRANTFLOW_AUDIT_PASSWORD',
]

const clean = (value, max = 1000) => String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, max)
const run = (command, args, extraEnv = {}) => {
  console.log(`[vercel-production-audit] run: ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
    shell: process.platform === 'win32',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}`)
}

async function fetchJson(route, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 120_000)
  try {
    const response = await fetch(`${BASE_URL}${route}`, {
      method: options.method || 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-store',
        ...(options.adminToken ? { 'x-admin-token': options.adminToken } : {}),
      },
    })
    const text = await response.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    return { ok: response.ok, status: response.status, json, error: response.ok ? null : clean(text) }
  } finally {
    clearTimeout(timer)
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true })
const evidence = {
  audit: 'grantflow-vercel-authenticated-production-audit-v1',
  expected_sha: EXPECTED_SHA,
  generated_at: new Date().toISOString(),
  base_url_host: new URL(BASE_URL).host,
  values_exposed: false,
  env_presence: Object.fromEntries(REQUIRED.map((name) => [name, Boolean(String(process.env[name] || '').trim())])),
  deployment: null,
  mission: null,
  fallback_snapshot: null,
}

try {
  const fresh = Date.now()
  const [build, mission] = await Promise.all([
    fetchJson(`/api/meta/build?fresh=${fresh}`),
    fetchJson(`/api/health/mission?fresh=${fresh}`),
  ])
  evidence.deployment = { status: build.status, sha: build.json?.sha || null }
  evidence.mission = {
    status: mission.status,
    production_gate: mission.json?.production_gate ?? null,
    release_blockers: Array.isArray(mission.json?.release_blockers) ? mission.json.release_blockers : [],
    counts: mission.json?.counts || {},
    rates: mission.json?.rates || {},
  }

  if (!build.ok || build.json?.sha !== EXPECTED_SHA) {
    throw new Error(`production SHA mismatch: expected ${EXPECTED_SHA}, got ${build.json?.sha || 'missing'}`)
  }
  const counts = mission.json?.counts || {}
  if (!mission.ok || mission.json?.production_gate !== true) throw new Error('production mission gate is not true')
  if ((mission.json?.release_blockers || []).length > 0) throw new Error('production release blockers are present')
  if (Number(counts.direct_opportunities_broken || 0) !== 0) throw new Error('direct_opportunities_broken is nonzero')
  if (Number(counts.quarantined_broken_direct_opportunities || 0) !== 0) throw new Error('quarantined_broken_direct_opportunities is nonzero')
  if (Number(counts.repair_pending_broken_direct_opportunities || 0) !== 0) throw new Error('repair_pending_broken_direct_opportunities is nonzero')

  const missing = REQUIRED.filter((name) => !evidence.env_presence[name])
  if (missing.length > 0) {
    const adminToken = String(process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN || '').trim()
    if (adminToken) {
      const params = new URLSearchParams({ profiles: PROFILES.join(','), match_limit: '100' })
      const snapshot = await fetchJson(`/api/admin/queue/production-audit/snapshot?${params}`, {
        adminToken,
        timeoutMs: 180_000,
      })
      evidence.fallback_snapshot = {
        status: snapshot.status,
        ok: snapshot.ok,
        payload: snapshot.ok ? snapshot.json : null,
        error: snapshot.error,
      }
    }
    throw new Error(`protected audit variables unavailable in Vercel preview: ${missing.join(',')}`)
  }

  const profileCsv = PROFILES.join(',')
  run('node', ['scripts/production-audit/redact.mjs', '--self-test'])
  run('node', ['scripts/production-audit/policy.test.mjs'])
  run('node', ['scripts/production-audit/validate-artifact.mjs', '--self-test'])
  run('node', ['scripts/production-audit/db-audit.mjs', '--guard-only', '--out', OUT_DIR])
  run('node', ['scripts/production-audit/db-audit.mjs', '--out', OUT_DIR, '--profiles', profileCsv])
  run('npx', ['playwright', 'install', 'chromium'])
  run('node', ['scripts/production-audit/app-audit.mjs', '--out', OUT_DIR, '--profiles', profileCsv])
  run('node', ['scripts/production-audit/validate-artifact.mjs', '--compose', '--out', OUT_DIR])
  run('node', ['scripts/production-audit/validate-artifact.mjs', '--out', OUT_DIR])

  fs.writeFileSync(
    path.join(OUT_DIR, 'index.html'),
    '<!doctype html><meta charset="utf-8"><title>GrantFlow final production audit</title><pre id="o">Validated sanitized audit artifact generated.</pre>',
  )
  console.log(`[vercel-production-audit] COMPLETE exact_sha=${EXPECTED_SHA}`)
} catch (error) {
  evidence.failed_at = new Date().toISOString()
  evidence.error = clean(error?.message || error, 1500)
  fs.writeFileSync(path.join(OUT_DIR, 'vercel-audit-preflight.json'), JSON.stringify(evidence, null, 2) + '\n')
  fs.writeFileSync(
    path.join(OUT_DIR, 'index.html'),
    '<!doctype html><meta charset="utf-8"><title>GrantFlow audit preflight</title><pre id="o">See vercel-audit-preflight.json</pre>',
  )
  console.error('[vercel-production-audit] FAILED', evidence.error)
  process.exitCode = 1
}
