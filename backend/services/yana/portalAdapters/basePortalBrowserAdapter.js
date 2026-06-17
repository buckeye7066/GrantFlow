/**
 * basePortalBrowserAdapter.js
 *
 * Default behaviours that every browser adapter inherits. Subclasses
 * override the heuristics; the orchestrator (`yanaPortalAutomation.js`)
 * only ever talks to this contract.
 *
 * Each adapter exposes:
 *   canHandle(portalLink, opportunity, profile)  → bool
 *   detectGate(page)                              → { kind, reason } | null
 *      kind ∈ login | 2fa | captcha | consent
 *   detectForm(page)                              → [field, ...]
 *      field shape: see portalFieldMapper.js
 *   detectSaveDraftButton(page)                   → ElementHandle | null
 *   detectSubmitButton(page)                      → ElementHandle | null
 *   detectConfirmation(page)                      → { reference } | null
 */

const LOGIN_HINTS = [
  /sign\s*in/i, /log\s*in|login/i, /authenticate/i, /netid|sso|cas/i,
]
const TWO_FACTOR_HINTS = [
  /verification\s*code/i, /one[\s-]?time\s*passcode|otp/i,
  /authenticator/i, /two[\s-]?factor|2fa|mfa/i, /duo|okta\s*verify/i,
]
const CAPTCHA_HINTS = [
  /recaptcha/i, /hcaptcha/i, /captcha/i,
]
const CONSENT_HINTS = [
  /i\s*agree|i\s*accept|terms\s*and\s*conditions|consent|privacy\s*policy|attest/i,
]

async function safeText(page) {
  try {
    return await page.locator('body').innerText({ timeout: 1500 })
  } catch {
    return ''
  }
}

async function passwordVisible(page) {
  try {
    const c = await page.locator('input[type="password"]').count()
    return c > 0
  } catch { return false }
}

async function captchaIframeVisible(page) {
  try {
    const c = await page.locator('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], div[class*="captcha"]').count()
    return c > 0
  } catch { return false }
}

export const basePortalBrowserAdapter = Object.freeze({
  name: 'base',
  portalTypes: [],

  canHandle() { return false },

  async detectGate(page) {
    if (!page) return null
    const url = (await page.url?.()) || ''
    const text = await safeText(page)
    if (await captchaIframeVisible(page)) {
      return { kind: 'captcha', reason: 'CAPTCHA element detected on page' }
    }
    if (CAPTCHA_HINTS.some((re) => re.test(text))) {
      return { kind: 'captcha', reason: 'Page text mentions CAPTCHA' }
    }
    if (TWO_FACTOR_HINTS.some((re) => re.test(text))) {
      return { kind: '2fa', reason: 'Page mentions 2FA / verification code' }
    }
    if (await passwordVisible(page)) {
      return { kind: 'login', reason: 'Password field visible — supervised login required' }
    }
    if (LOGIN_HINTS.some((re) => re.test(url))) {
      return { kind: 'login', reason: `URL "${url}" looks like a login page` }
    }
    return null
  },

  async detectForm(page) {
    if (!page) return []
    return await page.evaluate(() => {
      function attr(el, name) { return el.getAttribute(name) || null }
      function labelFor(el) {
        if (el.id) {
          const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
          if (lbl && lbl.textContent) return lbl.textContent.trim()
        }
        const wrapping = el.closest('label')
        if (wrapping && wrapping.textContent) return wrapping.textContent.trim()
        const aria = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')
        if (aria) return aria
        return null
      }
      function uniqueSelector(el) {
        if (el.id) return `#${CSS.escape(el.id)}`
        if (el.getAttribute('name')) return `${el.tagName.toLowerCase()}[name="${el.getAttribute('name')}"]`
        const idx = Array.from(el.parentElement?.children || []).indexOf(el)
        return `${el.tagName.toLowerCase()}:nth-child(${idx + 1})`
      }
      const out = []
      const inputs = Array.from(document.querySelectorAll('input, textarea, select'))
      for (const el of inputs) {
        const tag = el.tagName.toLowerCase()
        if (tag === 'input') {
          const t = (el.getAttribute('type') || 'text').toLowerCase()
          if (['hidden', 'submit', 'reset', 'button', 'image'].includes(t)) continue
        }
        const field = {
          selector: uniqueSelector(el),
          name: attr(el, 'name'),
          id: el.id || null,
          label: labelFor(el),
          placeholder: attr(el, 'placeholder'),
          aria_label: attr(el, 'aria-label'),
          type: tag === 'textarea' ? 'textarea'
              : tag === 'select' ? 'select'
              : (el.getAttribute('type') || 'text').toLowerCase(),
          required: el.required === true || el.getAttribute('aria-required') === 'true',
        }
        if (field.type === 'select') {
          const opts = Array.from(el.options || [])
          field.options = opts.map((o) => ({ value: o.value, label: o.text || o.value }))
        }
        out.push(field)
      }
      return out
    })
  },

  async detectSaveDraftButton(page) {
    if (!page) return null
    try {
      const candidate = page.getByRole('button', { name: /save\s*draft|save\s*progress|save\s*&\s*continue\s*later/i })
      if (await candidate.count()) return candidate.first()
    } catch { /* fallthrough */ }
    return null
  },

  async detectSubmitButton(page) {
    if (!page) return null
    const re = /^(submit|submit\s*application|finish|complete|send)$/i
    try {
      const role = page.getByRole('button', { name: re })
      if (await role.count()) return role.first()
    } catch { /* ignore */ }
    try {
      const native = page.locator('button[type="submit"], input[type="submit"]')
      if (await native.count()) return native.first()
    } catch { /* ignore */ }
    return null
  },

  async detectConfirmation(page) {
    if (!page) return null
    const text = await safeText(page)
    // Look for an explicit "Confirmation: VALUE" / "Reference #VALUE" pair.
    // The captured token must start with an uppercase letter or digit and
    // contain at least one hyphen or be ≥6 chars — this prevents the
    // word "submitted" from being mis-captured as a reference.
    const patterns = [
      /(?:confirmation|reference)\s*(?:number|id|code)?\s*[:#]\s*([A-Z0-9]+-[A-Z0-9-]+)/i,
      /(?:confirmation|reference)\s*(?:number|id|code)?\s*[:#]\s*([A-Z0-9]{6,})/,
      /(?:confirmation|reference)\s*(?:number|id|code)\s*[:#]?\s*([A-Z0-9]{4,})/,
    ]
    for (const re of patterns) {
      const m = text.match(re)
      if (m && m[1]) return { reference: m[1] }
    }
    return null
  },
})
