/**
 * A jsdom-backed stand-in for a Playwright page, for driving the REAL
 * `runAutopilot` against a representative portal form without a browser.
 * Same shape as the fixture in hamiltonAutonomousE2E.test.js, made reusable:
 * pass the form HTML, get a page whose submit turns into a confirmation page.
 *
 * Rendering accommodations only (jsdom performs no layout): every element gets
 * a visible rect, `innerText` aliases `textContent`. Nothing about matching or
 * fill logic lives here.
 */
import fs from 'node:fs'
import { JSDOM } from 'jsdom'

export function makeJsdomPortalPage(html, {
  url = 'https://hamilton-submit-fixture.invalid/apply',
  confirmationHtml = '<h1>Application submitted</h1><p>Thank you. Your confirmation number is E2E-CONF-4821.</p>',
} = {}) {
  const dom = new JSDOM(html, { url })
  const { window } = dom
  const doc = window.document
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { width: 160, height: 24, top: 0, left: 0, right: 160, bottom: 24, x: 0, y: 0 }
  }
  if (!Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'innerText')) {
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
      configurable: true,
      get() { return this.textContent },
      set(v) { this.textContent = v },
    })
  }

  let submitted = false
  const clicks = []

  const withGlobals = (fn, arg) => {
    const g = globalThis
    const saved = { document: g.document, window: g.window, Node: g.Node, Element: g.Element, HTMLElement: g.HTMLElement, CSS: g.CSS, getComputedStyle: g.getComputedStyle, Event: g.Event, CustomEvent: g.CustomEvent }
    g.document = doc
    g.window = window
    g.Node = window.Node
    g.Element = window.Element
    g.CSS = window.CSS || { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&') }
    g.HTMLElement = window.HTMLElement
    g.Event = window.Event
    g.CustomEvent = window.CustomEvent
    g.getComputedStyle = window.getComputedStyle.bind(window)
    try { return fn(arg) } finally { Object.assign(g, saved) }
  }

  function wrapHandle(el) {
    if (!el) return null
    return {
      evaluate: async (fn) => withGlobals(() => fn(el)),
      fill: async (v) => { el.value = String(v); el.dispatchEvent(new window.Event('input', { bubbles: true })); el.dispatchEvent(new window.Event('change', { bubbles: true })) },
      check: async () => { el.checked = true; el.dispatchEvent(new window.Event('change', { bubbles: true })) },
      // Real select semantics: choose by label or by value, throw when neither
      // matches — that throw is what makes the engine try its alternates.
      selectOption: async (arg) => {
        const wantLabel = arg && typeof arg === 'object' && 'label' in arg ? String(arg.label) : null
        const wantValue = typeof arg === 'string' ? arg : (arg && typeof arg === 'object' && 'value' in arg ? String(arg.value) : null)
        const opts = Array.from(el.options || [])
        const hit = opts.find((o) => (wantLabel !== null && (o.textContent || '').trim() === wantLabel) || (wantValue !== null && o.value === wantValue))
        if (!hit) throw new Error(`no option matches ${JSON.stringify(arg)}`)
        el.value = hit.value
        el.dispatchEvent(new window.Event('change', { bubbles: true }))
      },
      setInputFiles: async () => {},
      press: async () => {},
      type: async (v) => { el.value = `${el.value || ''}${v}` },
      click: async () => {
        const type = (el.getAttribute('type') || '').toLowerCase()
        clicks.push((el.textContent || el.value || '').trim())
        if (type === 'submit' || /submit/i.test(el.textContent || '')) {
          submitted = true
          doc.body.innerHTML = confirmationHtml
          doc.title = 'Application submitted'
        }
      },
    }
  }

  return {
    _submitted: () => submitted,
    _clicks: () => clicks.slice(),
    _doc: doc,
    _removeCaptcha: () => { const c = doc.querySelector('[data-sitekey]'); if (c) c.remove() },
    url: () => url,
    content: async () => doc.documentElement.outerHTML,
    title: async () => doc.title,
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForNavigation: async () => {},
    waitForTimeout: async () => {},
    screenshot: async (opts = {}) => { if (opts.path) { try { fs.writeFileSync(opts.path, Buffer.from('PNG-fake-e2e')) } catch { /* dir may not exist */ } } return Buffer.from('PNG-fake-e2e') },
    locator: (sel) => ({
      count: async () => { try { return doc.querySelectorAll(sel).length } catch { return 0 } },
      first: () => ({ click: async () => {} }),
      innerText: async () => { try { const el = doc.querySelector(sel); return el ? (el.textContent || '') : '' } catch { return '' } },
    }),
    $: async (sel) => {
      try { return wrapHandle(doc.querySelector(sel)) } catch {
        for (const part of String(sel).split(',')) {
          try { const e = doc.querySelector(part.trim()); if (e) return wrapHandle(e) } catch { /* skip */ }
        }
        return null
      }
    },
    $$: async (sel) => { try { return Array.from(doc.querySelectorAll(sel)).map(wrapHandle) } catch { return [] } },
    $$eval: async (sel, fn, arg) => withGlobals(() => fn(Array.from(doc.querySelectorAll(sel)), arg)),
    $eval: async (sel, fn, arg) => withGlobals(() => fn(doc.querySelector(sel), arg)),
    evaluate: async (fn, arg) => withGlobals(() => fn(arg)),
    context: () => ({ close: async () => {}, storageState: async () => ({}) }),
    close: async () => {},
  }
}
