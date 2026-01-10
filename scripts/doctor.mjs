import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'

import { repoRoot, artifactsDir, todayStamp } from './_doctor/paths.mjs'
import { ensureDir, runCommand, writeFile } from './_doctor/run.mjs'

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitForHttpOk(url, { timeoutMs = 60_000, intervalMs = 500 } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: 'GET' })
      if (res.ok) return true
    } catch {}
    await sleep(intervalMs)
  }
  return false
}

function mergedEnv(extra = {}) {
  return { ...process.env, ...extra }
}

function startProcess(command, args, { cwd, env, logFile, label }) {
  const child = spawn(command, args, {
    cwd,
    env,
    shell: true,
    windowsHide: true,
  })

  if (logFile) {
    ensureDir(path.dirname(logFile))
    const stream = fs.createWriteStream(logFile, { flags: 'a' })
    stream.write(`\n\n===== ${label ?? command} =====\n`)
    child.stdout.pipe(stream)
    child.stderr.pipe(stream)
  }

  return child
}

function isPortAvailable(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE') return resolve(false)
      resolve(false)
    })
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, host)
  })
}

async function startBackend(root, { outDir, logFile }) {
  const candidatePorts = [8080, 8081, 8082]
  for (const port of candidatePorts) {
    const available = await isPortAvailable(port)
    if (!available) continue

    const backendEnv = mergedEnv({
      NODE_ENV: 'development',
      SMOKE_MODE: 'true',
      PORT: String(port),
      ADMIN_TOKEN: process.env.ADMIN_TOKEN || 'dev-admin-token',
      CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173',
      AUTH_FRONTEND_APP_BASE: process.env.VITE_APP_BASE || '/grantflow',
    })

    const proc = startProcess('node', ['backend/server.js'], {
      cwd: root,
      env: backendEnv,
      logFile,
      label: `backend:${port}`,
    })

    const ok = await waitForHttpOk(`http://127.0.0.1:${port}/health`, { timeoutMs: 30_000 })
    if (ok) {
      writeFile(path.join(outDir, 'backend-port.txt'), `${port}\n`)
      return { proc, port, env: backendEnv }
    }

    try { proc.kill('SIGTERM') } catch {}
  }

  throw new Error('Backend did not become healthy on any candidate port (8080/8081/8082)')
}

async function main() {
  const root = repoRoot()
  const stamp = todayStamp()
  const outDir = artifactsDir(root, stamp)
  ensureDir(outDir)

  // Wipe prior artifacts for the day so reruns are easier to read.
  const wipeTargets = [
    path.join(outDir, 'lint.log'),
    path.join(outDir, 'typecheck.log'),
    path.join(outDir, 'test.log'),
    path.join(outDir, 'build.log'),
    path.join(outDir, 'backend.log'),
    path.join(outDir, 'smoke.log'),
    path.join(outDir, 'repro'),
    path.join(outDir, 'playwright-report'),
    path.join(outDir, 'playwright-output'),
    path.join(outDir, 'doctor-failure.txt'),
    path.join(outDir, 'doctor-success.txt'),
  ]
  wipeTargets.forEach((target) => {
    try { fs.rmSync(target, { recursive: true, force: true }) } catch {}
  })
  ensureDir(outDir)

  writeFile(
    path.join(outDir, 'doctor-meta.json'),
    JSON.stringify(
      { stamp, root, outDir, node: process.version, startedAt: new Date().toISOString() },
      null,
      2,
    ),
  )

  const logs = {
    lint: path.join(outDir, 'lint.log'),
    typecheck: path.join(outDir, 'typecheck.log'),
    test: path.join(outDir, 'test.log'),
    build: path.join(outDir, 'build.log'),
    backend: path.join(outDir, 'backend.log'),
    smoke: path.join(outDir, 'smoke.log'),
  }

  // Install check (non-destructive): if node_modules missing, do npm ci.
  if (!fs.existsSync(path.join(root, 'node_modules'))) {
    const ci = await runCommand('npm', ['ci', '--no-audit', '--no-fund'], { cwd: root, env: process.env, logFile: logs.test, label: 'npm ci' })
    if (ci.code !== 0) process.exit(ci.code ?? 1)
  }

  // Env inventory → docs/ENV_VARS.md
  const inv = await runCommand('node', ['scripts/inventory-env.mjs'], { cwd: root, env: process.env, logFile: logs.test, label: 'env inventory' })
  if (inv.code !== 0) process.exit(inv.code ?? 1)

  const lint = await runCommand('npm', ['run', 'lint'], { cwd: root, env: process.env, logFile: logs.lint, label: 'npm run lint' })
  if (lint.code !== 0) process.exit(lint.code ?? 1)

  const typecheck = await runCommand('npm', ['run', 'typecheck'], { cwd: root, env: process.env, logFile: logs.typecheck, label: 'npm run typecheck' })
  if (typecheck.code !== 0) process.exit(typecheck.code ?? 1)

  const unit = await runCommand('npm', ['run', 'unit'], { cwd: root, env: process.env, logFile: logs.test, label: 'npm run unit' })
  if (unit.code !== 0) process.exit(unit.code ?? 1)

  // Build with a stable app base (default /grantflow)
  const buildEnv = mergedEnv({
    VITE_APP_BASE: process.env.VITE_APP_BASE || '/grantflow',
    VITE_ASSET_BASE: process.env.VITE_ASSET_BASE || process.env.VITE_APP_BASE || '/grantflow',
  })
  const build = await runCommand('npm', ['run', 'build'], { cwd: root, env: buildEnv, logFile: logs.build, label: 'npm run build' })
  if (build.code !== 0) process.exit(build.code ?? 1)

  // Start backend (serves dist + /api) then run smoke against it.
  const backend = await startBackend(root, { outDir, logFile: logs.backend })
  const baseUrl = `http://127.0.0.1:${backend.port}`

  const smokeEnv = mergedEnv({
    SMOKE_BASE_URL: baseUrl,
    SMOKE_BASE_PATH: process.env.SMOKE_BASE_PATH || process.env.VITE_APP_BASE || '/grantflow',
    API_BASE_URL: baseUrl,
    SMOKE_ADMIN_TOKEN: process.env.SMOKE_ADMIN_TOKEN || backend.env.ADMIN_TOKEN,
    ARTIFACTS_DIR: outDir,
    // Keep smoke fast and deterministic by default.
    SMOKE_MAX_ROUTES: process.env.SMOKE_MAX_ROUTES || '20',
    SMOKE_MAX_CLICKS: process.env.SMOKE_MAX_CLICKS || '25',
    SMOKE_MAX_PER_SELECTOR: process.env.SMOKE_MAX_PER_SELECTOR || '10',
  })

  const smoke = await runCommand('npm', ['run', 'smoke'], {
    cwd: root,
    env: smokeEnv,
    logFile: logs.smoke,
    label: 'npm run smoke',
    timeoutMs: 10 * 60_000,
  })

  try { backend.proc.kill('SIGTERM') } catch {}

  if (smoke.code !== 0) process.exit(smoke.code ?? 1)
  writeFile(path.join(outDir, 'doctor-success.txt'), 'doctor: OK\n')
}

main().catch((err) => {
  console.error('[doctor] fatal:', err)
  process.exit(1)
})

