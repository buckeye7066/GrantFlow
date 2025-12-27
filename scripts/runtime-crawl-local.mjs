#!/usr/bin/env node
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { chromium } from 'playwright'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const projectRoot = path.resolve(__dirname, '..')
const distIndex = path.join(projectRoot, 'dist', 'index.html')

async function ensureBuildExists() {
  try {
    await fs.access(distIndex)
  } catch {
    throw new Error('Build artifacts missing. Run "npm run build" before runtime crawl.')
  }
}

function waitForServer(server) {
  return new Promise((resolve, reject) => {
    server.once('listening', () => resolve(server))
    server.once('error', reject)
  })
}

async function launchBackend() {
  process.env.ANYA_ADMIN_TOKEN = process.env.ANYA_ADMIN_TOKEN || 'runtime-crawl-token'
  process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || ''

  const { default: app } = await import('../backend/server.js')
  const server = app.listen(0)
  await waitForServer(server)
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Failed to determine server port')
  }
  return { server, port: address.port }
}

async function verifyApi(port) {
  const base = `http://localhost:${port}`
  const headers = {
    Authorization: `Bearer ${process.env.ANYA_ADMIN_TOKEN}`,
  }

  const endpoints = [
    { method: 'GET', url: `${base}/api/anya/status` },
    { method: 'GET', url: `${base}/api/anya/logs?limit=5` },
    {
      method: 'POST',
      url: `${base}/api/anya/scan`,
      body: JSON.stringify({ target: 'repository', autoFix: false, approve: false }),
    },
    {
      method: 'POST',
      url: `${base}/api/anya/crawl`,
      body: JSON.stringify({ scope: 'default-datasets', depth: 1 }),
    },
    {
      method: 'POST',
      url: `${base}/api/anya/explain`,
      body: JSON.stringify({ context: 'latest-scan' }),
    },
  ]

  for (const endpoint of endpoints) {
    const payloadHeaders =
      endpoint.body != null
        ? { ...headers, 'Content-Type': 'application/json' }
        : headers
    const response = await fetch(endpoint.url, {
      method: endpoint.method,
      headers: payloadHeaders,
      body: endpoint.body,
    })
    if (!response.ok) {
      throw new Error(`API check failed for ${endpoint.method} ${endpoint.url} (${response.status})`)
    }
    await response.text()
  }
}

async function runBrowser(port) {
  try {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    const base = `http://localhost:${port}/grantflow/`
    await page.goto(`${base}login`, { waitUntil: 'networkidle', timeout: 15_000 })
    await page.fill('input[type="password"]', process.env.ANYA_ADMIN_TOKEN ?? '')
    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/anya/status') && res.status() < 400, { timeout: 15_000 }),
      page.click('button[type="submit"]'),
    ])
    await page.waitForTimeout(500)
    await browser.close()
  } catch (error) {
    if (error instanceof Error && /install.*playwright/i.test(error.message)) {
      console.error('[runtime-crawl] Playwright browsers missing. Run "npx playwright install" and retry.')
    }
    throw error
  }
}

async function main() {
  await ensureBuildExists()
  const { server, port } = await launchBackend()
  try {
    await verifyApi(port)
    await runBrowser(port)
    console.log('[runtime-crawl] Completed successfully.')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

main().catch((error) => {
  console.error('[runtime-crawl] Failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
