#!/usr/bin/env node
/**
 * Minimal smoke test to ensure the production bundle renders the login page.
 * Requires `npm run preview` (or another static server) to be running locally.
 */

import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

const PREVIEW_BASE_URL = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:4173'
const TARGET_URL = new URL('/grantflow/login', PREVIEW_BASE_URL).toString()

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
  try {
    const response = await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 15_000 })
    if (!response || !response.ok()) {
      throw new Error(`Failed to load ${TARGET_URL} (status: ${response?.status() ?? 'no response'})`)
    }

    await page.waitForSelector('text=GrantFlow Control Center', { timeout: 10_000 })
    await page.waitForSelector('input[type="password"]', { timeout: 10_000 })
    console.log('[smoke] Login screen rendered successfully.')
  } finally {
    await browser.close()
  }
}

run().catch((error) => {
  console.error('[smoke] Login smoke test failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
