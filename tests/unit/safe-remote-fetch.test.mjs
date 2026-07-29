import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchPublicText } from '../../backend/utils/safeRemoteFetch.js'

const publicResolver = async () => ['8.8.8.8']

test('safe remote fetch blocks loopback before network access', async () => {
  let called = false
  const result = await fetchPublicText('https://127.0.0.1/private', {
    fetchImpl: async () => { called = true },
    resolve: publicResolver,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'private_host')
  assert.equal(called, false)
})

test('safe remote fetch blocks DNS rebinding to private space', async () => {
  let called = false
  const result = await fetchPublicText('https://portal.example.org/apply', {
    fetchImpl: async () => { called = true },
    resolve: async () => ['10.0.0.7'],
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'dns_resolves_private')
  assert.equal(called, false)
})

test('safe remote fetch revalidates redirect destinations', async () => {
  const result = await fetchPublicText('https://portal.example.org/start', {
    resolve: publicResolver,
    fetchImpl: async () => new Response('', {
      status: 302,
      headers: { location: 'https://169.254.169.254/latest/meta-data' },
    }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'private_host')
})

test('safe remote fetch enforces content type and byte limits', async () => {
  const unsupported = await fetchPublicText('https://portal.example.org/file', {
    resolve: publicResolver,
    fetchImpl: async () => new Response('binary', {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    }),
  })
  assert.equal(unsupported.reason, 'unsupported_content_type')

  const oversized = await fetchPublicText('https://portal.example.org/large', {
    resolve: publicResolver,
    maxBytes: 4,
    fetchImpl: async () => new Response('12345', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
  })
  assert.equal(oversized.reason, 'response_too_large')
})

test('safe remote fetch returns bounded public HTML', async () => {
  const result = await fetchPublicText('https://portal.example.org/apply', {
    resolve: publicResolver,
    fetchImpl: async (_url, init) => {
      assert.equal(init.redirect, 'manual')
      assert.equal(init.headers.Authorization, undefined)
      assert.equal(init.headers.Cookie, undefined)
      return new Response('<h1>Apply</h1>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.body, '<h1>Apply</h1>')
})
