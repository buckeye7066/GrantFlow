import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveInternalSelfBaseUrl } from '../../backend/utils/internalSelfBaseUrl.js'

test('internal self base defaults to literal loopback without request authority', () => {
  const result = resolveInternalSelfBaseUrl({ configured: '', port: 8080 })
  assert.deepEqual(result, {
    ok: true,
    baseUrl: 'http://127.0.0.1:8080',
    reason: null,
    source: 'loopback_default',
  })
})

test('internal self base canonicalizes localhost before forwarding credentials', () => {
  const result = resolveInternalSelfBaseUrl({ configured: 'http://localhost:3911/' })
  assert.equal(result.ok, true)
  assert.equal(result.baseUrl, 'http://127.0.0.1:3911')
  assert.equal(result.source, 'configured')
})

test('internal self base rejects configured public origins even over HTTPS', () => {
  const result = resolveInternalSelfBaseUrl({ configured: 'https://attacker.example' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'internal_base_must_be_loopback')
})

test('internal self base rejects credentials, paths, and invalid ports', () => {
  assert.equal(
    resolveInternalSelfBaseUrl({ configured: 'http://user:secret@127.0.0.1:8080' }).reason,
    'invalid_internal_base_url',
  )
  assert.equal(
    resolveInternalSelfBaseUrl({ configured: 'http://127.0.0.1:8080/api' }).reason,
    'internal_base_path_not_allowed',
  )
  assert.equal(
    resolveInternalSelfBaseUrl({ configured: '', port: 0 }).reason,
    'invalid_internal_base_port',
  )
})
