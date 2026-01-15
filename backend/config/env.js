import { z } from 'zod'

function isTruthy(value) {
  return String(value ?? '').toLowerCase() === 'true'
}

/**
 * Validate runtime environment variables.
 *
 * Goals:
 * - Fail-fast in production for truly required configuration (auth + DB + email).
 * - Keep dev flexible (warn instead of crash) to reduce friction.
 * - Never print secrets.
 */
export function validateRuntimeEnv() {
  const nodeEnv = process.env.NODE_ENV || 'development'
  const isProd = nodeEnv === 'production'

  const Schema = z
    .object({
      NODE_ENV: z.string().default('development'),
      PORT: z.coerce.number().int().positive().default(8080),

      DB_PROVIDER: z.enum(['sqlite', 'postgres']).default('sqlite'),
      SQLITE_DB_PATH: z.string().optional(),
      DATABASE_URL: z.string().optional(),

      AUTH_JWT_SECRET: z.string().optional(),
      JWT_SECRET: z.string().optional(),

      ADMIN_TOKEN: z.string().optional(),

      RESEND_API_KEY: z.string().optional(),
      FROM_EMAIL: z.string().optional(),

      OPENAI_API_KEY: z.string().optional(),

      OPENAI_TIMEOUT_MS: z.string().optional(),
      OPENAI_MAX_RETRIES: z.string().optional(),

      // Optional runtime toggles
      DB_AUTO_MIGRATE: z.string().optional(),
      ANYA_AUTONOMOUS_ENABLED: z.string().optional(),
      NATIONAL_PROGRAMS_CRAWLER_ENABLED: z.string().optional(),
      CORS_ORIGIN: z.string().optional(),
    })
    .passthrough()

  const parsed = Schema.safeParse(process.env)
  const errors = []
  const warnings = []

  if (!parsed.success) {
    errors.push(
      ...parsed.error.issues.map((issue) => ({
        key: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    )
  }

  const env = parsed.success ? parsed.data : process.env
  const dbProvider = env.DB_PROVIDER || 'sqlite'

  if (dbProvider === 'postgres' && !env.DATABASE_URL) {
    errors.push({ key: 'DATABASE_URL', message: 'Required when DB_PROVIDER=postgres' })
  }

  if (dbProvider === 'sqlite' && !env.SQLITE_DB_PATH) {
    const msg = 'Required when DB_PROVIDER=sqlite'
    if (isProd) errors.push({ key: 'SQLITE_DB_PATH', message: msg })
    else warnings.push({ key: 'SQLITE_DB_PATH', message: msg })
  }

  const jwtSecret = env.AUTH_JWT_SECRET || env.JWT_SECRET || ''
  if (!jwtSecret || jwtSecret === 'grantflow-dev-secret') {
    const msg = 'Missing or insecure. Set AUTH_JWT_SECRET to a strong random value.'
    if (isProd) errors.push({ key: 'AUTH_JWT_SECRET', message: msg })
    else warnings.push({ key: 'AUTH_JWT_SECRET', message: msg })
  }

  // Email OTP is a core flow in production.
  if (!env.RESEND_API_KEY) {
    const msg = 'Missing. Email OTP delivery requires RESEND_API_KEY.'
    if (isProd) errors.push({ key: 'RESEND_API_KEY', message: msg })
    else warnings.push({ key: 'RESEND_API_KEY', message: msg })
  }
  if (!env.FROM_EMAIL) {
    const msg = 'Missing. Email OTP delivery requires FROM_EMAIL.'
    if (isProd) errors.push({ key: 'FROM_EMAIL', message: msg })
    else warnings.push({ key: 'FROM_EMAIL', message: msg })
  }

  if (!env.ADMIN_TOKEN) {
    const msg = 'Missing. Admin endpoints/tools require ADMIN_TOKEN.'
    if (isProd) errors.push({ key: 'ADMIN_TOKEN', message: msg })
    else warnings.push({ key: 'ADMIN_TOKEN', message: msg })
  }

  if (!env.OPENAI_API_KEY) {
    warnings.push({
      key: 'OPENAI_API_KEY',
      message: 'Missing. AI features (Anya/enrichment/avatar lookup) will be degraded.',
    })
  }

  if (dbProvider === 'postgres' && isTruthy(env.DB_AUTO_MIGRATE)) {
    warnings.push({
      key: 'DB_AUTO_MIGRATE',
      message: 'DB_AUTO_MIGRATE=true with Postgres is discouraged; prefer explicit `npm run migrate`.',
    })
  }

  const ok = errors.length === 0
  return {
    ok,
    node_env: nodeEnv,
    is_prod: isProd,
    db_provider: dbProvider,
    errors,
    warnings,
  }
}

