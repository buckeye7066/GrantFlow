import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function normalizeBasePath(p) {
  if (!p) return '/grantflow'
  if (p === '/') return '/'
  return `/${String(p).replace(/^\/+/, '').replace(/\/+$/, '')}`
}

async function main() {
  const port = Number.parseInt(process.env.PORT || '8099', 10)
  const basePath = normalizeBasePath(process.env.AUTH_FRONTEND_APP_BASE || process.env.VITE_APP_BASE || '/grantflow')
  const base = `http://127.0.0.1:${port}`

  const proc = spawn('node', ['backend/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      AUTH_FRONTEND_APP_BASE: basePath,
      NODE_ENV: process.env.NODE_ENV || 'development',
    },
    stdio: 'ignore',
    windowsHide: true,
  })

  try {
    // wait for server health
    let ok = false
    for (let i = 0; i < 240; i += 1) {
      try {
        const res = await fetch(`${base}/health`)
        if (res.ok) {
          ok = true
          break
        }
      } catch {}
      await sleep(250)
    }
    if (!ok) throw new Error(`backend did not become healthy on ${base}`)

    const r1 = await fetch(`${base}/`, { redirect: 'manual' })
    console.log('GET /', r1.status, r1.headers.get('location'))

    const r2 = await fetch(`${base}${basePath}/`, { redirect: 'manual' })
    console.log(`GET ${basePath}/`, r2.status)
    const html = await r2.text()

    // Find an asset URL that matches the configured base path (normal HTML quotes)
    const escapedBase = basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`["'](${escapedBase}/assets/[^"']+)["']`)
    const m = html.match(re)
    const asset = m ? m[1] : null
    console.log('asset', asset)
    if (!asset) {
      // Dump a small snippet for debugging
      console.log('index.html snippet:', html.slice(0, 500).replace(/\n/g, '\\n'))
      throw new Error(`could not locate asset URL in index.html for basePath=${basePath}`)
    }

    const r3 = await fetch(`${base}${asset}`, { redirect: 'manual' })
    console.log(`GET ${asset}`, r3.status, r3.headers.get('content-type'))
    if (!r3.ok) throw new Error('asset request failed')
  } finally {
    try {
      proc.kill('SIGTERM')
    } catch {}
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

