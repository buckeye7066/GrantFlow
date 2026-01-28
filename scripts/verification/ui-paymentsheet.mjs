#!/usr/bin/env node
/**
 * UI evidence capture (local dev):
 * - Login via "Dev: Login as Admin" (requires VITE_DEV_ADMIN_TOKEN)
 * - Capture Billing page and BillingSheet page screenshots
 *
 * Env:
 * - VERIFY_UI_BASE_URL (default http://127.0.0.1:5177)
 * - VERIFY_UI_OUT_DIR (default docs/verification)
 */
import process from 'node:process'
import path from 'node:path'
import fs from 'node:fs/promises'
import { chromium } from 'playwright'

const BASE_URL = process.env.VERIFY_UI_BASE_URL || 'http://127.0.0.1:5177'
const OUT_DIR = process.env.VERIFY_UI_OUT_DIR || 'docs/verification'

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true })
}

async function run() {
  await ensureDir(OUT_DIR)

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })

  try {
    // 1) Login
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle', timeout: 60_000 })
    await page.getByRole('button', { name: 'Dev: Login as Admin' }).click({ timeout: 30_000 })
    await page.waitForURL(/\/Dashboard/i, { timeout: 60_000 })

    // 2) Billing page
    await page.goto(`${BASE_URL}/Billing`, { waitUntil: 'networkidle', timeout: 60_000 })
    await page.screenshot({ path: path.join(OUT_DIR, 'billing-page.png'), fullPage: true })

    // BillingSheet is required to be reachable from Billing UI.
    await page.getByRole('button', { name: 'Payment Sheet (Master)' }).click({ timeout: 30_000 })
    await page.waitForURL(/\/BillingSheet/i, { timeout: 60_000 })
    await page.waitForTimeout(500)
    await page.screenshot({ path: path.join(OUT_DIR, 'billing-sheet-master.png'), fullPage: true })

    console.log(
      JSON.stringify(
        {
          ok: true,
          base_url: BASE_URL,
          screenshots: {
            billing_page: path.join(OUT_DIR, 'billing-page.png'),
            billing_sheet_master: path.join(OUT_DIR, 'billing-sheet-master.png'),
          },
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
  console.error('[ui-paymentsheet] failed:', err?.stack || err)
  process.exit(1)
})

