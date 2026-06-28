// packetPdf.js
//
// Render application-packet HTML to PDF bytes. Reuses Playwright (already a
// project dependency) — NO new package. Two entry points:
//   - renderHtmlToPdf(html)        -> Buffer | null  (single)
//   - renderHtmlBatchToPdf(htmls)  -> Array<Buffer|null>  (one browser for the
//                                     whole batch, so generating packets for many
//                                     selected funders launches chromium ONCE)
//
// Graceful by design: when chromium isn't installed (CI, minimal deploys), every
// result is null and the caller falls back to saving the packet as HTML — the
// packet is never lost, it just isn't a PDF on that host.

import fs from 'node:fs'

const PDF_OPTS = Object.freeze({
  format: 'Letter',
  printBackground: true,
  margin: { top: '0.6in', bottom: '0.6in', left: '0.6in', right: '0.6in' },
})

let _warned = false

async function loadChromium() {
  try {
    const { chromium } = await import('playwright')
    const exe = chromium.executablePath?.()
    if (!exe || !fs.existsSync(exe)) return null
    return chromium
  } catch {
    return null
  }
}

/**
 * @param {string[]} htmls
 * @returns {Promise<Array<Buffer|null>>} aligned with input; null where PDF couldn't render
 */
export async function renderHtmlBatchToPdf(htmls = []) {
  const list = Array.isArray(htmls) ? htmls : []
  if (list.length === 0) return []
  // Skip the (slow, environment-dependent) chromium launch under tests so the
  // packet routes stay deterministic and fast — callers fall back to HTML.
  if (process.env.NODE_ENV === 'test') return list.map(() => null)
  const chromium = await loadChromium()
  if (!chromium) return list.map(() => null)

  let browser = null
  try {
    browser = await chromium.launch({ headless: true })
    const ctx = await browser.newContext()
    const out = []
    for (const html of list) {
      let page = null
      try {
        page = await ctx.newPage()
        await page.setContent(String(html ?? ''), { waitUntil: 'domcontentloaded' })
        out.push(await page.pdf(PDF_OPTS))
      } catch {
        out.push(null) // one bad page must not sink the batch
      } finally {
        if (page) { try { await page.close() } catch { /* ignore */ } }
      }
    }
    await ctx.close()
    return out
  } catch (err) {
    if (!_warned && process.env.NODE_ENV !== 'test') {
      _warned = true
      console.warn(`[packetPdf] PDF rendering unavailable; packets will be saved as HTML: ${err?.message || err}`)
    }
    return list.map(() => null)
  } finally {
    if (browser) { try { await browser.close() } catch { /* ignore */ } }
  }
}

/** @returns {Promise<Buffer|null>} */
export async function renderHtmlToPdf(html) {
  const [buf] = await renderHtmlBatchToPdf([html])
  return buf ?? null
}

export default { renderHtmlToPdf, renderHtmlBatchToPdf }
