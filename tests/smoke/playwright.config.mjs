// Playwright smoke configuration.
// This repo primarily uses Playwright via custom scripts under `scripts/`.
// We also keep a tiny `playwright test` suite to validate the runner + browser install on CI/Windows.

import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const testDir = dirname(fileURLToPath(import.meta.url))

/** @type {import('@playwright/test').PlaywrightTestConfig} */
export default {
  testDir,
  timeout: 30_000,
  retries: 0,
  reporter: [['list']],
  use: {
    headless: true,
  },
}

