#!/usr/bin/env node
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { buildIsolatedTestEnv } from './test-environment.mjs'

const vitestEntry = path.resolve('node_modules', 'vitest', 'vitest.mjs')
const args = process.argv.slice(2)
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
