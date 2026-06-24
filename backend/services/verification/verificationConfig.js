/**
 * verificationConfig.js
 *
 * Centralised, feature-flagged configuration for the free, keyless
 * verification layer (ProPublica Nonprofit Explorer + US Census Geocoder).
 *
 * Design rules:
 *   - Both data sources are FREE and require NO API KEY. We only gate
 *     ENABLEMENT and TIMEOUTS via env so an operator can switch them off or
 *     tune latency budgets without code changes.
 *   - SAFE DEFAULTS: enabled by default (these are best-effort enrichers that
 *     NEVER hard-reject on failure), but every call is wrapped so a flag flip
 *     to "off" fully disables the network path.
 *   - Reading env lazily (per-call) keeps the modules testable: a test can set
 *     process.env before invoking without re-importing.
 */

/** Parse a boolean-ish env var with an explicit default. */
function boolEnv(name, defaultValue) {
  const raw = process.env[name]
  if (raw === undefined || raw === null || String(raw).trim() === '') return defaultValue
  const s = String(raw).trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes'
}

/** Parse a positive-integer env var with a default + sane clamp. */
function intEnv(name, defaultValue, { min = 100, max = 30000 } = {}) {
  const raw = Number(process.env[name])
  if (!Number.isFinite(raw) || raw <= 0) return defaultValue
  return Math.max(min, Math.min(max, Math.round(raw)))
}

/**
 * @returns {boolean} whether the ProPublica nonprofit-registry verification is on.
 * Default: ON (best-effort, never blocks discovery).
 */
export function isRegistryVerificationEnabled() {
  return boolEnv('ENABLE_REGISTRY_VERIFICATION', true)
}

/**
 * @returns {boolean} whether the US Census geocoder enrichment is on.
 * Default: ON (best-effort, never blocks discovery).
 */
export function isCensusGeoEnabled() {
  return boolEnv('ENABLE_CENSUS_GEO', true)
}

/** Per-request network timeout (ms) for ProPublica. */
export function registryTimeoutMs() {
  return intEnv('REGISTRY_VERIFICATION_TIMEOUT_MS', 4000)
}

/** Per-request network timeout (ms) for the Census geocoder. */
export function censusTimeoutMs() {
  return intEnv('CENSUS_GEO_TIMEOUT_MS', 4000)
}

/** Cache TTL (ms) for verification lookups. Default 24h — IRS/Census data is stable. */
export function verificationCacheTtlMs() {
  return intEnv('VERIFICATION_CACHE_TTL_MS', 24 * 60 * 60 * 1000, { min: 1000, max: 7 * 24 * 60 * 60 * 1000 })
}

export default {
  isRegistryVerificationEnabled,
  isCensusGeoEnabled,
  registryTimeoutMs,
  censusTimeoutMs,
  verificationCacheTtlMs,
}
