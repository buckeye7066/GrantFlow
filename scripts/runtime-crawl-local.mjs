#!/usr/bin/env node
/**
 * Local runtime crawl (no credentials).
 *
 * What it validates:
 * - backend boots and exposes /api/health
 * - frontend production preview boots
 * - login route renders
 *
 * Usage:
 *   npm run build
 *   node scripts/runtime-crawl-local.mjs
 */

import { spawn } from 'node:child_process'
import net from 'node:net'
import process from 'node:process'
import crypto from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

function runCmd(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  })
  return child
}

async function isPortAvailable(port, host = '127.0.0.1') {
  // Prefer connect-probing over bind-probing.
  // If connect() succeeds, a service is already listening.
  return await new Promise((resolve) => {
    const socket = net.connect({ port, host })
    socket.once('connect', () => {
      try { socket.destroy() } catch {}
      resolve(false)
    })
    socket.once('error', (err) => {
      try { socket.destroy() } catch {}
      if (err?.code === 'ECONNREFUSED') return resolve(true)
      resolve(false)
    })
  })
}

async function pickPort({ start, count = 30 } = {}) {
  const base = Number(start)
  if (!Number.isFinite(base) || base <= 0) throw new Error(`Invalid port start: ${start}`)
  for (let i = 0; i < count; i += 1) {
    const port = base + i
    if (await isPortAvailable(port)) return port
  }
  throw new Error(`No available port found starting at ${start}`)
}

async function waitFor(url, { method = 'GET', retries = 30, intervalMs = 250 } = {}) {
  let lastError = null
  for (let i = 0; i < retries; i += 1) {
    try {
      const res = await fetch(url, { method })
      if (res.ok) return true
    } catch (err) {
      lastError = err
    }
    await delay(intervalMs)
  }
  if (lastError) {
    console.warn(`[crawl] Last error while probing ${url}:`, lastError?.message || String(lastError))
  }
  return false
}

async function main() {
  const procs = []
  const preferredPreviewPort = Number(process.env.PREVIEW_PORT || 4173)
  const preferredBackendPort = Number(process.env.BACKEND_PORT || process.env.PORT || 8080)
  const previewPort = process.env.SMOKE_BASE_URL ? null : await pickPort({ start: preferredPreviewPort, count: 30 })
  const backendPort = process.env.BACKEND_BASE_URL ? null : await pickPort({ start: preferredBackendPort, count: 30 })

  const previewBaseUrl = process.env.SMOKE_BASE_URL ?? `http://127.0.0.1:${previewPort}`
  const backendBaseUrl = process.env.BACKEND_BASE_URL ?? `http://127.0.0.1:${backendPort}`
  
  const cleanup = () => {
    console.log('[crawl] Cleaning up processes...')
    let cleanupErrors = 0
    
    for (const p of procs) {
      if (!p || !p.pid) continue
      
      try {
        // Check if process is still running
        if ((p.exitCode === null || p.exitCode === undefined)) {
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
    if (!process.env.BACKEND_BASE_URL) {
      const adminToken = process.env.ADMIN_TOKEN || crypto.randomUUID()
      const backendProc = runCmd('npm', ['run', 'backend'], {
        env: {
          ...process.env,
          PORT: String(backendPort),
          // Match the generated root `.env.example` contract without requiring a copied `.env`.
          ADMIN_TOKEN: adminToken,
        },
      })
      procs.push(backendProc)
      console.log('[crawl] Started backend process', { port: backendPort })
    } else {
      console.log('[crawl] Using external backend', { baseUrl: backendBaseUrl })
    }

    if (!process.env.SMOKE_BASE_URL) {
      const previewProc = runCmd('npm', [
        'run',
        'preview',
        '--',
        '--host',
        '127.0.0.1',
        '--port',
        String(previewPort),
        '--strictPort',
      ])
      procs.push(previewProc)
      console.log('[crawl] Started preview process', { port: previewPort })
    } else {
      console.log('[crawl] Using external preview', { baseUrl: previewBaseUrl })
    }
  } catch (err) {
    console.error('[crawl] Failed to start processes:', err)
    cleanup()
    throw new Error(`Process startup failed: ${err.message}`)
  }

  const backendOk = await waitFor(`${backendBaseUrl}/api/health`, { method: 'GET', retries: 240, intervalMs: 250 })
  if (!backendOk) {
    cleanup()
    throw new Error(`Backend not reachable at ${backendBaseUrl}/api/health after waiting`)
  }
  console.log('[crawl] Backend is ready')

  const previewOk = await waitFor(`${previewBaseUrl}/grantflow/`, { method: 'HEAD', retries: 120, intervalMs: 250 })
  if (!previewOk) {
    cleanup()
    throw new Error(`Preview not reachable at ${previewBaseUrl}/grantflow/ after waiting`)
  }
  console.log('[crawl] Preview is ready')

  // Browser checks (no auth)
  try {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    try {
      await page.goto(new URL('/grantflow/login', previewBaseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForSelector('text=Sign in to GrantFlow', { timeout: 20_000 })
      await page.waitForSelector('#auth-email', { timeout: 20_000 })
      console.log('[crawl] Login page rendered.')
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
      console.error('[crawl] Browser checks failed:', msg)
      cleanup()
      throw err
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
