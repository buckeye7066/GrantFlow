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
import net from 'node:net'

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
    default:
      return randomBytes(16).toString('hex')
  }
}

/**
 * Build the environment a web app is launched with.
 * Precedence (low -> high): inherited process env, manifest.launch_env,
 * manifest.launch_env_generated, owner override (EVA_APP_ENV[app_id]).
 * A generated var is NOT generated when the owner supplied one.
 */
export function resolveLaunchEnv({ app, manifest, env = process.env, overrides = null, generate = generateValue } = {}) {
  const appId = manifest?.app_id || app?.app_id || ''
  const ownerVars = (overrides || loadAppEnvOverrides(env))[appId] || {}
  const resolved = { ...env }
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
  return { env: resolved, sources, appId }
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
  const tcp = probes.tcp || probeTcp
  const unmet = []
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
      result = docker()
    } else if (p?.type === 'tcp') {
      result = await tcp({ host: p.host || '127.0.0.1', port: Number(p.port) })
    } else {
      // An unknown prerequisite type must NOT silently pass — an unverifiable
      // claim is not a met prerequisite.
      result = { ok: false, detail: `unsupported prerequisite type "${p?.type}"` }
    }
    if (!result.ok) unmet.push({ id, name, remedy, detail: result.detail || null })
  }
  return { unmet, checked: declared.length }
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
