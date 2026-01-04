#!/usr/bin/env node
/**
 * Smoke test for the OrganizationProfile page to ensure:
 * - Page loads without React invariant errors
 * - Missing ID shows appropriate error message
 * - Valid organization ID renders profile data
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
  const noIdUrl = new URL(
    buildPath(basePathEnv, 'OrganizationProfile'),
    PREVIEW_BASE_URL,
  ).toString()
  const withIdUrl = new URL(
    `${buildPath(basePathEnv, 'OrganizationProfile')}?id=test-org-123`,
    PREVIEW_BASE_URL,
  ).toString()

  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    
    // Capture console errors to detect React invariant errors
    const consoleErrors = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text())
      }
    })

    // Capture page errors
    const pageErrors = []
    page.on('pageerror', (error) => {
      pageErrors.push(error.message)
    })

    // Test 1: Navigate without ID parameter
    console.log('[smoke] Test 1: OrganizationProfile without ID')
    await page.goto(noIdUrl, { waitUntil: 'networkidle', timeout: 30_000 })
    
    // Wait for error message to appear
    await page.waitForFunction(
      () => document.body && document.body.innerText.includes('No organization ID provided'),
      { timeout: 10_000 },
    )
    
    // Check for React invariant errors
    const hasInvariantError = consoleErrors.some(err => 
      err.includes('Invariant') || err.includes('invariant')
    ) || pageErrors.some(err => 
      err.includes('Invariant') || err.includes('invariant')
    )
    
    if (hasInvariantError) {
      throw new Error('React invariant error detected on OrganizationProfile page')
    }
    
    console.log('[smoke] ✓ No ID parameter shows error message without invariant errors')

    // Test 2: Navigate with ID parameter
    console.log('[smoke] Test 2: OrganizationProfile with ID parameter')
    consoleErrors.length = 0 // Clear previous errors
    pageErrors.length = 0
    
    await page.goto(withIdUrl, { waitUntil: 'networkidle', timeout: 30_000 })
    await delay(2000) // Wait for component to mount
    
    // Check that no React invariant errors occurred
    const hasInvariantError2 = consoleErrors.some(err => 
      err.includes('Invariant') || err.includes('invariant')
    ) || pageErrors.some(err => 
      err.includes('Invariant') || err.includes('invariant')
    )
    
    if (hasInvariantError2) {
      console.error('[smoke] Console errors:', consoleErrors)
      console.error('[smoke] Page errors:', pageErrors)
      throw new Error('React invariant error detected when loading OrganizationProfile with ID')
    }
    
    console.log('[smoke] ✓ OrganizationProfile with ID loads without invariant errors')

    // Test 3: Verify component actually rendered (not a blank page)
    console.log('[smoke] Test 3: Verify component renders content')
    const hasContent = await page.evaluate(() => {
      const body = document.body.innerText
      // Should either show loading, profile data, or error - not be completely blank
      return body.length > 100 // Basic check that something rendered
    })
    
    if (!hasContent) {
      throw new Error('OrganizationProfile page appears blank')
    }
    
    console.log('[smoke] ✓ OrganizationProfile renders content')

    console.log('[smoke] OrganizationProfile smoke test passed!')
  } finally {
    await browser.close()
  }
}

run().catch((error) => {
  console.error('[smoke] OrganizationProfile smoke test failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
