/**
 * Central API key configuration for Funding APIs.
 *
 * IMPORTANT:
 * - Never print secret values.
 * - Keep env var names consistent with docs/API_KEYS_ONBOARDING.md.
 * - Grants.gov key is optional (some endpoints require Help Desk ticket + encrypted key).
 */

function readEnv(name) {
  const raw = process.env[name]
  if ((raw === null || raw === undefined)) return null
  const v = String(raw).trim()
  return v ? v : null
}

/**
 * @typedef {Object} FundingApiKeys
 * @property {string|null} GRANTS_GOV_API_KEY
 * @property {string|null} SIMPLER_GRANTS_API_KEY
 * @property {string|null} SAM_GOV_PUBLIC_API_KEY
 * @property {string|null} API_DATA_GOV_KEY
 */

/**
 * Load API keys from environment.
 *
 * NOTE: We accept `SAM_GOV_API_KEY` as a backward-compatible alias, but the canonical
 * name is `SAM_GOV_PUBLIC_API_KEY` (documented).
 *
 * @returns {FundingApiKeys}
 */
export function loadFundingApiKeys() {
  // Canonical name first, then documented alias, then case/spelling variants we
  // have actually seen set by hand in the Railway dashboard. Env var names are
  // case-sensitive on Linux, so a key saved as `Sam_gov_key` is invisible to
  // `SAM_GOV_PUBLIC_API_KEY` — this fallback keeps a hand-entered key working
  // instead of silently disabling the whole SAM.gov source.
  const SAM_GOV_PUBLIC_API_KEY =
    readEnv('SAM_GOV_PUBLIC_API_KEY') ||
    readEnv('SAM_GOV_API_KEY') ||
    readEnv('Sam_gov_key') ||
    readEnv('SAM_GOV_KEY') ||
    null

  return Object.freeze({
    GRANTS_GOV_API_KEY: readEnv('GRANTS_GOV_API_KEY'),
    SIMPLER_GRANTS_API_KEY: readEnv('SIMPLER_GRANTS_API_KEY'),
    SAM_GOV_PUBLIC_API_KEY,
    API_DATA_GOV_KEY: readEnv('API_DATA_GOV_KEY'),
  })
}

/**
 * Safe diagnostics: presence flags only (never values).
 * @returns {Record<string, boolean>}
 */
export function getFundingApiKeyPresence() {
  const keys = loadFundingApiKeys()
  return {
    GRANTS_GOV_API_KEY: Boolean(keys.GRANTS_GOV_API_KEY),
    SIMPLER_GRANTS_API_KEY: Boolean(keys.SIMPLER_GRANTS_API_KEY),
    SAM_GOV_PUBLIC_API_KEY: Boolean(keys.SAM_GOV_PUBLIC_API_KEY),
    API_DATA_GOV_KEY: Boolean(keys.API_DATA_GOV_KEY),
  }
}

/**
 * Validate required provider keys (optionally enforced).
 *
 * Default behavior is **non-fatal**: in production we only enforce if
 * `FUNDING_APIS_REQUIRE_KEYS=true` (or `1`).
 *
 * @param {Object=} options
 * @param {boolean=} options.enforce - override env flag
 * @param {Array<'SIMPLER_GRANTS_API_KEY'|'SAM_GOV_PUBLIC_API_KEY'>=} options.required
 * @returns {{ ok: boolean, missing: string[], enforced: boolean }}
 */
export function validateFundingApiKeys(options = {}) {
  const flag = String(process.env.FUNDING_APIS_REQUIRE_KEYS || '').trim().toLowerCase()
  const enforced =
    typeof options.enforce === 'boolean'
      ? options.enforce
      : ['1', 'true', 'yes', 'y', 'on'].includes(flag)

  const required = options.required || ['SIMPLER_GRANTS_API_KEY', 'SAM_GOV_PUBLIC_API_KEY']
  const keys = loadFundingApiKeys()

  const missing = required.filter((name) => !keys[name])
  return { ok: missing.length === 0, missing, enforced }
}

/**
 * Throw (and optionally exit) if required keys are missing.
 * Intended for startup checks in production when enforcement is enabled.
 *
 * @param {Object=} options
 * @param {boolean=} options.enforce
 * @param {boolean=} options.exitOnError - default: true in production when enforced
 */
export function assertFundingApiKeys(options = {}) {
  const { ok, missing, enforced } = validateFundingApiKeys(options)
  if (ok || !enforced) return

  const msg =
    `Missing required Funding API keys: ${missing.join(', ')}. ` +
    `Set these as secrets (local .env / Railway / Vercel).`

  const isProd = process.env.NODE_ENV === 'production'
  const exitOnError =
    typeof options.exitOnError === 'boolean' ? options.exitOnError : isProd === true

  console.error('[funding-api-keys] ' + msg)
  if (exitOnError) process.exit(1)
  throw new Error(msg)
}

