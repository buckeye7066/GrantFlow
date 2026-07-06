import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { processAvatarLookupJob, extractProfileWebsite } from '../../backend/services/avatarCrawler.js'

// Enable localhost fetch for this test (SSRF guard).
process.env.NODE_ENV = 'test'

function startSiteServer() {
  const png = Buffer.from(
    // 1x1 transparent PNG
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+8iUQAAAAASUVORK5CYII=',
    'base64',
  )

  const server = http.createServer((req, res) => {
    if (req.url === '/cover.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' })
      res.end(png)
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html>
<html>
  <head>
    <meta property="og:image" content="/cover.png" />
    <meta name="twitter:image" content="/cover.png" />
  </head>
  <body>hello</body>
</html>`)
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({ server, port: addr.port })
    })
  })
}

test('avatar lookup prefers website og:image when present', async () => {
  const { server, port } = await startSiteServer()
  const uploadDir = mkdtempSync(path.join(tmpdir(), 'grantflow-avatar-test-'))

  try {
    const profileContext = {
      profile: { id: 'p1', display_name: 'Example Org', primary_type: 'organization' },
      sections: {
        basic_information: {
          website: `http://127.0.0.1:${port}/`,
        },
      },
    }

    const result = await processAvatarLookupJob({
      profileContext,
      uploadDir,
      getOpenAI: () => null, // force website path
    })

    assert.equal(result?.inserted, 1)
    assert.ok(result?.avatarUrl)
    assert.ok(result.avatarUrl.startsWith('/uploads/'))
    assert.equal(result?.result_meta?.method, 'website_cover')
    assert.ok(result?.result_meta?.website_used)
    assert.ok(result?.result_meta?.image_url_used)
    // Durable persistence (Railway ephemeral-disk fix, 2026-07-06): the job
    // result MUST carry the raw bytes + content type so the dispatcher can
    // store them to profiles.avatar_data — the /uploads file alone vanishes on
    // redeploy and the logo would "fail to load".
    assert.ok(Buffer.isBuffer(result?.avatarBuffer))
    assert.ok(result.avatarBuffer.length > 0)
    assert.match(String(result?.avatarContentType || ''), /^image\//)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    rmSync(uploadDir, { recursive: true, force: true })
  }
})

test('avatar lookup uses organization.website and falls back to icon when no og:image', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+8iUQAAAAASUVORK5CYII=',
    'base64',
  )
  const server = http.createServer((req, res) => {
    if (req.url === '/favicon.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' })
      res.end(png)
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html>
<html>
  <head>
    <link rel="icon" href="/favicon.png" />
  </head>
  <body>hello</body>
</html>`)
  })

  const started = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
  const uploadDir = mkdtempSync(path.join(tmpdir(), 'grantflow-avatar-test-'))

  try {
    const profileContext = {
      profile: { id: 'p2', display_name: 'Org Website Fallback', primary_type: 'organization' },
      sections: { basic_information: {} },
      organization: { website: `http://127.0.0.1:${started}/` },
    }

    const result = await processAvatarLookupJob({
      profileContext,
      uploadDir,
      getOpenAI: () => null, // force website path
    })

    assert.equal(result?.inserted, 1)
    assert.ok(result?.avatarUrl)
    assert.ok(result.avatarUrl.startsWith('/uploads/'))
    assert.equal(result?.result_meta?.method, 'website_icon')
    assert.equal(result?.result_meta?.website_used, `http://127.0.0.1:${started}/`)
    assert.ok(String(result?.result_meta?.image_url_used || '').includes('/favicon.png'))
  } finally {
    await new Promise((resolve) => server.close(resolve))
    rmSync(uploadDir, { recursive: true, force: true })
  }
})

test('extractProfileWebsite honors website_hint from avatar job parameters', () => {
  const url = extractProfileWebsite({
    sections: { basic_information: {} },
    website_hint: 'https://www.zacog.org/',
  })
  assert.equal(url, 'https://www.zacog.org/')
})

