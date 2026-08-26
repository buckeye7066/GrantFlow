import { defineConfig, devices } from 'playwright/test'
import path from 'node:path'

const baseURL = process.env.SMOKE_BASE_URL || process.env.API_BASE_URL || 'http://127.0.0.1:8080'
const basePath = process.env.SMOKE_BASE_PATH || process.env.VITE_APP_BASE || '/'

export default defineConfig({
  testDir: path.resolve(process.cwd(), 'tests', 'smoke'),
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  // Self-start the app server for local + CI smoke runs.
  // These tests validate basePath routing + health endpoints, so we need the backend running.
  webServer: {
    command: 'node backend/start.js',
    cwd: process.cwd(),
    port: 8080,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      PORT: process.env.PORT || '8080',
      NODE_ENV: process.env.NODE_ENV || (process.env.CI ? 'test' : 'development'),
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
    {
      name: 'webkit-safari',
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'mobile-safari',
      testMatch: /platform-compatibility\.spec\.mjs/,
      use: { ...devices['iPhone 15'] },
    },
  ],
})

export { baseURL, basePath }
