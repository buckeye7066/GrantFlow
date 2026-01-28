import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * Standalone version of normalizeAuthenticatedApiPath for testing
 * This duplicates the logic from src/utils/authenticatedDownload.js
 */
function normalizeAuthenticatedApiPath(url) {
  if (!url) return null
  const urlStr = String(url).trim()
  if (!urlStr) return null

  try {
    // Handle absolute URLs
    if (urlStr.startsWith('http://') || urlStr.startsWith('https://')) {
      const parsed = new URL(urlStr)
      // Only normalize if it's our API
      if (parsed.pathname.includes('/api/')) {
        // Extract everything from /api/ onward
        const apiIndex = parsed.pathname.indexOf('/api/')
        if (apiIndex >= 0) {
          const normalizedPath = parsed.pathname.substring(apiIndex)
          return normalizedPath + parsed.search
        }
      }
      // External URL - return null to signal non-API
      return null
    }

    // Handle relative URLs
    // Remove leading slash for consistent processing
    let path = urlStr.startsWith('/') ? urlStr.substring(1) : urlStr
    
    // If it starts with api/ (no leading slash), add the slash
    if (path.startsWith('api/')) {
      return '/' + path
    }
    
    // If it contains base path like "grantflow/api/", extract from "/api/" onward
    if (path.includes('/api/')) {
      const apiIndex = path.indexOf('/api/')
      if (apiIndex >= 0) {
        return path.substring(apiIndex)
      }
    }
    
    // If it already starts with /api/, return as-is
    if (urlStr.startsWith('/api/')) {
      return urlStr
    }
    
    // Not an API path
    return null
  } catch {
    // Invalid URL format
    return null
  }
}

test('normalizeAuthenticatedApiPath: handles various URL formats', () => {
  // Test 1: Already normalized API path
  assert.equal(
    normalizeAuthenticatedApiPath('/api/profiles/123/avatar/download'),
    '/api/profiles/123/avatar/download'
  )

  // Test 2: Missing leading slash
  assert.equal(
    normalizeAuthenticatedApiPath('api/profiles/123/avatar/download'),
    '/api/profiles/123/avatar/download'
  )

  // Test 3: With base path prefix
  assert.equal(
    normalizeAuthenticatedApiPath('/grantflow/api/profiles/123/avatar/download'),
    '/api/profiles/123/avatar/download'
  )

  // Test 4: With query string
  assert.equal(
    normalizeAuthenticatedApiPath('/api/documents/download?id=abc123'),
    '/api/documents/download?id=abc123'
  )

  // Test 5: Base path with query string
  assert.equal(
    normalizeAuthenticatedApiPath('/grantflow/api/documents/download?id=abc123&format=pdf'),
    '/api/documents/download?id=abc123&format=pdf'
  )

  // Test 6: Absolute URL with base path
  assert.equal(
    normalizeAuthenticatedApiPath('https://example.com/grantflow/api/profiles/123/avatar/download'),
    '/api/profiles/123/avatar/download'
  )

  // Test 7: Absolute URL without base path
  assert.equal(
    normalizeAuthenticatedApiPath('https://example.com/api/documents/export'),
    '/api/documents/export'
  )

  // Test 8: External URL (not an API path)
  assert.equal(
    normalizeAuthenticatedApiPath('https://external.com/image.jpg'),
    null
  )

  // Test 9: Relative non-API path
  assert.equal(
    normalizeAuthenticatedApiPath('/public/logo.png'),
    null
  )

  // Test 10: Empty or invalid input
  assert.equal(normalizeAuthenticatedApiPath(''), null)
  assert.equal(normalizeAuthenticatedApiPath(null), null)
  assert.equal(normalizeAuthenticatedApiPath(undefined), null)
})

test('normalizeAuthenticatedApiPath: preserves query parameters', () => {
  const input = '/grantflow/api/export?profile=123&format=pdf&timestamp=1234567890'
  const expected = '/api/export?profile=123&format=pdf&timestamp=1234567890'
  assert.equal(normalizeAuthenticatedApiPath(input), expected)
})

test('normalizeAuthenticatedApiPath: handles edge cases', () => {
  // Multiple slashes
  assert.equal(
    normalizeAuthenticatedApiPath('//api/profiles/123'),
    '/api/profiles/123'
  )

  // Mixed case - API path must be lowercase '/api/' to be recognized
  // This is expected behavior since our backend uses lowercase '/api/'
  assert.equal(
    normalizeAuthenticatedApiPath('/API/Profiles/123'),
    null
  )

  // API in different positions - extracts from first /api/ occurrence
  assert.equal(
    normalizeAuthenticatedApiPath('/some/prefix/api/resource'),
    '/api/resource'
  )
})

