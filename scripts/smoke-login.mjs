#!/usr/bin/env node
/**
 * Minimal smoke test to ensure the production bundle renders the login page.
 * Requires `npm run preview` (or another static server) to be running locally.
 *
 * Environment variables:
 *   SMOKE_BASE_URL  - Override the preview base URL (default http://127.0.0.1:4173)
 *   SMOKE_BASE_PATH - Override the base path for the app (default /grantflow)
 *   SMOKE_TARGET_PATH - Override the page under the base path (default login)
 */

import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

const PREVIEW_BASE_URL = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:4173'

function buildTargetPath(basePath, leafPath) {
  const sanitize = (value) => value.replace(/^\/+|\/+$/g, '')
  const normalizedBase = sanitize(basePath ?? '')
  const normalizedLeaf = sanitize(leafPath ?? '')
  const parts = [normalizedBase, normalizedLeaf].filter(Boolean)
  if (parts.length === 0) {
    return '/'
  }
  return `/${parts.join('/')}`
}

const basePathEnv = process.env.SMOKE_BASE_PATH ?? '/grantflow'
const targetLeafEnv = process.env.SMOKE_TARGET_PATH ?? 'login'
const TARGET_URL = new URL(buildTargetPath(basePathEnv, targetLeafEnv), PREVIEW_BASE_URL).toString()

async function ensurePreviewReachable(url, retries = 5) {
  const fetchFn = globalThis.fetch
  if (typeof fetchFn !== 'function') return
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const res = await fetchFn(url, { method: 'HEAD' })
      if (res.ok) return true
    } catch (error) {
      if (attempt === retries - 1) throw error
    }
    await delay(250)
  }
  return false
}

async function run() {
  const reachable = await ensurePreviewReachable(PREVIEW_BASE_URL).catch(() => false)
  if (!reachable) {
    console.error(`[smoke] Could not reach preview server at ${PREVIEW_BASE_URL}. Start it with "npm run preview".`)
    process.exitCode = 1
    return
  }

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  if (process.env.SMOKE_DEBUG === '1') {
    page.on('console', (message) => {
      console.log(`[smoke][debug] console.${message.type()}: ${message.text()}`)
    })
    page.on('pageerror', (error) => {
      console.error('[smoke][debug] page error:', error instanceof Error ? error.stack : error)
    })
  }
  try {
    const response = await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 15_000 })
    if (!response || !response.ok()) {
      throw new Error(`Failed to load ${TARGET_URL} (status: ${response?.status() ?? 'no response'})`)
    }

    if (process.env.SMOKE_DEBUG === '1') {
      const html = await page.content()
      console.log('[smoke][debug] document snippet:', html.slice(0, 500))
    }

    await page.waitForSelector('text=Sign in to GrantFlow', { timeout: 10_000 })
    await page.waitForSelector('role=tab[name="Email"]', { timeout: 5_000 })

    console.log('[smoke] GrantFlow login surface rendered successfully with Email auth.')
  } finally {
    await browser.close()
  }
}

run().catch((error) => {
  console.error('[smoke] Login smoke test failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
