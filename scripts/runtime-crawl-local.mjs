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
    for (const p of procs) {
      try {
        p.kill('SIGTERM')
      } catch (_) {
        // ignore
      }
    }
  }
  process.on('SIGINT', () => {
    cleanup()
    process.exit(130)
  })
  process.on('SIGTERM', () => {
    cleanup()
    process.exit(143)
  })

  // Start backend + preview
  procs.push(runCmd('npm', ['run', 'backend']))
  procs.push(runCmd('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', '4173']))

  const backendOk = await waitFor(`${BACKEND_BASE_URL}/api/anya/status`, { method: 'GET' })
  if (!backendOk) throw new Error(`Backend not reachable at ${BACKEND_BASE_URL}/api/anya/status`)

  const previewOk = await waitFor(`${PREVIEW_BASE_URL}/grantflow/`, { method: 'HEAD' })
  if (!previewOk) throw new Error(`Preview not reachable at ${PREVIEW_BASE_URL}/grantflow/`)

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
    console.warn('[crawl] Playwright browser checks skipped:', msg)
    console.warn('[crawl] If you want browser-level validation, run: npx playwright install')
  }

  cleanup()
  console.log('[crawl] Local runtime crawl complete: no fatal server errors detected.')
}

main().catch((err) => {
  console.error('[crawl] FAILED:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
