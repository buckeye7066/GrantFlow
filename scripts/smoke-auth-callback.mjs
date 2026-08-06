#!/usr/bin/env node
/**
 * Smoke test for the `/auth/callback` page to ensure provider redirects surface
 * meaningful feedback (both error and one-time handoff paths).
 *
 * Requires the preview bundle to be served locally (e.g. `npm run preview`).
 *
 * Env:
 *   SMOKE_BASE_URL  - Preview base URL (default http://127.0.0.1:4173)
 *   SMOKE_BASE_PATH - Vite base path (default /grantflow)
 */

import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

const PREVIEW_BASE_URL = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:4173'

function buildPath(basePath, leaf) {
  const sanitize = (value) => value.replace(/^\/+|\/+$/g, '')
  const base = sanitize(basePath ?? '')
  const leafPath = sanitize(leaf ?? '')
  return `/${[base, leafPath].filter(Boolean).join('/')}`
}

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

  const basePathEnv = process.env.SMOKE_BASE_PATH ?? '/grantflow'
  const errorUrl = new URL(
    `${buildPath(basePathEnv, 'auth/callback')}?provider=google&error=oauth_state_invalid`,
    PREVIEW_BASE_URL,
  ).toString()
  const handoffUrl = new URL(
    `${buildPath(basePathEnv, 'auth/callback')}?provider=google&handoff=fake-oauth-handoff-that-is-not-valid-1234`,
    PREVIEW_BASE_URL,
  ).toString()

  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.goto(errorUrl, { waitUntil: 'networkidle', timeout: 30_000 })
    await page.waitForFunction(
      () => document.body && document.body.innerText.includes('Sign-in issue'),
      { timeout: 30_000 },
    )
    await page.waitForFunction(
      () =>
        document.body &&
        document.body.innerText.includes('We could not validate the login request'),
      { timeout: 30_000 },
    )

    await page.goto(handoffUrl, { waitUntil: 'networkidle', timeout: 30_000 })
    await page.waitForFunction(
      () => document.body && document.body.innerText.includes('Sign-in issue'),
      { timeout: 30_000 },
    )
    await page.waitForFunction(
      () =>
        document.body &&
        document.body.innerText.includes('We could not complete the sign-in'),
      { timeout: 30_000 },
    )

    console.log('[smoke] Auth callback page surfaces errors correctly.')
  } finally {
    await browser.close()
  }
}

run().catch((error) => {
  console.error('[smoke] Auth callback smoke test failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
