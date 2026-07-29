import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const tarPath = '/tmp/grantflow-need-first-source.tgz'
const adminToken = 'need-first-playwright-admin-token-20260729'
const sandboxRoot = '/vercel/sandbox'
const appRoot = `${sandboxRoot}/app`
const browserPath = `${sandboxRoot}/browsers`

const CHROMIUM_SYSTEM_DEPS = [
  'nss', 'nspr', 'libxkbcommon', 'atk', 'at-spi2-atk', 'at-spi2-core',
  'libXcomposite', 'libXdamage', 'libXrandr', 'libXfixes', 'libXcursor',
  'libXi', 'libXtst', 'libXScrnSaver', 'libXext', 'mesa-libgbm', 'libdrm',
  'mesa-libGL', 'mesa-libEGL', 'cups-libs', 'alsa-lib', 'pango', 'cairo',
  'gtk3', 'dbus-libs',
]

function smokeEnv(nodeEnv = 'development') {
  // Vercel Sandbox supplies its own runtime PATH/HOME. Passing the host build
  // image's PATH into the microVM makes npm's `env node` shebang unable to find
  // the VM's Node binary. Supply only application variables and let runCommand
  // retain the sandbox defaults.
  return {
    CI: 'true',
    NODE_ENV: nodeEnv,
    PORT: '8080',
    DB_PROVIDER: 'sqlite',
    DB_DIALECT: 'sqlite',
    DB_AUTO_MIGRATE: 'true',
    SQLITE_DB_PATH: `${sandboxRoot}/grantflow-need-first-playwright.db`,
    ALLOW_EPHEMERAL_SQLITE: 'true',
    ALLOW_EPHEMERAL_UPLOADS: 'true',
    UPLOADS_DIR: `${sandboxRoot}/uploads`,
    APPLY_STORAGE_DIR: `${sandboxRoot}/apply`,
    HAMILTON_PACKET_STORAGE_DIR: `${sandboxRoot}/packets`,
    HAMILTON_SCREENSHOTS_DIR: `${sandboxRoot}/screenshots`,
    HAMILTON_BROWSER_STORAGE_DIR: `${sandboxRoot}/browser-storage`,
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

function runLocal(command, args, label, env = process.env) {
  console.log(`[need-first-playwright-gate] ${label}`)
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env,
    shell: false,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${label} failed with exit ${result.status}`)
}

async function runSandbox(sandbox, params, label, outputLimit = 20000) {
  console.log(`[need-first-playwright-gate] sandbox: ${label}`)
  const result = await sandbox.runCommand(params)
  const stdout = await result.stdout()
  const stderr = await result.stderr()
  if (stdout) console.log(stdout.slice(-outputLimit))
  if (stderr) console.error(stderr.slice(-outputLimit))
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed in sandbox with exit ${result.exitCode}`)
  }
}

// Keep a normal local production build as part of the Vercel artifact.
runLocal(npm, ['run', 'build'], 'production frontend build', {
  ...process.env,
  NODE_ENV: 'production',
  VITE_APP_BASE: '/grantflow',
})

// Install only the orchestration SDK in the build workspace. It is deliberately
// not committed to package.json or package-lock.json.
runLocal(
  npm,
  ['install', '--no-save', '--package-lock=false', '@vercel/sandbox'],
  'install temporary Vercel Sandbox SDK',
)

runLocal(
  'sh',
  ['-c', `git ls-files -z | tar --null --files-from=- -czf ${tarPath}`],
  'package the exact tracked PR source',
)

const { Sandbox } = await import('@vercel/sandbox')
const sandbox = await Sandbox.create({
  runtime: 'node24',
  timeout: 900_000,
})

try {
  console.log(`[need-first-playwright-gate] sandbox created: ${sandbox.sandboxId ?? sandbox.id ?? 'active'}`)
  await sandbox.writeFiles([
    { path: 'grantflow-source.tgz', content: fs.readFileSync(tarPath) },
  ])

  await runSandbox(sandbox, {
    cmd: 'sh',
    args: ['-c', `mkdir -p ${appRoot} && tar -xzf ${sandboxRoot}/grantflow-source.tgz -C ${appRoot}`],
  }, 'extract exact source')

  await runSandbox(sandbox, {
    cmd: 'dnf',
    args: ['clean', 'all'],
    sudo: true,
  }, 'clean package metadata', 4000)

  await runSandbox(sandbox, {
    cmd: 'dnf',
    args: ['install', '-y', '--skip-broken', ...CHROMIUM_SYSTEM_DEPS],
    sudo: true,
  }, 'install Chromium system libraries', 12000)

  await runSandbox(sandbox, {
    cmd: 'ldconfig',
    args: [],
    sudo: true,
  }, 'refresh dynamic linker cache', 4000)

  await runSandbox(sandbox, {
    cmd: 'npm',
    args: ['ci', '--include=optional'],
    cwd: appRoot,
    env: smokeEnv('development'),
  }, 'install locked repository dependencies', 12000)

  await runSandbox(sandbox, {
    cmd: 'npm',
    args: ['run', 'build'],
    cwd: appRoot,
    env: smokeEnv('production'),
  }, 'build the application in the browser VM', 12000)

  await runSandbox(sandbox, {
    cmd: 'npx',
    args: ['playwright', 'install', 'chromium'],
    cwd: appRoot,
    env: smokeEnv('development'),
  }, 'install Chromium in the browser VM', 12000)

  await runSandbox(sandbox, {
    cmd: 'npm',
    args: ['run', 'smoke'],
    cwd: appRoot,
    env: smokeEnv('development'),
  }, 'Playwright smoke suite', 30000)

  console.log('[need-first-playwright-gate] PASS')
} finally {
  await sandbox.stop()
}
