import { defineConfig } from 'playwright/test'
import path from 'node:path'

const baseURL = process.env.SMOKE_BASE_URL || process.env.API_BASE_URL || 'http://127.0.0.1:8080'
const basePath = process.env.SMOKE_BASE_PATH || process.env.VITE_APP_BASE || '/grantflow'

export default defineConfig({
  testDir: path.resolve(process.cwd(), 'tests', 'smoke'),
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
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

export { baseURL, basePath }
