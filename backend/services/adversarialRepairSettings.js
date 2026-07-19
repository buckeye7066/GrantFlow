/**
 * adversarialRepairSettings.js
 *
 * Owner-controlled, DB-authoritative settings for the Anya/Sam adversarial
 * code-repair feature (+ direct-to-main landing). Lets the owner turn the
 * feature on/off, choose how fixes land (PR vs direct), and (separately) allow
 * direct-merge to critical paths — ALL from the admin UI, with NO Railway env
 * vars required.
 *
 * Resolution order (getConfig):
 *   1. system_kv key `adversarial_repair_config` (JSON) — the AUTHORITATIVE
 *      value once the owner has used the toggle. DB wins.
 *   2. env fallback (SAM_ADVERSARIAL_REPAIR / SAM_ADVERSARIAL_LAND_MODE /
 *      ADVERSARIAL_DIRECT_ALLOW_CRITICAL) — the initial default so existing
 *      env-configured behavior is preserved until the owner saves once.
 *   3. When neither is set, the effective config is {enabled:false,
 *      landMode:'pr', allowCritical:false} (feature fully OFF / inert).
 *
 * The consumers (samAdversarialRepair, anyaCodeFixDispatch's direct-landing
 * gate, and Anya's owner.adversarial_repair tool) read the EFFECTIVE config
 * from here — never env directly — so the master switch makes the feature inert
 * on the very next read (no stale cache).
 */

export const CONFIG_KV_KEY = 'adversarial_repair_config'
export const DEFAULT_CONFIG = Object.freeze({ enabled: false, landMode: 'pr', allowCritical: false })
export const VALID_LAND_MODES = Object.freeze(['pr', 'direct'])

function envBool(v) {
  return /^(1|true|yes|on)$/i.test(String(v ?? '').trim())
}

/** The initial default derived from env (existing behavior before the toggle). */
export function configFromEnv(env = process.env) {
  return {
    enabled: envBool(env?.SAM_ADVERSARIAL_REPAIR),
    landMode: /^direct$/i.test(String(env?.SAM_ADVERSARIAL_LAND_MODE ?? '').trim()) ? 'direct' : 'pr',
    allowCritical: envBool(env?.ADVERSARIAL_DIRECT_ALLOW_CRITICAL),
  }
}

/** Coerce any stored/patched shape into a valid, complete config. Pure. */
export function normalizeConfig(raw) {
  const o = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: o.enabled === true,
    landMode: o.landMode === 'direct' ? 'direct' : 'pr',
    allowCritical: o.allowCritical === true,
  }
}

/** Validate a PUT patch (route-level 400 guard). Pure. */
export function validateConfigPatch(patch) {
  const errors = []
  const p = patch && typeof patch === 'object' ? patch : null
  if (!p) return { ok: false, errors: ['body must be a JSON object'] }
  if (p.enabled !== undefined && typeof p.enabled !== 'boolean') errors.push('enabled must be a boolean')
  if (p.landMode !== undefined && !VALID_LAND_MODES.includes(p.landMode)) errors.push("landMode must be 'pr' or 'direct'")
  if (p.allowCritical !== undefined && typeof p.allowCritical !== 'boolean') errors.push('allowCritical must be a boolean')
  return { ok: errors.length === 0, errors }
}

/**
 * Report whether the feature is actually WIRED, using PRESENCE BOOLEANS ONLY
 * (never a secret value). The signing secret is self-provisioning so it is NOT
 * an external dependency here; the external deps are the AI keys (author +
 * verifier) and the GitHub merge token.
 *
 *   - missing an AI key   → 'inert'   : repair cannot run at all.
 *   - missing GitHub token → 'pr_only' : repair runs but can only open a PR
 *                                        (a direct-merge request falls back to PR).
 *   - all present          → 'ready'   : fixes can land (PR or direct).
 *
 * @returns {{githubToken:boolean, anthropicKey:boolean, openaiKey:boolean,
 *            status:'ready'|'pr_only'|'inert', message:string}}
 */
export function computeReadiness(env = process.env) {
  const githubToken = Boolean(String(env?.GITHUB_TOKEN || env?.ANYA_GITHUB_TOKEN || '').trim())
  const anthropicKey = Boolean(String(env?.ANTHROPIC_API_KEY || '').trim())
  const openaiKey = Boolean(String(env?.OPENAI_API_KEY || '').trim())
  let status
  let message
  if (!anthropicKey || !openaiKey) {
    status = 'inert'
    message = 'AI provider key missing — repair is inert.'
  } else if (!githubToken) {
    status = 'pr_only'
    message = 'GitHub token not configured — fixes will open a PR instead of direct-merging.'
  } else {
    status = 'ready'
    message = 'Ready — fixes can land.'
  }
  return { githubToken, anthropicKey, openaiKey, status, message }
}

async function ensureKv(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
}

/**
 * Resolve the EFFECTIVE config. DB key wins if present; otherwise env fallback.
 * Includes a `source` ('db' | 'env') for observability. Never throws.
 *
 * @param {object} db
 * @param {object} [env=process.env]
 * @returns {Promise<{enabled:boolean, landMode:'pr'|'direct', allowCritical:boolean, source:string}>}
 */
export async function getConfig(db, env = process.env) {
  if (db && typeof db.prepare === 'function') {
    try {
      const row = await db.prepare('SELECT value FROM system_kv WHERE key = ? LIMIT 1').get(CONFIG_KV_KEY)
      if (row && row.value !== null && row.value !== undefined) {
        const parsed = typeof row.value === 'string' ? JSON.parse(row.value) : row.value
        return { ...normalizeConfig(parsed), source: 'db' }
      }
    } catch {
      // fall through to env fallback
    }
  }
  return { ...configFromEnv(env), source: 'env' }
}

/**
 * Persist a config PATCH (merged over the current effective config) and return
 * the new effective config. Once written, getConfig reads this DB value
 * authoritatively over env. Shim-safe UPDATE-then-INSERT.
 *
 * @param {object} db
 * @param {object} patch  subset of { enabled, landMode, allowCritical }
 * @param {object} [opts]
 * @param {object} [opts.env=process.env]
 * @param {string} [opts.now]  ISO timestamp (defaults to new Date().toISOString())
 */
export async function setConfig(db, patch = {}, { env = process.env, now = null } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('setConfig requires a database connection')
  }
  const { ok, errors } = validateConfigPatch(patch)
  if (!ok) {
    const err = new Error(`invalid config: ${errors.join('; ')}`)
    err.status = 400
    throw err
  }
  const current = await getConfig(db, env)
  const merged = normalizeConfig({
    enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
    landMode: patch.landMode !== undefined ? patch.landMode : current.landMode,
    allowCritical: patch.allowCritical !== undefined ? patch.allowCritical : current.allowCritical,
  })
  await ensureKv(db)
  const value = JSON.stringify(merged)
  const at = now || new Date().toISOString()
  const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(value, at, CONFIG_KV_KEY)
  if (!Number(res?.changes ?? res?.rowCount ?? 0)) {
    await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(CONFIG_KV_KEY, value, at)
  }
  return { ...merged, source: 'db' }
}
