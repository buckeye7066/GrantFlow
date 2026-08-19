import { describe, expect, it } from 'vitest'

import {
  compareVersions,
  downloadAndApplyUpdate,
  fetchUpdateManifest,
  isNewerVersion,
  parseUpdateManifest,
  parseVersion,
  requireVerifiableBundle,
  requiresNativeUpdate,
  resolveFeedUrl,
  FEED_URL_OVERRIDE_KEY,
  UPDATE_BASE_URL,
  UPDATE_MANIFEST_TIMEOUT_MS,
} from './mobileUpdater.js'

/** A syntactically valid lowercase-hex sha256 for fixtures. */
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

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
      sha256: '',
      minNativeVersion: '',
      notes: '',
      builtAt: '',
    })
  })

  it('normalizes a published sha256 to lowercase hex', () => {
    const m = parseUpdateManifest({
      version: '1.0.2',
      url: 'https://axiombiolabs.org/mobile/b.zip',
      sha256: `  ${SHA_A.toUpperCase()}  `,
    })
    expect(m.sha256).toBe(SHA_A)
  })

  it('rejects a malformed sha256 rather than forwarding it to the native plugin', () => {
    const base = { version: '1.0.2', url: 'https://axiombiolabs.org/mobile/b.zip' }
    expect(() => parseUpdateManifest({ ...base, sha256: 'deadbeef' })).toThrow(/invalid bundle checksum/)
    expect(() => parseUpdateManifest({ ...base, sha256: 'z'.repeat(64) })).toThrow(/invalid bundle checksum/)
    expect(() => parseUpdateManifest({ ...base, sha256: 123 })).toThrow(/invalid bundle checksum/)
  })

  it('carries and validates minNativeVersion', () => {
    const base = { version: '1.0.2', url: 'https://axiombiolabs.org/mobile/b.zip' }
    expect(parseUpdateManifest({ ...base, minNativeVersion: '1.2' }).minNativeVersion).toBe('1.2')
    expect(() => parseUpdateManifest({ ...base, minNativeVersion: 'latest' })).toThrow(/invalid minimum app version/)
  })

  it('treats an EMPTY optional field as "not declared", not as malformed', () => {
    const base = { version: '1.0.2', url: 'https://axiombiolabs.org/mobile/b.zip' }
    const m = parseUpdateManifest({ ...base, sha256: '', minNativeVersion: '' })
    expect(m.sha256).toBe('')
    expect(m.minNativeVersion).toBe('')
    // …and an undeclared checksum is still refused at APPLY time, not parse time.
    expect(() => requireVerifiableBundle(m)).toThrow(/no published checksum/)
  })

  it('rejects non-objects (the SPA-fallback HTML case) with an honest message', () => {
    expect(() => parseUpdateManifest(null)).toThrow(/not available yet/)
    expect(() => parseUpdateManifest('<!doctype html>')).toThrow(/not available yet/)
  })

  it('rejects bad versions and non-https URLs', () => {
    expect(() => parseUpdateManifest({ version: 'builtin', url: 'https://x/y.zip' })).toThrow(/invalid version/)
    expect(() => parseUpdateManifest({ version: '1.0.2', url: 'http://x/y.zip' })).toThrow(/absolute https/)
    expect(() => parseUpdateManifest({ version: '1.0.2', url: 'https://' })).toThrow(/absolute https/)
  })
})

describe('resolveFeedUrl', () => {
  it('defaults to the production feed', () => {
    expect(resolveFeedUrl({ localStorage: { getItem: () => null } })).toBe(`${UPDATE_BASE_URL}/mobile/latest.json`)
  })

  it('honors an explicit override URL in a DEV build only', () => {
    const ls = { getItem: (k) => (k === FEED_URL_OVERRIDE_KEY ? 'http://localhost:8123/mobile/latest.json' : null) }
    expect(resolveFeedUrl({ localStorage: ls, isDev: true })).toBe('http://localhost:8123/mobile/latest.json')
  })

  // SECURITY REGRESSION GUARD: anything that can write localStorage (XSS, a
  // hostile deep link, a third-party script) must NOT be able to repoint the
  // native updater at a foreign bundle host in a shipped app.
  it('IGNORES the localStorage override in a production build (feed origin is pinned)', () => {
    const hostile = { getItem: () => 'https://evil.example/mobile/latest.json' }
    expect(resolveFeedUrl({ localStorage: hostile, isDev: false })).toBe(`${UPDATE_BASE_URL}/mobile/latest.json`)
  })

  it('never returns a non-pinned origin for any override value in production', () => {
    for (const value of [
      'http://127.0.0.1:9/latest.json',
      'https://axiombiolabs.org.evil.example/mobile/latest.json',
      'https://evil.example/x.json',
    ]) {
      expect(resolveFeedUrl({ localStorage: { getItem: () => value }, isDev: false })).toBe(
        `${UPDATE_BASE_URL}/mobile/latest.json`,
      )
    }
  })

  // Proves the default `isDev` really reads import.meta.env.DEV rather than
  // being hard-coded: vitest runs with DEV === true, so the override applies.
  it('defaults its dev decision to import.meta.env.DEV', () => {
    const ls = { getItem: () => 'https://override.example/latest.json' }
    const expected = import.meta.env.DEV
      ? 'https://override.example/latest.json'
      : `${UPDATE_BASE_URL}/mobile/latest.json`
    expect(resolveFeedUrl({ localStorage: ls })).toBe(expected)
  })
})

describe('requiresNativeUpdate', () => {
  it('is true only when the bundle demands a newer NATIVE app than the one installed', () => {
    expect(requiresNativeUpdate({ minNativeVersion: '1.2' }, '1.1')).toBe(true)
    expect(requiresNativeUpdate({ minNativeVersion: '1.2' }, '1.2')).toBe(false)
    expect(requiresNativeUpdate({ minNativeVersion: '1.2' }, '2.0')).toBe(false)
  })

  it('never blocks an update on an unstated or unparseable floor', () => {
    expect(requiresNativeUpdate({}, '1.1')).toBe(false)
    expect(requiresNativeUpdate({ minNativeVersion: '' }, '1.1')).toBe(false)
    expect(requiresNativeUpdate({ minNativeVersion: '1.2' }, '')).toBe(false)
    expect(requiresNativeUpdate(null, '1.1')).toBe(false)
  })
})

describe('requireVerifiableBundle (fail closed)', () => {
  it('returns the normalized digest for a well-formed manifest', () => {
    expect(requireVerifiableBundle({ sha256: SHA_A.toUpperCase() })).toBe(SHA_A)
  })

  it('refuses a bundle with no published checksum', () => {
    expect(() => requireVerifiableBundle({})).toThrow(/no published checksum/)
    expect(() => requireVerifiableBundle({ sha256: '' })).toThrow(/no published checksum/)
    expect(() => requireVerifiableBundle({ sha256: 'not-a-digest' })).toThrow(/no published checksum/)
  })
})

describe('downloadAndApplyUpdate', () => {
  const manifest = { version: '1.0.2', url: 'https://axiombiolabs.org/mobile/bundle-1.0.2.zip', sha256: SHA_A }

  function makeUpdater(overrides = {}) {
    const calls = { download: [], set: [] }
    return {
      calls,
      updater: {
        download: async (opts) => {
          calls.download.push(opts)
          return { id: 'bundle-id', version: opts.version }
        },
        set: async (bundle) => {
          calls.set.push(bundle)
        },
        ...overrides,
      },
    }
  }

  it('passes the published sha256 to the plugin as `checksum` so the zip is verified', async () => {
    const { calls, updater } = makeUpdater()
    await downloadAndApplyUpdate({ manifest, updater })
    expect(calls.download).toEqual([{ url: manifest.url, version: '1.0.2', checksum: SHA_A }])
    expect(calls.set).toEqual([{ id: 'bundle-id', version: '1.0.2' }])
  })

  // FAIL CLOSED: the plugin only verifies when a checksum is supplied, so a
  // manifest without one must never reach download()/set().
  it('REFUSES to download or apply a bundle with no checksum', async () => {
    const { calls, updater } = makeUpdater()
    await expect(
      downloadAndApplyUpdate({ manifest: { version: '1.0.2', url: manifest.url }, updater }),
    ).rejects.toThrow(/no published checksum/)
    expect(calls.download).toEqual([])
    expect(calls.set).toEqual([])
  })

  // The native plugin throws on a digest mismatch (Android CapgoUpdater
  // "Checksum failed", iOS ObjectSavableError.checksum). We must surface that
  // and never fall through to set().
  it('does NOT apply the bundle when the plugin reports a checksum mismatch', async () => {
    const { calls, updater } = makeUpdater({
      download: async () => {
        throw new Error('Checksum failed: bundle-id')
      },
    })
    await expect(downloadAndApplyUpdate({ manifest, updater })).rejects.toThrow(/Checksum failed/)
    expect(calls.set).toEqual([])
  })

  it('reports download progress and always removes its listener', async () => {
    let removed = false
    const seen = []
    const { updater } = makeUpdater({
      addListener: async (_event, cb) => {
        cb({ percent: 42 })
        return { remove: () => { removed = true } }
      },
    })
    await downloadAndApplyUpdate({ manifest, updater, onProgress: (p) => seen.push(p) })
    expect(seen).toEqual([42])
    expect(removed).toBe(true)
  })

  it('removes its listener even when the download fails', async () => {
    let removed = false
    const { updater } = makeUpdater({
      addListener: async () => ({ remove: () => { removed = true } }),
      download: async () => {
        throw new Error('Checksum failed: bundle-id')
      },
    })
    await expect(
      downloadAndApplyUpdate({ manifest, updater, onProgress: () => {} }),
    ).rejects.toThrow(/Checksum failed/)
    expect(removed).toBe(true)
  })

  it('is the only apply path — a differing digest still produces a different checksum argument', async () => {
    const { calls, updater } = makeUpdater()
    await downloadAndApplyUpdate({ manifest: { ...manifest, sha256: SHA_B }, updater })
    expect(calls.download[0].checksum).toBe(SHA_B)
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
    expect(seenInit.cache).toBe('no-store')
    expect(seenInit.signal).toBeInstanceOf(AbortSignal)
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

  it('aborts a stalled check and gives the user a clear timeout message', async () => {
    let receivedSignal
    const fetchImpl = (_url, init) => {
      receivedSignal = init.signal
      return new Promise(() => {})
    }
    await expect(fetchUpdateManifest({
      fetchImpl,
      feedUrl: 'https://example.test/latest.json',
      timeoutMs: 1,
    })).rejects.toThrow(/timed out/)
    expect(receivedSignal.aborted).toBe(true)
  })

  it('exposes a finite default timeout', () => {
    expect(UPDATE_MANIFEST_TIMEOUT_MS).toBeGreaterThan(0)
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
