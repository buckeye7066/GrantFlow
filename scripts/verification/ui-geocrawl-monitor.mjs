#!/usr/bin/env node
/**
 * UI evidence capture: Admin -> Geo Crawl monitor (DB-backed, survives refresh).
 *
 * Requires dev servers:
 * - frontend: Vite at VERIFY_UI_BASE_URL (default http://localhost:5177)
 *
 * Env:
 * - VERIFY_UI_BASE_URL (default http://localhost:5177)
 * - VERIFY_UI_OUT_DIR (default docs/verification)
 * - VERIFY_GEO_RUN_ID (required)
 */
import process from 'node:process'
import path from 'node:path'
import fs from 'node:fs/promises'
import { chromium } from 'playwright'

const BASE_URL = process.env.VERIFY_UI_BASE_URL || 'http://localhost:5177'
const OUT_DIR = process.env.VERIFY_UI_OUT_DIR || 'docs/verification'
const RUN_ID = process.env.VERIFY_GEO_RUN_ID || ''

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true })
}

async function run() {
  if (!RUN_ID) throw new Error('VERIFY_GEO_RUN_ID is required')
  await ensureDir(OUT_DIR)

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })

  try {
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle', timeout: 60_000 })
    await page.getByRole('button', { name: 'Dev: Login as Admin' }).click({ timeout: 30_000 })
    await page.waitForURL(/\/Dashboard/i, { timeout: 60_000 })

    // Ensure the AdminGeoCrawl component picks up the run id on mount.
    await page.addInitScript((rid) => {
      try {
        window.localStorage.setItem('gf_geo_crawl_last_run_id', rid)
      } catch {
        // ignore
      }
    }, RUN_ID)

    await page.goto(`${BASE_URL}/Admin`, { waitUntil: 'networkidle', timeout: 60_000 })
    await page.getByRole('tab', { name: 'Geo Crawl' }).click({ timeout: 30_000 })

    // Wait for monitor header to show the run id
    await page.getByText('GeoCrawl Monitor', { exact: true }).waitFor({ timeout: 30_000 })
    await page.getByText(RUN_ID).waitFor({ timeout: 30_000 })

    await page.waitForTimeout(500)
    await page.screenshot({ path: path.join(OUT_DIR, 'admin-geo-crawl-monitor.png'), fullPage: true })

    console.log(
      JSON.stringify(
        {
          ok: true,
          base_url: BASE_URL,
          run_id: RUN_ID,
          screenshot: path.join(OUT_DIR, 'admin-geo-crawl-monitor.png'),
        },
        null,
        2,
      ),
    )
  } finally {
    await browser.close()
  }
}

run().catch((err) => {
  console.error('[ui-geocrawl-monitor] failed:', err?.stack || err)
  process.exit(1)
})

