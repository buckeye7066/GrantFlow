const EXACT_KEYS_TO_REMOVE = new Set([
  'DATABASE_URL',
  'DATABASE_PUBLIC_URL',
  'DATABASE_PRIVATE_URL',
  'RAILWAY_DATABASE_URL',
  'POSTGRES_URL',
  'POSTGRES_PRISMA_URL',
  'POSTGRES_URL_NON_POOLING',
  'PGHOST',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGPASSWORD',
  'PGSSLMODE',
  'DB_PROVIDER',
  'DB_DIALECT',
  'DB_HOST',
  'DB_PORT',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
  'REDIS_URL',
  'UPLOADS_DIR',
  'PORT',
  'CORS_ORIGIN',
  'VITE_API_URL',
  'VITE_PREVIEW_API_URL',
  'VITE_APP_BASE',
  'AUTH_FRONTEND_APP_BASE',
  'URL_VERIFICATION_ENABLED',
  'OPPORTUNITY_INSERT_VERIFY_URL',
  'LINK_VERIFICATION_ENABLED',
  'AUTH_JWT_SECRET',
  'JWT_SECRET',
  'SESSION_SECRET',
  'ADMIN_TOKEN',
  'ADMIN_EMAIL',
  'ANYA_ADMIN_TOKEN',
  'SERVICE_APPLICATION_EMAIL',
  'RUNTIME_SECRETS_KEY',
  'RUNTIME_SECRETS_KEY_PREVIOUS',
  'RUNTIME_SECRETS_KEY_FILE',
  'API_AUTH_RATE_LIMIT_MAX',
  'API_AUTH_RATE_LIMIT_WINDOW_MS',
  'API_COST_RATE_LIMIT_MAX',
  'API_COST_RATE_LIMIT_WINDOW_MS',
  'API_AUTOMATION_RATE_LIMIT_MAX',
  'API_AUTOMATION_RATE_LIMIT_WINDOW_MS',
  'API_MUTATION_RATE_LIMIT_MAX',
  'API_MUTATION_RATE_LIMIT_WINDOW_MS',
  'API_STANDARD_RATE_LIMIT_MAX',
  'API_STANDARD_RATE_LIMIT_WINDOW_MS',
  'GRANTFLOW_SKIP_MISSION_GATE',
])

const PREFIXES_TO_REMOVE = [
  'RAILWAY_',
  'VERCEL_',
  'POSTGRES_',
  'UPSTASH_',
  'TWILIO_',
  'RESEND_',
  'OPENAI_',
  'ANTHROPIC_',
  'GRANTS_GOV_',
  'SIMPLER_GRANTS_',
  'SAM_GOV_',
  'API_DATA_GOV_',
]

/**
 * Build a deterministic environment for isolated unit and integration tests.
 * Hosted build environments can expose production database URLs, provider
 * credentials, and feature switches. Unit fixtures must never inherit those
 * values and silently turn a local SQLite test into a production-network test.
 */
export function buildIsolatedTestEnv(base = process.env, overrides = {}) {
  const env = { ...base }

  for (const key of Object.keys(env)) {
    if (
      EXACT_KEYS_TO_REMOVE.has(key) ||
      PREFIXES_TO_REMOVE.some((prefix) => key.startsWith(prefix))
    ) {
      delete env[key]
    }
  }

  env.NODE_ENV = 'test'
  env.GRANTFLOW_TEST_RUNNER = '1'
  env.DISABLE_BACKGROUND_SERVICES = 'true'

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) delete env[key]
    else env[key] = String(value)
  }

  return env
}

export default buildIsolatedTestEnv
