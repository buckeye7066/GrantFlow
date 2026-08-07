import fs from 'node:fs'

function replaceOnce(path, before, after) {
  const source = fs.readFileSync(path, 'utf8')
  const first = source.indexOf(before)
  if (first === -1) throw new Error(`${path}: expected source block not found`)
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`${path}: expected source block is not unique`)
  }
  fs.writeFileSync(path, source.replace(before, after))
}

const safeFetchPath = 'backend/services/http/safeFetch.js'
const safeFetchSource = fs.readFileSync(safeFetchPath, 'utf8')
const functionStart = safeFetchSource.indexOf('export async function safeFetch(url, init = {}, opts = {}) {')
const functionEnd = safeFetchSource.indexOf('/**\n * Read a response body as text with a hard byte cap.', functionStart)
if (functionStart === -1 || functionEnd === -1) {
  throw new Error('safeFetch function boundaries were not found')
}

const safeFetchReplacement = `export async function safeFetch(url, init = {}, opts = {}) {
  const doFetch = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : nodeFetch
  const maxRedirects = Number.isFinite(opts.maxRedirects)
    ? Math.max(0, Math.trunc(opts.maxRedirects))
    : DEFAULT_MAX_REDIRECTS
  const timeoutMs = Number.isFinite(opts.timeoutMs)
    ? Math.max(1, Math.trunc(opts.timeoutMs))
    : DEFAULT_TIMEOUT_MS

  let currentUrl = String(url || '')
  let requestInit = { ...init }
  const visited = []
  // One lifetime covers DNS validation, every redirect hop, and the terminal
  // response. A caller's per-probe timeout must never reset at a redirect.
  const lifetime = createRequestLifetime(timeoutMs, [init.signal, opts.signal])

  try {
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const resolved = await assertEgressAllowed(currentUrl, { resolve: opts.resolve })
      currentUrl = resolved.url
      visited.push(currentUrl)

      const res = await doFetch(currentUrl, {
        ...requestInit,
        redirect: 'manual',
        signal: lifetime.signal,
        agent: createPinnedAgent(currentUrl, resolved),
      })

      if (!REDIRECT_STATUSES.has(res.status)) {
        try {
          Object.defineProperty(res, 'grantflowFinalUrl', { value: currentUrl, enumerable: false })
        } catch {
          // Non-fatal: some Response implementations freeze the object.
        }
        releaseWhenBodyFinishes(res, lifetime.release)
        return res
      }

      const location = res.headers?.get?.('location')
      if (!location) {
        // A 3xx with no Location is terminal; the caller owns its body.
        releaseWhenBodyFinishes(res, lifetime.release)
        return res
      }

      let nextUrl
      try {
        nextUrl = new URL(location, currentUrl).toString()
      } catch {
        await discardResponseBody(res)
        throw new SsrfBlockedError('unparseable_redirect', location)
      }

      await discardResponseBody(res)
      if (hop >= maxRedirects) {
        throw new SsrfBlockedError(\`too_many_redirects:\${visited.length}\`, visited[0])
      }
      requestInit = redirectRequestInit(requestInit, res.status, currentUrl, nextUrl)
      currentUrl = nextUrl
    }

    throw new SsrfBlockedError(\`too_many_redirects:\${visited.length}\`, visited[0])
  } catch (err) {
    lifetime.release()
    throw err
  }
}

`

fs.writeFileSync(
  safeFetchPath,
  `${safeFetchSource.slice(0, functionStart)}${safeFetchReplacement}${safeFetchSource.slice(functionEnd)}`,
)

replaceOnce(
  'backend/tests/safeFetchSsrf.test.js',
  `  it('aborts at the configured timeout', async () => {
    await expect(safeFetch(
      PUBLIC_URL,
      {},
      { fetchImpl: abortAwareFetch(), timeoutMs: 5 },
    )).rejects.toMatchObject({ name: 'AbortError' })
  })`,
  `  it('uses one end-to-end deadline across redirect hops', async () => {
    vi.useFakeTimers()
    const signals = []
    const fetchMock = vi.fn((_url, request = {}) => {
      signals.push(request.signal)
      if (signals.length === 1) {
        return new Promise((resolve) => {
          setTimeout(() => resolve(redirectTo('/second', {
            cancel: vi.fn().mockResolvedValue(undefined),
          })), 60)
        })
      }
      return new Promise((_resolve, reject) => {
        const rejectAbort = () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        }
        if (request.signal?.aborted) rejectAbort()
        else request.signal?.addEventListener('abort', rejectAbort, { once: true })
      })
    })

    try {
      const pending = safeFetch(
        PUBLIC_URL,
        {},
        { fetchImpl: fetchMock, timeoutMs: 100 },
      )
      const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })

      await vi.advanceTimersByTimeAsync(60)
      for (let attempt = 0; attempt < 10 && fetchMock.mock.calls.length < 2; attempt += 1) {
        await Promise.resolve()
      }

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(signals[1]).toBe(signals[0])
      await vi.advanceTimersByTimeAsync(39)
      expect(signals[1].aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await rejection
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts at the configured timeout', async () => {
    await expect(safeFetch(
      PUBLIC_URL,
      {},
      { fetchImpl: abortAwareFetch(), timeoutMs: 5 },
    )).rejects.toMatchObject({ name: 'AbortError' })
  })`,
)

console.log('Applied PR #1173 end-to-end redirect deadline fix')
