#!/usr/bin/env node
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { buildIsolatedTestEnv } from './test-environment.mjs'
import { assertLaneIntegrity } from './isolated-test-lanes.mjs'

const vitestEntry = path.resolve('node_modules', 'vitest', 'vitest.mjs')
const args = process.argv.slice(2)

// `vitest.config.js` sets `passWithNoTests: true`, so a name-prefix lane whose
// filters match nothing prints "No test files found, exiting with code 0" and
// EXITS 0 — a check that cannot fail. Before spawning Vitest, prove the lane
// this invocation describes still resolves to the suites it is supposed to run,
// and that the bulk lane's --exclude list and the serial lane's include filters
// still cover exactly the same files. See scripts/isolated-test-lanes.mjs.
const laneProblems = assertLaneIntegrity(args)
if (laneProblems.length > 0) {
  console.error('[vitest-isolated] REFUSING TO RUN — the requested test lane no longer describes reality:')
  for (const problem of laneProblems) console.error(`  - ${problem}`)
  console.error('')
  console.error('  Update scripts/isolated-test-lanes.mjs (and the matching package.json `unit` script)')
  console.error('  so the declared lane, its include filters, and its --exclude list all agree.')
  process.exit(2)
}
// Vercel's build sandbox can finish all test assertions while a parallel
// worker still has a console-log RPC in flight. Vitest then reports an
// EnvironmentTeardownError and turns an otherwise green release gate red.
// File-level serial execution is intentionally scoped to Vercel builds: the
// test process remains isolated everywhere, and local/CI runs retain their
// normal parallelism.
const hostedSerialArgs = process.env.VERCEL === '1' && !args.includes('--no-file-parallelism')
  ? ['--no-file-parallelism']
  : []
const env = buildIsolatedTestEnv(process.env, {
  GRANTFLOW_TEST_RUNNER: process.env.GRANTFLOW_TEST_RUNNER || '1',
})

const child = spawn(process.execPath, [vitestEntry, ...args, ...hostedSerialArgs], {
  stdio: 'inherit',
  env,
})

child.on('error', (error) => {
  console.error('[vitest-isolated] Failed to start Vitest:', error?.message || error)
  process.exitCode = 1
})

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[vitest-isolated] Vitest exited from signal ${signal}`)
    process.exitCode = 1
    return
  }
  process.exitCode = code ?? 1
})
