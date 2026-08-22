/**
 * REAL-BROWSER: Hamilton answers portal-specific questions its fixed field
 * vocabulary does NOT recognize, via the injected LLM field-understanding layer.
 *
 * A form with standard fields (filled by FIELD_RULES) AND custom questions
 * ("Describe your community involvement", "What is your intended research
 * area?") that only the answerer can handle. With the answerer injected, the
 * custom fields are filled and the application submits; without it, they stay
 * blank (the prior behavior). Uses a FAKE answerer (grounded) so the test is
 * hermetic — the real one is unit-tested in hamiltonFieldAnswerer.test.js.
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

const FORM_HTML = `<!DOCTYPE html><html><head><title>Scholarship Application</title></head>
<body>
  <form action="/confirmation" method="get">
    <label for="first_name">First name</label><input id="first_name" name="first_name" />
    <label for="email">Email</label><input id="email" name="email" type="email" />
    <label for="ci">Your involvement with local organizations</label>
    <textarea id="involve" name="local_org_involvement" required></textarea>
    <label for="ra">Intended research area</label>
    <input id="ra" name="research_area" type="text" required />
    <button type="submit">Submit application</button>
  </form>
</body></html>`

const CONFIRM_HTML = `<!DOCTYPE html><html><head><title>Application submitted</title></head>
<body><h1>Application submitted</h1><p>Confirmation Number: UNKFIELD-9</p></body></html>`

let browser
beforeAll(async () => { if (hasBrowser) browser = await chromium.launch({ headless: true }) }, 60_000)
afterAll(async () => { await browser?.close?.() })

async function formPage() {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.route('**/*', (route) => route.fulfill({
    status: 200, contentType: 'text/html',
    body: route.request().url().includes('/confirmation') ? CONFIRM_HTML : FORM_HTML,
  }))
  return { context, page }
}

// A fake answerer: grounded, deterministic — mimics the real service's contract.
const fakeAnswerer = (field) => {
  const label = String(field?.label || '').toLowerCase()
  if (label.includes('involvement') || label.includes('organizations')) return Promise.resolve({ value: 'Volunteers as an EMT with the county rescue squad.', free_text: true, grounded_in: ['activities'] })
  if (label.includes('research area')) return Promise.resolve({ value: 'Forensic Science', free_text: false, grounded_in: ['education.major'] })
  return Promise.resolve(null)
}

run('Hamilton answers unrecognized portal questions (real browser)', () => {
  it('fills the custom community + research questions via the answerer and submits', async () => {
    const { context, page } = await formPage()
    try {
      const result = await runAutopilot({
        url: 'https://fixture.invalid/apply',
        profile: {
          basic_information: { first_name: 'Jordan', last_name: 'Rivera', email: 'jordan@example.org' },
          education: { major: 'Forensic Science' },
        },
        authorizations: { submit_applications: true, complete_forms: true, generate_narratives: true },
        allowAutoSubmit: true,
        fullAutomation: true,
        answerUnknownField: fakeAnswerer,
        beforeSubmit: async () => ({ allow: true, reason: 'authorized', decision: {} }),
        headless: true,
        _testPage: page,
      })
      const steps = (result.trace || []).map((t) => t.step)
      const keys = (result.filled_fields || []).map((f) => f.key)
      // Standard field recognized by FIELD_RULES:
      expect(keys).toContain('first_name')
      // Custom questions answered by the LLM layer:
      expect(steps.filter((s) => s === 'llm_field_answer').length).toBeGreaterThanOrEqual(2)
      // And the form went through:
      expect(result.status).toBe('submitted')
    } finally {
      await context.close()
    }
  }, 60_000)

  it('without the answerer, the required custom fields stay blank (blocked, not fabricated)', async () => {
    const { context, page } = await formPage()
    try {
      const result = await runAutopilot({
        url: 'https://fixture.invalid/apply',
        profile: { basic_information: { first_name: 'Jordan', last_name: 'Rivera', email: 'jordan@example.org' } },
        authorizations: { submit_applications: true, complete_forms: true, generate_narratives: true },
        allowAutoSubmit: true,
        fullAutomation: true,
        // no answerUnknownField
        beforeSubmit: async () => ({ allow: true, reason: 'authorized', decision: {} }),
        headless: true,
        _testPage: page,
      })
      // The required custom fields were never filled — Hamilton never invented a
      // value; the native-validation gate holds it as a validation blocker.
      const steps = (result.trace || []).map((t) => t.step)
      expect(steps).not.toContain('llm_field_answer')
      expect(result.status).not.toBe('submitted')
    } finally {
      await context.close()
    }
  }, 60_000)
})
