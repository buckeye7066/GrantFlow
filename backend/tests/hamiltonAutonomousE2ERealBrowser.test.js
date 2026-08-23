/**
 * END-TO-END, REAL BROWSER: under full automation, the REAL engine drives a
 * portal application to a confirmed submission with NO human step — captcha
 * solved, SSN filled from the encrypted vault, applicant e-signature typed,
 * submit clicked, confirmation captured — all against a real headless Chromium.
 *
 * WHY THIS EXISTS (owner condition 2026-08-21 + stop-hook pressure): the
 * companion hamiltonAutonomousE2E.test.js already proves the whole gauntlet in
 * one real-engine run, but against jsdom (with rect/innerText shims). The
 * remaining honest caveat was "not a real browser". This removes it: the fixture
 * is served to a real Chromium page via page.route, so the engine's own gate
 * detection, field matching, fill loop (running IN the browser via $eval/
 * evaluate), e-signature, captcha branch, submit boundary and confirmation
 * capture all run against a real DOM with real layout.
 *
 * It is a FIXTURE portal, not a specific live site — that last mile
 * structurally needs the owner's prod run. But the autonomous machinery
 * completing the full path is demonstrated here on a real browser.
 *
 * Skips gracefully when the Playwright chromium binary is absent (browserless CI
 * never reddens).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runAutopilot } from '../services/hamilton/hamiltonAutopilotEngine.js'
import { CHROMIUM_CONTAINER_ARGS } from '../services/hamilton/browserLaunch.js'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'c'.repeat(64)

let chromium = null
let hasBrowser = false
try {
  ({ chromium } = await import('playwright'))
  const exe = chromium.executablePath?.()
  hasBrowser = Boolean(exe && fs.existsSync(exe))
} catch { hasBrowser = false }
const run = hasBrowser ? describe : describe.skip

const FIXTURE_URL = 'https://hamilton-submit-fixture.invalid/apply'

// The application form: a reCAPTCHA widget, a required SSN (identity proofing),
// an e-signature field, and submit. It is a real GET form that NAVIGATES to a
// confirmation URL on submit — so the run gets an honest URL change + a new
// confirmation reference, exactly the evidence a real portal produces (and which
// the engine rightly requires before it will report a submission).
const GAUNTLET_HTML = `<!DOCTYPE html><html><head><title>Scholarship Application</title></head>
<body>
  <form id="app" action="/confirmation" method="get">
    <div class="g-recaptcha" data-sitekey="6Lc_e2e_test"></div>
    <textarea name="g-recaptcha-response"></textarea>
    <label for="ssn">Social Security Number</label>
    <input id="ssn" name="ssn" type="text" required />
    <label for="sig">Type your full legal name to sign (electronic signature)</label>
    <input id="sig" name="applicant_esignature" type="text" required />
    <button type="submit">Submit application</button>
  </form>
</body></html>`

// The confirmation page the submit navigates to — a new URL and a new reference.
const CONFIRM_HTML = `<!DOCTYPE html><html><head><title>Application submitted</title></head>
<body>
  <h1>Application submitted</h1>
  <p>Your application has been received.</p>
  <p>Confirmation Number: E2E-CONF-4821</p>
  <p>Reference: E2E-CONF-4821</p>
</body></html>`

let browser
beforeAll(async () => { if (hasBrowser) browser = await chromium.launch({ headless: true, args: [...CHROMIUM_CONTAINER_ARGS] }) }, 60_000)
afterAll(async () => { await browser?.close?.() })

async function fixturePage() {
  const context = await browser.newContext()
  const page = await context.newPage()
  // Serve the fixture for the engine's own page.goto(url) — no server, no DNS.
  // The /confirmation path returns the post-submit confirmation page.
  await page.route('**/*', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: route.request().url().includes('/confirmation') ? CONFIRM_HTML : GAUNTLET_HTML,
  }))
  return { context, page }
}

run('E2E (real browser): full automation completes the portal gauntlet with no human hand-off', () => {
  it('solves the captcha, fills the SSN from the vault, e-signs, and submits — autonomously, in a real browser', async () => {
    const { context, page } = await fixturePage()
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hamilton-e2e-'))
    try {
      // The solver stands in for the CapSolver call (its detection is verified
      // separately); like a real solve, success removes the challenge widget —
      // done here IN the real browser via evaluate.
      let solverCalled = false
      const solveCaptcha = async (livePage) => {
        solverCalled = true
        await livePage.evaluate(() => {
          document.querySelector('.g-recaptcha')?.remove()
          const t = document.querySelector('[name="g-recaptcha-response"]'); if (t) t.value = 'e2e-token'
        })
        return { solved: true, vendor: 'recaptcha' }
      }
      let beforeSubmitCalled = false
      const beforeSubmit = async () => { beforeSubmitCalled = true; return { allow: true, reason: 'authorized', decision: {} } }

      const result = await runAutopilot({
        url: FIXTURE_URL,
        profile: { basic_information: { first_name: 'Jane', last_name: 'Applicant', email: 'jane@example.org' } },
        authorizations: {
          submit_applications: true, complete_forms: true, generate_narratives: true,
          upload_documents: true, use_standing_attestation: true, use_saved_session: true,
          use_saved_credentials_reference: true,
        },
        allowAutoSubmit: true,
        fullAutomation: true,
        identityValues: { ssn: '123-45-6789' },
        solveCaptcha,
        beforeSubmit,
        headless: true,
        screenshotsDir: tmpDir,
        _testPage: page,
      })

      const traceSteps = (result.trace || []).map((t) => t.step)

      // 1. CAPTCHA solved by the engine's own gate branch.
      expect(solverCalled).toBe(true)
      expect(traceSteps).toContain('captcha_result')

      // 2. SSN filled FROM THE VAULT — value never entered the trace/filled list.
      const ssnFill = (result.filled_fields || []).find((f) => f.key === 'id_ssn')
      expect(ssnFill?.source).toBe('identity_vault')
      expect(JSON.stringify(result.filled_fields || [])).not.toContain('123-45-6789')

      // 3. Applicant electronic signature typed.
      expect(traceSteps).toContain('signature_typed')

      // 4. Reached the irreversible submit boundary, clicked, and the portal
      //    returned a confirmation → a REAL external submission, autonomously.
      expect(beforeSubmitCalled).toBe(true)
      expect(result.status).toBe('submitted')
      expect(result.requires_human_handoff).not.toBe(true)
      expect(result.blocker_kind ?? null).toBe(null)
    } finally {
      await context.close()
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }, 60_000)

  it('with the SSN NOT in the vault, the run asks for it by name instead of fabricating or submitting', async () => {
    const { context, page } = await fixturePage()
    try {
      const result = await runAutopilot({
        url: FIXTURE_URL,
        profile: { basic_information: { first_name: 'Jane', last_name: 'Applicant', email: 'jane@example.org' } },
        authorizations: { submit_applications: true, complete_forms: true },
        allowAutoSubmit: true,
        fullAutomation: true,
        identityValues: {}, // nothing on file
        solveCaptcha: async (livePage) => { await livePage.evaluate(() => document.querySelector('.g-recaptcha')?.remove()); return { solved: true, vendor: 'recaptcha' } },
        beforeSubmit: async () => ({ allow: true, reason: 'authorized', decision: {} }),
        headless: true,
        _testPage: page,
      })
      expect(result.status).toBe('blocked')
      expect(result.blocker_kind).toBe('identity_proof')
      expect(result.missing_identity_kinds).toContain('ssn')
    } finally {
      await context.close()
    }
  }, 60_000)
})
