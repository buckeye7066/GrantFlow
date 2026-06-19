/**
 * bootPolicy.js
 *
 * Single canonical source of truth for boot-time policy decisions
 * driven by environment variables. Pure functions only — no I/O,
 * no side effects, no console writes — so the same module can be
 * imported from server.js, scripts, and unit tests.
 *
 * Why this module exists:
 *   Three env vars (MIGRATE_ON_BOOT, SMOKE_MODE, DB_AUTO_MIGRATE)
 *   interact in non-trivial ways and the logic was duplicated in
 *   backend/server.js (3 different blocks) and re-implemented in
 *   tests/unit/migrate-on-boot-default.test.mjs with a "keep this in
 *   sync with server.js" comment that historically drifted. Each
 *   drift was a real boot-time bug (Agent Control Center reporting
 *   "relation 'robert_runs' does not exist", smoke tests writing
 *   migrations into the dev DB, etc.).
 *
 *   This module centralizes the truth. server.js consumes the
 *   policy, and tests assert the policy directly without
 *   re-implementing it.
 *
 * Mission rule: 'Any new logic must be: traceable, logged
 * (lightweight), reversible.' Each function below describes its
 * intent + default in the JSDoc, returns a plain boolean, and
 * carries env-var fallbacks so the orchestrator can log exactly
 * what it decided and why.
 */

/**
 * Parse a string as a boolean flag.
 *
 *   '1' / 'true' / 'TRUE' / 'yes' / 'on'  → true
 *   '0' / 'false' / 'no' / 'off'          → false
 *   anything else (including '', undefined) → defaultWhenMissing
 *
 * Case-insensitive. Whitespace-trimmed.
 */
export function parseBoolFlag(value, defaultWhenMissing = false) {
  const raw = String(value ?? '').trim()
  if (!raw) return defaultWhenMissing
  if (/^(1|true|yes|on)$/i.test(raw)) return true
  if (/^(0|false|no|off)$/i.test(raw)) return false
  return defaultWhenMissing
}

/**
 * Returns true iff a string env value was set to one of the
 * canonical opt-in tokens. Stricter than parseBoolFlag — used to
 * detect "operator explicitly turned this on" so we can override
 * smoke-mode default behavior.
 */
export function isExplicitOptIn(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim())
}

/**
 * Returns true iff a string env value was set to one of the
 * canonical opt-out tokens. Used the same way for "operator
 * explicitly turned this off".
 */
export function isExplicitOptOut(value) {
  return /^(0|false|no|off)$/i.test(String(value ?? '').trim())
}

/**
 * Smoke mode detection.
 *
 *   - SMOKE_MODE=1 → explicit smoke (always wins).
 *   - PORT=0 + DB_AUTO_MIGRATE=true + NODE_ENV != 'production'
 *     → inferred smoke. Several unit/contract tests start the
 *     server with these flags but never set SMOKE_MODE explicitly,
 *     and we don't want their boot to do heavy work.
 *
 * @param {object} env - process.env (or test stub)
 * @param {string|number} port - the port the server will bind
 */
export function isSmokeMode(env = process.env, port = env?.PORT) {
  if (parseBoolFlag(env?.SMOKE_MODE, false)) return true
  const dbAutoMigrate = parseBoolFlag(env?.DB_AUTO_MIGRATE, false)
  const inferred =
    String(port ?? '') === '0' &&
    dbAutoMigrate &&
    String(env?.NODE_ENV ?? '').trim().toLowerCase() !== 'production'
  return inferred
}

/**
 * Should we run pending SQL migrations on boot?
 *
 * DEFAULT: ON. Opt out with MIGRATE_ON_BOOT=0|false|no|off.
 * Smoke mode opts out by default (preserves test fixture
 * isolation) — but explicit opt-in wins.
 *
 * Regression this guards: Agent Control Center reporting
 *   "Agent robert failed: relation 'robert_runs' does not exist"
 * because the operator never set MIGRATE_ON_BOOT=1.
 */
export function shouldMigrateOnBoot(env = process.env, { smokeMode } = {}) {
  const smoke = smokeMode ?? isSmokeMode(env)
  const raw = env?.MIGRATE_ON_BOOT
  if (isExplicitOptIn(raw)) return true
  if (isExplicitOptOut(raw)) return false
  return !smoke
}

/**
 * Should server.js apply backend/db/schema.sql at startup?
 *
 *   - DB_AUTO_MIGRATE=true forces ON (any dialect).
 *   - On sqlite + non-production, ON by default (legacy local-dev
 *     behavior).
 *   - Otherwise OFF.
 */
export function shouldAutoApplySchema(env = process.env, dialect = 'sqlite') {
  if (parseBoolFlag(env?.DB_AUTO_MIGRATE, false)) return true
  if (dialect === 'sqlite' && String(env?.NODE_ENV ?? '').toLowerCase() !== 'production') {
    return true
  }
  return false
}

/**
 * Should background services (crawlers, schedulers, autopilot
 * loops) be disabled on this boot?
 *
 *   - SMOKE_MODE → disabled (tests).
 *   - DISABLE_BACKGROUND_SERVICES=true → disabled.
 *   - Otherwise enabled.
 */
export function disableBackgroundServices(env = process.env, { smokeMode } = {}) {
  const smoke = smokeMode ?? isSmokeMode(env)
  if (smoke) return true
  return parseBoolFlag(env?.DISABLE_BACKGROUND_SERVICES, false)
}

/**
 * Build a single immutable snapshot of all boot policy decisions
 * for this process. Logged once at startup so operators see exactly
 * which env vars decided which behaviors.
 */
export function buildBootPolicy(env = process.env, { port, dialect = 'sqlite' } = {}) {
  const smokeMode = isSmokeMode(env, port)
  return Object.freeze({
    smoke_mode: smokeMode,
    migrate_on_boot: shouldMigrateOnBoot(env, { smokeMode }),
    auto_apply_schema: shouldAutoApplySchema(env, dialect),
    background_services_disabled: disableBackgroundServices(env, { smokeMode }),
    raw: {
      SMOKE_MODE: env?.SMOKE_MODE ?? null,
      MIGRATE_ON_BOOT: env?.MIGRATE_ON_BOOT ?? null,
      DB_AUTO_MIGRATE: env?.DB_AUTO_MIGRATE ?? null,
      DISABLE_BACKGROUND_SERVICES: env?.DISABLE_BACKGROUND_SERVICES ?? null,
      NODE_ENV: env?.NODE_ENV ?? null,
      PORT: port ?? env?.PORT ?? null,
      dialect,
    },
  })
}
