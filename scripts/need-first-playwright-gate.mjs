import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const dbPath = '/tmp/grantflow-need-first-playwright.db'
const uploadsPath = '/tmp/grantflow-need-first-playwright-uploads'
const browserPath = '/tmp/grantflow-playwright-browsers'
const adminToken = 'need-first-playwright-admin-token-20260729'

function cleanBaseEnv() {
  const passthrough = [
    'PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'TEMP', 'TMP',
    'SystemRoot', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA',
    'NPM_CONFIG_CACHE', 'npm_config_cache', 'NODE_OPTIONS',
  ]
  const env = {}
  for (const key of passthrough) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return env
}

function smokeEnv() {
  return {
    ...cleanBaseEnv(),
    CI: 'true',
    NODE_ENV: 'development',
    PORT: '8080',
    DB_PROVIDER: 'sqlite',
    DB_DIALECT: 'sqlite',
    DB_AUTO_MIGRATE: 'true',
    SQLITE_DB_PATH: dbPath,
    ALLOW_EPHEMERAL_SQLITE: 'true',
    ALLOW_EPHEMERAL_UPLOADS: 'true',
    UPLOADS_DIR: uploadsPath,
    APPLY_STORAGE_DIR: '/tmp/grantflow-need-first-apply',
    HAMILTON_PACKET_STORAGE_DIR: '/tmp/grantflow-need-first-packets',
    HAMILTON_SCREENSHOTS_DIR: '/tmp/grantflow-need-first-screenshots',
    HAMILTON_BROWSER_STORAGE_DIR: '/tmp/grantflow-need-first-browser',
    DISABLE_BACKGROUND_SERVICES: 'true',
    SMOKE_MODE: 'true',
    STARTUP_SMOKE_CRAWL_ENABLED: 'false',
    NATIONAL_PROGRAMS_CRAWLER_ENABLED: 'false',
    ANYA_AUTONOMOUS_ENABLED: 'false',
    ANYA_RUN_ON_STARTUP: 'false',
    ANYA_RUN_ON_SCHEDULE: 'false',
    AMY_RUN_ON_STARTUP: 'false',
    AMY_RUN_ON_SCHEDULE: 'false',
    ROBERT_RUN_ON_STARTUP: 'false',
    ROBERT_RUN_ON_SCHEDULE: 'false',
    YANA_ENABLED: 'false',
    YANA_RUN_ON_STARTUP: 'false',
    YANA_RUN_ON_SCHEDULE: 'false',
    YANA_LEADS_ENABLED: 'false',
    JOHN_RUN_ON_STARTUP: 'false',
    JOHN_RUN_ON_SCHEDULE: 'false',
    HAMILTON_ALLOW_AUTOSUBMIT: 'false',
    HAMILTON_ENABLE_BROWSER_AUTOMATION: 'false',
    HAMILTON_RUN_ON_SCHEDULE: 'false',
    URL_VERIFICATION_ENABLED: 'false',
    OPPORTUNITY_INSERT_VERIFY_URL: 'false',
    LOGIN_MAINTENANCE: 'false',
    ADMIN_TOKEN: adminToken,
    SMOKE_ADMIN_TOKEN: adminToken,
    AUTH_JWT_SECRET: 'need-first-playwright-jwt-secret-not-for-production-20260729',
    JWT_SECRET: 'need-first-playwright-jwt-secret-not-for-production-20260729',
    SESSION_SECRET: 'need-first-playwright-session-secret-not-for-production-20260729',
    RUNTIME_SECRETS_KEY: 'need-first-playwright-runtime-key-32-bytes-minimum-20260729',
    SMOKE_BASE_URL: 'http://127.0.0.1:8080',
    SMOKE_BASE_PATH: '/grantflow',
    VITE_APP_BASE: '/grantflow',
    PLAYWRIGHT_BROWSERS_PATH: browserPath,
  }
}

function run(args, label, env) {
  console.log(`[need-first-playwright-gate] ${label}`)
  const result = spawnSync(npm, args, {
    stdio: 'inherit',
    env,
    shell: false,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit ${result.status}`)
  }
}

for (const target of [dbPath, uploadsPath, browserPath]) {
  fs.rmSync(target, { recursive: true, force: true })
}

const env = smokeEnv()
run(['run', 'build'], 'production frontend build', { ...env, NODE_ENV: 'production' })
run(
  ['exec', '--', 'playwright', 'install', '--with-deps', 'chromium'],
  'install Chromium and system dependencies',
  env,
)
run(['run', 'smoke'], 'Playwright smoke suite', env)

console.log('[need-first-playwright-gate] PASS')
