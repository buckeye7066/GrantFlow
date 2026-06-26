#!/usr/bin/env node
/**
 * crawler:smoke
 *
 * Retained command name for operator muscle memory. It now runs the Crawler OS
 * deterministic doctor instead of the retired National Crawler V2 smoke path.
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'

const repoRoot = path.resolve(process.cwd())
const doctorPath = path.join(repoRoot, 'backend', 'crawler-os', 'scripts', 'doctor.mjs')

const result = spawnSync(process.execPath, [doctorPath], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: process.env,
})

if (result.error) {
  console.error('[crawler:smoke] FAILED', result.error.message)
  process.exit(1)
}

process.exit(result.status ?? 1)
