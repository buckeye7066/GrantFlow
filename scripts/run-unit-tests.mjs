#!/usr/bin/env node
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { buildIsolatedTestEnv } from './test-environment.mjs'

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      // eslint-disable-next-line no-await-in-loop
      files.push(...(await walk(fullPath)))
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
      files.push(fullPath)
    }
  }
  return files
}

async function main() {
  const root = process.cwd()
  const target = path.join(root, 'tests', 'unit')
  const testFiles = (await walk(target)).sort()

  if (testFiles.length === 0) {
    console.error(`[unit] No test files found under ${target}`)
    process.exitCode = 1
    return
  }

  // Node's default test concurrency can overwhelm machines because many tests
  // spawn full backend processes. Keep this conservative by default to reduce
  // flakes/timeouts.
  const concurrencyRaw = process.env.UNIT_TEST_CONCURRENCY || process.env.TEST_CONCURRENCY || '4'
  const concurrency = Math.max(1, Number.parseInt(String(concurrencyRaw), 10) || 4)

  // Unit tests are hermetic. In hosted builds, inherited DATABASE_URL and
  // provider settings can otherwise redirect SQLite fixtures to production
  // services or alter feature behavior. Child tests can still opt into an
  // explicit production-shaped environment inside their own spawn calls.
  const testEnv = buildIsolatedTestEnv(process.env, {
    GRANTFLOW_TEST_RUNNER: process.env.GRANTFLOW_TEST_RUNNER || '1',
  })

  const child = spawn(process.execPath, ['--test', `--test-concurrency=${concurrency}`, ...testFiles], {
    stdio: 'inherit',
    env: testEnv,
  })

  let exited = false
  child.on('exit', (code) => {
    exited = true
    process.exitCode = code ?? 1
  })

  // Test-spawned server processes may keep open handles that prevent
  // node --test from exiting. Keep a deadman switch, but size it for the
  // current suite: many tests intentionally boot the backend, exercise auth,
  // parse documents, and run Hamilton/agent flows. This is not a performance
  // SLA; CI/local callers can still lower or raise it with UNIT_TEST_HARD_TIMEOUT_MS.
  const HARD_TIMEOUT_MS = Number(process.env.UNIT_TEST_HARD_TIMEOUT_MS) || 12 * 60 * 1000
  setTimeout(() => {
    if (!exited) {
      console.error(`[unit] Hard timeout (${HARD_TIMEOUT_MS / 1000}s) reached — killing test runner`)
      try { child.kill('SIGKILL') } catch { /* already dead */ }
    }
    process.exit(process.exitCode ?? 1)
  }, HARD_TIMEOUT_MS).unref()
}

main().catch((error) => {
  console.error('[unit] Failed to run unit tests:', error?.message || error)
  process.exitCode = 1
})
