import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'

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

function sha256(text) {
  return crypto.createHash('sha256').update(text || '').digest('hex')
}

function computeInstallFingerprint(root) {
  const lockPath = path.join(root, 'package-lock.json')
  const pkgPath = path.join(root, 'package.json')
  const lock = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : ''
  const pkg = fs.existsSync(pkgPath) ? fs.readFileSync(pkgPath, 'utf8') : ''
  return sha256(`${pkg}\n---\n${lock}`)
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

function isPortAvailable(port, host = '127.0.0.1') {
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

function parsePortListEnv(name) {
  const raw = process.env[name]
  if (!raw) return null
  const ports = raw
    .split(',')
    .map((s) => Number.parseInt(String(s).trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 65536)
  return ports.length > 0 ? ports : null
}

function portRange(start, count) {
  const ports = []
  for (let i = 0; i < count; i++) ports.push(start + i)
  return ports
}

async function startFrontend(root, { outDir, logFile, basePath = '/grantflow', apiProxyTarget }) {
  const candidatePorts = parsePortListEnv('DOCTOR_FRONTEND_PORTS') || portRange(5173, 15) // 5173-5187
  for (const port of candidatePorts) {
    const available = await isPortAvailable(port)
    if (!available) continue

    const frontendEnv = mergedEnv({
      NODE_ENV: 'development',
      VITE_SMOKE_MODE: 'true',
      VITE_APP_BASE: process.env.VITE_APP_BASE || basePath,
      VITE_ASSET_BASE: process.env.VITE_ASSET_BASE || process.env.VITE_APP_BASE || basePath,
      // Proxy /api → backend. Doctor fills this once backend port is known.
      VITE_API_PROXY_TARGET: apiProxyTarget || process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:8080',
      // Some codepaths use VITE_API_URL directly (not the proxy).
      VITE_API_URL: apiProxyTarget || process.env.VITE_API_URL || '',
      // Keep frontend deterministic for smoke.
      SMOKE_MODE: 'true',
    })

    const proc = startProcess('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: root,
      env: frontendEnv,
      logFile,
      label: `frontend:${port}`,
    })

    // If base is configured under a subpath, ensure that path is reachable.
    const normalizedBase = (frontendEnv.VITE_APP_BASE || '/').replace(/\/$/, '')
    const checkUrl =
      normalizedBase && normalizedBase !== '/'
        ? `http://127.0.0.1:${port}${normalizedBase}/`
        : `http://127.0.0.1:${port}/`
    const ok = await waitForHttpOk(checkUrl, { timeoutMs: 45_000 })
    if (ok) {
      writeFile(path.join(outDir, 'frontend-port.txt'), `${port}\n`)
      return { proc, port, env: frontendEnv }
    }

    try { proc.kill('SIGTERM') } catch {}
  }

  throw new Error(`Frontend did not become healthy on any candidate port (${candidatePorts.join(',')})`)
}

async function startBackend(root, { outDir, logFile }) {
  const candidatePorts = parsePortListEnv('DOCTOR_BACKEND_PORTS') || portRange(8080, 15) // 8080-8094
  for (const port of candidatePorts) {
    // Express binds 0.0.0.0 by default; check port availability on all interfaces.
    const available = await isPortAvailable(port, '0.0.0.0')
    if (!available) continue

    const frontendPorts = parsePortListEnv('DOCTOR_FRONTEND_PORTS') || portRange(5173, 15) // 5173-5187
    const corsOrigins = [
      ...frontendPorts.flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]),
    ]

    const backendEnv = mergedEnv({
      NODE_ENV: 'development',
      SMOKE_MODE: 'true',
      PORT: String(port),
      ADMIN_TOKEN: process.env.ADMIN_TOKEN || 'dev-admin-token',
      // Serve the production build from the doctor run output directory (prod-like server shape).
      DIST_DIR: process.env.DIST_DIR || path.join(outDir, 'dist'),
      // Include a few candidate dev ports so we can start Vite on any of them without restarting backend.
      CORS_ORIGIN:
        process.env.CORS_ORIGIN || corsOrigins.join(','),
      AUTH_FRONTEND_APP_BASE: process.env.VITE_APP_BASE || '/grantflow',
      // Some routes gate production startup on OPENAI_API_KEY; keep dev runnable without real keys.
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
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

  throw new Error(`Backend did not become healthy on any candidate port (${candidatePorts.join(',')})`)
}

async function main() {
  const root = repoRoot()
  const stamp = todayStamp()
  const dayDir = artifactsDir(root, stamp)
  ensureDir(dayDir)
  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = path.join(dayDir, `run-${runId}`)
  ensureDir(outDir)
  // Convenience pointer for humans/tools.
  try {
    writeFile(path.join(dayDir, 'doctor-latest.txt'), `${outDir}\n`)
  } catch {}

  // Wipe prior artifacts for THIS run directory so reruns are easier to read.
  const wipeTargets = [
    path.join(outDir, 'install.log'),
    path.join(outDir, 'lint.log'),
    path.join(outDir, 'typecheck.log'),
    path.join(outDir, 'test.log'),
    path.join(outDir, 'build.log'),
    path.join(outDir, 'backend.log'),
    path.join(outDir, 'frontend.log'),
    path.join(outDir, 'smoke.log'),
    path.join(outDir, 'smoke-prod.log'),
    path.join(outDir, 'repro'),
    path.join(outDir, 'playwright-report'),
    path.join(outDir, 'playwright-output'),
    path.join(outDir, 'doctor-failure.txt'),
    path.join(outDir, 'doctor-success.txt'),
    path.join(outDir, 'trace.zip'),
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
    install: path.join(outDir, 'install.log'),
    lint: path.join(outDir, 'lint.log'),
    typecheck: path.join(outDir, 'typecheck.log'),
    test: path.join(outDir, 'test.log'),
    build: path.join(outDir, 'build.log'),
    backend: path.join(outDir, 'backend.log'),
    frontend: path.join(outDir, 'frontend.log'),
    smoke: path.join(outDir, 'smoke.log'),
    smokeProd: path.join(outDir, 'smoke-prod.log'),
  }

  // Ensure devDependencies (eslint/vite/playwright) are installed even if the parent environment
  // sets NODE_ENV=production (common in some shells/CI).
  const installEnv = mergedEnv({
    NODE_ENV: 'development',
  })

  // Install check (non-destructive): if node_modules missing OR lock changed, do npm ci.
  const nodeModulesDir = path.join(root, 'node_modules')
  const fingerprintFile = path.join(nodeModulesDir, '.grantflow-doctor-install-fingerprint')
  const expectedFingerprint = computeInstallFingerprint(root)
  const currentFingerprint =
    fs.existsSync(fingerprintFile) ? fs.readFileSync(fingerprintFile, 'utf8').trim() : null

  const binExists = (name) => {
    const binDir = path.join(nodeModulesDir, '.bin')
    const candidates =
      process.platform === 'win32'
        ? [`${name}.cmd`, `${name}.ps1`, `${name}.exe`, name]
        : [name]
    return candidates.some((f) => fs.existsSync(path.join(binDir, f)))
  }

  // If we have a fingerprint but dev deps weren't installed (common when NODE_ENV=production),
  // `npm run lint` / `vite` / `playwright` will fail. Treat missing bins as needing reinstall.
  const requiredBinsOk =
    fs.existsSync(nodeModulesDir) && binExists('eslint') && binExists('vite') && binExists('playwright')

  if (!fs.existsSync(nodeModulesDir) || currentFingerprint !== expectedFingerprint || !requiredBinsOk) {
    // Improve install reliability (Windows commonly fails with EPERM when unlinking native binaries).
    // Best-effort: remove node_modules up-front so `npm ci` doesn't need to unlink locked files.
    if (fs.existsSync(nodeModulesDir)) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          fs.rmSync(nodeModulesDir, { recursive: true, force: true })
          break
        } catch {
          if (attempt === 3) break
          await new Promise((r) => setTimeout(r, 500))
        }
      }
    }

    const ci = await runCommand('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], {
      cwd: root,
      env: installEnv,
      logFile: logs.install,
      label: 'npm ci',
    })
    if (ci.code !== 0) {
      // Fallback: `npm install` is often more resilient on Windows than `npm ci`.
      const install = await runCommand('npm', ['install', '--include=dev', '--no-audit', '--no-fund'], {
        cwd: root,
        env: installEnv,
        logFile: logs.install,
        label: 'npm install (fallback after npm ci failure)',
      })
      if (install.code !== 0) process.exit(install.code ?? ci.code ?? 1)
    }
    try {
      ensureDir(nodeModulesDir)
      // Only consider install successful once required tool shims exist.
      if (binExists('eslint') && binExists('vite') && binExists('playwright')) {
        writeFile(fingerprintFile, `${expectedFingerprint}\n`)
      }
    } catch {}
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
    NODE_ENV: 'production',
    VITE_APP_BASE: process.env.VITE_APP_BASE || '/grantflow',
    VITE_ASSET_BASE: process.env.VITE_ASSET_BASE || process.env.VITE_APP_BASE || '/grantflow',
    // Prevent local .env files from hardcoding a cross-origin backend URL into the production bundle.
    VITE_API_URL: '',
  })
  // Build output goes into artifacts to avoid Windows file-lock issues on repo-level dist/
  // and to keep "hard evidence" outputs co-located with logs.
  const doctorDistDir = path.join(outDir, 'dist')
  const build = await runCommand('npm', ['run', 'build', '--', '--outDir', doctorDistDir], {
    cwd: root,
    env: buildEnv,
    logFile: logs.build,
    label: `npm run build -- --outDir ${doctorDistDir}`,
  })
  if (build.code !== 0) process.exit(build.code ?? 1)

  // Start backend first, then Vite dev server (for "dev servers" evidence), then run smoke.
  let backend = null
  let frontend = null
  let exitCode = 0

  try {
    backend = await startBackend(root, { outDir, logFile: logs.backend })
    const baseUrl = `http://127.0.0.1:${backend.port}`

    frontend = await startFrontend(root, {
      outDir,
      logFile: logs.frontend,
      basePath: buildEnv.VITE_APP_BASE || '/grantflow',
      apiProxyTarget: baseUrl,
    })
    const uiBaseUrl = `http://127.0.0.1:${frontend.port}`

    const smokeEnv = mergedEnv({
      // UI base (Vite dev) + API base (Express)
      SMOKE_UI_BASE_URL: uiBaseUrl,
      SMOKE_BASE_URL: uiBaseUrl,
      SMOKE_BASE_PATH: process.env.SMOKE_BASE_PATH || process.env.VITE_APP_BASE || '/grantflow',
      API_BASE_URL: baseUrl,
      SMOKE_ADMIN_TOKEN: process.env.SMOKE_ADMIN_TOKEN || backend.env.ADMIN_TOKEN,
      SMOKE_BULK_KEY: process.env.SMOKE_BULK_KEY || process.env.BULK_POPULATE_KEY || 'grantflow-bulk-2026',
      ARTIFACTS_DIR: outDir,
      // Keep smoke fast and deterministic by default.
      SMOKE_MAX_ROUTES: process.env.SMOKE_MAX_ROUTES || '3',
      SMOKE_MAX_CLICKS: process.env.SMOKE_MAX_CLICKS || '10',
      SMOKE_MAX_PER_SELECTOR: process.env.SMOKE_MAX_PER_SELECTOR || '6',
      SMOKE_ROUTE_CLICK_BUDGET_MS: process.env.SMOKE_ROUTE_CLICK_BUDGET_MS || '15000',
    })

    const smoke = await runCommand('npm', ['run', 'smoke'], {
      cwd: root,
      env: smokeEnv,
      logFile: logs.smoke,
      label: 'npm run smoke',
      timeoutMs: 10 * 60_000,
    })

    if (smoke.code !== 0) {
      exitCode = smoke.code ?? 1
      // Make it easy to find a trace quickly.
      try {
        const outputDir = path.join(outDir, 'playwright-output')
        if (fs.existsSync(outputDir)) {
          const zips = fs
            .readdirSync(outputDir, { withFileTypes: true })
            .filter((d) => d.isFile() && d.name.endsWith('.zip'))
            .map((d) => d.name)
          if (zips.length > 0) {
            const newest = zips
              .map((name) => ({ name, mtime: fs.statSync(path.join(outputDir, name)).mtimeMs }))
              .sort((a, b) => b.mtime - a.mtime)[0]?.name
            if (newest) {
              fs.copyFileSync(path.join(outputDir, newest), path.join(outDir, 'trace.zip'))
            }
          }
        }
      } catch {}
    } else {
      // Also exercise "prod-like" server shape: backend serving the built SPA from DIST_DIR.
      const smokeProdEnv = mergedEnv({
        SMOKE_UI_BASE_URL: baseUrl,
        SMOKE_BASE_URL: baseUrl,
        SMOKE_BASE_PATH: process.env.SMOKE_BASE_PATH || process.env.VITE_APP_BASE || '/grantflow',
        API_BASE_URL: baseUrl,
        SMOKE_ADMIN_TOKEN: process.env.SMOKE_ADMIN_TOKEN || backend.env.ADMIN_TOKEN,
        SMOKE_BULK_KEY: process.env.SMOKE_BULK_KEY || process.env.BULK_POPULATE_KEY || 'grantflow-bulk-2026',
        ARTIFACTS_DIR: outDir,
        SMOKE_MAX_ROUTES: process.env.SMOKE_MAX_ROUTES || '3',
        SMOKE_MAX_CLICKS: process.env.SMOKE_MAX_CLICKS || '10',
        SMOKE_MAX_PER_SELECTOR: process.env.SMOKE_MAX_PER_SELECTOR || '6',
        SMOKE_ROUTE_CLICK_BUDGET_MS: process.env.SMOKE_ROUTE_CLICK_BUDGET_MS || '15000',
      })

      const smokeProd = await runCommand('npm', ['run', 'smoke'], {
        cwd: root,
        env: smokeProdEnv,
        logFile: logs.smokeProd,
        label: 'npm run smoke (backend-served SPA)',
        timeoutMs: 10 * 60_000,
      })

      if (smokeProd.code !== 0) {
        exitCode = smokeProd.code ?? 1
      } else {
        writeFile(path.join(outDir, 'doctor-success.txt'), 'doctor: OK\n')
      }
    }
  } finally {
    // Always clean up; otherwise a failed run can leave ports occupied and break the next run.
    try { frontend?.proc?.kill('SIGTERM') } catch {}
    try { backend?.proc?.kill('SIGTERM') } catch {}
  }

  if (exitCode !== 0) process.exit(exitCode)
}

main().catch((err) => {
  console.error('[doctor] fatal:', err)
  process.exit(1)
})

