import { z } from 'zod'

function splitCsv(value) {
  if (!value) return []
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

const EnvSchema = z
  .object({
    NODE_ENV: z.string().optional().default('development'),
    PORT: z.coerce.number().int().positive().optional().default(8080),

    // Frontend base path (used for SPA static hosting under subpaths like /grantflow)
    AUTH_FRONTEND_APP_BASE: z.string().optional(),
    VITE_APP_BASE: z.string().optional(),

    // CORS
    CORS_ORIGIN: z.string().optional(),

    // DB
    DB_PROVIDER: z.enum(['sqlite', 'postgres']).optional(),
    DB_DIALECT: z.string().optional(),
    DATABASE_URL: z.string().optional(),
    SQLITE_DB_PATH: z.string().optional(),
    DB_AUTO_MIGRATE: z.string().optional(),

    // Auth
    AUTH_JWT_SECRET: z.string().optional(),
    JWT_SECRET: z.string().optional(),

    // Admin
    ADMIN_TOKEN: z.string().optional(),
    ANYA_ADMIN_TOKEN: z.string().optional(),

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
    REQUEST_TIMEOUT_MS: z.string().optional(),
  })
  .passthrough()

function looksLikePostgresUrl(value) {
  return /^postgres(ql)?:\/\//i.test(String(value || '').trim())
}

export function loadEnv({ mode = process.env.NODE_ENV } = {}) {
  const parsed = EnvSchema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    return {
      ok: false,
      issues,
      env: null,
      warnings: [],
    }
  }

  const env = parsed.data
  const warnings = []

  const effectiveMode = String(mode || env.NODE_ENV || 'development')
  const isProd = effectiveMode === 'production'

  // DB invariants (fail-fast)
  const providerRaw = String(env.DB_PROVIDER || env.DB_DIALECT || '').trim().toLowerCase()
  const provider = providerRaw === 'postgresql' || providerRaw === 'pg' ? 'postgres' : providerRaw

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
    if (!env.CORS_ORIGIN) {
      warnings.push('CORS_ORIGIN is not set; default allowlist will be used.')
    }
  } else {
    if (!(env.AUTH_JWT_SECRET || env.JWT_SECRET)) {
      warnings.push('AUTH_JWT_SECRET/JWT_SECRET not set; using dev defaults inside auth router.')
    }
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
      PORT: env.PORT,
      isProd,
      appBase,
      corsOrigins,
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