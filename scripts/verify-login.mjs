#!/usr/bin/env node
import { chromium } from 'playwright'

const BASE_URL = process.env.VERIFY_BASE_URL ?? 'http://127.0.0.1:5173'
const ADMIN_TOKEN = process.env.VERIFY_ADMIN_TOKEN ?? 'my-secret-admin-token-123'

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  page.on('console', (msg) => {
    console.log(`[browser:${msg.type()}] ${msg.text()}`)
  })
  page.on('response', (response) => {
    const status = response.status()
    if (status >= 400) {
      console.log(`[response:${status}] ${response.url()}`)
    }
  })
  try {
    await page.goto(new URL('login', BASE_URL).toString(), { waitUntil: 'networkidle', timeout: 15_000 })
    await page.fill('input[type="password"]', ADMIN_TOKEN)
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15_000 }),
      page.click('button[type="submit"]'),
    ])
    await page.waitForTimeout(1_000)
    console.log('[verify] Login attempt completed.')
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error('[verify] Login automation failed:', error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
