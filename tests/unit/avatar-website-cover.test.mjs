import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { processAvatarLookupJob } from '../../backend/services/avatarCrawler.js'

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
  } finally {
    await new Promise((resolve) => server.close(resolve))
    rmSync(uploadDir, { recursive: true, force: true })
  }
})

