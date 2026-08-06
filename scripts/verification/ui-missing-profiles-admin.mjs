#!/usr/bin/env node
/**
 * UI evidence: Admin can see Axiom + Focus Forward on MyProfiles page.
 *
 * Env:
 * - VERIFY_UI_BASE_URL (default http://localhost:5178)
 * - VERIFY_UI_OUT_DIR (default docs/verification)
 */
import process from 'node:process'
import path from 'node:path'
import fs from 'node:fs/promises'
import { chromium } from 'playwright'

const BASE = process.env.VERIFY_UI_BASE_URL || 'http://localhost:5178'
const OUT_DIR = process.env.VERIFY_UI_OUT_DIR || 'docs/verification'

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true })
}

async function run() {
  await ensureDir(OUT_DIR)

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  try {
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 60_000 })
    await page.getByRole('button', { name: 'Dev: Login as Admin' }).click({ timeout: 30_000 })
    await page.waitForURL(/\/Dashboard/i, { timeout: 60_000 })

    await page.goto(`${BASE}/MyProfiles`, { waitUntil: 'networkidle', timeout: 60_000 })
    await page.getByRole('button', { name: 'All Profiles' }).click({ timeout: 30_000 })

    // Filter by search term to make the evidence unambiguous in the screenshot.
    const search = page.getByPlaceholder('Search profiles...')
    await search.fill('Axiom')
    await page.getByText('Axiom Biolabs', { exact: false }).waitFor({ timeout: 30_000 })
    await page.screenshot({ path: path.join(OUT_DIR, 'admin-myprofiles-axiom.png'), fullPage: true })

    await search.fill('Focus Forward')
    await page.getByText('Demo Faith-Based Nonprofit', { exact: false }).waitFor({ timeout: 30_000 })
    await page.screenshot({ path: path.join(OUT_DIR, 'admin-myprofiles-focus-forward.png'), fullPage: true })

    console.log(
      JSON.stringify(
        {
          ok: true,
          screenshots: {
            axiom: path.join(OUT_DIR, 'admin-myprofiles-axiom.png'),
            focus_forward: path.join(OUT_DIR, 'admin-myprofiles-focus-forward.png'),
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
  console.error('[ui-missing-profiles-admin] failed:', err?.stack || err)
  process.exit(1)
})

