#!/usr/bin/env node
/**
 * crawler:doctor
 * End-to-end verification:
 * - Ensures DB schema applied (server-style schema exec)
 * - Runs crawler:smoke (offline by default)
 * - Runs smoke tests (node --test)
 * - Starts API server on ephemeral port and verifies endpoints
 * - Writes artifacts to /artifacts/crawler/YYYY-MM-DD/
 */

import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import Database from 'better-sqlite3'

const projectRoot = path.resolve(process.cwd())
const dbPath = process.env.DATABASE_URL || path.join(projectRoot, 'backend', 'data', 'grantflow.db')
const schemaPath = path.join(projectRoot, 'backend', 'db', 'schema.sql')

function runCmd(command, args, { env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: cwd || projectRoot,
      env: { ...process.env, ...(env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr })
      const err = new Error(`${command} ${args.join(' ')} exited ${code}\n${stderr || stdout}`)
      err.code = code
      err.stdout = stdout
      err.stderr = stderr
      reject(err)
    })
  })
}

async function ensureSchema() {
  if (!fs.existsSync(schemaPath)) throw new Error(`Missing schema at ${schemaPath}`)
  const schema = fs.readFileSync(schemaPath, 'utf8')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(schema)
  db.close()
}

async function startServerAndGetPort() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['backend/server.js'], {
      cwd: projectRoot,
      env: { ...process.env, PORT: '0', NATIONAL_PROGRAMS_CRAWLER_ENABLED: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let ready = false
    let port = null
    let stdout = ''
    let stderr = ''

    const onData = (chunk) => {
      const text = chunk.toString()
      stdout += text
      const match = text.match(/\[Server\]\s+Ready on port\s+(\d+)/)
      if (match && !ready) {
        ready = true
        port = Number(match[1])
        resolve({ child, port, stdout, stderr })
      }
    }

    child.stdout.on('data', onData)
    child.stderr.on('data', (d) => {
      const text = d.toString()
      stderr += text
    })

    child.on('error', reject)
    child.on('close', (code) => {
      if (!ready) {
        reject(new Error(`Server exited before ready (code ${code}).\n${stderr || stdout}`))
      }
    })

    setTimeout(() => {
      if (!ready) {
        try { child.kill('SIGTERM') } catch {}
        reject(new Error(`Timed out waiting for server readiness.\n${stderr || stdout}`))
      }
    }, 20000)
  })
}

async function fetchJson(url, { headers } = {}) {
  const res = await fetch(url, { headers })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text }
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${url}`)
    err.status = res.status
    err.body = json
    throw err
  }
  return json
}

async function main() {
  if (!fs.existsSync(path.dirname(dbPath))) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  }
  if (!fs.existsSync(dbPath)) {
    // Create empty db file so schema can apply
    fs.writeFileSync(dbPath, '')
  }

  console.log('[crawler:doctor] Applying schema...')
  await ensureSchema()

  console.log('[crawler:doctor] Running crawler:smoke (offline by default)...')
  await runCmd('node', ['scripts/crawler-smoke.mjs'], {
    env: {
      CRAWLER_MAX_SOURCES: process.env.CRAWLER_MAX_SOURCES || '10',
    },
  })

  console.log('[crawler:doctor] Running crawler smoke tests...')
  await runCmd('node', ['--test', 'tests/crawler/smoke/nationalCrawlerV2.test.js'])

  console.log('[crawler:doctor] Starting API server and running API smoke...')
  const { child, port } = await startServerAndGetPort()
  try {
    const base = `http://127.0.0.1:${port}`
    const health = await fetchJson(`${base}/health`)
    const crawlerHealth = await fetchJson(`${base}/api/crawler-v2/health`)
    const programs = await fetchJson(`${base}/api/nf-programs?track=TRACK_A&limit=5`)
    if (!programs?.data || !Array.isArray(programs.data)) {
      throw new Error('API smoke failed: /api/nf-programs did not return data[]')
    }
    console.log('[crawler:doctor] API smoke OK')

    // Write API smoke log into today's artifacts directory
    const day = new Date().toISOString().slice(0, 10)
    const artifactsDir = path.join(projectRoot, 'artifacts', 'crawler', day)
    try {
      fs.mkdirSync(artifactsDir, { recursive: true })
      const apiLogPath = path.join(artifactsDir, 'api-smoke.log')
      fs.appendFileSync(
        apiLogPath,
        [
          `[doctor] ${new Date().toISOString()} API smoke OK`,
          `[doctor] /health.status=${health?.status ?? 'unknown'}`,
          `[doctor] /api/crawler-v2/health.status=${crawlerHealth?.status ?? 'unknown'}`,
          `[doctor] /api/nf-programs TRACK_A sample_count=${programs?.data?.length ?? 0}`,
          '',
        ].join('\n'),
        'utf8',
      )
    } catch {
      // best-effort; artifacts folder may be read-only in some environments
    }
  } finally {
    try { child.kill('SIGTERM') } catch {}
  }

  console.log('[crawler:doctor] OK')
}

main().catch((err) => {
  console.error('[crawler:doctor] FAILED:', err?.message || err)
  process.exit(1)
})

