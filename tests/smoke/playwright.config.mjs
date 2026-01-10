import path from 'node:path'

const artifactsDir = process.env.ARTIFACTS_DIR
  ? process.env.ARTIFACTS_DIR
  : path.resolve(process.cwd(), 'artifacts', 'local')

export default {
  testDir: path.resolve(process.cwd(), 'tests', 'smoke'),
  timeout: 60_000,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(artifactsDir, 'playwright-report'), open: 'never' }],
  ],
  use: {
    // Prefer doctor-provided SMOKE_BASE_URL; fall back to other common envs; finally PORT/8080.
    baseURL:
      process.env.SMOKE_BASE_URL ||
      process.env.BASE_URL ||
      process.env.API_BASE_URL ||
      `http://127.0.0.1:${process.env.PORT || '8080'}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  outputDir: path.join(artifactsDir, 'playwright-output'),
}

