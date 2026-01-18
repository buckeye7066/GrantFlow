#!/usr/bin/env node
/**
 * Local runtime crawl (no credentials).
 *
 * What it validates:
 * - backend boots and exposes /api/anya/status
 * - frontend production preview boots
 * - login route renders
 *
 * Usage:
 *   npm run build
 *   node scripts/runtime-crawl-local.mjs
 */

import { spawn } from 'node:child_process'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

const PREVIEW_BASE_URL = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:4173'
const BACKEND_BASE_URL = process.env.BACKEND_BASE_URL ?? 'http://127.0.0.1:4000'

function runCmd(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  })
  return child
}

async function waitFor(url, { method = 'GET', retries = 30, intervalMs = 250 } = {}) {
  for (let i = 0; i < retries; i += 1) {
    try {
      const res = await fetch(url, { method })
      if (res.ok) return true
    } catch (_) {
      // ignore
    }
    await delay(intervalMs)
  }
  return false
}

async function main() {
  const procs = []
  
  const cleanup = () => {
    console.log('[crawl] Cleaning up processes...')
    let cleanupErrors = 0
    
    for (const p of procs) {
      if (!p || !p.pid) continue
      
      try {
        // Check if process is still running
        if (p.exitCode === null) {
          p.kill('SIGTERM')
          console.log(`[crawl] Terminated process ${p.pid}`)
        }
      } catch (err) {
        cleanupErrors++
        console.warn(`[crawl] Error terminating process ${p.pid}:`, err.message)
      }
    }
    
    if (cleanupErrors > 0) {
      console.warn(`[crawl] ${cleanupErrors} process(es) could not be terminated cleanly`)
    }
  }
  
  process.on('SIGINT', () => {
    console.log('[crawl] Received SIGINT, cleaning up...')
    cleanup()
    process.exit(130)
  })
  process.on('SIGTERM', () => {
    console.log('[crawl] Received SIGTERM, cleaning up...')
    cleanup()
    process.exit(143)
  })
  process.on('uncaughtException', (err) => {
    console.error('[crawl] Uncaught exception:', err)
    cleanup()
    process.exit(1)
  })

  // Start backend + preview
  try {
    const backendProc = runCmd('npm', ['run', 'backend'])
    procs.push(backendProc)
    console.log('[crawl] Started backend process')
    
    const previewProc = runCmd('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', '4173'])
    procs.push(previewProc)
    console.log('[crawl] Started preview process')
  } catch (err) {
    console.error('[crawl] Failed to start processes:', err)
    cleanup()
    throw new Error(`Process startup failed: ${err.message}`)
  }

  const backendOk = await waitFor(`${BACKEND_BASE_URL}/api/anya/status`, { method: 'GET' })
  if (!backendOk) {
    cleanup()
    throw new Error(`Backend not reachable at ${BACKEND_BASE_URL}/api/anya/status after waiting`)
  }
  console.log('[crawl] Backend is ready')

  const previewOk = await waitFor(`${PREVIEW_BASE_URL}/grantflow/`, { method: 'HEAD' })
  if (!previewOk) {
    cleanup()
    throw new Error(`Preview not reachable at ${PREVIEW_BASE_URL}/grantflow/ after waiting`)
  }
  console.log('[crawl] Preview is ready')

  // Browser checks (no auth)
  try {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    try {
      await page.goto(new URL('/grantflow/login', PREVIEW_BASE_URL).toString(), { waitUntil: 'networkidle', timeout: 20_000 })
      await page.waitForSelector('text=GrantFlow Control Center', { timeout: 10_000 })
      await page.waitForSelector('input[type="password"]', { timeout: 10_000 })
      console.log('[crawl] Login page rendered.')

      // Optional: try the admin page route - it should either render or redirect, but not hard-crash.
      await page.goto(new URL('/grantflow/admin', PREVIEW_BASE_URL).toString(), { waitUntil: 'networkidle', timeout: 20_000 })
      console.log('[crawl] Admin route reachable (may require token to do anything useful).')
    } finally {
      await browser.close()
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    
    // Provide more specific error messages
    if (msg.includes('Executable doesn\'t exist')) {
      console.warn('[crawl] Playwright browser checks skipped: Browser not installed')
      console.warn('[crawl] To enable browser-level validation, run: npx playwright install')
    } else if (msg.includes('net::ERR_CONNECTION_REFUSED')) {
      console.error('[crawl] Browser checks failed: Could not connect to preview server')
      cleanup()
      throw new Error('Preview server connection failed during browser checks')
    } else if (msg.includes('Timeout')) {
      console.error('[crawl] Browser checks failed: Page load timeout')
      cleanup()
      throw new Error('Page load timeout during browser checks')
    } else {
      console.warn('[crawl] Playwright browser checks skipped:', msg)
      console.warn('[crawl] If you want browser-level validation, run: npx playwright install')
    }
  }

  cleanup()
  console.log('[crawl] Local runtime crawl complete: no fatal server errors detected.')
}

main().catch((err) => {
  const errorMsg = err instanceof Error ? err.message : String(err)
  console.error('[crawl] FAILED:', errorMsg)
  
  // Set appropriate exit code based on error type
  if (errorMsg.includes('not reachable') || errorMsg.includes('connection')) {
    process.exitCode = 2 // Connection error
  } else if (errorMsg.includes('timeout')) {
    process.exitCode = 3 // Timeout error
  } else if (errorMsg.includes('startup')) {
    process.exitCode = 4 // Startup error
  } else {
    process.exitCode = 1 // General error
  }
})
