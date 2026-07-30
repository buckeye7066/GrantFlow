import fs from 'node:fs'

const file = 'scripts/vercel-final-authenticated-audit.mjs'
let source = fs.readFileSync(file, 'utf8')
source = source.replace(
  "import chromiumBinary from '@sparticuz/chromium'\nimport { chromium as playwrightChromium } from 'playwright-core'",
  "import { chromium as playwrightChromium } from 'playwright'",
)
source = source.replace(
  `  const executablePath = await chromiumBinary.executablePath()\n  const browser = await playwrightChromium.launch({\n    args: chromiumBinary.args,\n    executablePath,\n    headless: true,\n  })`,
  `  const browser = await playwrightChromium.launch({ headless: true })`,
)
if (source.includes('@sparticuz/chromium') || source.includes('chromiumBinary')) {
  throw new Error('serverless Chromium patch did not fully apply')
}
if (!source.includes("from 'playwright'") || !source.includes('playwrightChromium.launch({ headless: true })')) {
  throw new Error('repository-pinned Playwright browser patch is incomplete')
}
fs.writeFileSync(file, source)
console.log('[final-audit-browser] repository-pinned Playwright Chromium applied')
