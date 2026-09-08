import { defineConfig } from 'playwright/test'
export default defineConfig({
  testDir: '.', testMatch: '*.spec.mjs', timeout: 90_000, workers: 1,
  expect: { timeout: 15_000 }, outputDir: '../../test-results/non-admin-ux',
  reporter: [['list'], ['html', { outputFolder: '../../playwright-report/non-admin-ux', open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:18133', headless: true, trace: 'retain-on-failure' },
  webServer: { cwd: process.cwd(), command: 'node tests/ux/server.mjs', url: 'http://127.0.0.1:18133/api/health', reuseExistingServer: !process.env.CI, timeout: 180_000 },
})
