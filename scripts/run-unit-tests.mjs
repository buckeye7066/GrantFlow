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

  // Several files boot full backends or exercise native SQLite in child
  // processes. Four-way parallelism produced sporadic file-level exits on the
  // hosted 4-core builder even though the same suites passed alone. Two workers
  // retain useful parallelism while keeping native/process pressure bounded.
  const concurrencyRaw = process.env.UNIT_TEST_CONCURRENCY || process.env.TEST_CONCURRENCY || '2'
  const concurrency = Math.max(1, Number.parseInt(String(concurrencyRaw), 10) || 2)

  // Unit tests are hermetic. In hosted builds, inherited DATABASE_URL and
  // provider settings can otherwise redirect SQLite fixtures to production
  // services or alter feature behavior. Child tests can still opt into an
  // explicit production-shaped environment inside their own spawn calls.
  const testEnv = buildIsolatedTestEnv(process.env, {
    GRANTFLOW_TEST_RUNNER: process.env.GRANTFLOW_TEST_RUNNER || '1',
  })

  // Pass paths RELATIVE to `root` (and set cwd) instead of absolute ones.
  // Windows CreateProcess caps a command line at 32,767 characters, and this
  // suite is 354 files: measured 2026-08-14 from a git worktree whose root path
  // is 66 chars, the absolute-path argv is 39,252 chars and `spawn` throws
  // `ENAMETOOLONG` — so the ENTIRE node:test lane silently failed to run
  // anywhere except the short main checkout (~23.7k chars there, which is why
  // CI never saw it). The relative form of the same 354 files is 15,534 chars,
  // i.e. under half the limit and independent of how deep the checkout sits.
  // A test lane that cannot execute is not a passing test lane.
  const relativeTestFiles = testFiles.map((file) => path.relative(root, file))

  const child = spawn(process.execPath, ['--test', `--test-concurrency=${concurrency}`, ...relativeTestFiles], {
    stdio: 'inherit',
    env: testEnv,
    cwd: root,
  })

  let exited = false
  // Without this, a spawn failure emits an 'error' event with no listener.
  // Report it and FAIL — never let "the runner could not start" read as a pass.
  child.on('error', (error) => {
    exited = true
    console.error('[unit] Failed to start the node:test runner:', error?.message || error)
    process.exitCode = 1
  })
  child.on('exit', (code) => {
    exited = true
    process.exitCode = code ?? 1
  })

  // Test-spawned server processes may keep open handles that prevent
  // node --test from exiting. Keep a deadman switch, but size it for the
  // conservative two-worker suite. Callers can still override it explicitly.
  const HARD_TIMEOUT_MS = Number(process.env.UNIT_TEST_HARD_TIMEOUT_MS) || 18 * 60 * 1000
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
