#!/usr/bin/env node
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { buildIsolatedTestEnv } from './test-environment.mjs'

const vitestEntry = path.resolve('node_modules', 'vitest', 'vitest.mjs')
const args = process.argv.slice(2)
const env = buildIsolatedTestEnv(process.env, {
  GRANTFLOW_TEST_RUNNER: process.env.GRANTFLOW_TEST_RUNNER || '1',
})

const child = spawn(process.execPath, [vitestEntry, ...args], {
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
