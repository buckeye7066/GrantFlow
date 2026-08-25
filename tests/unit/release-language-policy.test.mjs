import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scanner = path.join(root, 'scripts/check-release-language.py')

function runPolicy(...args) {
  return spawnSync('python3', [scanner, ...args], {
    cwd: root,
    encoding: 'utf8',
  })
}

test('delivery-language probes cover wrapping, rendered JSX boundaries, and literal concatenation', () => {
  const result = runPolicy('--self-test')
  assert.equal(result.status, 0, result.stderr || result.stdout)
})

test('the complete tracked tree satisfies the delivery-language policy', () => {
  const result = runPolicy()
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
