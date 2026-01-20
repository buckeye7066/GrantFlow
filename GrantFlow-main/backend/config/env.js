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

    // Frontend base path (used for SPA static hosting under subpaths like /grantflow)
    AUTH_FRONTEND_APP_BASE: z.string().optional(),
    VITE_APP_BASE: z.string().optional(),

    // Admin
    ADMIN_TOKEN: z.string().optional(),
    ANYA_ADMIN_TOKEN: z.string().optional(),
    ANYA_API_KEY: z.string().optional(),
    BULK_POPULATE_KEY: z.string().optional(),
    ALLOW_LEGACY_PROFILE_TOKEN: z.string().optional(),

    // Integrations
    OPENAI_API_KEY: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),

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

  const effectiveMode = String(mode || env.NODE_ENV || 'development')
  const isProd = effectiveMode === 'production'

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
    if (!(env.AUTH_JWT_SECRET || env.JWT_SECRET)) {
      return {
        ok: false,
        issues: ['AUTH_JWT_SECRET (or JWT_SECRET) is required in production for secure auth tokens'],
        env: null,
        warnings: [],
      }
    }
    if (env.PORT === 0) {
      return {
        ok: false,
        issues: ['PORT must be >= 1 in production (PORT=0 is only valid for local/ephemeral use)'],
        env: null,
        warnings: [],
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
  const appBase =
    (env.AUTH_FRONTEND_APP_BASE || env.VITE_APP_BASE || '/grantflow').replace(/\/+$/, '') || '/grantflow'

  return {
    ok: true,
    issues: [],
    warnings,
    env: {
      ...env,
      NODE_ENV: effectiveMode,
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
    if (String(mode || process.env.NODE_ENV) === 'production') {
      process.exit(1)
    }
    return { env: null, warnings: [] }
  }

  if (result.warnings.length) {
    result.warnings.forEach((w) => console.warn(`[env] ${w}`))
  }

  return { env: result.env, warnings: result.warnings }
}

