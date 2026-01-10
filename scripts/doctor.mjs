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

async function startPreview(root, { outDir, logFile, appBasePath, frontendEnv }) {
  const candidatePorts = [4173, 4174, 4175]
  for (const port of candidatePorts) {
    const available = await isPortAvailable(port)
    if (!available) continue

    const proc = startProcess(
      'npm',
      ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      {
        cwd: root,
        env: frontendEnv,
        logFile,
        label: `frontend preview:${port}`,
      },
    )

    const ok = await waitForHttpOk(`http://127.0.0.1:${port}${appBasePath}`, { timeoutMs: 30_000 })
    if (ok) {
      writeFile(path.join(outDir, 'frontend-port.txt'), `${port}\n`)
      return { proc, port }
    }

    try { proc.kill('SIGTERM') } catch {}
  }

  throw new Error('Frontend preview did not become ready on any candidate port (4173/4174/4175)')
}

async function main() {
  const root = repoRoot()
  const stamp = todayStamp()
  const outDir = artifactsDir(root, stamp)
  ensureDir(outDir)

  // Wipe prior artifacts for the day to keep evidence clean and deterministic.
  const wipeTargets = [
    path.join(outDir, 'lint.log'),
    path.join(outDir, 'typecheck.log'),
    path.join(outDir, 'test.log'),
    path.join(outDir, 'build.log'),
    path.join(outDir, 'backend.log'),
    path.join(outDir, 'frontend.log'),
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

  const summary = {
    stamp,
    root,
    outDir,
    node: process.version,
    startedAt: new Date().toISOString(),
  }
  writeFile(path.join(outDir, 'doctor-meta.json'), JSON.stringify(summary, null, 2))

  const logs = {
    lint: path.join(outDir, 'lint.log'),
    typecheck: path.join(outDir, 'typecheck.log'),
    test: path.join(outDir, 'test.log'),
    build: path.join(outDir, 'build.log'),
    backend: path.join(outDir, 'backend.log'),
    frontend: path.join(outDir, 'frontend.log'),
    smoke: path.join(outDir, 'smoke.log'),
  }

  // Install check (non-destructive): if node_modules missing, do npm ci.
  const nodeModules = path.join(root, 'node_modules')
  if (!fs.existsSync(nodeModules)) {
    const result = await runCommand('npm', ['ci', '--no-audit', '--no-fund'], { cwd: root, env: process.env, logFile: logs.test, label: 'npm ci' })
    if (result.code !== 0) process.exit(result.code ?? 1)
  }

  // Env inventory → docs/ENV_VARS.md
  const envInv = await runCommand('node', ['scripts/inventory-env.mjs'], { cwd: root, env: process.env, logFile: logs.test, label: 'env inventory' })
  if (envInv.code !== 0) process.exit(envInv.code ?? 1)

  // Lint
  const lint = await runCommand('npm', ['run', 'lint'], { cwd: root, env: process.env, logFile: logs.lint, label: 'npm run lint' })
  if (lint.code !== 0) process.exit(lint.code ?? 1)

  // Typecheck
  {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    if (pkg.scripts?.typecheck) {
      const tc = await runCommand('npm', ['run', 'typecheck'], { cwd: root, env: process.env, logFile: logs.typecheck, label: 'npm run typecheck' })
      if (tc.code !== 0) process.exit(tc.code ?? 1)
    } else {
      writeFile(logs.typecheck, 'typecheck: (no script configured)\n')
    }
  }

  // Unit
  {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    if (pkg.scripts?.unit) {
      const unit = await runCommand('npm', ['run', 'unit'], { cwd: root, env: process.env, logFile: logs.test, label: 'npm run unit' })
      if (unit.code !== 0) process.exit(unit.code ?? 1)
    } else {
      writeFile(path.join(outDir, 'unit.log'), 'unit: (no script configured)\n')
    }
  }

  // Build
  {
    const buildEnv = mergedEnv({
      VITE_APP_BASE: process.env.VITE_APP_BASE || '/grantflow',
      VITE_ASSET_BASE: process.env.VITE_ASSET_BASE || process.env.VITE_APP_BASE || '/grantflow',
    })
    const build = await runCommand('npm', ['run', 'build'], { cwd: root, env: buildEnv, logFile: logs.build, label: 'npm run build' })
    if (build.code !== 0) process.exit(build.code ?? 1)
  }

  // Servers + smoke
  const backend = await startBackend(root, { outDir, logFile: logs.backend })
  const apiBaseUrl = `http://127.0.0.1:${backend.port}`

  const frontendEnv = mergedEnv({
    NODE_ENV: 'development',
    SMOKE_MODE: 'true',
    VITE_APP_BASE: process.env.VITE_APP_BASE || '/grantflow',
    VITE_API_URL: apiBaseUrl,
    VITE_ASSET_BASE: process.env.VITE_ASSET_BASE || process.env.VITE_APP_BASE || '/grantflow',
  })

  const appBasePath = frontendEnv.VITE_APP_BASE && frontendEnv.VITE_APP_BASE !== '/'
    ? `/${String(frontendEnv.VITE_APP_BASE).replace(/^\/+/, '').replace(/\/+$/, '')}/`
    : '/'

  const preview = await startPreview(root, {
    outDir,
    logFile: logs.frontend,
    appBasePath,
    frontendEnv,
  })

  const smokeEnv = mergedEnv({
    SMOKE_BASE_URL: `http://127.0.0.1:${preview.port}`,
    SMOKE_BASE_PATH: process.env.SMOKE_BASE_PATH || frontendEnv.VITE_APP_BASE || '/grantflow',
    API_BASE_URL: apiBaseUrl,
    SMOKE_ADMIN_TOKEN: process.env.SMOKE_ADMIN_TOKEN || backend.env.ADMIN_TOKEN,
    ARTIFACTS_DIR: outDir,
  })

  const smoke = await runCommand('npm', ['run', 'smoke'], {
    cwd: root,
    env: smokeEnv,
    logFile: logs.smoke,
    label: 'npm run smoke',
    timeoutMs: 10 * 60_000,
  })

  try { backend.proc.kill('SIGTERM') } catch {}
  try { preview.proc.kill('SIGTERM') } catch {}

  if (smoke.code !== 0) {
    process.exit(smoke.code ?? 1)
  }

  writeFile(path.join(outDir, 'doctor-success.txt'), 'doctor: OK\n')
}

main().catch((err) => {
  console.error('[doctor] fatal:', err)
  process.exit(1)
})

