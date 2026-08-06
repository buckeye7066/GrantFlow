import test from 'node:test'
import assert from 'node:assert/strict'
import {
  fetchPublicResource,
  fetchPublicText,
  publicFetchFailureStatus,
} from '../../backend/utils/safeRemoteFetch.js'

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

test('resource fetch pins the validated DNS answer into the transport', async () => {
  let observed = null
  const result = await fetchPublicResource('https://portal.example.org/file.pdf', {
    resolve: async () => ['8.8.8.8'],
    transport: async (url, options) => {
      observed = { url, options }
      return {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
        body: Buffer.from('%PDF-safe'),
      }
    },
    allowedContentTypes: ['application/pdf'],
  })

  assert.equal(result.ok, true)
  assert.equal(observed.url, 'https://portal.example.org/file.pdf')
  assert.equal(observed.options.address, '8.8.8.8')
  assert.equal(observed.options.family, 4)
})

test('resource fetch rejects mixed public and private DNS answers before transport', async () => {
  let called = false
  const result = await fetchPublicResource('https://portal.example.org/file.pdf', {
    resolve: async () => ['8.8.8.8', '10.0.0.7'],
    transport: async () => {
      called = true
      return { status: 200, headers: {}, body: Buffer.alloc(0) }
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'dns_resolves_private')
  assert.equal(called, false)
})

test('resource fetch revalidates redirect DNS and blocks private destinations', async () => {
  let calls = 0
  const result = await fetchPublicResource('https://portal.example.org/start', {
    resolve: async (host) => (host === 'portal.example.org' ? ['8.8.8.8'] : ['127.0.0.1']),
    transport: async () => {
      calls += 1
      return {
        status: 302,
        headers: { location: 'https://redirect.example.org/private' },
        body: Buffer.alloc(0),
      }
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'dns_resolves_private')
  assert.equal(calls, 1)
})

test('resource fetch enforces returned byte and content-type bounds defensively', async () => {
  const oversized = await fetchPublicResource('https://portal.example.org/file', {
    resolve: publicResolver,
    maxBytes: 4,
    transport: async () => ({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from('12345'),
    }),
  })
  assert.equal(oversized.reason, 'response_too_large')

  const unsupported = await fetchPublicResource('https://portal.example.org/file', {
    resolve: publicResolver,
    allowedContentTypes: ['application/pdf'],
    transport: async () => ({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: Buffer.from('<h1>not a PDF</h1>'),
    }),
  })
  assert.equal(unsupported.reason, 'unsupported_content_type')
})

test('resource fetch applies one wall-clock deadline across DNS and redirects', async () => {
  const result = await fetchPublicResource('https://portal.example.org/file', {
    timeoutMs: 5,
    resolve: async () => new Promise(() => {}),
    transport: async () => {
      throw new Error('transport must not run')
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'timeout')
})

test('resource fetch rejects malformed redirects without throwing', async () => {
  const result = await fetchPublicResource('https://portal.example.org/start', {
    resolve: publicResolver,
    transport: async () => ({
      status: 302,
      headers: { location: 'https://[not-an-ip' },
      body: Buffer.alloc(0),
    }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'invalid_redirect_location')
})

test('resource fetch bounds a hanging injected transport', async () => {
  const result = await fetchPublicResource('https://portal.example.org/file', {
    timeoutMs: 5,
    resolve: publicResolver,
    transport: async () => new Promise(() => {}),
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'timeout')
})

test('remote failure reasons map to honest HTTP statuses', () => {
  assert.equal(publicFetchFailureStatus({ reason: 'private_host' }), 400)
  assert.equal(publicFetchFailureStatus({ reason: 'response_too_large' }), 413)
  assert.equal(publicFetchFailureStatus({ reason: 'unsupported_content_type' }), 415)
  assert.equal(publicFetchFailureStatus({ reason: 'fetch_failed' }), 502)
  assert.equal(publicFetchFailureStatus({ reason: 'timeout' }), 504)
  assert.equal(publicFetchFailureStatus({ reason: 'http_error', status: 403 }), 403)
})
