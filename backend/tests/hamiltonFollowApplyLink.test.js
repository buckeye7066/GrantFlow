/**
 * LANDING PAGE → APPLICATION FORM (real browser).
 *
 * The single biggest "waiting for review" bucket on a real profile (86 of 200,
 * 2026-08-22) was `no_application_form`: a "portal" URL that points at a program
 * LANDING page whose only control is an "Apply" / "Start Application" link that
 * NAVIGATES to the real form. Hamilton filtered that control out (no fields to
 * fill on a landing page) and dead-ended one click from the application. The
 * engine now follows the apply link and re-inspects the form it leads to.
 *
 * Driven through a REAL headless Chromium so the actual navigation + form
 * detection runs. Skips gracefully without a chromium binary.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import { runAutopilot } from '../services/hamilton/hamiltonAutopilotEngine.js'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'c'.repeat(64)

let chromium = null
let hasBrowser = false
try {
  ({ chromium } = await import('playwright'))
  const exe = chromium.executablePath?.()
  hasBrowser = Boolean(exe && fs.existsSync(exe))
} catch { hasBrowser = false }
const run = hasBrowser ? describe : describe.skip

// A program LANDING page: no form, just an "Apply Now" link to /apply.
const LANDING_HTML = `<!DOCTYPE html><html><head><title>Scholarship — Program Details</title></head>
<body>
  <h1>The Example Scholarship</h1>
  <p>A merit award for students. Read the details below.</p>
  <a href="/apply" role="button">Apply Now</a>
</body></html>`

// The real application form at /apply.
const FORM_HTML = `<!DOCTYPE html><html><head><title>Application</title></head>
<body>
  <form action="/confirmation" method="get">
    <label for="first_name">First name</label><input id="first_name" name="first_name" />
    <label for="last_name">Last name</label><input id="last_name" name="last_name" />
    <label for="email">Email</label><input id="email" name="email" type="email" />
    <button type="submit">Submit application</button>
  </form>
</body></html>`

const CONFIRM_HTML = `<!DOCTYPE html><html><head><title>Application submitted</title></head>
<body><h1>Application submitted</h1><p>Confirmation Number: APPLY-NAV-777</p></body></html>`

let browser
beforeAll(async () => { if (hasBrowser) browser = await chromium.launch({ headless: true }) }, 60_000)
afterAll(async () => { await browser?.close?.() })

run('follow the apply link from a landing page to the real form', () => {
  it('navigates landing → /apply → fills → submits (not no_application_form)', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.route('**/*', (route) => {
      const u = route.request().url()
      const body = u.includes('/confirmation') ? CONFIRM_HTML
        : u.includes('/apply') ? FORM_HTML
          : LANDING_HTML
      route.fulfill({ status: 200, contentType: 'text/html', body })
    })
    try {
      const result = await runAutopilot({
        url: 'https://fixture.invalid/scholarship',
        profile: { basic_information: { first_name: 'Jordan', last_name: 'Rivera', email: 'jordan@example.org' } },
        authorizations: { submit_applications: true, complete_forms: true },
        allowAutoSubmit: true,
        fullAutomation: true,
        beforeSubmit: async () => ({ allow: true, reason: 'authorized', decision: {} }),
        headless: true,
        _testPage: page,
      })
      const steps = (result.trace || []).map((t) => t.step)
      // It followed the apply link instead of dead-ending.
      expect(steps).toContain('follow_apply_link')
      expect(result.blocker_kind).not.toBe('no_application_form')
      // Reached the real form, filled it, and submitted.
      expect((result.filled_fields || []).length).toBeGreaterThan(0)
      expect(result.status).toBe('submitted')
    } finally {
      await context.close()
    }
  }, 60_000)
})
