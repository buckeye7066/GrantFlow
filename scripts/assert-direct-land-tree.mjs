#!/usr/bin/env node
/**
 * assert-direct-land-tree.mjs
 *
 * Run by the anya-code-fix-pr workflow AFTER applying the patch + running the
 * gates, BEFORE committing. It asserts the working tree contains ONLY the files
 * the backend-validated patch declared (EXPECTED_PATHS, newline-separated) and
 * that none hit the critical-path denylist. Exits non-zero on any undeclared or
 * forbidden change, so exactly the verified diff can be committed — nothing more
 * (Sol HIGH #3: npm ci / gate steps must not smuggle extra files into a direct
 * land).
 *
 * The decision logic lives in anyaCodeFixDispatch.assertTreeMatchesDeclared
 * (pure, unit-tested); this wrapper only supplies real `git status` output.
 */
import { execFileSync } from 'node:child_process'
import { assertTreeMatchesDeclared } from '../backend/services/anyaCodeFixDispatch.js'

const expectedPaths = String(process.env.EXPECTED_PATHS || '')
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean)

if (expectedPaths.length === 0) {
  console.error('assert-direct-land-tree: EXPECTED_PATHS is empty — refusing (cannot bound the change).')
  process.exit(1)
}

let porcelain = ''
try {
  // Static args, no shell — no interpolation of any external input.
  porcelain = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
} catch (err) {
  console.error(`assert-direct-land-tree: could not read git status: ${err?.message || err}`)
  process.exit(1)
}

const result = assertTreeMatchesDeclared({ porcelain, expectedPaths })
if (!result.ok) {
  console.error(`assert-direct-land-tree: ${result.reason}`)
  console.error(`  declared: ${expectedPaths.join(', ')}`)
  console.error(`  changed:  ${result.changed.join(', ')}`)
  process.exit(1)
}

console.log(`assert-direct-land-tree: OK — only declared files changed (${result.changed.join(', ') || 'none'}).`)
