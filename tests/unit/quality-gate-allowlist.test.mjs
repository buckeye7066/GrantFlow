/**
 * Quality-gate allowlist integrity tests.
 *
 * Verifies that `codeQualityGate.allowlist.json`:
 *  1. Is valid JSON (no parse errors)
 *  2. Contains no wildcard `*` patterns that would silently bypass real checks
 *  3. References only real files that exist in the repository
 *
 * A regression here would cause CI to silently skip real checks, hiding
 * quality issues from PRs.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '../..')
const ALLOWLIST_PATH = path.join(ROOT, 'codeQualityGate.allowlist.json')

// ---------------------------------------------------------------------------
// Parse once for all tests
// ---------------------------------------------------------------------------

let parsed
try {
  parsed = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'))
} catch {
  // Let the first test surface the error
}

test('codeQualityGate.allowlist.json exists', () => {
  assert.ok(fs.existsSync(ALLOWLIST_PATH), 'allowlist file must exist at repo root')
})

test('codeQualityGate.allowlist.json is valid JSON', () => {
  const content = fs.readFileSync(ALLOWLIST_PATH, 'utf8')
  assert.doesNotThrow(() => JSON.parse(content), 'allowlist must be parseable JSON')
})

test('allowlist parses to a non-empty object', () => {
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'allowlist should be a JSON object')
  assert.ok(Object.keys(parsed).length > 0, 'allowlist should have at least one key')
})

test('allowlist entries contain no wildcard * patterns', () => {
  for (const [key, value] of Object.entries(parsed)) {
    if (!Array.isArray(value)) continue
    for (const entry of value) {
      assert.ok(
        typeof entry === 'string' && !entry.includes('*'),
        `allowlist["${key}"] must not contain wildcard patterns, found: ${JSON.stringify(entry)}`,
      )
    }
  }
})

test('all allowlist file-path entries reference real files that exist', () => {
  const missing = []
  for (const [key, value] of Object.entries(parsed)) {
    if (!Array.isArray(value)) continue
    for (const entry of value) {
      if (typeof entry !== 'string' || !entry) continue
      const abs = path.join(ROOT, entry)
      if (!fs.existsSync(abs)) {
        missing.push(`allowlist["${key}"]: ${entry}`)
      }
    }
  }
  assert.deepStrictEqual(
    missing,
    [],
    `The following allowlist entries reference files that do not exist:\n  ${missing.join('\n  ')}`,
  )
})
