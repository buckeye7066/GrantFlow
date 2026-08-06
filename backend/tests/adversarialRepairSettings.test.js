/**
 * Owner-controlled, DB-authoritative settings for the adversarial code-repair
 * feature: the store (getConfig/setConfig, DB-wins-over-env), the readiness
 * indicator (presence booleans only), the self-provisioning signing secret, and
 * the owner-gated GET/PUT route. No network; an in-memory system_kv fake DB.
 */
import { describe, it, expect } from 'vitest'
import express from 'express'
import http from 'node:http'

import {
  getConfig,
  setConfig,
  configFromEnv,
  normalizeConfig,
  validateConfigPatch,
  computeReadiness,
  CONFIG_KV_KEY,
} from '../services/adversarialRepairSettings.js'
import { resolveDirectLandSecret, DIRECT_LAND_SECRET_KV_KEY } from '../services/anyaDirectLandToken.js'
import { ADMIN_EMAIL } from '../config/constants.js'

const OWNER = ADMIN_EMAIL

/** In-memory system_kv fake: supports the exact SQL the settings/secret/nonce use. */
function makeFakeDb() {
  const kv = new Map()
  const runLog = []
  return {
    _kv: kv,
    runLog,
    exec: async () => {}, // audit table DDL uses db.exec — no-op so logAuditEvent proceeds
    prepare(sql) {
      const s = String(sql)
      return {
        get: async (...args) => {
          if (/SELECT value FROM system_kv WHERE key/i.test(s)) {
            return kv.has(args[0]) ? { value: kv.get(args[0]) } : undefined
          }
          if (/SELECT 1 AS x FROM system_kv WHERE key/i.test(s)) {
            return kv.has(args[0]) ? { x: 1 } : undefined
          }
          return undefined
        },
        run: async (...args) => {
          runLog.push({ sql: s, args })
          if (/^\s*CREATE TABLE/i.test(s)) return { changes: 0 }
          if (/UPDATE system_kv SET value/i.test(s)) {
            const [value, , key] = args
            if (kv.has(key)) { kv.set(key, value); return { changes: 1 } }
            return { changes: 0 }
          }
          if (/INSERT INTO system_kv/i.test(s)) {
            kv.set(args[0], args[1]); return { changes: 1 }
          }
          return { changes: 0 } // audit_logs / agent_control_events → no-op
        },
      }
    },
  }
}

describe('adversarialRepairSettings — config resolution', () => {
  it('DEFAULT when unset (no DB key, no env) → feature OFF', async () => {
    const db = makeFakeDb()
    const cfg = await getConfig(db, {})
    expect(cfg).toMatchObject({ enabled: false, landMode: 'pr', allowCritical: false })
  })

  it('env FALLBACK when the DB key is unset (existing behavior preserved)', async () => {
    const db = makeFakeDb()
    const env = { SAM_ADVERSARIAL_REPAIR: '1', SAM_ADVERSARIAL_LAND_MODE: 'direct', ADVERSARIAL_DIRECT_ALLOW_CRITICAL: 'true' }
    const cfg = await getConfig(db, env)
    expect(cfg).toMatchObject({ enabled: true, landMode: 'direct', allowCritical: true, source: 'env' })
  })

  it('DB WINS over env once written', async () => {
    const db = makeFakeDb()
    // env says fully ON+direct+critical...
    const env = { SAM_ADVERSARIAL_REPAIR: '1', SAM_ADVERSARIAL_LAND_MODE: 'direct', ADVERSARIAL_DIRECT_ALLOW_CRITICAL: 'true' }
    // ...but the owner saved OFF via the toggle:
    await setConfig(db, { enabled: false, landMode: 'pr', allowCritical: false }, { env })
    const cfg = await getConfig(db, env)
    expect(cfg).toMatchObject({ enabled: false, landMode: 'pr', allowCritical: false, source: 'db' })
  })

  it('setConfig MERGES a partial patch over the current effective config', async () => {
    const db = makeFakeDb()
    await setConfig(db, { enabled: true, landMode: 'direct' })
    // flip only allowCritical; enabled + landMode must persist
    const merged = await setConfig(db, { allowCritical: true })
    expect(merged).toMatchObject({ enabled: true, landMode: 'direct', allowCritical: true })
  })

  it('setConfig persists to the canonical system_kv key', async () => {
    const db = makeFakeDb()
    await setConfig(db, { enabled: true })
    expect(db._kv.has(CONFIG_KV_KEY)).toBe(true)
  })

  it('validateConfigPatch rejects bad shapes; setConfig throws 400 on invalid landMode', async () => {
    expect(validateConfigPatch({ landMode: 'yolo' }).ok).toBe(false)
    expect(validateConfigPatch({ enabled: 'nope' }).ok).toBe(false)
    expect(validateConfigPatch({ enabled: true, landMode: 'pr', allowCritical: false }).ok).toBe(true)
    const db = makeFakeDb()
    await expect(setConfig(db, { landMode: 'sideways' })).rejects.toThrow(/invalid config/i)
  })

  it('normalizeConfig / configFromEnv coerce defensively', () => {
    expect(normalizeConfig({ enabled: 'x', landMode: 'weird', allowCritical: 1 })).toEqual({ enabled: false, landMode: 'pr', allowCritical: false })
    expect(configFromEnv({})).toEqual({ enabled: false, landMode: 'pr', allowCritical: false })
  })
})

describe('computeReadiness — presence booleans only (no secret values)', () => {
  it('all keys + token present → ready', () => {
    const r = computeReadiness({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', GITHUB_TOKEN: 'g' })
    expect(r).toMatchObject({ anthropicKey: true, openaiKey: true, githubToken: true, status: 'ready' })
    expect(r.message).toMatch(/Ready — fixes can land/i)
  })
  it('missing GitHub token → pr_only (informational)', () => {
    const r = computeReadiness({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' })
    expect(r.status).toBe('pr_only')
    expect(r.githubToken).toBe(false)
    expect(r.message).toMatch(/open a PR instead of direct-merging/i)
  })
  it('missing an AI key → inert', () => {
    const r = computeReadiness({ GITHUB_TOKEN: 'g', OPENAI_API_KEY: 'o' })
    expect(r.status).toBe('inert')
    expect(r.message).toMatch(/repair is inert/i)
  })
  it('never returns secret values, only booleans', () => {
    const r = computeReadiness({ ANTHROPIC_API_KEY: 'super-secret', OPENAI_API_KEY: 'o', GITHUB_TOKEN: 'g' })
    expect(JSON.stringify(r)).not.toContain('super-secret')
  })
})

describe('resolveDirectLandSecret — self-provisioning (zero env config)', () => {
  it('env secret wins when present', async () => {
    const db = makeFakeDb()
    const s = await resolveDirectLandSecret({ db, env: { DIRECT_LAND_TOKEN_SECRET: 'from-env' } })
    expect(s).toBe('from-env')
    expect(db._kv.has(DIRECT_LAND_SECRET_KV_KEY)).toBe(false) // never persisted an env secret
  })
  it('auto-generates + persists when no env secret, and REUSES it', async () => {
    const db = makeFakeDb()
    const first = await resolveDirectLandSecret({ db, env: {} })
    expect(first).toMatch(/^[0-9a-f]{64}$/) // 32 random bytes hex
    expect(db._kv.get(DIRECT_LAND_SECRET_KV_KEY)).toBe(first)
    const second = await resolveDirectLandSecret({ db, env: {} })
    expect(second).toBe(first) // reused, not regenerated
  })
  it('no DB and no env secret → empty (fail closed)', async () => {
    expect(await resolveDirectLandSecret({ db: null, env: {} })).toBe('')
  })
})

// ── Owner-gated GET/PUT route ────────────────────────────────────────────────
async function req(baseUrl, method, path, body, headersUser) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null
    const u = new URL(baseUrl + path)
    const r = http.request(
      {
        hostname: u.hostname, port: u.port, path: u.pathname, method,
        headers: { 'content-type': 'application/json', ...(data ? { 'content-length': data.length } : {}), 'x-test-user': headersUser },
      },
      (res) => {
        let chunks = ''
        res.on('data', (c) => { chunks += c })
        res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(chunks || '{}') }) } catch { resolve({ status: res.statusCode, text: chunks }) } })
      },
    )
    r.on('error', reject)
    if (data) r.write(data)
    r.end()
  })
}

describe('GET/PUT /api/admin/agent-control/adversarial-repair (owner-gated)', () => {
  async function buildApp(db) {
    const app = express()
    app.use(express.json())
    // Inject req.user from a header so each request can be owner or non-owner.
    app.use((r, _res, next) => {
      const email = r.headers['x-test-user']
      r.user = { userId: 'u1', email, role: 'admin', is_admin: true }
      // Mirror requestContext's trusted DB-resolved identity. Token/user claims
      // alone must never authorize this control-center route.
      r.ctx = { userId: 'u1', email, identityResolved: true, isAdmin: true }
      r.db = db
      next()
    })
    const { default: router } = await import('../routes/adminAgentControl.js')
    app.use('/api/admin/agent-control', router)
    const server = await new Promise((res) => { const s = app.listen(0, () => res(s)) })
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    return { server, baseUrl }
  }

  it('403 for a NON-owner admin; 200 for the owner; PUT persists + returns readiness; master-off inert', async () => {
    const db = makeFakeDb()
    const { server, baseUrl } = await buildApp(db)
    try {
      // Non-owner → 403 on both GET and PUT (owner gate governs prod auto-merge)
      const forbidden = await req(baseUrl, 'GET', '/api/admin/agent-control/adversarial-repair', null, 'someone-else@example.com')
      expect(forbidden.status).toBe(403)
      const forbiddenPut = await req(baseUrl, 'PUT', '/api/admin/agent-control/adversarial-repair', { enabled: true }, 'someone-else@example.com')
      expect(forbiddenPut.status).toBe(403)

      // Owner GET → 200, default OFF, readiness present
      const got = await req(baseUrl, 'GET', '/api/admin/agent-control/adversarial-repair', null, OWNER)
      expect(got.status).toBe(200)
      expect(got.json.config).toMatchObject({ enabled: false, landMode: 'pr', allowCritical: false })
      expect(got.json.readiness).toHaveProperty('status')

      // Owner PUT enable+direct → 200, persisted, echoed back
      const put = await req(baseUrl, 'PUT', '/api/admin/agent-control/adversarial-repair', { enabled: true, landMode: 'direct' }, OWNER)
      expect(put.status).toBe(200)
      expect(put.json.config).toMatchObject({ enabled: true, landMode: 'direct' })
      expect(put.json.source).toBe('db')

      // Invalid PUT → 400
      const bad = await req(baseUrl, 'PUT', '/api/admin/agent-control/adversarial-repair', { landMode: 'nope' }, OWNER)
      expect(bad.status).toBe(400)

      // A config change writes an audit_logs row (governs prod auto-merge).
      expect(db.runLog.some((e) => /INSERT INTO audit_logs/i.test(e.sql))).toBe(true)

      // Master OFF is reflected immediately on the next GET (no stale cache).
      await req(baseUrl, 'PUT', '/api/admin/agent-control/adversarial-repair', { enabled: false }, OWNER)
      const off = await req(baseUrl, 'GET', '/api/admin/agent-control/adversarial-repair', null, OWNER)
      expect(off.json.config.enabled).toBe(false)
    } finally {
      await new Promise((res) => server.close(res))
    }
  })
})
