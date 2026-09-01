import { defineConfig } from 'playwright/test'
import path from 'node:path'

const port = Number.parseInt(process.env.E2E_PORT || '18081', 10)
const baseURL =
  process.env.E2E_BASE_URL ||
  process.env.SMOKE_BASE_URL ||
  process.env.API_BASE_URL ||
  `http://127.0.0.1:${port}`
const basePath = process.env.E2E_BASE_PATH || process.env.SMOKE_BASE_PATH || process.env.VITE_APP_BASE || '/grantflow'
const crawlerDataDir = process.env.CRAWLER_DATA_DIR || path.resolve(process.cwd(), 'tests', 'fixtures', 'crawlers')
const e2eAdminEmail = process.env.E2E_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin-e2e@example.invalid'

export default defineConfig({
  testDir: path.resolve(process.cwd(), 'tests', 'e2e'),
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  // Self-start the app server for local + CI e2e runs.
  // Ensure DB migrations + deterministic seed run first so UI flows are reproducible.
  webServer: {
    command:
      'node backend/db/migrate.js && node backend/scripts/seed-deterministic.mjs --reset && npm run build && node backend/start.js',
    cwd: process.cwd(),
    port,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: process.env.NODE_ENV || (process.env.CI ? 'test' : 'development'),
      // Force an isolated per-run DB; never fall back to any shared/prod DB.
      TEST_DATABASE_URL:
        process.env.TEST_DATABASE_URL
        || path.resolve(process.cwd(), 'test-results', `e2e-${Date.now()}.db`),
      DB_AUTO_MIGRATE: process.env.DB_AUTO_MIGRATE || 'true',
      // Ensure deterministic seed aligns with backend admin defaults.
      ADMIN_EMAIL: e2eAdminEmail,
      ADMIN_NAME: process.env.ADMIN_NAME || 'Admin User',
      CRAWLER_DATA_DIR: crawlerDataDir,
      // Hint to frontend + backend to suppress noisy background behavior during automation.
      SMOKE_MODE: process.env.SMOKE_MODE || 'true',
      VITE_SMOKE_MODE: process.env.VITE_SMOKE_MODE || 'true',
    },
  },
  use: {
    baseURL,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  metadata: { baseURL, basePath },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
})

export { baseURL, basePath, e2eAdminEmail }
