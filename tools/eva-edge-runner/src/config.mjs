// Edge-runner configuration + manifest discovery.
//
// Config comes from the environment (never source): the coordinator URL, the
// runner id + HMAC secret, and the schedule catch-up marker directory. Manifests
// are discovered per-app from each repo's qa/user-journeys.json.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

export const RUNNER_SEMVER = '1.0.0'

/**
 * Build a schema-bounded SemVer identifier for the runner code that produced a
 * payload. The installed bootstrap supplies the verified origin/main object id
 * through EVA_RUNNER_BUILD_SHA; direct development runs retain plain SemVer.
 */
export function formatRunnerVersion(buildSha, semver = RUNNER_SEMVER) {
  const sha = typeof buildSha === 'string' ? buildSha.trim().toLowerCase() : ''
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) return semver
  // 1.0.0 + '+' + 12 hex = 18 chars, safely below schema maxLength 32.
  return `${semver}+${sha.slice(0, 12)}`
}

// Expand a portable `~/`-prefixed local_path to this machine's home directory.
//
// WHY: the 2026-08-06 "controlled beta" hardening pass sanitized the real
// Windows username out of qa/portfolio-registry.json and every qa/manifests/*.json
// (`C:/Users/<real-user>/…` -> `C:/Users/example_user/…`) — correct for a repo
// that must not carry a real local username, but those SAME files are what this
// runner reads for each app's cwd. Every spawn then ran with a nonexistent cwd
// and died as `spawn …cmd.exe ENOENT`, which took the whole nightly fleet down
// from 2026-08-07 on (13 of 14 apps startup_failed, 9 nights). The portable form
// is `~/<repo-dir>`: it names no user, and this expansion — applied at the TWO
// choke points every consumer passes through (loadRegistry + loadManifest) —
// resolves it on whatever machine the runner runs on. A path with no `~` prefix
// passes through untouched (family-stewardship-navigator legitimately lives on
// G:).
export function expandLocalPath(p, home = os.homedir()) {
  if (typeof p !== 'string' || !p) return p
  if (p === '~') return home
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2))
  return p
}

export function loadRunnerConfig(env = process.env) {
  const cfg = {
    coordinatorUrl: env.EVA_COORDINATOR_URL || 'http://localhost:3001',
    runnerId: env.EVA_RUNNER_ID || 'windows-edge-1',
    secret: env.EVA_RUNNER_SECRET || null,
    dataDir: env.EVA_RUNNER_DATA_DIR || join(os.tmpdir(), 'eva-edge-runner'),
    environment: env.EVA_RUNNER_ENV || 'local-windows',
    version: formatRunnerVersion(env.EVA_RUNNER_BUILD_SHA),
    // Comma-separated app_ids to include; empty = all feasible from the registry.
    onlyApps: (env.EVA_RUNNER_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean),
  }
  return cfg
}

export function ensureDataDir(cfg) {
  if (!existsSync(cfg.dataDir)) mkdirSync(cfg.dataDir, { recursive: true })
  return cfg.dataDir
}

// Where the schedule marker lives (last successful run day-key) — used for the
// wake-from-sleep catch-up decision.
export function markerPath(cfg) {
  return join(cfg.dataDir, 'last-run-marker.json')
}

export function readMarker(cfg) {
  try {
    return JSON.parse(readFileSync(markerPath(cfg), 'utf8'))
  } catch {
    return null
  }
}

export function writeMarker(cfg, marker) {
  ensureDataDir(cfg)
  writeFileSync(markerPath(cfg), JSON.stringify(marker), 'utf8')
}

// Load a manifest for an app. The coordinator's central bundle is canonical:
// it is versioned with the runner that interprets it and lets one fleet-wide
// repair update every app atomically. A per-repo qa/user-journeys.json is only
// a fallback for standalone runners that do not carry the bundle.
//
// The old order preferred the per-repo copy. That made central fixes inert:
// the bundle could correct a port, timeout, or launch command while the runner
// silently kept reading an older copy from the app checkout. GrantFlow's probe
// fix did exactly that in August 2026 and the same failure returned nightly.
export function loadManifest(localPath, appId = null, env = process.env) {
  if (appId && env.EVA_MANIFEST_DIR) {
    const bundled = join(env.EVA_MANIFEST_DIR, `${appId}.json`)
    // Once a central bundle is configured it is authoritative, including for
    // absence and parse failures. Falling back here would silently execute a
    // stale per-repo contract after a bad global deploy.
    if (!existsSync(bundled)) return null
    try {
      return expandManifestPaths(JSON.parse(readFileSync(bundled, 'utf8')))
    } catch (err) {
      throw new Error(`canonical EVA manifest is invalid (${bundled}): ${err?.message || err}`)
    }
  }
  const perRepo = join(expandLocalPath(localPath), 'qa', 'user-journeys.json')
  if (existsSync(perRepo)) {
    try {
      return expandManifestPaths(JSON.parse(readFileSync(perRepo, 'utf8')))
    } catch {
      return null
    }
  }
  return null
}

// A manifest's own `local_path` outranks the registry's in the launcher/cli
// adapters, so it must be expanded at the same choke point it is loaded.
function expandManifestPaths(manifest) {
  if (manifest && typeof manifest.local_path === 'string') {
    manifest.local_path = expandLocalPath(manifest.local_path)
  }
  return manifest
}

// Load the portfolio registry (shipped with the coordinator repo, but the runner
// carries its own copy path via EVA_REGISTRY_PATH for standalone operation).
export function loadRegistry(env = process.env) {
  const p = env.EVA_REGISTRY_PATH
  if (!p) throw new Error('EVA_REGISTRY_PATH is required for a portfolio run')
  if (!existsSync(p)) throw new Error(`EVA portfolio registry does not exist: ${p}`)
  try {
    const registry = JSON.parse(readFileSync(p, 'utf8'))
    if (!Array.isArray(registry.apps) || registry.apps.length === 0) {
      throw new Error('registry.apps must be a non-empty array')
    }
    for (const app of registry.apps) {
      if (app && typeof app.local_path === 'string') app.local_path = expandLocalPath(app.local_path)
    }
    return registry
  } catch (err) {
    throw new Error(`EVA portfolio registry is invalid (${p}): ${err?.message || err}`)
  }
}

// Day-key in America/New_York for the catch-up marker (matches the coordinator's
// once-per-day semantics conceptually; the runner only needs a stable per-day key).
export function etDayKey(date = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
  } catch {
    return date.toISOString().slice(0, 10)
  }
}
