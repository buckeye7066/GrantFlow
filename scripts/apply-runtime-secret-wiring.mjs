import fs from 'node:fs'

function read(file) {
  return fs.readFileSync(file, 'utf8')
}

function write(file, text) {
  fs.writeFileSync(file, text)
}

function replaceOne(file, pattern, replacement, label) {
  const before = read(file)
  const matches = [...before.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))]
  if (matches.length !== 1) {
    throw new Error(`${label || file}: expected one match, found ${matches.length}`)
  }
  write(file, before.replace(pattern, replacement))
}

function insertBefore(file, marker, text, label) {
  const before = read(file)
  const first = before.indexOf(marker)
  if (first < 0 || before.indexOf(marker, first + marker.length) >= 0) {
    throw new Error(`${label || file}: marker missing or ambiguous`)
  }
  write(file, before.slice(0, first) + text + before.slice(first))
}

replaceOne(
  'backend/server.js',
  /import \{ decryptRuntimeSecret \} from '\.\/utils\/runtimeSecrets\.js';/,
  `import {
  decryptRuntimeSecret,
  ensureRuntimeSecretKeyMaterial,
  migrateRuntimeSecretRows,
} from './utils/runtimeSecrets.js';`,
  'runtime secret startup imports',
)

insertBefore(
  'backend/server.js',
  '// Load persisted runtime secrets (encrypted) if missing from environment.',
  `// Ensure runtime-provider secrets are encrypted independently from the JWT
// signing key. Production uses the persistent Railway volume unless an explicit
// RUNTIME_SECRETS_KEY is configured. Existing v1/auth-derived rows are migrated
// idempotently before any provider secret is restored into process.env.
if (!app.locals.db_startup_error) {
  try {
    const keyMaterial = ensureRuntimeSecretKeyMaterial(process.env)
    const secretMigration = await migrateRuntimeSecretRows(db, {
      logger: console,
      env: process.env,
    })
    console.info('[runtimeSecrets] dedicated key ready', {
      source: keyMaterial.source,
      migrated: Number(secretMigration?.migrated || 0),
      skipped: Number(secretMigration?.skipped || 0),
      table_missing: Boolean(secretMigration?.table_missing),
    })
  } catch (runtimeSecretError) {
    app.locals.runtime_secrets_error = runtimeSecretError?.message || String(runtimeSecretError)
    console.error('[runtimeSecrets] FATAL: dedicated key initialization or migration failed', {
      error: app.locals.runtime_secrets_error,
    })
    if (isProdEnv) process.exit(1)
  }
}

`,
  'runtime secret startup wiring',
)

insertBefore(
  'backend/services/productionReadinessChecks.js',
  'const TRUE_VALUES = new Set',
  "import { runtimeSecretKeyPosture } from '../utils/runtimeSecrets.js'\n\n",
  'runtime secret readiness import',
)

insertBefore(
  'backend/services/productionReadinessChecks.js',
  '/**\n * Aggregate all checks into a single readiness report.',
  `/**
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
        detail: `Dedicated runtime-secret key is configured via ${posture.dedicated_key_source}.`,
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
      detail: `Runtime-secret key posture could not be verified: ${error?.message || String(error)}`,
      ok: false,
    }
  }
}

`,
  'runtime secret readiness check',
)

replaceOne(
  'backend/services/productionReadinessChecks.js',
  /    checkTwilioWebhookSecurity\(\{ env \}\),\n  \]/,
  `    checkTwilioWebhookSecurity({ env }),
    checkRuntimeSecretKeySecurity({ env }),
  ]`,
  'runtime secret readiness aggregation',
)

replaceOne(
  'tests/unit/production-readiness-hardening.test.mjs',
  /import \{ checkTwilioWebhookSecurity \} from '\.\.\/\.\.\/backend\/services\/productionReadinessChecks\.js'/,
  `import {
  checkRuntimeSecretKeySecurity,
  checkTwilioWebhookSecurity,
} from '../../backend/services/productionReadinessChecks.js'`,
  'runtime secret readiness test import',
)

const readinessTests = `

test('production readiness rejects missing dedicated runtime-secret key', () => {
  const check = checkRuntimeSecretKeySecurity({
    env: {
      NODE_ENV: 'production',
      RUNTIME_SECRETS_KEY_FILE: '/definitely/not/present/grantflow-runtime.key',
      AUTH_JWT_SECRET: 'legacy-only',
    },
  })
  assert.equal(check.ok, false)
  assert.equal(check.level, 'error')
})

test('production readiness accepts a dedicated runtime-secret environment key', () => {
  const check = checkRuntimeSecretKeySecurity({
    env: {
      NODE_ENV: 'production',
      RUNTIME_SECRETS_KEY: '44'.repeat(32),
      AUTH_JWT_SECRET: 'legacy-for-migration-only',
    },
  })
  assert.equal(check.ok, true)
  assert.equal(check.level, 'info')
})
`

const readinessTestFile = 'tests/unit/production-readiness-hardening.test.mjs'
const readinessBefore = read(readinessTestFile)
if (readinessBefore.includes('production readiness rejects missing dedicated runtime-secret key')) {
  throw new Error('runtime secret readiness tests already present')
}
write(readinessTestFile, `${readinessBefore.trimEnd()}${readinessTests}`)

console.log('[global-hardening] runtime-secret startup and readiness wiring applied')
