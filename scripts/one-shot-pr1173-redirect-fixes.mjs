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

replaceOnce(
  'backend/services/http/safeFetch.js',
  `  return new Agent({
    keepAlive: false,
    lookup,
    ...(parsed.protocol === 'https:' ? { servername: resolved.host } : {}),
  })
}

/**
 * Merge cancellation signals`,
  `  const tlsIdentity =
    parsed.protocol === 'https:' && net.isIP(resolved.host) === 0
      ? { servername: resolved.host }
      : {}

  return new Agent({
    keepAlive: false,
    lookup,
    ...tlsIdentity,
  })
}

function redirectRequestInit(init, status, fromUrl, toUrl) {
  const next = { ...init }
  const method = String(next.method || 'GET').toUpperCase()
  const switchToGet =
    (status === 303 && method !== 'GET' && method !== 'HEAD') ||
    ((status === 301 || status === 302) && method === 'POST')

  const headers = new Headers(next.headers || {})
  if (switchToGet) {
    next.method = 'GET'
    delete next.body
    headers.delete('content-length')
    headers.delete('content-type')
    headers.delete('content-encoding')
    headers.delete('transfer-encoding')
  }

  if (new URL(fromUrl).origin !== new URL(toUrl).origin) {
    headers.delete('authorization')
    headers.delete('cookie')
    headers.delete('proxy-authorization')
  }

  next.headers = Object.fromEntries(headers.entries())
  return next
}

/**
 * Merge cancellation signals`,
)

replaceOnce(
  'backend/services/http/safeFetch.js',
  `  let currentUrl = String(url || '')
  const visited = []`,
  `  let currentUrl = String(url || '')
  let requestInit = { ...init }
  const visited = []`,
)
replaceOnce(
  'backend/services/http/safeFetch.js',
  `      res = await doFetch(currentUrl, {
        ...init,`,
  `      res = await doFetch(currentUrl, {
        ...requestInit,`,
)
replaceOnce(
  'backend/services/http/safeFetch.js',
  `    if (hop >= maxRedirects) {
      throw new SsrfBlockedError(\`too_many_redirects:\${visited.length}\`, visited[0])
    }
    currentUrl = nextUrl`,
  `    if (hop >= maxRedirects) {
      throw new SsrfBlockedError(\`too_many_redirects:\${visited.length}\`, visited[0])
    }
    requestInit = redirectRequestInit(requestInit, res.status, currentUrl, nextUrl)
    currentUrl = nextUrl`,
)

replaceOnce(
  'backend/tests/safeFetchSsrf.test.js',
  `  it('follows a redirect to another public host and returns the final response', async () => {`,
  `  it('converts POST to GET on a 303 and removes body headers', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        status: 303,
        headers: { get: (name) => name.toLowerCase() === 'location' ? '/complete' : null },
        body: { cancel: vi.fn().mockResolvedValue(undefined) },
      })
      .mockResolvedValueOnce(new Response('done', { status: 200 }))

    await safeFetch(PUBLIC_URL, {
      method: 'POST',
      body: 'secret=form',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': '11',
        accept: 'text/plain',
      },
    }, { fetchImpl: fetchMock })

    const secondInit = fetchMock.mock.calls[1][1]
    expect(secondInit.method).toBe('GET')
    expect(secondInit.body).toBeUndefined()
    expect(secondInit.headers['content-type']).toBeUndefined()
    expect(secondInit.headers['content-length']).toBeUndefined()
    expect(secondInit.headers.accept).toBe('text/plain')
  })

  it('strips credentials on a cross-origin redirect', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(redirectTo('http://93.184.216.35/next'))
      .mockResolvedValueOnce(new Response('done', { status: 200 }))

    await safeFetch(PUBLIC_URL, {
      headers: {
        Authorization: 'Bearer should-not-cross-origins',
        Cookie: 'session=should-not-cross-origins',
        Accept: 'text/html',
      },
    }, { fetchImpl: fetchMock })

    const secondHeaders = fetchMock.mock.calls[1][1].headers
    expect(secondHeaders.authorization).toBeUndefined()
    expect(secondHeaders.cookie).toBeUndefined()
    expect(secondHeaders.accept).toBe('text/html')
  })

  it('preserves credentials on a same-origin redirect', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(redirectTo('/next'))
      .mockResolvedValueOnce(new Response('done', { status: 200 }))

    await safeFetch(PUBLIC_URL, {
      headers: {
        Authorization: 'Bearer same-origin',
        Cookie: 'session=same-origin',
      },
    }, { fetchImpl: fetchMock })

    const secondHeaders = fetchMock.mock.calls[1][1].headers
    expect(secondHeaders.authorization).toBe('Bearer same-origin')
    expect(secondHeaders.cookie).toBe('session=same-origin')
  })

  it('follows a redirect to another public host and returns the final response', async () => {`,
)
replaceOnce(
  'backend/tests/safeFetchSsrf.test.js',
  `  it('pins the policy-approved DNS answer into the transport agent', async () => {`,
  `  it('omits TLS servername for an IP-literal URL', async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      expect(init.agent.options.servername).toBeUndefined()
      return new Response('ok', { status: 200 })
    })

    await safeFetch('https://93.184.216.34/start', {}, { fetchImpl: fetchMock })
  })

  it('keeps the original DNS hostname as TLS servername', async () => {
    const resolve = vi.fn().mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ])
    const fetchMock = vi.fn(async (_url, init) => {
      expect(init.agent.options.servername).toBe('tls.example')
      return new Response('ok', { status: 200 })
    })

    await safeFetch('https://tls.example/start', {}, { fetchImpl: fetchMock, resolve })
  })

  it('pins the policy-approved DNS answer into the transport agent', async () => {`,
)

console.log('Applied PR #1173 redirect and SNI review fixes')
