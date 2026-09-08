import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFailureLogs } from '../src/adapters/web.mjs'

test('every console/network reference names an existing redacted evidence file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eva-evidence-'))
  try {
    const refs = writeFailureLogs(dir, 'login', {
      consoleErrors: ['Authorization: Bearer sensitive-test-value'],
      failedRequests: ['GET https://example.test/api?token=sensitive-test-value'],
    })
    assert.equal(refs.length, 2)
    for (const ref of refs) {
      const text = readFileSync(join(dir, ref.ref), 'utf8')
      assert.ok(text.includes('[REDACTED]'))
      assert.ok(!text.includes('sensitive-test-value'))
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('missing capture directories and unsafe names never publish phantom references', () => {
  const ctx = { consoleErrors: ['a real error'] }
  assert.deepEqual(writeFailureLogs(null, 'login', ctx), [])
  assert.deepEqual(writeFailureLogs('/nonexistent/eva/evidence', 'login', ctx), [])
  assert.deepEqual(writeFailureLogs(tmpdir(), '../escape', ctx), [])
})
