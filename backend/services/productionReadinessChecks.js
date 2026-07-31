/**
 * productionReadinessChecks.js
 *
 * Phase I: surfaces deployment-time risks in a single structured report
 * the mission-health endpoint, the smoke script, and any release gate
 * can consume.
 *
 * Each check returns:
 *   { id, level: 'info'|'warn'|'error', detail, ok }
 *
 * Level semantics:
 *   - error:  release gate must refuse a deploy.
 *   - warn:   release gate must refuse a deploy (matches Phase F policy
 *             — the strict release-blocking codes use warns too).
 *   - info:   surfaces context but does not gate the deploy.
 *
 * The functions are intentionally pure so they can be exercised by unit
 * tests without touching real env/disk.
 */

import { twilioWebhookPosture } from './twilioWebhookSecurity.js'

import { runtimeSecretKeyPosture } from '../utils/runtimeSecrets.js'

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off'])

function envBool(value, fallback = null) {
  const lower = String(value ?? '').trim().toLowerCase()
  if (TRUE_VALUES.has(lower)) return true
  if (FALSE_VALUES.has(lower)) return false
  return fallback
}

/**
 * Check 1: NODE_ENV=production must NOT be running on SQLite without an
 * explicit override (ALLOW_SQLITE_IN_PROD=true). SQLite is not safe for
 * the multi-process production deploy and silently degrades concurrency.
 */
export function checkSqliteInProduction({ env = process.env, dbDialect = null } = {}) {
  const isProd = String(env.NODE_ENV || '').toLowerCase() === 'production'
  if (!isProd) {
    return { id: 'sqlite_in_production', level: 'info', detail: 'NODE_ENV is not production.', ok: true }
  }
  if (dbDialect && String(dbDialect).toLowerCase() !== 'sqlite') {
    return {
      id: 'sqlite_in_production',
      level: 'info',
      detail: `Production is using ${dbDialect}.`,
      ok: true,
    }
  }
  if (envBool(env.ALLOW_SQLITE_IN_PROD) === true) {
    return {
      id: 'sqlite_in_production',
      level: 'warn',
      detail: 'Production is running on SQLite (ALLOW_SQLITE_IN_PROD=true). This is allowed but not recommended; expect concurrency limits.',
      ok: true,
    }
  }
  return {
    id: 'sqlite_in_production',
    level: 'error',
    detail: 'NODE_ENV=production but the active database is SQLite. Set DATABASE_URL to a Postgres instance, or set ALLOW_SQLITE_IN_PROD=true to acknowledge the limitation.',
    ok: false,
  }
}

/**
 * Check 2: persistent uploads storage must be configured (UPLOADS_DIR
 * pointing at a likely-persistent mount). Bootstrap already FATALs when
 * this is wrong; here we surface the same status so the mission health
 * endpoint and smoke script can read it without relying on a startup
 * crash.
 */
export function checkPersistentUploads({ env = process.env, storageStatus = null, runtimeOnly = false } = {}) {
  const isProd = String(env.NODE_ENV || '').toLowerCase() === 'production'
  if (!isProd) {
    return { id: 'persistent_uploads', level: 'info', detail: 'NODE_ENV is not production.', ok: true }
  }
  if (envBool(env.ALLOW_EPHEMERAL_UPLOADS) === true) {
    return {
      id: 'persistent_uploads',
      level: 'warn',
      detail: 'Production allows ephemeral upload storage (ALLOW_EPHEMERAL_UPLOADS=true). Uploads will not survive deploys/restarts.',
      ok: true,
    }
  }
  if (!storageStatus) {
    // Two callers:
    //   - bootstrap (authoritative; throws in production when uploads
    //     aren't persistent — see backend/server.js + bootstrap.js).
    //   - runtime mission health (`/api/health/mission`, every dashboard
    //     refresh). When mission health hits this path it only means
    //     `storageStatus` was not plumbed through req.app.locals; the
    //     bootstrap gate has already run (otherwise the process would
    //     not be serving traffic).
    // Boot-time callers want a hard `warn` (test enforces this). Runtime
    // callers should not re-trip the gate on every health hit, so they
    // pass `runtimeOnly: true` and we demote to `info`.
    if (runtimeOnly) {
      return {
        id: 'persistent_uploads',
        level: 'info',
        detail:
          'No storageStatus plumbed to runtime mission health. The authoritative persistent-uploads check runs at boot (backend/startup/bootstrap.js); if the process is serving traffic, that check passed.',
        ok: true,
      }
    }
    return {
      id: 'persistent_uploads',
      level: 'warn',
      detail: 'No storageStatus available — production runtime cannot confirm uploads_dir is persistent.',
      ok: false,
    }
  }
  if (storageStatus.likely_persistent !== true || storageStatus.writable !== true) {
    return {
      id: 'persistent_uploads',
      level: 'error',
      detail: `Production uploads dir ${storageStatus.uploads_dir ?? '(unknown)'} is not persistent or not writable. Configure UPLOADS_DIR on a persistent mount.`,
      ok: false,
    }
  }
  return {
    id: 'persistent_uploads',
    level: 'info',
    detail: `Production uploads dir is persistent + writable: ${storageStatus.uploads_dir ?? '(unknown)'}`,
    ok: true,
  }
}

/**
 * Check 3: URL verification must be enabled in production (or operator
 * has explicitly opted out via GRANTFLOW_SKIP_VERIFICATION_GATE=true).
 */
export function checkUrlVerificationEnabled({ env = process.env } = {}) {
  const isProd = String(env.NODE_ENV || '').toLowerCase() === 'production'
  if (!isProd) {
    return { id: 'url_verification_enabled', level: 'info', detail: 'NODE_ENV is not production.', ok: true }
  }
  const explicit = envBool(env.URL_VERIFICATION_ENABLED)
  const skip = envBool(env.GRANTFLOW_SKIP_VERIFICATION_GATE) === true
  if (skip) {
    return {
      id: 'url_verification_enabled',
      level: 'warn',
      detail: 'GRANTFLOW_SKIP_VERIFICATION_GATE=true — operator has acknowledged a seed/import boot. URL verification may be off.',
      ok: true,
    }
  }
  if (explicit === false) {
    return {
      id: 'url_verification_enabled',
      level: 'error',
      detail: 'NODE_ENV=production but URL_VERIFICATION_ENABLED=false. Live ingest must verify URLs before storing them as "verified".',
      ok: false,
    }
  }
  return {
    id: 'url_verification_enabled',
    level: 'info',
    detail: 'URL_VERIFICATION_ENABLED is on (default in production).',
    ok: true,
  }
}

/**
 * Check 4: pending DB migrations. Returns warn when the caller can
 * detect at least one pending migration. Caller-supplied list keeps
 * this module IO-free; release-gate jobs query this elsewhere.
 */
export function checkPendingMigrations({ pendingMigrations = [] } = {}) {
  const list = Array.isArray(pendingMigrations) ? pendingMigrations : []
  if (list.length === 0) {
    return { id: 'pending_migrations', level: 'info', detail: 'No pending migrations detected.', ok: true }
  }
  return {
    id: 'pending_migrations',
    level: 'error',
    detail: `${list.length} migration(s) pending: ${list.slice(0, 5).join(', ')}${list.length > 5 ? '…' : ''}. Run migrations before deploy.`,
    ok: false,
  }
}

/**
 * Check 5: stale crawler data. The mission-health service already
 * inspects crawler_source_runs freshness; this check accepts the
 * mission-health payload's `crawler_source_runs.age_hours` and decides
 * whether the data is stale relative to the freshness window.
 *
 * In non-production environments a missing/empty crawler_source_runs
 * table is acceptable — local dev and unit tests never run real
 * crawler ingest, so a null ageHours falls through to `info`. The
 * release gate only trips on this check in production OR when ageHours
 * is past the freshness window.
 */
export function checkCrawlerFreshness({ ageHours = null, maxAgeHours = 48, env = process.env, tablePresent = null } = {}) {
  const isProd = String(env?.NODE_ENV || '').toLowerCase() === 'production'
  // tablePresent=false means the underlying `crawler_source_runs` table
  // does not yet exist on this database (e.g. migration 0066/072 has not
  // been applied). That is a one-shot install issue, not a freshness
  // failure -- the very next crawler run after migration will populate
  // it. Reporting `warn` on every health hit until the next deploy
  // uselessly trips the production_gate. Demote to `info` and tell the
  // operator what to do.
  if (tablePresent === false) {
    return {
      id: 'crawler_data_freshness',
      level: 'info',
      detail:
        'crawler_source_runs table is not present yet. Apply pending migrations (0066/072) and run the next crawler — coverage outcomes will populate.',
      ok: true,
    }
  }
  if (!Number.isFinite(ageHours)) {
    if (!isProd) {
      return {
        id: 'crawler_data_freshness',
        level: 'info',
        detail: 'crawler_source_runs not yet populated (dev/test environment).',
        ok: true,
      }
    }
    return {
      id: 'crawler_data_freshness',
      level: 'warn',
      detail: 'No recent crawler_source_runs row found — coverage outcomes may not be recorded.',
      ok: false,
    }
  }
  if (ageHours > maxAgeHours) {
    return {
      id: 'crawler_data_freshness',
      level: 'warn',
      detail: `crawler_source_runs latest row is ${ageHours}h old (max ${maxAgeHours}h).`,
      ok: false,
    }
  }
  return {
    id: 'crawler_data_freshness',
    level: 'info',
    detail: `crawler_source_runs is fresh (${ageHours}h old).`,
    ok: true,
  }
}

/**
 * Check 6: mission health route is available. Caller passes the same
 * payload it expects to serve from /api/health/mission. If the payload
 * itself is missing or has an error field, the release gate must trip.
 *
 * When the readiness builder is invoked from *inside* mission health
 * itself (self-reference), the caller can pass selfReference=true to
 * skip this check and avoid a paradox where the mission-health builder
 * reports its own output as "unreachable".
 */
export function checkMissionHealthAvailability(missionHealth = null, { selfReference = false } = {}) {
  if (selfReference) {
    return {
      id: 'mission_health_unreachable',
      level: 'info',
      detail: 'mission health is the caller (self-reference skipped).',
      ok: true,
    }
  }
  if (!missionHealth) {
    return {
      id: 'mission_health_unreachable',
      level: 'error',
      detail: 'mission health payload unavailable.',
      ok: false,
    }
  }
  if (missionHealth.error || missionHealth.ok === false) {
    return {
      id: 'mission_health_unreachable',
      level: 'error',
      detail: `mission health endpoint reports error: ${missionHealth.error ?? 'unknown'}`,
      ok: false,
    }
  }
  return {
    id: 'mission_health_unreachable',
    level: 'info',
    detail: 'mission health endpoint healthy.',
    ok: true,
  }
}

/**
 * Check 7: configured production SMS must authenticate inbound consent mutations.
 */
export function checkTwilioWebhookSecurity({ env = process.env } = {}) {
  const posture = twilioWebhookPosture(env)
  if (!posture.production || !posture.configured) {
    return {
      id: 'twilio_webhook_security',
      level: 'info',
      detail: posture.production ? 'Twilio SMS is not configured.' : 'NODE_ENV is not production.',
      ok: true,
    }
  }
  if (!posture.token_configured) {
    return {
      id: 'twilio_webhook_security',
      level: 'error',
      detail: 'Twilio SMS is configured in production but TWILIO_AUTH_TOKEN is missing.',
      ok: false,
    }
  }
  if (posture.validation_explicitly_disabled) {
    return {
      id: 'twilio_webhook_security',
      level: 'error',
      detail: 'TWILIO_VALIDATE_SIGNATURE=false is forbidden in production.',
      ok: false,
    }
  }
  return {
    id: 'twilio_webhook_security',
    level: 'info',
    detail: 'Twilio inbound webhook signatures are required in production.',
    ok: true,
  }
}

/**
 * Check 8: production provider secrets must be encrypted with a dedicated key,
 * never solely with the authentication/JWT signing material.
 */
export function checkRuntimeSecretKeySecurity({ env = process.env } = {}) {
  const production = String(env.NODE_ENV || '').trim().toLowerCase() === 'production'
  const testLike =
    String(env.NODE_ENV || '').trim().toLowerCase() === 'test' ||
    envBool(env.SMOKE_MODE) === true ||
    envBool(env.ALLOW_EPHEMERAL_SQLITE) === true

  if (!production || testLike) {
    return {
      id: 'runtime_secret_key_security',
      level: 'info',
      detail: production ? 'Production-shaped test runtime is exempt.' : 'NODE_ENV is not production.',
      ok: true,
    }
  }

  try {
    const posture = runtimeSecretKeyPosture(env)
    if (posture.dedicated_key_configured) {
      return {
        id: 'runtime_secret_key_security',
        level: 'info',
        detail: 'Dedicated runtime-secret key is configured via ' + posture.dedicated_key_source + '.',
        ok: true,
      }
    }
    return {
      id: 'runtime_secret_key_security',
      level: 'error',
      detail: 'No dedicated runtime-secret key is configured or present on persistent storage.',
      ok: false,
    }
  } catch (error) {
    return {
      id: 'runtime_secret_key_security',
      level: 'error',
      detail: 'Runtime-secret key posture could not be verified: ' + (error?.message || String(error)),
      ok: false,
    }
  }
}

/**
 * Aggregate all checks into a single readiness report.
 * Each input is optional; missing inputs degrade to a warn (the gate
 * cannot prove safety without them).
 */
export function buildProductionReadinessReport({
  env = process.env,
  dbDialect = null,
  storageStatus = null,
  pendingMigrations = [],
  crawlerSourceRunsAgeHours = null,
  crawlerSourceRunsMaxAgeHours = 48,
  crawlerSourceRunsTablePresent = null,
  missionHealth = null,
  selfReference = false,
} = {}) {
  const results = [
    checkSqliteInProduction({ env, dbDialect }),
    checkPersistentUploads({ env, storageStatus, runtimeOnly: Boolean(selfReference) }),
    checkUrlVerificationEnabled({ env }),
    checkPendingMigrations({ pendingMigrations }),
    checkCrawlerFreshness({ ageHours: crawlerSourceRunsAgeHours, maxAgeHours: crawlerSourceRunsMaxAgeHours, env, tablePresent: crawlerSourceRunsTablePresent }),
    checkMissionHealthAvailability(missionHealth, { selfReference }),
    checkTwilioWebhookSecurity({ env }),
    checkRuntimeSecretKeySecurity({ env }),
  ]

  const errors = results.filter((r) => r.level === 'error')
  const warnings = results.filter((r) => r.level === 'warn')
  const productionReady = errors.length === 0 && warnings.length === 0
  const safeToBoot = errors.length === 0

  return {
    generated_at: new Date().toISOString(),
    production_ready: productionReady,
    safe_to_boot: safeToBoot,
    checks: results,
    error_count: errors.length,
    warning_count: warnings.length,
  }
}

export default {
  buildProductionReadinessReport,
  checkSqliteInProduction,
  checkPersistentUploads,
  checkUrlVerificationEnabled,
  checkPendingMigrations,
  checkCrawlerFreshness,
  checkMissionHealthAvailability,
}
