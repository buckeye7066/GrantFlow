// Launch environment resolution + prerequisite checking.
//
// WHY THIS EXISTS: manifests have always declared `required_env`, but the runner
// never supplied any of it and never checked whether it could. Every app whose
// process refuses to boot without a value ("FATAL: set ADMIN_TOKEN", Prisma's
// "Invalid value undefined for datasource") therefore reported as
// `startup_failed` with a CRITICAL, never-passing `app-startup` finding — an
// alarm the owner learns to scroll past, which is worse than no alarm. Two
// different facts were being collapsed into one:
//
//   1. the app CAN run here and the runner was launching it wrong  -> fix + run
//   2. the app CANNOT run here until a prerequisite exists         -> BLOCKED,
//      naming the prerequisite, exactly like Factory Deck's "Anthropic credits
//      empty".
//
// This module makes (2) expressible and checkable:
//
//   manifest.launch_env            literal, non-secret env the runner supplies
//   manifest.launch_env_generated  {VAR: 'token'} -> fresh random value per run
//   manifest.prerequisites         [{id,type,name,remedy,...}] checked before launch
//   EVA_APP_ENV / EVA_APP_ENV_FILE owner-supplied per-app secrets (env only)
//
// Nothing here ever invents a value for a declared prerequisite: an unmet
// prerequisite blocks the app and says what is missing and how to fix it.
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

// Child apps receive only the operating-system variables needed to locate
// executables and temporary/cache directories. Inheriting the runner's entire
// environment leaked EVA_RUNNER_SECRET and could silently point a disposable
// QA launch at a production DATABASE_URL or paid model key.
const SAFE_INHERITED_ENV = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'LANG', 'LC_ALL', 'TZ',
  'PNPM_HOME', 'COREPACK_HOME', 'NPM_CONFIG_CACHE',
])

export function baseLaunchEnv(env = process.env) {
  const safe = {}
  for (const [key, value] of Object.entries(env || {})) {
    if (SAFE_INHERITED_ENV.has(String(key).toUpperCase())) safe[key] = String(value)
  }
  return safe
}

/** Parse the owner's per-app env overrides. Never logged; never defaulted. */
export function loadAppEnvOverrides(env = process.env, readFile = (p) => readFileSync(p, 'utf8')) {
  const blobs = []
  if (env.EVA_APP_ENV_FILE) {
    try {
      blobs.push(JSON.parse(readFile(env.EVA_APP_ENV_FILE)))
    } catch {
      /* an unreadable override file is the same as none: prerequisites then block honestly */
    }
  }
  if (env.EVA_APP_ENV) {
    try {
      blobs.push(JSON.parse(env.EVA_APP_ENV))
    } catch {
      /* malformed JSON is the same as none */
    }
  }
  const merged = {}
  for (const blob of blobs) {
    if (!blob || typeof blob !== 'object') continue
    for (const [appId, vars] of Object.entries(blob)) {
      if (!vars || typeof vars !== 'object') continue
      merged[appId] = { ...(merged[appId] || {}), ...vars }
    }
  }
  return merged
}

function generateValue(kind) {
  switch (kind) {
    case 'token':
    case 'secret':
      return randomBytes(24).toString('hex')
    case 'uuid':
      return randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')
    case 'hex32':
      return randomBytes(32).toString('hex')
    default:
      return randomBytes(16).toString('hex')
  }
}

/**
 * Build the environment a web app is launched with.
 * Precedence (low -> high): minimal safe system env, manifest.launch_env,
 * manifest.launch_env_generated, owner override (EVA_APP_ENV[app_id]).
 * A generated var is NOT generated when the owner supplied one.
 */
export function resolveLaunchEnv({ app, manifest, env = process.env, overrides = null, generate = generateValue } = {}) {
  const appId = manifest?.app_id || app?.app_id || ''
  const ownerVars = (overrides || loadAppEnvOverrides(env))[appId] || {}
  const resolved = baseLaunchEnv(env)
  const sources = {}

  const literal = manifest?.launch_env || manifest?.env || {}
  for (const [k, v] of Object.entries(literal)) {
    resolved[k] = String(v)
    sources[k] = 'manifest'
  }
  const generated = manifest?.launch_env_generated || {}
  for (const [k, kind] of Object.entries(generated)) {
    if (hasValue(ownerVars[k])) continue
    resolved[k] = generate(kind)
    sources[k] = 'generated'
  }
  for (const [k, v] of Object.entries(ownerVars)) {
    resolved[k] = String(v)
    sources[k] = 'owner'
  }
  return { env: resolved, sources, appId, sensitiveValues: sensitiveLaunchValues(resolved, sources) }
}

const SENSITIVE_ENV_NAME = /(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|DATABASE_URL|AUTHORIZATION|COOKIE|ENCRYPTION)/i

/** Values that must be removed if an app echoes its launch environment. */
export function sensitiveLaunchValues(env, sources = {}) {
  const values = []
  for (const [name, source] of Object.entries(sources || {})) {
    if (source !== 'owner' && source !== 'generated' && !SENSITIVE_ENV_NAME.test(name)) continue
    const value = env?.[name]
    if (value !== undefined && value !== null && String(value).length >= 6) values.push(String(value))
  }
  return [...new Set(values)]
}

function hasValue(v) {
  return typeof v === 'string' ? v.trim() !== '' : v !== undefined && v !== null
}

/** Is the Docker daemon reachable? Detail is the daemon's own first error line. */
export function probeDocker({ run = spawnSync } = {}) {
  try {
    const res = run('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 20000, shell: true })
    if (res && res.status === 0 && String(res.stdout || '').trim()) return { ok: true, detail: `docker ${String(res.stdout).trim()}` }
    const detail = firstLine(res?.stderr || res?.stdout || '') || 'docker info failed'
    return { ok: false, detail }
  } catch (err) {
    return { ok: false, detail: String(err?.message || err) }
  }
}

/** Start Docker Desktop through the bounded, idempotent repo-owned helper. */
export function recoverDockerDesktop({
  run = spawnSync,
  timeoutSeconds = 900,
  env = process.env,
  platform = process.platform,
} = {}) {
  if (platform !== 'win32') return { ok: false, detail: 'Docker Desktop recovery is Windows-only' }
  const script = fileURLToPath(new URL('../../ensure-docker-for-eva.ps1', import.meta.url))
  try {
    const res = run('powershell', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', script,
      '-TimeoutSeconds', String(timeoutSeconds),
    ], {
      encoding: 'utf8',
      env: baseLaunchEnv(env),
      timeout: (timeoutSeconds + 30) * 1000,
      windowsHide: true,
    })
    const detail = firstLine(res?.stdout || res?.stderr || '') || `Docker Desktop recovery exited ${res?.status ?? 'without a status'}`
    return { ok: res?.status === 0, detail }
  } catch (err) {
    return { ok: false, detail: String(err?.message || err) }
  }
}

/** Is a runtime command callable through the exact sanitized child PATH? */
export function probeExecutable({ command, args = ['--version'], env = process.env, timeoutMs = 10000, run = spawnSync } = {}) {
  if (!command || typeof command !== 'string') return { ok: false, detail: 'executable name is missing' }
  try {
    // shell:true is required for npm.cmd/pnpm.cmd/npx.cmd on Windows. Commands
    // come only from the versioned manifest's fixed runtime allowlist; no user
    // input is interpolated here.
    const res = run(command, Array.isArray(args) ? args : [], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      shell: process.platform === 'win32',
      env,
    })
    if (res && res.status === 0) {
      const version = firstLine(res.stdout || res.stderr || '')
      return { ok: true, detail: version || `${command} is callable` }
    }
    const detail = firstLine(res?.stderr || res?.stdout || '') || String(res?.error?.message || `${command} exited ${res?.status ?? 'without a status'}`)
    return { ok: false, detail }
  } catch (err) {
    return { ok: false, detail: String(err?.message || err) }
  }
}

const EXECUTABLE_PATTERNS = [
  { pattern: /\bdocker\s+compose\b/i, command: 'docker', args: ['compose', 'version'], name: 'Docker Compose plugin' },
  { pattern: /\bpnpm(?:[.]cmd)?\b/i, command: 'pnpm', name: 'pnpm' },
  { pattern: /\bnpx(?:[.]cmd)?\b/i, command: 'npx', name: 'npx' },
  { pattern: /\bnpm(?:[.]cmd)?\b/i, command: 'npm', name: 'npm' },
  { pattern: /\bstreamlit(?:[.]exe)?\b/i, command: 'streamlit', name: 'Streamlit' },
  { pattern: /\buvicorn(?:[.]exe)?\b/i, command: 'uvicorn', name: 'Uvicorn' },
  { pattern: /\belectron(?:[.]exe)?\b/i, command: 'electron', name: 'Electron' },
  { pattern: /\bpython(?:3)?(?:[.]exe)?\b/i, command: 'python', name: 'Python' },
  { pattern: /(?:^|[\s;&|])node(?:[.]exe)?(?=$|[\s;&|])/i, command: 'node', name: 'Node.js' },
  { pattern: /\bpowershell(?:[.]exe)?\b/i, command: 'powershell', name: 'PowerShell' },
]

function normalizeExecutableSpec(spec) {
  if (typeof spec === 'string') return { command: spec, args: ['--version'], name: spec }
  if (!spec || typeof spec !== 'object' || typeof spec.command !== 'string') return null
  return {
    command: spec.command,
    args: Array.isArray(spec.args) ? spec.args.map(String) : ['--version'],
    name: spec.name || spec.command,
    remedy: spec.remedy || null,
  }
}

/** Runtime commands inferred from the start command and CLI journey commands. */
export function inferExecutableRequirements(manifest = {}) {
  const specs = (Array.isArray(manifest.required_executables) ? manifest.required_executables : [])
    .map(normalizeExecutableSpec)
    .filter(Boolean)
  const commandText = [manifest.start_command, ...(manifest.journeys || []).map((j) => j?.command)]
    .filter((v) => typeof v === 'string')
    .join(' & ')
  for (const known of EXECUTABLE_PATTERNS) {
    if (known.pattern.test(commandText)) specs.push({ command: known.command, args: known.args || ['--version'], name: known.name })
  }
  // npm/pnpm/npx/electron all execute on Node even when the literal start
  // command does not contain the word "node".
  if (specs.some((s) => ['npm', 'pnpm', 'npx', 'electron'].includes(s.command.toLowerCase()))) {
    specs.push({ command: 'node', args: ['--version'], name: 'Node.js' })
  }
  const seen = new Set()
  return specs.filter((spec) => {
    const key = `${spec.command.toLowerCase()}\0${(spec.args || []).join('\0')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function versionParts(value) {
  const match = String(value || '').trim().match(/^v?(\d+)(?:[.](\d+))?(?:[.](\d+))?/)
  return match ? [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)] : null
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

function satisfiesComparator(actual, token) {
  if (!token || token === '*' || /^x$/i.test(token)) return true
  if (token.startsWith('^') || token.startsWith('~')) {
    const base = versionParts(token.slice(1))
    if (!base || compareVersions(actual, base) < 0) return false
    const upper = token[0] === '^' ? [base[0] + 1, 0, 0] : [base[0], base[1] + 1, 0]
    return compareVersions(actual, upper) < 0
  }
  const match = token.match(/^(>=|<=|>|<|=)?\s*(v?\d+(?:[.]\d+)?(?:[.]\d+)?)(?:[.]x)?$/i)
  if (!match) return false
  const expected = versionParts(match[2])
  const cmp = compareVersions(actual, expected)
  switch (match[1] || '=') {
    case '>=': return cmp >= 0
    case '<=': return cmp <= 0
    case '>': return cmp > 0
    case '<': return cmp < 0
    default: {
      const specified = match[2].replace(/^v/, '').split('.').length
      return actual.slice(0, specified).every((part, i) => part === expected[i])
    }
  }
}

/** Minimal npm-engine evaluator covering comparator, caret, tilde, and OR ranges. */
export function satisfiesNodeEngine(version, range) {
  const actual = versionParts(version)
  if (!actual || typeof range !== 'string' || !range.trim()) return false
  return range.split('||').some((clause) => {
    const tokens = clause.trim().split(/\s+/).filter(Boolean)
    return tokens.length > 0 && tokens.every((token) => satisfiesComparator(actual, token))
  })
}

/** Manifest override first; otherwise read engines.node from the exact workspace. */
export function resolveNodeEngine(manifest, readFile = (p) => readFileSync(p, 'utf8')) {
  const explicit = manifest?.node_engine || manifest?.runtime_requirements?.node
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
  if (!manifest?.local_path) return null
  try {
    const pkg = JSON.parse(readFile(join(manifest.local_path, 'package.json')))
    return typeof pkg?.engines?.node === 'string' && pkg.engines.node.trim() ? pkg.engines.node.trim() : null
  } catch {
    return null
  }
}

/** Can we open a TCP connection (a local Postgres, a sidecar, …)? */
export function probeTcp({ host = '127.0.0.1', port, timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    let settled = false
    const done = (ok, detail) => {
      if (settled) return
      settled = true
      try {
        sock.destroy()
      } catch {
        /* ignore */
      }
      resolve({ ok, detail })
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => done(true, `${host}:${port} accepted a connection`))
    sock.once('timeout', () => done(false, `no answer from ${host}:${port} within ${timeoutMs}ms`))
    sock.once('error', (err) => done(false, `${host}:${port}: ${err?.code || err?.message || 'unreachable'}`))
    sock.connect(port, host)
  })
}

function firstLine(s) {
  return String(s || '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .find(Boolean)
}

/**
 * Evaluate a manifest's declared prerequisites against this machine.
 * Returns `{ unmet: [{id,name,remedy,detail}], checked: n }`.
 * A manifest with no `prerequisites` is never blocked by this (backwards
 * compatible: unchanged manifests behave exactly as before).
 */
export async function checkPrerequisites({ manifest, resolvedEnv = process.env, probes = {} } = {}) {
  const declared = Array.isArray(manifest?.prerequisites) ? manifest.prerequisites : []
  const docker = probes.docker || probeDocker
  const dockerRecovery = probes.dockerRecovery || recoverDockerDesktop
  const tcp = probes.tcp || probeTcp
  const executable = probes.executable || ((spec) => probeExecutable({ ...spec, env: resolvedEnv }))
  const unmet = []
  const explicitlyCheckedExecutables = new Set()
  let explicitNodeEngine = false
  for (const p of declared) {
    const id = p?.id || p?.type || 'prerequisite'
    const name = p?.name || id
    const remedy = p?.remedy || null
    let result = { ok: true, detail: null }
    if (p?.type === 'env') {
      const vars = Array.isArray(p.env) ? p.env : [p.env].filter(Boolean)
      const missing = vars.filter((v) => !hasValue(resolvedEnv[v]))
      result = missing.length
        ? { ok: false, detail: `unset: ${missing.join(', ')}` }
        : { ok: true, detail: null }
    } else if (p?.type === 'docker') {
      result = await docker()
      if (!result.ok && p.auto_recover === 'docker-desktop') {
        const recovery = await dockerRecovery()
        if (recovery.ok) result = await docker()
        if (!result.ok && recovery.detail) {
          result = { ...result, detail: `${result.detail || 'docker unavailable'}; recovery: ${recovery.detail}` }
        }
      }
    } else if (p?.type === 'tcp') {
      result = await tcp({ host: p.host || '127.0.0.1', port: Number(p.port) })
    } else if (p?.type === 'executable') {
      const spec = normalizeExecutableSpec(p)
      if (!spec) {
        result = { ok: false, detail: 'executable prerequisite is missing command' }
      } else {
        explicitlyCheckedExecutables.add(spec.command.toLowerCase())
        result = await executable(spec)
      }
    } else if (p?.type === 'node-engine' || p?.type === 'node') {
      explicitNodeEngine = true
      const range = p.range || p.engine
      const version = typeof probes.nodeVersion === 'function' ? await probes.nodeVersion() : (probes.nodeVersion || process.versions.node)
      result = satisfiesNodeEngine(version, range)
        ? { ok: true, detail: `Node ${version} satisfies ${range}` }
        : { ok: false, detail: `Node ${version || 'unknown'} does not satisfy ${range || '(missing range)'}` }
    } else {
      // An unknown prerequisite type must NOT silently pass — an unverifiable
      // claim is not a met prerequisite.
      result = { ok: false, detail: `unsupported prerequisite type "${p?.type}"` }
    }
    if (!result.ok) unmet.push({ id, name, remedy, detail: result.detail || null })
  }

  // Runtime commands are also prerequisites. Infer them at the fleet choke
  // point so a newly added npm/pnpm/Python/Electron app cannot be launched and
  // misreported as broken merely because this Windows account lacks its tool.
  const runtimeExecutables = inferExecutableRequirements(manifest)
  for (const spec of runtimeExecutables) {
    if (explicitlyCheckedExecutables.has(spec.command.toLowerCase())) continue
    const result = await executable(spec)
    if (!result.ok) {
      unmet.push({
        id: `executable-${spec.command.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        name: `${spec.name || spec.command} runtime`,
        remedy: spec.remedy || `install ${spec.name || spec.command} for the scheduled-task account and ensure it is on PATH`,
        detail: result.detail || `${spec.command} is not callable`,
      })
    }
  }

  // Node's own engines contract belongs to the exact origin/main snapshot. A
  // central `node_engine` may pin it explicitly; otherwise read package.json in
  // the isolated workspace. This catches GeneMap's Node >=24 contract before
  // pnpm emits a vague startup failure on a runner whose documented floor is 20.
  const usesNode = runtimeExecutables.some((spec) => ['node', 'npm', 'pnpm', 'npx', 'electron'].includes(spec.command.toLowerCase()))
  const nodeEngine = !explicitNodeEngine && usesNode
    ? resolveNodeEngine(manifest, probes.readFile || ((p) => readFileSync(p, 'utf8')))
    : null
  if (nodeEngine) {
    const version = typeof probes.nodeVersion === 'function' ? await probes.nodeVersion() : (probes.nodeVersion || process.versions.node)
    if (!satisfiesNodeEngine(version, nodeEngine)) {
      unmet.push({
        id: 'node-engine',
        name: `Node.js ${nodeEngine}`,
        remedy: `install a Node.js version satisfying ${nodeEngine} for the scheduled-task account`,
        detail: `runner has Node ${version || 'unknown'}`,
      })
    }
  }

  // required_env used to be documentation only. Apps with missing boot
  // configuration were launched anyway and became recurring CRITICAL
  // readiness failures. Make it an executable preflight contract at this one
  // fleet choke point. Avoid duplicating variables already named by an
  // explicit env prerequisite (which may carry a better owner remedy).
  const explicitlyChecked = new Set(
    declared
      .filter((p) => p?.type === 'env')
      .flatMap((p) => (Array.isArray(p.env) ? p.env : [p.env]))
      .filter(Boolean),
  )
  const missingRequired = (Array.isArray(manifest?.required_env) ? manifest.required_env : [])
    .filter((name) => !explicitlyChecked.has(name) && !hasValue(resolvedEnv[name]))
  if (missingRequired.length) {
    unmet.push({
      id: 'required-env',
      name: 'required launch environment',
      remedy: `set per-app values in EVA_APP_ENV or declare safe launch_env/launch_env_generated values in the canonical manifest`,
      detail: `unset: ${missingRequired.join(', ')}`,
    })
  }
  return {
    unmet,
    checked: declared.length + runtimeExecutables.filter((spec) => !explicitlyCheckedExecutables.has(spec.command.toLowerCase())).length +
      (nodeEngine ? 1 : 0) + (Array.isArray(manifest?.required_env) ? manifest.required_env.length : 0),
  }
}

/**
 * One-line, owner-readable summary of what is missing and how to fix it.
 * The probe's raw detail is clipped: an owner needs the NAME and the REMEDY,
 * not a daemon's full pipe path.
 */
export function describeUnmet(unmet, { maxDetail = 120 } = {}) {
  return unmet
    .map((u) => {
      const detail = u.detail ? String(u.detail).slice(0, maxDetail) : ''
      return `${u.name}${detail ? ` (${detail})` : ''}${u.remedy ? ` — ${u.remedy}` : ''}`
    })
    .join('; ')
}
