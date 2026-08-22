/**
 * A SOLVABLE bot-protection wall (Cloudflare Turnstile) must be routed to the
 * CAPTCHA solver, not dead-ended at the co-browse hand-off.
 *
 * detectBotWall runs FIRST in detectGate, so a full-page Cloudflare interstitial
 * returns `bot_protected` and used to skip the captcha branch entirely — even
 * when the interstitial is a Turnstile challenge CapSolver can solve proxyless.
 * The engine now gives a bot_protected gate a solver attempt before the hard
 * stop: a solvable challenge (a sitekey is present) is cleared and the run
 * proceeds; an UNSOLVABLE managed challenge (no widget) still hands off exactly
 * as before. This removes the block for the solvable subset without ever
 * claiming to pass a wall it did not.
 */
import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { runAutopilot } from '../services/hamilton/hamiltonAutopilotEngine.js'

// A minimal Playwright-shaped page backed by jsdom whose DOM the test can swap
// (the solver "clearing" the wall = swapping to a benign page).
function seamPage(initialHtml) {
  let dom = new JSDOM(`<!DOCTYPE html><html><head><title>Just a moment…</title></head><body>${initialHtml}</body></html>`, { url: 'https://portal.example.org/apply' })
  const withGlobals = (fn, arg) => {
    const g = globalThis
    const saved = { document: g.document, window: g.window }
    g.document = dom.window.document; g.window = dom.window
    try { return fn(arg) } finally { Object.assign(g, saved) }
  }
  return {
    _swap(html, title = 'Application') {
      dom = new JSDOM(`<!DOCTYPE html><html><head><title>${title}</title></head><body>${html}</body></html>`, { url: 'https://portal.example.org/apply' })
    },
    url: () => dom.window.document.location.href,
    title: async () => dom.window.document.title,
    content: async () => dom.window.document.documentElement.outerHTML,
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForNavigation: async () => {},
    waitForTimeout: async () => {},
    screenshot: async () => Buffer.from('x'),
    $: async (sel) => { try { const e = dom.window.document.querySelector(sel); return e ? { } : null } catch { return null } },
    $$: async () => [],
    $eval: async (sel, fn, arg) => withGlobals(() => fn(dom.window.document.querySelector(sel), arg)),
    $$eval: async (sel, fn, arg) => withGlobals(() => fn(Array.from(dom.window.document.querySelectorAll(sel)), arg)),
    evaluate: async (fn, arg) => withGlobals(() => (typeof fn === 'function' ? fn(arg) : undefined)),
    context: () => ({ close: async () => {}, storageState: async () => ({}) }),
    close: async () => {},
  }
}

// The verbatim shape of a Cloudflare Turnstile interstitial: the strong bot-wall
// copy AND a cf-turnstile widget carrying a sitekey (so it is SOLVABLE).
const TURNSTILE_WALL = `
  <h1>Checking your browser before accessing the site</h1>
  <p>Performing security verification… this website uses a security service to protect itself. Ray ID: 8a2b. Cloudflare</p>
  <div class="cf-turnstile" data-sitekey="0x4AAAAAAA_turnstile_key"></div>
  <input name="cf-turnstile-response" type="hidden" />`

describe('bot-wall → solver routing', () => {
  it('routes a solvable Turnstile wall to the solver and proceeds past it', async () => {
    const page = seamPage(TURNSTILE_WALL)
    let solverCalled = false
    const solveCaptcha = async (livePage) => {
      solverCalled = true
      // A real solve clears the interstitial; here the wall is replaced by a
      // trivially-complete page so the run moves on.
      livePage._swap('<h1>Welcome</h1><p>Signed in.</p>')
      return { solved: true, vendor: 'turnstile' }
    }
    const result = await runAutopilot({
      url: 'https://portal.example.org/apply',
      profile: { basic_information: { first_name: 'Jane', last_name: 'Applicant', email: 'jane@example.org' } },
      authorizations: { complete_forms: true },
      solveCaptcha,
      headless: true,
      _testPage: page,
    })
    expect(solverCalled).toBe(true)
    // The run did NOT dead-end as a bot wall — it got past it.
    expect(result.blocker_kind).not.toBe('bot_protected')
    expect((result.trace || []).some((t) => t.step === 'captcha_attempt' && t.detail?.source === 'bot_wall')).toBe(true)
  })

  it('still hands off a bot wall when no solver is configured (unchanged)', async () => {
    const page = seamPage(TURNSTILE_WALL)
    const result = await runAutopilot({
      url: 'https://portal.example.org/apply',
      profile: { basic_information: { first_name: 'Jane', last_name: 'Applicant', email: 'jane@example.org' } },
      authorizations: { complete_forms: true },
      solveCaptcha: null, // no solver
      headless: true,
      _testPage: page,
    })
    expect(result.blocker_kind).toBe('bot_protected')
  })

  it('hands off when the solver cannot solve the wall (no sitekey / managed challenge)', async () => {
    const page = seamPage(TURNSTILE_WALL)
    const result = await runAutopilot({
      url: 'https://portal.example.org/apply',
      profile: { basic_information: { first_name: 'Jane', last_name: 'Applicant', email: 'jane@example.org' } },
      authorizations: { complete_forms: true },
      // Solver runs but cannot solve — the wall persists, so the run hands off.
      solveCaptcha: async () => ({ solved: false, reason: 'no_sitekey_on_page' }),
      headless: true,
      _testPage: page,
    })
    expect(result.blocker_kind).toBe('bot_protected')
  })
})
