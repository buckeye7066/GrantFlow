#!/usr/bin/env node
/**
 * UI evidence capture: ProfileDetail -> Health tab visible for health profiles.
 *
 * Requires:
 * - frontend preview/dev server reachable at VERIFY_UI_BASE_URL (default http://localhost:5177/grantflow)
 * - Dev admin login enabled (VITE_DEV_ADMIN_TOKEN set in the running Vite process)
 *
 * Env:
 * - VERIFY_UI_BASE_URL (default http://localhost:5177/grantflow)
 * - VERIFY_UI_OUT_DIR (default docs/verification)
 * - VERIFY_PROFILE_ID (required)
 */
import process from 'node:process'
import path from 'node:path'
import fs from 'node:fs/promises'
import { chromium } from 'playwright'

const BASE = process.env.VERIFY_UI_BASE_URL || 'http://localhost:5177'
const OUT_DIR = process.env.VERIFY_UI_OUT_DIR || 'docs/verification'
const PROFILE_ID = process.env.VERIFY_PROFILE_ID || ''

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true })
}

async function run() {
  if (!PROFILE_ID) throw new Error('VERIFY_PROFILE_ID is required')
  await ensureDir(OUT_DIR)

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  try {
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 60_000 })
    await page.getByRole('button', { name: 'Dev: Login as Admin' }).click({ timeout: 30_000 })
    await page.waitForURL(/\/Dashboard/i, { timeout: 60_000 })

    const profileUrl = `${BASE}/ProfileDetail?id=${encodeURIComponent(PROFILE_ID)}`
    await page.goto(profileUrl, { waitUntil: 'networkidle', timeout: 60_000 })

    // Health tab must exist and render the card.
    await page.getByRole('tab', { name: 'Health' }).click({ timeout: 30_000 })
    await page.getByText('Health resources', { exact: true }).waitFor({ timeout: 30_000 })
    await page.screenshot({ path: path.join(OUT_DIR, 'profile-health-tab.png'), fullPage: true })

    console.log(
      JSON.stringify(
        {
          ok: true,
          profile_url: profileUrl,
          screenshot: path.join(OUT_DIR, 'profile-health-tab.png'),
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
  console.error('[ui-health] failed:', err?.stack || err)
  process.exit(1)
})

