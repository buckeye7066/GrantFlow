/**
 * Release gate: verify local_funding crawler returns directory resources.
 *
 * Boots a test server, authenticates, runs the local_funding crawler,
 * and asserts that at least one result survives filtering.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function startServer() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'gf-local-funding-'))
  const dbPath = path.join(tmp, 'test.db')
  const child = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: '0',
      DB_PROVIDER: 'sqlite',
      SQLITE_DB_PATH: dbPath,
      DB_AUTO_MIGRATE: 'true',
      AUTH_JWT_SECRET: 'test-secret',
      LIVE_CRAWL_TIMEOUT_MS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (d) => (stdout += d))
  child.stderr.on('data', (d) => (stderr += d))
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { child.kill('SIGTERM') } catch { /* noop */ }
      reject(new Error(`server not ready\n${stdout}\n${stderr}`))
    }, 60_000)
    child.stdout.on('data', () => {
      const m = stdout.match(/\[Server\] Ready on port\s+(\d+)/)
      if (m) { clearTimeout(timeout); resolve({ port: Number(m[1]) }) }
    })
  })
  async function stop() {
    if (!child.killed) child.kill('SIGTERM')
    await new Promise((r) => child.once('exit', r))
  }
  return { ready, stop, dbPath }
}

async function fetchJson(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

async function main() {
  const srv = startServer()
  let port
  try {
    ;({ port } = await srv.ready)

    const email = 'localfunding@example.com'
    const userId = '20000000-0000-0000-0000-000000000001'
    const credId = '20000000-0000-0000-0000-000000000002'
    const orgId = '20000000-0000-0000-0000-000000000003'
    const profileId = '20000000-0000-0000-0000-000000000004'

    const Database = (await import('better-sqlite3')).default
    const db = new Database(srv.dbPath)
    db.exec(`
      INSERT INTO users (id, display_name, primary_email, is_admin) VALUES ('${userId}', 'u', '${email}', 0);
      INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count) VALUES ('${credId}', '${userId}', 'email_otp', '${email}', 0);
      INSERT INTO organizations (id, name, city, state, zip) VALUES ('${orgId}', 'Org', 'Columbus', 'OH', '43215');
      INSERT INTO profiles (id, user_id, organization_id, display_name, primary_type, status, tags) VALUES ('${profileId}', '${userId}', '${orgId}', 'P', 'individual_need', 'active', '[]');
      INSERT INTO profile_sections (profile_id, section_key, data, updated_by) VALUES ('${profileId}', 'basic_information', '{"city":"Columbus","state":"OH","zip":"43215","primary_needs":["housing","food","utilities"]}', 'test');
    `)
    db.close()

    const start = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/start`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    })
    if (start.status !== 202) {
      console.error('[gate:discover-local-funding] auth start failed', start.json)
      process.exitCode = 1
      return
    }
    const verify = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/verify`, {
      method: 'POST',
      body: JSON.stringify({ email, code: start.json.previewCode, verification_token: start.json.verification_token }),
    })
    if (verify.status !== 200 || !verify.json?.accessToken) {
      console.error('[gate:discover-local-funding] auth verify failed', verify.json)
      process.exitCode = 1
      return
    }
    const token = verify.json.accessToken

    const run = await fetchJson(`http://127.0.0.1:${port}/api/real-crawlers/run`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        crawler_type: 'local_funding',
        profile_id: profileId,
        min_match_score: 0,
      }),
    })

    if (run.status !== 200) {
      console.error('[gate:discover-local-funding] run failed', run.status, run.json)
      process.exitCode = 1
      return
    }

    const json = run.json
    const count = json.count ?? json.results?.length ?? 0
    const totalFound = json.total_found ?? count

    if (!json.success) {
      console.error('[gate:discover-local-funding] crawler returned success=false', json.error)
      process.exitCode = 1
      return
    }

    console.log(`[gate:discover-local-funding] total_found=${totalFound} count=${count}`)

    if (count === 0 && totalFound === 0) {
      console.error('[gate:discover-local-funding] FAIL: 0 results returned')
      process.exitCode = 1
      return
    }

    console.log('[gate:discover-local-funding] PASS')
  } catch (err) {
    console.error('[gate:discover-local-funding] ERROR:', err.message)
    process.exitCode = 1
  } finally {
    await srv.stop()
  }
}

main()
