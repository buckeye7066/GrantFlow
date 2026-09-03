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
import { mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join, isAbsolute, resolve, sep } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// WHO MAY BE KILLED TO FREE A PORT
//
// Freeing a port used to mean "taskkill whatever owns it". That is a claim
// about a PORT NUMBER, not about a process EVA started, and the two diverge
// badly on Windows: Docker Desktop PUBLISHES every container port through
// `com.docker.backend`, so a published port's owning PID is Docker's backend
// itself. Measured 2026-08-03 with the family-stewardship-navigator compose
// stack up: 127.0.0.1:3001 (its server container) and 127.0.0.1:5180 (its web
// container) both resolve to `com.docker.backend` — and 3001 is the probe port
// of three OTHER manifests (sermonsmith, are-we-mice, mind-over-math) while
// 5180 is factory-deck's. Any of them, and FSN itself, would have taskkilled
// Docker Desktop's backend before launching. FSN's ONLY declared prerequisite
// is a live Docker daemon, so EVA could destroy the prerequisite it then blocks
// on, and the owner-facing remedy ("leave Docker Desktop running overnight")
// could never work. Its manifest even lists `com.docker.backend` in
// allowlist.processes, i.e. it authorized exactly the kill that breaks it.
//
// The rule is therefore a POSITIVE allowlist: EVA frees a port only by killing a
// process class the manifest declared it may run, and never touches shared
// infrastructure it did not start. A port it may not clear is REPORTED (the
// squatter is named), never silently ignored and never force-killed.
// ---------------------------------------------------------------------------

/** Shared infrastructure EVA never kills, whatever a manifest declares. */
export const PROTECTED_PORT_HOLDERS = new Set([
  'com.docker.backend',
  'com.docker.service',
  'com.docker.proxy',
  'com.docker.dev-envs',
  'docker',
  'dockerd',
  'docker desktop',
  'docker desktop backend',
  'wsl',
  'wslservice',
  'wslhost',
  'vmmem',
  'vmmemwsl',
  'vmcompute',
  'system',
  'idle',
  'services',
  'svchost',
  'lsass',
  'wininit',
  'csrss',
  'postgres',
  'pg_ctl',
  'mysqld',
  'sqlservr',
  'redis-server',
  'mongod',
])

/** Dev-server images EVA may clear when a manifest declares no process list. */
export const DEFAULT_KILLABLE_PROCESSES = new Set([
  'node',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'vite',
  'python',
  'python3',
  'py',
  'streamlit',
  'uvicorn',
  'gunicorn',
  'deno',
  'bun',
  'electron',
])

/** `Node.EXE` / `python3.exe ` / `  npm ` all normalize to one comparable key. */
export function normalizeProcessName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, '')
}

/**
 * The process names EVA may kill to free THIS app's ports: the manifest's own
 * `allowlist.processes` when it declares any, else the conservative dev-server
 * default. `PROTECTED_PORT_HOLDERS` always wins — a manifest cannot authorize
 * killing shared infrastructure (family-stewardship-navigator's allowlist
 * literally lists `com.docker.backend`, which is exactly the process whose death
 * blocks it).
 */
export function resolveKillableProcesses(manifest) {
  const declared = Array.isArray(manifest?.allowlist?.processes) ? manifest.allowlist.processes : []
  const base = declared.length ? declared.map(normalizeProcessName) : [...DEFAULT_KILLABLE_PROCESSES]
  return new Set(base.filter(Boolean).filter((n) => !PROTECTED_PORT_HOLDERS.has(n)))
}

/** May EVA kill a process with this image name to free a port? */
export function mayKillProcess(name, killable) {
  const key = normalizeProcessName(name)
  if (!key) return false
  if (PROTECTED_PORT_HOLDERS.has(key)) return false
  return killable instanceof Set ? killable.has(key) : false
}

/**
 * Ports a server ANNOUNCED in its own output. A manifest's `readiness_probe.port`
 * is a GUESS about what the app will bind; the app's own line ("SermonSmith API
 * running on 127.0.0.1:3101") is the fact. When readiness fails, comparing the
 * two turns "not ready at http://localhost:3001/healthz" — a mystery repeated
 * nightly — into a named, one-line fix.
 * Only 4-5 digit ports are considered so a log timestamp (11:35:41) cannot be
 * read as a port.
 */
export function detectAnnouncedPorts(text) {
  const s = String(text || '')
  const out = new Set()
  // Stack frames also contain `file.js:14849:15`; an unrestricted host:port
  // pattern therefore reported source line numbers as manifest drift. URLs
  // are unambiguous announcements, while bare host:port pairs count only on a
  // line whose wording says the process started listening.
  for (const m of s.matchAll(/\b(?:https?|wss?):\/\/(?:\[[0-9a-f:]+\]|[A-Za-z0-9._-]+):(\d{4,5})\b/gi)) {
    out.add(Number(m[1]))
  }
  for (const line of s.split(/\r?\n|\s+\|\s+/)) {
    if (!/\b(?:listen(?:ing)?|running|ready|started|bound)\b/i.test(line)) continue
    for (const m of line.matchAll(/(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\]|localhost|[A-Za-z][A-Za-z0-9._-]*):(\d{4,5})\b/g)) {
      out.add(Number(m[1]))
    }
  }
  for (const m of s.matchAll(/\bport\s*[=:]?\s*(\d{4,5})\b/gi)) out.add(Number(m[1]))
  return [...out].filter((p) => p >= 1024 && p <= 65535).sort((a, b) => a - b)
}

/**
 * Announced ports the manifest does not declare. Empty when the app announced
 * nothing, or announced only ports we were already probing — absence of evidence
 * is never reported as drift.
 */
export function detectPortDrift({ output = '', declaredPorts = [] } = {}) {
  const declared = new Set((declaredPorts || []).map(Number).filter(Boolean))
  return detectAnnouncedPorts(output).filter((p) => !declared.has(p))
}

// A launched-but-unreadiable server is reported honestly (startup_failed),
// never silently passed. A web app with no start_command falls back to the old
// behavior (assume something external is already serving base_url).
export async function launchWebApp({ app, manifest, log = () => {}, launchEnv = null, freePortFn = freePortAndWait }) {
  const startCmd = manifest.start_command
  const cwd = manifest.local_path || app?.local_path || null
  const probe = manifest.readiness_probe || {}
  const probeHost = probe.host || '127.0.0.1'
  const baseUrl =
    manifest.base_url ||
    app?.base_url ||
    (probe.port ? `http://${probeHost}:${probe.port}` : null)

  // Nothing to launch: no command, an explicit n/a, or no directory to run in.
  if (!startCmd || startCmd === 'n/a' || !cwd) {
    return { launched: false, ready: true, baseUrl, reason: 'no start_command', outputTail: () => '', failedProbeUrl: null, stop: async () => {} }
  }

  // A cwd that does not exist on this machine can never start the app, and on
  // Windows it surfaces as `spawn C:\…\cmd.exe ENOENT` — an error that names the
  // SHELL, not the cause, which is how a fleet-wide bad-local_path condition
  // (the 2026-08-06 `example_user` sanitization) read as 13 unrelated app
  // failures for 9 nights. Name the actual defect and where to fix it.
  if (!existsSync(cwd)) {
    const msg = `[launcher] ${manifest.app_id || app?.app_id}: local_path does not exist on this machine: ${cwd} — fix local_path in qa/portfolio-registry.json / qa/manifests (portable form: ~/<repo-dir>)`
    log(msg)
    return {
      launched: true,
      ready: false,
      baseUrl,
      failedProbeUrl: null,
      exitInfos: [null],
      outputTail: () => msg,
      portDrift: [],
      blockedPorts: [],
      declaredPorts: [],
      stop: async () => {},
    }
  }

  const rawEnv = launchEnv || { ...process.env, ...(manifest.launch_env || manifest.env || {}) }
  const env = resolveDisposableLaunchEnv(rawEnv, cwd, manifest.disposable_data_root)
  let fixtureEnvFiles = []

  // Pre-launch hygiene: a prior app (or a dev server the owner left running)
  // squatting this app's ports makes the new server fail to bind. Free them
  // before spawning so the fleet run is order-independent.
  const preClearPorts = new Set()
  if (probe.port) preClearPorts.add(Number(probe.port))
  const preBasePort = baseUrl ? portOfUrl(baseUrl) : null
  if (preBasePort && preBasePort !== 80 && preBasePort !== 443) preClearPorts.add(preBasePort)
  const killable = resolveKillableProcesses(manifest)
  // A pre-existing PID is never owned merely because its image is "node" or
  // "python". Preflight therefore kills nothing: any occupied declared port is
  // named and blocks before spawn, rather than terminating a developer app or
  // probing the unrelated service.
  const blockedPorts = []
  for (const port of preClearPorts) {
    const res = freePortFn(port, { attempts: 1, killable: new Set() })
    if (res && !res.freed && res.blockedBy?.length) {
      blockedPorts.push(res)
      log(
        `[launcher] ${manifest.app_id || app?.app_id}: port ${port} is held by ${res.blockedBy
          .map((p) => p.name)
          .join(', ')} — EVA does not kill shared infrastructure it did not start`,
      )
    }
  }
  if (blockedPorts.length) {
    const msg = `[launcher] ${manifest.app_id || app?.app_id}: refusing to launch or probe while a protected process owns declared port(s) ${blockedPorts.map((p) => p.port).join(', ')}; a response there would belong to the wrong service`
    log(msg)
    return {
      launched: true,
      ready: false,
      baseUrl,
      failedProbeUrl: probe.port ? `http://${probeHost}:${probe.port}${probe.path || '/'}` : baseUrl,
      exitInfos: [null],
      outputTail: () => msg,
      portDrift: [],
      blockedPorts,
      declaredPorts: [...preClearPorts],
      stop: async () => {},
    }
  }

  // Write credentials as late as possible, after every pre-launch refusal.
  // If process creation itself throws, remove them before propagating.
  fixtureEnvFiles = writeFixtureEnvFiles(cwd, manifest, env)
  // The manifest declares where an app's disposable data goes; create it before
  // launch ONLY when the launch env actually points at it (PromoPilot's
  // better-sqlite3 SQLITE_PATH will not create its own parent and dies on the
  // first write). Creating it unconditionally would leave an untracked
  // `.eva-tmp/` in every app's repo every night — drift the owner never asked
  // for, in repos EVA is only supposed to read.
  if (manifest.__eva_isolated_workspace && manifest.disposable_data_root) {
    // Persistent isolated worktrees reuse ignored dependency caches, but test
    // data must never leak between nights. Reset only the declared relative
    // root inside EVA's dedicated workspace; developer checkouts are never
    // deleted from or cleaned by this path.
    resetDisposableRoot(cwd, manifest.disposable_data_root)
  } else if (envReferencesRoot(env, manifest.disposable_data_root)) {
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
  let children
  try {
    children = segments.map((segment) =>
      spawn(segment, {
        cwd,
        shell: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      }),
    )
  } catch (err) {
    removeFixtureEnvFiles(fixtureEnvFiles)
    throw err
  }
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
      exitInfos[i] = { code: null, signal: null, spawn_error: String(err?.message || err) }
      output.push(`[launcher] spawn error: ${err?.message || err}\n`)
    })
  })
  // Every concurrent segment is a required service. If the backend exits while
  // Vite remains alive, waiting the full timeout only turns a precise process
  // failure into a vague readiness timeout. Detached compose is the one common
  // exception: `up -d` is a successful one-shot starter and the containers own
  // readiness after it exits.
  const starterMayExit = manifest.start_process_may_exit === true ||
    /\bdocker(?:\s+compose|-compose)\b.*\bup\b.*(?:^|\s)-d(?:\s|$)/i.test(startCmd)
  const requiredProcessExited = () => !starterMayExit && exitInfos.some(Boolean)

  const stop = async () => {
    try {
      const stopCommand = String(manifest.stop_command || '').trim()
      const declarativeStopOnly = new Set(['taskkill-by-port', 'n/a', 'close window'])
      if (stopCommand && !declarativeStopOnly.has(stopCommand.toLowerCase())) {
        const stopped = spawnSync(stopCommand, {
          cwd,
          shell: true,
          env,
          encoding: 'utf8',
          timeout: Math.min(Number(manifest.max_runtime_ms) || 120000, 120000),
          windowsHide: true,
        })
        if (stopped.status !== 0) {
          output.push(`[launcher] stop_command failed (${stopped.status}): ${stopped.stderr || stopped.stdout || ''}\n`)
        }
      }
    } finally {
      await stopLaunched(children, probe, baseUrl, killable)
      removeFixtureEnvFiles(fixtureEnvFiles)
    }
  }
  const declaredPorts = [...preClearPorts]

  // Readiness: for an http probe, poll until the server answers (any HTTP
  // response means it is up). Without an http probe we cannot confirm a port,
  // so we grant a short grace period and proceed — the journey's own goto still
  // fails honestly if nothing is listening.
  const timeoutMs = probe.timeout_ms || manifest.max_runtime_ms || 60000
  const startupDeadline = Date.now() + timeoutMs
  const remainingStartupMs = () => Math.max(0, startupDeadline - Date.now())
  if (probe.type === 'http' && (baseUrl || probe.port)) {
    // Manifests may declare the health endpoint on a BACKEND port (probe.port)
    // while journeys navigate the FRONTEND base_url. Probing only base_url
    // asked e.g. are-we-mice for /health on 5273 (its Vite port) though the
    // health route lives on 3001 — and probing only probe.port would declare
    // ready before the frontend listens. Wait for BOTH when they differ.
    const readyUrls = []
    const probePath = probe.path || '/'
    if (probe.port) readyUrls.push(safeJoin(`http://${probeHost}:${probe.port}`, probePath))
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
        timeoutMs: remainingStartupMs(),
        acceptedStatuses: probe.accepted_statuses,
        isDead: requiredProcessExited,
      })
      if (!ready) {
        failedProbeUrl = readyUrl
        log(`[launcher] ${manifest.app_id || app?.app_id}: not ready at ${readyUrl} within the shared ${timeoutMs}ms startup deadline${requiredProcessExited() ? ` (required start process exited ${JSON.stringify(exitInfos)})` : ''}`)
        break
      }
    }
    // Warm-path stage: "answers" ≠ "can serve the app". A dev server that is
    // still cold-transforming (or about to reload for dependency
    // re-optimization) passes the listen probe and then drops the journeys'
    // module requests. Each declared warm path must return an OK, non-empty
    // body on consecutive polls before the app is called ready.
    if (ready && baseUrl) {
      const warmPaths = new Set(Array.isArray(probe.warm_paths) ? probe.warm_paths : [])
      // Every Vite app inherits the cold-transform guard. Requiring each
      // manifest author to remember /@vite/client let the same first-navigation
      // timeout recur in GeneMap, GrantFlow, SermonSmith, and Incognito.
      if (/\bVITE\s+v?\d/i.test(output.snapshot())) warmPaths.add('/@vite/client')
      for (const warmPath of warmPaths) {
        const warmUrl = safeJoin(baseUrl, warmPath)
        ready = await waitForWarmPath(warmUrl, {
          timeoutMs: remainingStartupMs(),
          isDead: requiredProcessExited,
        })
        if (!ready) {
          failedProbeUrl = warmUrl
          log(`[launcher] ${manifest.app_id || app?.app_id}: listen probe passed but warm path ${warmUrl} never served a stable non-empty response within ${timeoutMs}ms`)
          break
        }
      }
    }
    // The app's own output outranks the manifest's guess about its port. Only
    // computed on a FAILED probe: a ready app has already proved the declared
    // port right, and reporting "drift" for a frontend port the backend logged
    // would be noise.
    const portDrift = ready ? [] : detectPortDrift({ output: output.tail(4000), declaredPorts })
    if (portDrift.length) {
      log(
        `[launcher] ${manifest.app_id || app?.app_id}: the app announced port(s) ${portDrift.join(', ')} but the manifest declares ${declaredPorts.join(', ')} — manifest port drift`,
      )
    }
    return { launched: true, ready, baseUrl, failedProbeUrl, exitInfos, outputTail: output.tail, pid: children[0]?.pid, portDrift, blockedPorts, declaredPorts, stop }
  }

  await sleep(Math.min(timeoutMs, 3000))
  return { launched: true, ready: starterMayExit || !requiredProcessExited(), baseUrl, failedProbeUrl: null, exitInfos, outputTail: output.tail, pid: children[0]?.pid, portDrift: [], blockedPorts, declaredPorts, stop }
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
    snapshot(maxChars = limit) {
      return buf.length > maxChars ? buf.slice(buf.length - maxChars) : buf
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

function workspaceRelativeFile(cwd, relativePath) {
  if (!cwd || typeof relativePath !== 'string' || !relativePath.trim()) return null
  const raw = relativePath.trim()
  if (isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) || /^[\\/]{2}/.test(raw) || raw.split(/[\\/]/).includes('..')) return null
  const base = resolve(cwd)
  const full = resolve(base, raw)
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`
  return full.startsWith(prefix) ? full : null
}

/** Write gitignored fixture env files only inside EVA's isolated worktree. */
export function writeFixtureEnvFiles(cwd, manifest, env, { write = writeFileSync } = {}) {
  const specs = Array.isArray(manifest?.fixture_env_files) ? manifest.fixture_env_files : []
  if (!specs.length) return []
  if (manifest?.__eva_isolated_workspace !== true) {
    throw new Error('fixture_env_files are allowed only in an EVA-owned isolated workspace')
  }
  const written = []
  try {
    for (const spec of specs) {
      const full = workspaceRelativeFile(cwd, spec?.path)
      if (!full) throw new Error(`unsafe fixture env path: ${spec?.path || '(missing)'}`)
      const names = Array.isArray(spec?.variables) ? spec.variables : []
      const lines = []
      for (const name of names) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name))) throw new Error(`unsafe fixture env variable: ${name}`)
        const value = env?.[name]
        if (value === undefined || value === null || String(value).includes('\n') || String(value).includes('\r')) {
          throw new Error(`fixture env variable is missing or multiline: ${name}`)
        }
        lines.push(`${name}=${String(value)}`)
      }
      mkdirSync(resolve(full, '..'), { recursive: true })
      write(full, `${lines.join('\n')}\n`, { mode: 0o600 })
      written.push(full)
    }
    return written
  } catch (error) {
    removeFixtureEnvFiles(written)
    throw error
  }
}

export function removeFixtureEnvFiles(paths, { remove = rmSync } = {}) {
  for (const file of Array.isArray(paths) ? paths : []) {
    try { remove(file, { force: true }) } catch { /* best-effort credential cleanup */ }
  }
}

// Create the manifest's declared disposable data root inside the app repo.
// Only ever a path RELATIVE to the app's own directory — an absolute or
// escaping root is ignored rather than created somewhere unexpected.
export function ensureDisposableRoot(cwd, root, mkdir = mkdirSync) {
  const full = resolveDisposableRoot(cwd, root)
  if (!full) return null
  try {
    mkdir(full, { recursive: true })
    return full
  } catch {
    return null
  }
}

function resolveDisposableRoot(cwd, root) {
  if (!cwd || !root || typeof root !== 'string') return null
  // `isAbsolute` is platform-dependent — on POSIX it says "C:/Windows" is
  // RELATIVE — so the Windows drive-letter and UNC forms are rejected
  // explicitly. The rule must not change with the host the tests run on.
  const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(root) || /^[\\/]{2}/.test(root)
  if (isAbsolute(root) || windowsAbsolute || root.split(/[\\/]/).includes('..')) return null
  const base = resolve(cwd)
  const full = resolve(base, root)
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`
  if (full === base || !full.startsWith(prefix)) return null
  return full
}

/**
 * Resolve manifest env paths inside `disposable_data_root` before launch.
 *
 * App manifests are portable and therefore store these paths relative to the
 * repository. Some applications correctly require an absolute data directory;
 * the launcher owns the conversion because it alone knows the isolated checkout
 * path. Only values at or below the declared disposable root are rewritten.
 */
export function resolveDisposableLaunchEnv(env, cwd, root) {
  const result = { ...(env || {}) }
  const fullRoot = resolveDisposableRoot(cwd, root)
  if (!fullRoot) return result

  const normalizedRoot = String(root).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  const rootPrefix = fullRoot.endsWith(sep) ? fullRoot : `${fullRoot}${sep}`
  for (const [name, value] of Object.entries(result)) {
    if (typeof value !== 'string' || !value.trim()) continue
    const raw = value.trim()
    if (isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) || /^[\\/]{2}/.test(raw)) continue
    const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '')
    if (normalized !== normalizedRoot && !normalized.startsWith(`${normalizedRoot}/`)) continue
    const full = resolve(cwd, raw)
    if (full === fullRoot || full.startsWith(rootPrefix)) result[name] = full
  }
  return result
}

export function resetDisposableRoot(cwd, root, { remove = rmSync, mkdir = mkdirSync } = {}) {
  const full = resolveDisposableRoot(cwd, root)
  if (!full) return null
  try {
    remove(full, { recursive: true, force: true })
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
// global fetch (Node >=18). Two consecutive accepted responses are required so
// a one-poll proxy/reload window cannot green-light browser journeys. By
// default only 2xx/3xx count; a 401/404/503 is an answering server, but it is
// not a ready application. A manifest may narrow this further with
// readiness_probe.accepted_statuses.
export async function waitForHttp(url, {
  timeoutMs = 60000,
  intervalMs = 600,
  consecutive = 2,
  acceptedStatuses = null,
  isDead = () => false,
} = {}) {
  const deadline = Date.now() + timeoutMs
  const accepted = Array.isArray(acceptedStatuses) && acceptedStatuses.length
    ? new Set(acceptedStatuses.map(Number).filter(Number.isFinite))
    : null
  let streak = 0
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
      try {
        const resp = await fetch(url, { signal: ctrl.signal, redirect: 'manual' })
        const statusOk = resp && (accepted ? accepted.has(resp.status) : resp.status >= 200 && resp.status < 400)
        streak = statusOk ? streak + 1 : 0
        if (streak >= consecutive) return true
      } finally {
        clearTimeout(t)
      }
    } catch {
      streak = 0
      /* connection refused / reset / abort => not ready yet */
    }
    await sleep(intervalMs)
  }
  return false
}

// A server that ANSWERS is not necessarily a server that can SERVE THE APP.
// FSN's compose stack measured 2026-08-03: the web container's Vite answers
// "/" with index.html seconds after recreate, readiness goes green, and then
// Vite re-optimizes dependencies ("lockfile has changed") and RELOADS —
// killing in-flight module requests (ERR_EMPTY_RESPONSE on
// /src/pages/Login.jsx, ws:// handshake failures) exactly while the journeys
// run. A manifest may therefore declare `readiness_probe.warm_paths`: extra
// paths on base_url (e.g. Vite's own /@vite/client) that must return an OK
// response WITH A NON-EMPTY BODY on `consecutive` polls spaced apart, proving
// the transform pipeline is warm and stable — not merely listening.
export async function waitForWarmPath(url, {
  timeoutMs = 60000,
  intervalMs = 1200,
  consecutive = 2,
  isDead = () => false,
} = {}) {
  const deadline = Date.now() + timeoutMs
  let streak = 0
  while (Date.now() < deadline) {
    if (isDead()) return false
    let ok = false
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 5000)
      const resp = await fetch(url, { signal: ctrl.signal, redirect: 'manual' })
      clearTimeout(t)
      if (resp && resp.ok) {
        const body = await resp.text()
        ok = body.length > 0
      }
    } catch {
      ok = false
    }
    streak = ok ? streak + 1 : 0
    if (streak >= consecutive) return true
    await sleep(intervalMs)
  }
  return false
}

// Tear down the spawned server(s) and everything they started. On Windows each
// child is a shell whose grandchildren (node/vite/python) survive a plain kill,
// so we use `taskkill /T` to kill the tree; on POSIX we signal the process
// group. We never sweep whatever happens to own a declared port afterward:
// process ownership, not image name or port number, is the teardown boundary.
function stopLaunched(children, probe = {}, baseUrl = null, killable = DEFAULT_KILLABLE_PROCESSES) {
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
  // Never sweep by image name after teardown: a developer process can claim a
  // released port immediately, and EVA must not kill it. The exact spawned
  // process trees above (plus an app's declared stop_command) are the complete
  // ownership boundary; the next app will block if a port remains occupied.
}

// Free a port and spin until it is no longer LISTENing (Windows), bounded to a
// few seconds so a genuinely stuck port can't hang the whole fleet run.
// Returns `{ port, freed, blockedBy: [{pid,name}] }` — a port still held by a
// process EVA may not kill is reported, never force-freed.
export function freePortAndWait(port, { attempts = 20, intervalMs = 250, killable = DEFAULT_KILLABLE_PROCESSES, listHolders = listPortHolders, kill = killPid } = {}) {
  let blockedBy = freePort(port, { killable, listHolders, kill })
  if (process.platform !== 'win32') return { port, freed: blockedBy.length === 0, blockedBy }
  for (let i = 0; i < attempts; i++) {
    const holders = listHolders(port)
    if (!holders.length) return { port, freed: true, blockedBy: [] }
    // Nothing left but processes we are not allowed to kill: spinning cannot
    // change that, so stop immediately instead of burning the whole bound.
    if (holders.every((h) => !mayKillProcess(h.name, killable))) {
      return { port, freed: false, blockedBy: holders }
    }
    blockedBy = freePort(port, { killable, listHolders, kill })
    spawnSync('powershell', ['-NoProfile', '-Command', `Start-Sleep -Milliseconds ${intervalMs}`], { stdio: 'ignore' })
  }
  const holders = listHolders(port)
  return { port, freed: holders.length === 0, blockedBy: holders.filter((h) => !mayKillProcess(h.name, killable)) }
}

/** PIDs + image names currently LISTENing on a port (Windows). */
export function listPortHolders(port) {
  if (process.platform !== 'win32') return []
  try {
    const res = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; "$($_.OwningProcess)|$($p.ProcessName)" }`,
      ],
      { encoding: 'utf8' },
    )
    const seen = new Map()
    for (const line of String(res.stdout || '').split(/\r?\n/)) {
      const [pid, name] = line.trim().split('|')
      if (!pid) continue
      if (!seen.has(pid)) seen.set(pid, { pid, name: name || '' })
    }
    return [...seen.values()]
  } catch {
    return []
  }
}

function killPid(pid) {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
}

// Kill the holders of a TCP port that EVA is ALLOWED to kill (Windows).
// Returns the holders it refused to touch. A port owned by shared
// infrastructure (Docker Desktop's backend owns 3001 and 5180 on this machine)
// is left alone: EVA never destroys a service it did not start, least of all one
// another app in the same run declares as its prerequisite.
export function freePort(port, { killable = DEFAULT_KILLABLE_PROCESSES, listHolders = listPortHolders, kill = killPid } = {}) {
  if (process.platform !== 'win32') return []
  const refused = []
  try {
    for (const holder of listHolders(port)) {
      if (mayKillProcess(holder.name, killable)) kill(holder.pid)
      else refused.push(holder)
    }
  } catch {
    /* best-effort */
  }
  return refused
}

function safeJoin(baseUrl, path) {
  try {
    return new URL(path || '/', baseUrl).toString()
  } catch {
    return baseUrl
  }
}
