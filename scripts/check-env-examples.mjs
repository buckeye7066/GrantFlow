#!/usr/bin/env node
/**
 * check-env-examples.mjs
 *
 * Re-runs the env-example generator in-memory and asserts the output
 * matches the checked-in `.env.example` and `backend/.env.example`.
 *
 * Why: those files are auto-generated from runtime env-variable
 * references (process.env[NAME] / import.meta.env) in the codebase.
 * Whenever a new
 * env var is introduced without re-running the generator, the
 * checked-in templates silently lag and contributors copy a stale
 * file as their `.env`. Mission rule: 'Any new logic must be:
 * traceable, logged (lightweight), reversible.' An undocumented env
 * var is the opposite of traceable.
 *
 * Exits 0 on match, 1 on drift. CI / pre-push should call:
 *   npm run check:env-examples
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

const { buildOutputs } = await import('./generate-env-examples.mjs')

const expected = buildOutputs()
const actualRoot = fs.existsSync(path.join(repoRoot, '.env.example'))
  ? fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8')
  : ''
const actualBackend = fs.existsSync(path.join(repoRoot, 'backend', '.env.example'))
  ? fs.readFileSync(path.join(repoRoot, 'backend', '.env.example'), 'utf8')
  : ''

const drifts = []
if (normalize(actualRoot) !== normalize(expected.rootEnvExample)) {
  drifts.push({ path: '.env.example', expectedBytes: expected.rootEnvExample.length, actualBytes: actualRoot.length })
}
if (normalize(actualBackend) !== normalize(expected.backendEnvExample)) {
  drifts.push({ path: 'backend/.env.example', expectedBytes: expected.backendEnvExample.length, actualBytes: actualBackend.length })
}

if (drifts.length === 0) {
  console.log('[check:env-examples] OK — checked-in env examples match generator output')
  process.exit(0)
}

console.error('[check:env-examples] DRIFT — run `node scripts/generate-env-examples.mjs` and commit the result')
for (const d of drifts) {
  console.error(`  - ${d.path}: actual=${d.actualBytes} bytes, expected=${d.expectedBytes} bytes`)
}
console.error('')
console.error('First 10 differing lines per file:')
for (const d of drifts) {
  const exp = d.path === '.env.example' ? expected.rootEnvExample : expected.backendEnvExample
  const act = d.path === '.env.example' ? actualRoot : actualBackend
  const expLines = exp.split(/\r?\n/)
  const actLines = act.split(/\r?\n/)
  const max = Math.max(expLines.length, actLines.length)
  let shown = 0
  console.error(`  --- ${d.path} ---`)
  for (let i = 0; i < max && shown < 10; i += 1) {
    if (expLines[i] !== actLines[i]) {
      console.error(`    line ${i + 1}:`)
      console.error(`      actual:   ${actLines[i] ?? '(missing)'}`)
      console.error(`      expected: ${expLines[i] ?? '(missing)'}`)
      shown += 1
    }
  }
}
process.exit(1)

// Normalise CRLF / trailing whitespace so a Windows checkout that
// normalised the line endings doesn't false-positive on a Linux CI.
function normalize(s) {
  return String(s || '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim()
}
