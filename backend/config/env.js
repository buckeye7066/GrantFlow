import { z } from 'zod'

function splitCsv(value) {
  if (!value) return []
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function looksLikePostgresUrl(value) {
  return /^postgres(ql)?:\/\//i.test(String(value || '').trim())
}

function normalizeMaybeSecret(value) {
  // `value === null || value === undefined` makes the null-ish check explicit
  // and satisfies eqeqeq.
  const raw =
    typeof value === 'string'
      ? value
      : value === null || value === undefined
        ? ''
        : String(value)
  const trimmed = raw.trim()
  return trimmed || null
}

export function looksUnsafeJwtSecret(value) {
  const v = String(value || '').trim()
  if (!v) return true
  const lowered = v.toLowerCase()
  return (
    lowered === 'grantflow-dev-secret' ||
    lowered === 'dev' ||
    lowered === 'development' ||
    lowered === 'secret' ||
    lowered === 'changeme' ||
    lowered === 'change-me' ||
    lowered === 'your_jwt_secret' ||
    lowered === 'your-jwt-secret' ||
    lowered === 'your jwt secret'
  )
}

function containsCorsWildcard(origins) {
  return Array.isArray(origins) && origins.some((o) => String(o || '').trim() === '*')
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim())
}

function normalizedMode(value) {
  return String(value || 'development').trim().toLowerCase()
}

function isDeployedRuntime(env, mode = env?.NODE_ENV) {
  return normalizedMode(mode) === 'production'
    || Boolean(String(env?.RAILWAY_ENVIRONMENT_ID || '').trim())
    || Boolean(String(env?.RAILWAY_DEPLOYMENT_ID || '').trim())
}

function isDeployableEmail(value) {
  if (!looksLikeEmail(value)) return false
  const domain = String(value).trim().toLowerCase().split('@').at(-1)
  return !(
    domain === 'example.com'
    || domain === 'example.net'
    || domain === 'example.org'
    || domain?.endsWith('.example')
    || domain?.endsWith('.invalid')
    || domain?.endsWith('.local')
    || domain?.endsWith('.localhost')
    || domain?.endsWith('.test')
  )
}

const EnvSchema = z
  .object({
    NODE_ENV: z.string().optional().default('development'),

    // Allow PORT=0 in non-prod (ephemeral). In prod we enforce PORT >= 1.
    PORT: z.coerce.number().int().min(0).max(65535).optional().default(8080),

    // CORS
    CORS_ORIGIN: z.string().optional(),

    // DB
    DB_PROVIDER: z.enum(['sqlite', 'postgres']).optional(),
    DB_DIALECT: z.string().optional(),
    DATABASE_URL: z.string().optional(),
    SQLITE_DB_PATH: z.string().optional(),
    DB_AUTO_MIGRATE: z.string().optional(),
    PG_POOL_MAX: z.coerce.number().int().positive().optional(),
    PG_POOL_IDLE_MS: z.coerce.number().int().positive().optional(),
    PG_POOL_CONN_TIMEOUT_MS: z.coerce.number().int().positive().optional(),

    // Auth
    AUTH_JWT_SECRET: z.string().optional(),
    JWT_SECRET: z.string().optional(),
    AUTH_NOTIFY_ON_LOGIN: z.string().optional(),
    AUTH_NOTIFY_EMAIL: z.string().optional(),
    AUTH_ALLOW_PREVIEW_CODE_IN_PROD: z.string().optional(),
    AUTH_ALLOW_ADMIN_PREVIEW_CODE: z.string().optional(), // Failsafe for admin users when email fails

    // Frontend base path (used for SPA static hosting under subpaths like /grantflow)
    AUTH_FRONTEND_APP_BASE: z.string().optional(),
    VITE_APP_BASE: z.string().optional(),

    // Admin
    ADMIN_TOKEN: z.string().optional(),
    ANYA_ADMIN_TOKEN: z.string().optional(),
    ANYA_API_KEY: z.string().optional(),
    BULK_POPULATE_KEY: z.string().optional(),
    ALLOW_LEGACY_PROFILE_TOKEN: z.string().optional(),
    ADMIN_EMAIL: z.string().optional(),
    ADMIN_EMAILS: z.string().optional(),
    AGENT_CONTROL_ADMIN_EMAIL: z.string().optional(),
    HAMILTON_ADMIN_EMAIL: z.string().optional(),

    // Integrations
    OPENAI_API_KEY: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    FREE_AI_ROUTES: z.string().optional(),
    FREE_AI_BASE_URL: z.string().optional(),
    FREE_AI_MODEL: z.string().optional(),
    FREE_AI_API_KEY: z.string().optional(),
    FREE_AI_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
    FREE_AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).optional(),
    FREE_AI_RESERVE_MS: z.coerce.number().int().positive().optional(),
    OLLAMA_BASE_URL: z.string().optional(),
    OLLAMA_MODEL: z.string().optional(),
    OLLAMA_API_KEY: z.string().optional(),

    RESEND_API_KEY: z.string().optional(),
    FROM_EMAIL: z.string().optional(),

    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
    TWILIO_FROM_NUMBER: z.string().optional(),

    // Timeouts
    REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().optional(),

    // Startup behaviors (production-safe defaults are enforced in code)
    ENABLE_ASSISTANCE_DIRECTORIES_SEED: z.string().optional(),
    ENABLE_MIN_NATIONAL_ENSURE: z.string().optional(),
    BASELINE_SEED_MODE: z.string().optional(),

    // Upload persistence
    UPLOADS_DIR: z.string().optional(),
  })
  .passthrough()

export function loadEnv({ mode = process.env.NODE_ENV } = {}) {
  const parsed = EnvSchema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    return { ok: false, issues, env: null, warnings: [] }
  }

  const env = parsed.data
  const warnings = []

  const effectiveMode = normalizedMode(mode || env.NODE_ENV)
  const isProd = isDeployedRuntime(env, effectiveMode)

  // Normalize provider selection logic: DB_PROVIDER/DB_DIALECT or DATABASE_URL implies postgres
  const providerRaw = String(env.DB_PROVIDER || env.DB_DIALECT || '').trim().toLowerCase()
  const provider =
    providerRaw === 'postgresql' || providerRaw === 'pg'
      ? 'postgres'
      : providerRaw || (looksLikePostgresUrl(env.DATABASE_URL) ? 'postgres' : 'sqlite')

  if (provider === 'postgres' && !looksLikePostgresUrl(env.DATABASE_URL)) {
    return {
      ok: false,
      issues: ['DB_PROVIDER=postgres requires DATABASE_URL to be a postgres:// connection string'],
      env: null,
      warnings: [],
    }
  }

  if (isProd) {
    const adminEmail = normalizeMaybeSecret(env.ADMIN_EMAIL)
    if (!adminEmail || !isDeployableEmail(adminEmail)) {
      return {
        ok: false,
        issues: ['ADMIN_EMAIL is required in deployed runtimes and must be a deliverable, non-fixture email address'],
        env: null,
        warnings: [],
      }
    }
    const invalidAdditionalAdmins = splitCsv(env.ADMIN_EMAILS).filter(value => !isDeployableEmail(value))
    if (invalidAdditionalAdmins.length > 0) {
      return {
        ok: false,
        issues: ['ADMIN_EMAILS contains an invalid or fixture email address'],
        env: null,
        warnings: [],
      }
    }
    for (const name of ['AGENT_CONTROL_ADMIN_EMAIL', 'HAMILTON_ADMIN_EMAIL']) {
      const value = normalizeMaybeSecret(env[name])
      if (value && !isDeployableEmail(value)) {
        return {
          ok: false,
          issues: [`${name} must be a deliverable, non-fixture email address when configured`],
          env: null,
          warnings: [],
        }
      }
    }
    const jwtSecret = normalizeMaybeSecret(env.AUTH_JWT_SECRET) || normalizeMaybeSecret(env.JWT_SECRET)
    if (!jwtSecret) {
      return {
        ok: false,
        issues: ['AUTH_JWT_SECRET (or JWT_SECRET) is required in production for secure auth tokens'],
        env: null,
        warnings: [],
      }
    }
    if (looksUnsafeJwtSecret(jwtSecret)) {
      return {
        ok: false,
        issues: [
          'AUTH_JWT_SECRET/JWT_SECRET is set to an insecure placeholder value. Set a strong random secret (recommended: 32+ bytes).',
        ],
        env: null,
        warnings: [],
      }
    }
    if (env.PORT === 0) {
      const allowEphemeralPort =
        String(env.ALLOW_EPHEMERAL_PORT || '').trim().toLowerCase() === 'true' ||
        String(env.SMOKE_MODE || '').trim().toLowerCase() === 'true' ||
        String(env.ALLOW_EPHEMERAL_SQLITE || '').trim().toLowerCase() === 'true'

      if (allowEphemeralPort) {
        warnings.push('PORT=0 accepted in production for ephemeral/test harness use (ALLOW_EPHEMERAL_PORT/SMOKE_MODE).')
      } else {
      return {
        ok: false,
        issues: ['PORT must be >= 1 in production (PORT=0 is only valid for local/ephemeral use)'],
        env: null,
        warnings: [],
      }
      }
    }

    if (String(env.ALLOW_LEGACY_PROFILE_TOKEN || '').trim().toLowerCase() === 'true') {
      return {
        ok: false,
        issues: ['ALLOW_LEGACY_PROFILE_TOKEN must not be enabled in production (it bypasses auth by accepting profile IDs as bearer tokens)'],
        env: null,
        warnings: [],
      }
    }
  } else {
    if (!(env.AUTH_JWT_SECRET || env.JWT_SECRET)) {
      warnings.push('AUTH_JWT_SECRET/JWT_SECRET not set; dev defaults may be used in auth flows.')
    }
  }

  // Partial-config checks (warn, but don’t fail boot)
  const twilioAny = Boolean(env.TWILIO_ACCOUNT_SID || env.TWILIO_AUTH_TOKEN || env.TWILIO_MESSAGING_SERVICE_SID || env.TWILIO_FROM_NUMBER)
  const twilioOk = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && (env.TWILIO_MESSAGING_SERVICE_SID || env.TWILIO_FROM_NUMBER))
  if (twilioAny && !twilioOk) {
    warnings.push('TWILIO_* appears partially configured; SMS OTP may fail. Provide TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and (TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER).')
  }

  const resendAny = Boolean(env.RESEND_API_KEY || env.FROM_EMAIL)
  const resendOk = Boolean(env.RESEND_API_KEY && env.FROM_EMAIL)
  if (resendAny && !resendOk) {
    warnings.push('RESEND_API_KEY/FROM_EMAIL appears partially configured; email OTP may fail.')
  }

  const corsOrigins = env.CORS_ORIGIN ? splitCsv(env.CORS_ORIGIN) : []
  if (isProd && corsOrigins.length === 0) {
    return {
      ok: false,
      issues: [
        'CORS_ORIGIN is required in deployed runtimes. Configure one or more explicit HTTPS origins (comma-separated).',
      ],
      env: null,
      warnings: [],
    }
  }
  if (isProd && containsCorsWildcard(corsOrigins)) {
    return {
      ok: false,
      issues: [
        'CORS_ORIGIN must not include "*" in production when credentials are enabled. Provide explicit origins (comma-separated).',
      ],
      env: null,
      warnings: [],
    }
  }
  const appBase =
    (env.AUTH_FRONTEND_APP_BASE || env.VITE_APP_BASE || '/').replace(/\/+$/, '') || '/'

  return {
    ok: true,
    issues: [],
    warnings,
    env: {
      ...env,
      NODE_ENV: effectiveMode,
      ADMIN_EMAIL: normalizeMaybeSecret(env.ADMIN_EMAIL)?.toLowerCase() || null,
      ADMIN_EMAILS: splitCsv(env.ADMIN_EMAILS).map(value => value.toLowerCase()).join(','),
      AGENT_CONTROL_ADMIN_EMAIL: normalizeMaybeSecret(env.AGENT_CONTROL_ADMIN_EMAIL)?.toLowerCase() || null,
      HAMILTON_ADMIN_EMAIL: normalizeMaybeSecret(env.HAMILTON_ADMIN_EMAIL)?.toLowerCase() || null,
      isProd,
      dbProvider: provider,
      corsOrigins,
      appBase,
    },
  }
}

export function assertEnv({ mode } = {}) {
  const result = loadEnv({ mode })
  if (!result.ok) {
    console.error('[env] Invalid environment configuration:')
    result.issues.forEach((issue) => console.error(`- ${issue}`))
    const deployed = isDeployedRuntime(process.env, mode || process.env.NODE_ENV)
    if (deployed) {
      process.exit(1)
    }
    // Return issues in warnings so callers can programmatically surface them
    return { env: null, warnings: result.issues }
  }

  if (result.warnings.length) {
    result.warnings.forEach((w) => console.warn(`[env] ${w}`))
  }

  return { env: result.env, warnings: result.warnings }
}

// Centralized JWT secret resolution for server/routes/tests.
// NOTE: This must never generate random secrets.
export function getJwtSecretOrThrow(env = {}) {
  const secret = normalizeMaybeSecret(env.AUTH_JWT_SECRET) || normalizeMaybeSecret(env.JWT_SECRET)
  const isProd = Boolean(env.isProd) || normalizedMode(env.NODE_ENV) === 'production'
  if (!secret) {
    // Unit tests and local dev shouldn't require configuring secrets.
    // IMPORTANT: This must never be random; tests require deterministic behavior.
    if (!isProd) {
      console.warn('[env] AUTH_JWT_SECRET not set; using insecure dev-only fallback. Never deploy this secret.')
      return 'grantflow-dev-secret'
    }
    throw new Error('Missing AUTH_JWT_SECRET (or JWT_SECRET)')
  }

  // In non-prod, warn loudly if an unsafe placeholder is explicitly configured
  if (!isProd && looksUnsafeJwtSecret(secret)) {
    console.warn('[env] AUTH_JWT_SECRET/JWT_SECRET is set to a known-insecure placeholder value; replace before staging/prod.')
  }

  if (isProd && looksUnsafeJwtSecret(secret)) {
    throw new Error('AUTH_JWT_SECRET/JWT_SECRET is set to insecure placeholder value')
  }

  return secret
}
