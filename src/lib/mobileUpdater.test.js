import { describe, expect, it } from 'vitest'

import {
  compareVersions,
  fetchUpdateManifest,
  isNewerVersion,
  parseUpdateManifest,
  parseVersion,
  resolveFeedUrl,
  FEED_URL_OVERRIDE_KEY,
  UPDATE_BASE_URL,
} from './mobileUpdater.js'

describe('parseVersion', () => {
  it('parses dotted numeric versions', () => {
    expect(parseVersion('1.0.1')).toEqual([1, 0, 1])
    expect(parseVersion('v2.10')).toEqual([2, 10])
    expect(parseVersion('1.0.0-beta.1')).toEqual([1, 0, 0])
  })

  it('returns null for non-versions (capgo "builtin", junk, non-strings)', () => {
    expect(parseVersion('builtin')).toBeNull()
    expect(parseVersion('')).toBeNull()
    expect(parseVersion(undefined)).toBeNull()
    expect(parseVersion('1.x.2')).toBeNull()
  })
})

describe('compareVersions / isNewerVersion', () => {
  it('orders versions numerically, not lexically', () => {
    expect(compareVersions('1.0.10', '1.0.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.1', '1.0.1')).toBe(0)
    expect(compareVersions('1.0.1', '1.1.0')).toBeLessThan(0)
  })

  it('treats missing parts as zero', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.1', '1.0')).toBeGreaterThan(0)
  })

  it('is strict: equal or unparseable versions are never "newer"', () => {
    expect(isNewerVersion('1.0.1', '1.0.1')).toBe(false)
    expect(isNewerVersion('builtin', '1.0.1')).toBe(false)
    expect(isNewerVersion('1.0.2', 'builtin')).toBe(false)
    expect(isNewerVersion('1.0.2', '1.0.1')).toBe(true)
  })
})

describe('parseUpdateManifest', () => {
  it('accepts a valid manifest and normalizes optional fields', () => {
    const m = parseUpdateManifest({ version: '1.0.2', url: 'https://axiombiolabs.org/mobile/bundle-1.0.2.zip' })
    expect(m).toEqual({
      version: '1.0.2',
      url: 'https://axiombiolabs.org/mobile/bundle-1.0.2.zip',
      notes: '',
      builtAt: '',
    })
  })

  it('rejects non-objects (the SPA-fallback HTML case) with an honest message', () => {
    expect(() => parseUpdateManifest(null)).toThrow(/not available yet/)
    expect(() => parseUpdateManifest('<!doctype html>')).toThrow(/not available yet/)
  })

  it('rejects bad versions and non-https URLs', () => {
    expect(() => parseUpdateManifest({ version: 'builtin', url: 'https://x/y.zip' })).toThrow(/invalid version/)
    expect(() => parseUpdateManifest({ version: '1.0.2', url: 'http://x/y.zip' })).toThrow(/absolute https/)
  })
})

describe('resolveFeedUrl', () => {
  it('defaults to the production feed', () => {
    expect(resolveFeedUrl({ localStorage: { getItem: () => null } })).toBe(`${UPDATE_BASE_URL}/mobile/latest.json`)
  })

  it('honors an explicit override URL', () => {
    const ls = { getItem: (k) => (k === FEED_URL_OVERRIDE_KEY ? 'http://localhost:8123/mobile/latest.json' : null) }
    expect(resolveFeedUrl({ localStorage: ls })).toBe('http://localhost:8123/mobile/latest.json')
  })
})

describe('fetchUpdateManifest', () => {
  it('fetches with no-store and a cache-busting param, and validates the body', async () => {
    let seenUrl = null
    let seenInit = null
    const fetchImpl = async (url, init) => {
      seenUrl = url
      seenInit = init
      return {
        ok: true,
        status: 200,
        json: async () => ({ version: '9.9.9', url: 'https://axiombiolabs.org/mobile/bundle-9.9.9.zip', notes: 'n', builtAt: 'b' }),
      }
    }
    const manifest = await fetchUpdateManifest({ fetchImpl, feedUrl: 'https://example.test/mobile/latest.json' })
    expect(manifest.version).toBe('9.9.9')
    expect(seenUrl).toMatch(/^https:\/\/example\.test\/mobile\/latest\.json\?ts=\d+$/)
    expect(seenInit).toEqual({ cache: 'no-store' })
  })

  it('reports HTTP failures with the status code', async () => {
    const fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}) })
    await expect(fetchUpdateManifest({ fetchImpl, feedUrl: 'https://example.test/latest.json' })).rejects.toThrow(/HTTP 404/)
  })

  it('reports network failure honestly', async () => {
    const fetchImpl = async () => {
      throw new TypeError('Failed to fetch')
    }
    await expect(fetchUpdateManifest({ fetchImpl, feedUrl: 'https://example.test/latest.json' })).rejects.toThrow(/Could not reach/)
  })

  it('reports an HTML body (SPA fallback) as "feed not available yet"', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <')
      },
    })
    await expect(fetchUpdateManifest({ fetchImpl, feedUrl: 'https://example.test/latest.json' })).rejects.toThrow(/not available yet/)
  })
})
