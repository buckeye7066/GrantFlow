import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import http from 'node:http'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'

// Dynamically import the admin router AFTER we build a lightweight app that
// short-circuits ensureAuth / ensureAdmin — we only want to prove the route is
// mounted and that it delegates to runAutonomousCodeCrawl end-to-end.

let app
let server
let baseUrl
let tmpDir
let originalCwd

async function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body))
    const u = new URL(url)
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': data.length },
      },
      (res) => {
        let chunks = ''
        res.on('data', (c) => { chunks += c })
        res.on('end', () => {
          try { resolve({ status: res.statusCode, json: JSON.parse(chunks || '{}') }) }
          catch (e) { resolve({ status: res.statusCode, text: chunks }) }
        })
      },
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

describe('POST /api/admin/anya/runAutonomous', () => {
  beforeAll(async () => {
    originalCwd = process.cwd()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anya-route-'))
    process.chdir(tmpDir)

    // Seed small fixture so runAutonomousCodeCrawl finds real work.
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true })
    await fs.writeFile(
      path.join(tmpDir, 'src/x.js'),
      [
        'export function risky() {',
        '  try { doStuff() }',
        '  catch (err) {}',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )

    app = express()
    app.locals.trustedRepoRoot = tmpDir
    app.use(express.json())
    // Pretend the user is authenticated + admin so ensureAuth / ensureAdmin pass.
    app.use((req, _res, next) => {
      req.user = { userId: 'test-admin', role: 'admin', is_admin: true }
      req.ctx = { user: req.user, isAdmin: true }
      req.db = null
      next()
    })

    const { default: adminRouter } = await import('../routes/admin.js')
    app.use('/api/admin', adminRouter)

    server = await new Promise((resolve, reject) => {
      const s = app.listen(0, () => resolve(s))
      s.on('error', reject)
    })
    const port = server.address().port
    baseUrl = `http://127.0.0.1:${port}`
  }, 60_000)

  afterAll(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve))
    }
    if (originalCwd) process.chdir(originalCwd)
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {
      /* intentionally ignored: test tmpdir cleanup is best-effort */
    })
  }, 30_000)

  it('returns 200 with {id, tool, output} envelope and real metrics', async () => {
    const { status, json } = await postJson(`${baseUrl}/api/admin/anya/runAutonomous`, {
      dry_run: true,
      max_iterations: 50,
      max_file_changes: 20,
    })
    expect(status).toBe(200)
    expect(json.tool).toBe('admin.anya.runAutonomous')
    expect(typeof json.id).toBe('string')
    expect(json.id.length).toBeGreaterThan(10)

    const out = json.output
    expect(out).toBeTruthy()
    expect(out.dry_run).toBe(true)
    // files_scanned is a real count of files the walker saw; in this tmp dir
    // we seeded exactly one .js file.
    expect(out.files_scanned).toBe(1)
    expect(out.files_analyzed).toBe(1)
    expect(out.issues_found).toBeGreaterThan(0)

    // issues_fixed must equal sum of changes_count across modifications
    const summed = (out.modifications || []).reduce((acc, m) => acc + m.changes_count, 0)
    expect(out.issues_fixed).toBe(summed)

    // Each modification has a real diff + distinct SHA1s
    for (const m of out.modifications || []) {
      expect(typeof m.diff).toBe('string')
      expect(m.diff.length).toBeGreaterThan(0)
      expect(m.before_sha1).not.toBe(m.after_sha1)
    }
  })

  it('honors dry_run=false outside production while preserving audit evidence', async () => {
    const before = await fs.readFile(path.join(tmpDir, 'src/x.js'), 'utf8')

    const result = await postJson(`${baseUrl}/api/admin/anya/runAutonomous`, { dry_run: false })
    expect(result.status).toBe(200)
    expect(result.json.output.dry_run).toBe(false)
    expect(result.json.output.env_write_gate_required).toBe(false)
    expect(result.json.output.permission_required).toBe(false)
    expect(result.json.output.audit_required).toBe(true)

    const after = await fs.readFile(path.join(tmpDir, 'src/x.js'), 'utf8')
    expect(after).not.toBe(before)
    expect(after).toMatch(/console\.error\('\[AnyaAudit\] Suppressed error/)
    expect(after).toMatch(/throw err/)
  })

  it('rejects an admin-supplied directory outside the server-owned repository root', async () => {
    const result = await postJson(`${baseUrl}/api/admin/anya/runAutonomous`, {
      directory: os.tmpdir(),
      dry_run: true,
    })
    expect(result.status).toBe(400)
    expect(result.json.output.success).toBe(false)
    expect(result.json.output.error).toMatch(/outside the trusted repository root/i)
  })

  it('rejects production writes unless the explicit operator gate is enabled', async () => {
    const previousNodeEnv = process.env.NODE_ENV
    const previousGate = process.env.ANYA_CODE_REPAIR_PRODUCTION_WRITES
    process.env.NODE_ENV = 'production'
    delete process.env.ANYA_CODE_REPAIR_PRODUCTION_WRITES
    try {
      const result = await postJson(`${baseUrl}/api/admin/anya/runAutonomous`, { dry_run: false })
      expect(result.status).toBe(403)
      expect(result.json.output.code).toBe('ANYA_PRODUCTION_WRITES_DISABLED')
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previousNodeEnv
      if (previousGate === undefined) delete process.env.ANYA_CODE_REPAIR_PRODUCTION_WRITES
      else process.env.ANYA_CODE_REPAIR_PRODUCTION_WRITES = previousGate
    }
  })
})
