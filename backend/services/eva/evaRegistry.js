// EVA portfolio registry — loads the canonical app roster (qa/portfolio-registry.json)
// and validates per-repo manifests (qa/user-journeys.json shape). Pure-ish: the
// registry file is read once and cached; manifest validation is pure.
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:eva:registry')
const __dirname = dirname(fileURLToPath(import.meta.url))
const REGISTRY_PATH = join(__dirname, '..', '..', '..', 'qa', 'portfolio-registry.json')

let cached = null

export function loadRegistry({ path = REGISTRY_PATH, force = false } = {}) {
  if (cached && !force) return cached
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw)
    cached = parsed
    return parsed
  } catch (err) {
    log.warn('eva registry load failed', { error: err?.message })
    return { schema_version: 1, apps: [] }
  }
}

/** The set of app_ids the fleet is EXPECTED to test (runtime available/blocked). */
export function expectedAppIds({ registry = null } = {}) {
  const reg = registry || loadRegistry()
  return (reg.apps || [])
    .filter((a) => a.runtime_status === 'available' || a.runtime_status === 'blocked_by_external_service')
    .map((a) => a.app_id)
}

export function appById(appId, { registry = null } = {}) {
  const reg = registry || loadRegistry()
  return (reg.apps || []).find((a) => a.app_id === appId) || null
}

// ---- Manifest validation --------------------------------------------------

const REQUIRED_MANIFEST_FIELDS = [
  'app_id',
  'display_name',
  'runtime_type',
  'disposable_data_root',
  'max_runtime_ms',
  'concurrency_class',
  'prohibited_actions',
  'cleanup',
  'coverage',
]

/**
 * Validate a per-repo qa/user-journeys.json manifest. A manifest without a
 * prohibited-action policy or a cleanup strategy is REJECTED (safety contract).
 * Returns { ok, errors[] }.
 */
export function validateManifest(manifest) {
  const errors = []
  const e = (m) => errors.push(m)
  const isSet = (v) => v !== null && v !== undefined
  if (!manifest || typeof manifest !== 'object') return { ok: false, errors: ['manifest not an object'] }

  for (const f of REQUIRED_MANIFEST_FIELDS) {
    if (!isSet(manifest[f])) e(`missing required field: ${f}`)
  }
  if (isSet(manifest.prohibited_actions) && (!Array.isArray(manifest.prohibited_actions) || manifest.prohibited_actions.length === 0)) {
    e('prohibited_actions must be a non-empty array (safety policy is mandatory)')
  }
  if (isSet(manifest.cleanup) && typeof manifest.cleanup !== 'string' && typeof manifest.cleanup !== 'object') {
    e('cleanup must be a command string or an object')
  }
  if (manifest.runtime_type && !['web', 'electron', 'cli', 'python-cli', 'powershell', 'windows-ui', 'api', 'mobile-web'].includes(manifest.runtime_type)) {
    e(`unknown runtime_type: ${manifest.runtime_type}`)
  }
  if (isSet(manifest.max_runtime_ms) && (!Number.isInteger(manifest.max_runtime_ms) || manifest.max_runtime_ms <= 0)) {
    e('max_runtime_ms must be a positive integer')
  }
  // Coverage must map each feature to at least one journey OR an explicit reason.
  if (Array.isArray(manifest.coverage)) {
    manifest.coverage.forEach((c, i) => {
      if (!c || !c.feature) e(`coverage[${i}].feature required`)
      const hasJourney = Array.isArray(c.journeys) && c.journeys.length > 0
      const hasReason = typeof c.unautomated_reason === 'string' && c.unautomated_reason.length > 0
      if (!hasJourney && !hasReason) e(`coverage[${i}] (${c?.feature}) must map to a journey or give an unautomated_reason`)
    })
  } else if (isSet(manifest.coverage)) {
    e('coverage must be an array')
  }
  // Nightly critical journeys must be declared (may be empty for blocked apps).
  if (isSet(manifest.nightly_critical_journeys) && !Array.isArray(manifest.nightly_critical_journeys)) {
    e('nightly_critical_journeys must be an array')
  }
  return { ok: errors.length === 0, errors }
}
