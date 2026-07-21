// Edge-runner configuration + manifest discovery.
//
// Config comes from the environment (never source): the coordinator URL, the
// runner id + HMAC secret, and the schedule catch-up marker directory. Manifests
// are discovered per-app from each repo's qa/user-journeys.json.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

export function loadRunnerConfig(env = process.env) {
  const cfg = {
    coordinatorUrl: env.EVA_COORDINATOR_URL || 'http://localhost:3001',
    runnerId: env.EVA_RUNNER_ID || 'windows-edge-1',
    secret: env.EVA_RUNNER_SECRET || null,
    dataDir: env.EVA_RUNNER_DATA_DIR || join(os.tmpdir(), 'eva-edge-runner'),
    environment: env.EVA_RUNNER_ENV || 'local-windows',
    version: '1.0.0',
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

// Load a manifest for an app. Prefers the per-repo qa/user-journeys.json; falls
// back to the central bundle (EVA_MANIFEST_DIR/<app_id>.json) shipped with the
// coordinator so the runner works before every repo carries its own copy.
export function loadManifest(localPath, appId = null, env = process.env) {
  const perRepo = join(localPath, 'qa', 'user-journeys.json')
  if (existsSync(perRepo)) {
    try {
      return JSON.parse(readFileSync(perRepo, 'utf8'))
    } catch {
      /* fall through to bundle */
    }
  }
  if (appId && env.EVA_MANIFEST_DIR) {
    const bundled = join(env.EVA_MANIFEST_DIR, `${appId}.json`)
    if (existsSync(bundled)) {
      try {
        return JSON.parse(readFileSync(bundled, 'utf8'))
      } catch {
        return null
      }
    }
  }
  return null
}

// Load the portfolio registry (shipped with the coordinator repo, but the runner
// carries its own copy path via EVA_REGISTRY_PATH for standalone operation).
export function loadRegistry(env = process.env) {
  const p = env.EVA_REGISTRY_PATH
  if (!p || !existsSync(p)) return { apps: [] }
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return { apps: [] }
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
