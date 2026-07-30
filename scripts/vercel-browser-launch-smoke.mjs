import fs from 'node:fs'
import chromiumBinary from '@sparticuz/chromium'
import { chromium } from 'playwright-core'

const executablePath = await chromiumBinary.executablePath()
const browser = await chromium.launch({
  args: chromiumBinary.args,
  executablePath,
  headless: true,
})
try {
  const page = await browser.newPage()
  await page.goto('data:text/html,<title>GrantFlow audit browser</title><body>ok</body>')
  const result = {
    ok: true,
    title: await page.title(),
    body: await page.locator('body').innerText(),
    version: browser.version(),
  }
  console.log(`[audit-browser-smoke] ${JSON.stringify(result)}`)
  fs.mkdirSync('audit-dist', { recursive: true })
  fs.writeFileSync('audit-dist/browser-smoke.json', JSON.stringify(result, null, 2) + '\n')
  fs.writeFileSync('audit-dist/index.html', '<!doctype html><meta charset="utf-8"><title>GrantFlow audit browser smoke</title><p>ok</p>')
} finally {
  await browser.close()
}
