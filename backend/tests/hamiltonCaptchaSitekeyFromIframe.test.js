/**
 * The CAPTCHA sitekey must be found even when the page renders NO data-sitekey.
 *
 * Live evidence 2026-08-21 (a real applicant's run): a CAPTCHA "failed". A very
 * common cause is detection, not solving: reCAPTCHA invisible / enterprise /
 * JS-injected widgets render only the challenge IFRAME, never a
 * `div.g-recaptcha[data-sitekey]`, so the detector returned the vendor with a
 * NULL sitekey and the solve dead-ended at `no_sitekey_on_page`. The sitekey is
 * reliably present in the iframe src (reCAPTCHA `...api2/anchor?k=KEY`,
 * hCaptcha `...#...sitekey=KEY`). readCaptchaChallenge now reads it there too.
 *
 * This STRICTLY WIDENS detection — a page that already exposes data-sitekey is
 * unaffected — so it can turn a previously unsolvable challenge solvable and
 * never the reverse.
 */
import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { readCaptchaChallenge } from '../services/hamilton/hamiltonCaptchaSolver.js'

// A page whose evaluate() runs the fn against a real jsdom document, exactly the
// contract readCaptchaChallenge relies on (document.querySelector[All] + window).
function jsdomPage(html, href = 'https://portal.example.org/apply') {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`, { url: href })
  return {
    async evaluate(fn, arg) {
      const g = globalThis
      const saved = { window: g.window, document: g.document }
      g.window = dom.window
      g.document = dom.window.document
      try { return await fn(arg) } finally { Object.assign(g, saved) }
    },
  }
}

describe('readCaptchaChallenge — sitekey from the iframe src', () => {
  it('extracts a reCAPTCHA sitekey from the anchor iframe when no data-sitekey exists', async () => {
    const key = '6LcAbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
    const c = await readCaptchaChallenge(jsdomPage(
      `<iframe src="https://www.google.com/recaptcha/api2/anchor?ar=1&k=${key}&co=aHR0cHM&hl=en"></iframe>`,
    ))
    expect(c?.type).toBe('recaptcha')
    expect(c?.sitekey).toBe(key)
  })

  it('extracts an hCaptcha sitekey from the iframe src', async () => {
    const key = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890xyz'
    const c = await readCaptchaChallenge(jsdomPage(
      `<iframe src="https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=challenge&sitekey=${key}&theme=light"></iframe>`,
    ))
    expect(c?.type).toBe('hcaptcha')
    expect(c?.sitekey).toBe(key)
  })

  it('still prefers an explicit data-sitekey div when present (unchanged path)', async () => {
    const c = await readCaptchaChallenge(jsdomPage(
      '<div class="g-recaptcha" data-sitekey="6Lc_explicit_div_key_000000000000000"></div>',
    ))
    expect(c?.type).toBe('recaptcha')
    expect(c?.sitekey).toBe('6Lc_explicit_div_key_000000000000000')
  })

  it('returns null when there is no captcha widget at all', async () => {
    expect(await readCaptchaChallenge(jsdomPage('<form><input name="x"/></form>'))).toBeNull()
  })
})
