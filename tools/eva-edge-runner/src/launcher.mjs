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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A launched-but-unreadiable server is reported honestly (startup_failed),
// never silently passed. A web app with no start_command falls back to the old
// behavior (assume something external is already serving base_url).
export async function launchWebApp({ app, manifest, log = () => {} }) {
  const startCmd = manifest.start_command
  const cwd = manifest.local_path || app?.local_path || null
  const probe = manifest.readiness_probe || {}
  const baseUrl =
    manifest.base_url ||
    app?.base_url ||
    (probe.port ? `http://localhost:${probe.port}` : null)

  // Nothing to launch: no command, an explicit n/a, or no directory to run in.
  if (!startCmd || startCmd === 'n/a' || !cwd) {
    return { launched: false, ready: true, baseUrl, reason: 'no start_command', stop: async () => {} }
  }

  const env = { ...process.env, ...(manifest.launch_env || manifest.env || {}) }
  // shell:true so multi-part manifest commands work verbatim on Windows and
  // POSIX ("npm run dev", "npm run dev:full", "a && b", "a & b"). detached on
  // POSIX gives us a process group to kill; on Windows we use taskkill /T.
  const child = spawn(startCmd, {
    cwd,
    shell: true,
    detached: process.platform !== 'win32',
    stdio: 'ignore',
    env,
  })

  let exited = false
  let exitInfo = null
  child.on('exit', (code, signal) => {
    exited = true
    exitInfo = { code, signal }
  })

  const stop = async () => stopLaunched(child, probe)

  // Readiness: for an http probe, poll until the server answers (any HTTP
  // response means it is up). Without an http probe we cannot confirm a port,
  // so we grant a short grace period and proceed — the journey's own goto still
  // fails honestly if nothing is listening.
  const timeoutMs = probe.timeout_ms || manifest.max_runtime_ms || 60000
  if (probe.type === 'http' && baseUrl) {
    const readyUrl = safeJoin(baseUrl, probe.path || '/')
    const ready = await waitForHttp(readyUrl, {
      timeoutMs,
      isDead: () => exited,
    })
    if (!ready) {
      log(`[launcher] ${manifest.app_id || app?.app_id}: not ready at ${readyUrl} within ${timeoutMs}ms${exited ? ` (start_command exited ${JSON.stringify(exitInfo)})` : ''}`)
    }
    return { launched: true, ready, baseUrl, pid: child.pid, stop }
  }

  await sleep(Math.min(timeoutMs, 3000))
  return { launched: true, ready: !exited, baseUrl, pid: child.pid, stop }
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

// Tear down the spawned server and everything it started. On Windows the child
// is a shell whose grandchildren (node/vite/python) survive a plain kill, so we
// use `taskkill /T` to kill the tree; on POSIX we signal the process group.
// stop_command "taskkill-by-port" additionally frees the readiness port in case
// a grandchild re-parented away from our tree.
function stopLaunched(child, probe = {}) {
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
  if (probe.port) freePort(probe.port)
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
