// App launch harness for EVA web journeys.
//
// Before this existed, the orchestrator navigated Playwright straight at each
// app's manifest base_url with NOTHING listening on that port, so every web
// journey failed with net::ERR_CONNECTION_REFUSED even though the apps were
// healthy. This module does what the manifests always declared: it spawns the
// app's `start_command` in the app's own repo directory, waits for the
// `readiness_probe` to actually answer, and hands back a `stop()` that tears the
// whole process tree down again. It only ever launches the declared command in
// the declared directory — no arbitrary command execution.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A launched-but-unreadiable server is reported honestly (startup_failed),
// never silently passed. A web app with no start_command falls back to the old
// behavior (assume something external is already serving base_url).
export async function launchWebApp({ app, manifest, log = () => {}, launchEnv = null }) {
  const startCmd = manifest.start_command
  const cwd = manifest.local_path || app?.local_path || null
  const probe = manifest.readiness_probe || {}
  const baseUrl =
    manifest.base_url ||
    app?.base_url ||
    (probe.port ? `http://localhost:${probe.port}` : null)

  // Nothing to launch: no command, an explicit n/a, or no directory to run in.
  if (!startCmd || startCmd === 'n/a' || !cwd) {
    return { launched: false, ready: true, baseUrl, reason: 'no start_command', outputTail: () => '', failedProbeUrl: null, stop: async () => {} }
  }

  // Pre-launch hygiene: a prior app (or a dev server the owner left running)
  // squatting this app's ports makes the new server fail to bind. Free them
  // before spawning so the fleet run is order-independent.
  const preClearPorts = new Set()
  if (probe.port) preClearPorts.add(Number(probe.port))
  const preBasePort = baseUrl ? portOfUrl(baseUrl) : null
  if (preBasePort && preBasePort !== 80 && preBasePort !== 443) preClearPorts.add(preBasePort)
  for (const port of preClearPorts) freePortAndWait(port, { attempts: 8 })

  const env = launchEnv || { ...process.env, ...(manifest.launch_env || manifest.env || {}) }
  // The manifest declares where an app's disposable data goes; create it before
  // launch ONLY when the launch env actually points at it (PromoPilot's
  // better-sqlite3 SQLITE_PATH will not create its own parent and dies on the
  // first write). Creating it unconditionally would leave an untracked
  // `.eva-tmp/` in every app's repo every night — drift the owner never asked
  // for, in repos EVA is only supposed to read.
  if (envReferencesRoot(env, manifest.disposable_data_root)) {
    ensureDisposableRoot(cwd, manifest.disposable_data_root)
  }
  // Manifests use the POSIX idiom "backend & frontend" to mean "run BOTH
  // concurrently". Under shell:true on Windows that string reaches cmd.exe,
  // where a single `&` is a SEQUENTIAL separator — the backend dev server runs
  // in the foreground forever and the frontend is never started, so every
  // `a & b` app failed readiness on its frontend port (the 5273/5173
  // startup_failed class, 2026-07-28). Split on single `&` (never `&&`) and
  // spawn each segment as its own shell child; `cd x && …` prefixes stay inside
  // their own segment, and each segment starts from the app's repo root.
  const segments = splitConcurrentSegments(startCmd)
  // Capture the server's own stdout/stderr into a bounded ring. With
  // `stdio: 'ignore'` the runner could only ever report "did not become ready",
  // never WHY — so a one-line, self-describing cause ("FATAL: set ADMIN_TOKEN",
  // "Invalid value undefined for datasource") was thrown away every night.
  const output = createOutputRing()
  const children = segments.map((segment) =>
    spawn(segment, {
      cwd,
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    }),
  )
  for (const child of children) {
    child.stdout?.on('data', (chunk) => output.push(chunk))
    child.stderr?.on('data', (chunk) => output.push(chunk))
    child.stdout?.on('error', () => {})
    child.stderr?.on('error', () => {})
  }

  const exitInfos = new Array(children.length).fill(null)
  children.forEach((child, i) => {
    child.on('exit', (code, signal) => {
      exitInfos[i] = { code, signal }
    })
    child.on('error', (err) => {
      output.push(`[launcher] spawn error: ${err?.message || err}\n`)
    })
  })
  // "Dead" means EVERY segment has exited — while any survives, the server we
  // are waiting on may still be coming up.
  const allExited = () => exitInfos.every(Boolean)

  const stop = async () => stopLaunched(children, probe, baseUrl)

  // Readiness: for an http probe, poll until the server answers (any HTTP
  // response means it is up). Without an http probe we cannot confirm a port,
  // so we grant a short grace period and proceed — the journey's own goto still
  // fails honestly if nothing is listening.
  const timeoutMs = probe.timeout_ms || manifest.max_runtime_ms || 60000
  if (probe.type === 'http' && (baseUrl || probe.port)) {
    // Manifests may declare the health endpoint on a BACKEND port (probe.port)
    // while journeys navigate the FRONTEND base_url. Probing only base_url
    // asked e.g. are-we-mice for /health on 5273 (its Vite port) though the
    // health route lives on 3001 — and probing only probe.port would declare
    // ready before the frontend listens. Wait for BOTH when they differ.
    const readyUrls = []
    const probePath = probe.path || '/'
    if (probe.port) readyUrls.push(safeJoin(`http://localhost:${probe.port}`, probePath))
    if (baseUrl) {
      const baseProbe = probe.port && portOfUrl(baseUrl) !== Number(probe.port)
        ? safeJoin(baseUrl, '/')
        : safeJoin(baseUrl, probe.port ? '/' : probePath)
      if (!readyUrls.includes(baseProbe)) readyUrls.push(baseProbe)
    }
    let ready = true
    let failedProbeUrl = null
    for (const readyUrl of readyUrls) {
      ready = await waitForHttp(readyUrl, {
        timeoutMs,
        isDead: allExited,
      })
      if (!ready) {
        failedProbeUrl = readyUrl
        log(`[launcher] ${manifest.app_id || app?.app_id}: not ready at ${readyUrl} within ${timeoutMs}ms${allExited() ? ` (start_command exited ${JSON.stringify(exitInfos)})` : ''}`)
        break
      }
    }
    return { launched: true, ready, baseUrl, failedProbeUrl, exitInfos, outputTail: output.tail, pid: children[0]?.pid, stop }
  }

  await sleep(Math.min(timeoutMs, 3000))
  return { launched: true, ready: !allExited(), baseUrl, failedProbeUrl: null, exitInfos, outputTail: output.tail, pid: children[0]?.pid, stop }
}

// Bounded capture of a launched server's console output. Keeps only the LAST
// `limit` characters so a chatty dev server cannot grow memory, and returns the
// most useful slice: the tail is where a fatal error lands.
export function createOutputRing(limit = 8000) {
  let buf = ''
  return {
    push(chunk) {
      buf += String(chunk)
      if (buf.length > limit) buf = buf.slice(buf.length - limit)
    },
    tail(maxChars = 400) {
      const lines = buf
        .split(/\r?\n/)
        .map((l) => l.replace(/\[[0-9;]*[A-Za-z]/g, '').trim())
        .filter(Boolean)
      const out = lines.slice(-6).join(' | ')
      return out.length > maxChars ? out.slice(out.length - maxChars) : out
    },
  }
}

// Split a start_command on single `&` (the POSIX "run concurrently" idiom) while
// leaving `&&` chains intact. "cd backend && npm run dev & npm run dev" →
// ["cd backend && npm run dev", "npm run dev"]. Quoted ampersands are not a
// concern for these manifests (commands are simple npm/pnpm/python invocations).
// Does any launch-env value actually point INTO the declared disposable root?
// Only then is creating the directory something the app asked for.
export function envReferencesRoot(env, root) {
  if (!root || typeof root !== 'string') return false
  const needle = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  if (!needle) return false
  return Object.values(env || {}).some((v) => String(v ?? '').replace(/\\/g, '/').toLowerCase().includes(needle))
}

// Create the manifest's declared disposable data root inside the app repo.
// Only ever a path RELATIVE to the app's own directory — an absolute or
// escaping root is ignored rather than created somewhere unexpected.
export function ensureDisposableRoot(cwd, root, mkdir = mkdirSync) {
  if (!cwd || !root || typeof root !== 'string') return null
  // `isAbsolute` is platform-dependent — on POSIX it says "C:/Windows" is
  // RELATIVE — so the Windows drive-letter and UNC forms are rejected
  // explicitly. The rule must not change with the host the tests run on.
  const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(root) || /^[\\/]{2}/.test(root)
  if (isAbsolute(root) || windowsAbsolute || root.split(/[\\/]/).includes('..')) return null
  const full = join(cwd, root)
  try {
    mkdir(full, { recursive: true })
    return full
  } catch {
    return null
  }
}

export function splitConcurrentSegments(command) {
  const segments = String(command || '')
    .split(/(?<![&])&(?![&])/)
    .map((s) => s.trim())
    .filter(Boolean)
  return segments.length ? segments : [String(command || '')]
}

function portOfUrl(url) {
  try {
    const u = new URL(url)
    return Number(u.port || (u.protocol === 'https:' ? 443 : 80))
  } catch {
    return null
  }
}

// Poll an http(s) endpoint until it answers or the deadline passes. Uses the
// global fetch (Node >=18). Any resolved response — even a 4xx/5xx — proves the
// server is listening; a thrown error means "not up yet, keep waiting".
async function waitForHttp(url, { timeoutMs = 60000, intervalMs = 600, isDead = () => false } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (isDead()) {
      // The start_command died. Give any in-flight bind a beat, then bail so we
      // don't burn the whole timeout on a process that already exited.
      await sleep(intervalMs)
      if (isDead()) return false
    }
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), Math.min(intervalMs * 4, 5000))
      const resp = await fetch(url, { signal: ctrl.signal, redirect: 'manual' })
      clearTimeout(t)
      if (resp) return true
    } catch {
      /* connection refused / reset / abort => not ready yet */
    }
    await sleep(intervalMs)
  }
  return false
}

// Tear down the spawned server(s) and everything they started. On Windows each
// child is a shell whose grandchildren (node/vite/python) survive a plain kill,
// so we use `taskkill /T` to kill the tree; on POSIX we signal the process
// group. We additionally free BOTH declared ports (readiness probe port and the
// base_url port — often backend + frontend of the same app) in case a
// grandchild re-parented away from our tree.
function stopLaunched(children, probe = {}, baseUrl = null) {
  const list = Array.isArray(children) ? children : [children]
  for (const child of list) {
    const pid = child?.pid
    try {
      if (process.platform === 'win32') {
        if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
      } else if (pid) {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            /* already gone */
          }
        }
      }
    } catch {
      /* best-effort */
    }
  }
  const ports = new Set()
  if (probe.port) ports.add(Number(probe.port))
  const basePort = baseUrl ? portOfUrl(baseUrl) : null
  if (basePort && basePort !== 80 && basePort !== 443) ports.add(basePort)
  // Free each port AND confirm it is actually released before returning. Apps
  // run sequentially and several share ports (are-we-mice + mind-over-math both
  // bind frontend 5273 / backend 3001), so if the NEXT app spawns while a prior
  // grandchild still holds the port, its own server fails to bind and reads as
  // startup_failed — a teardown race, not a real failure (the 2026-07-28
  // flaky-fleet class). Block here until the ports are free (bounded).
  for (const port of ports) freePortAndWait(port)
}

// Free a port and spin until it is no longer LISTENing (Windows), bounded to a
// few seconds so a genuinely stuck port can't hang the whole fleet run.
function freePortAndWait(port, { attempts = 20, intervalMs = 250 } = {}) {
  freePort(port)
  if (process.platform !== 'win32') return
  for (let i = 0; i < attempts; i++) {
    const res = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count`],
      { encoding: 'utf8' },
    )
    if (String(res.stdout || '').trim() === '0') return
    freePort(port)
    spawnSync('powershell', ['-NoProfile', '-Command', `Start-Sleep -Milliseconds ${intervalMs}`], { stdio: 'ignore' })
  }
}

// Kill whatever still holds a TCP port (Windows). Only used as a post-stop
// safety net for a server we ourselves launched; we never target a port we
// weren't asked to free.
function freePort(port) {
  if (process.platform !== 'win32') return
  try {
    const res = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -Expand OwningProcess`],
      { encoding: 'utf8' },
    )
    const pids = String(res.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    for (const p of pids) spawnSync('taskkill', ['/PID', p, '/T', '/F'], { stdio: 'ignore' })
  } catch {
    /* best-effort */
  }
}

function safeJoin(baseUrl, path) {
  try {
    return new URL(path || '/', baseUrl).toString()
  } catch {
    return baseUrl
  }
}
