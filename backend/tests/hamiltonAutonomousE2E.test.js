/**
 * END-TO-END: under full automation, Hamilton drives a real portal FORM to the
 * submit click with NO human hand-off — solving the CAPTCHA, filling an identity
 * field from the encrypted vault, and typing the applicant's electronic
 * signature, all in ONE run of the REAL engine.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * Owner goal 2026-08-21: "Hamilton will be able to finish submissions in every
 * portal e2e completely autonomous if the profile has full automation toggled
 * on." Every piece was unit-tested, but nothing exercised the WHOLE gauntlet in
 * one engine run reaching submit. This does.
 *
 * It is NOT a stub asserting on itself: it drives the actual `runAutopilot`
 * against a real DOM (jsdom) — the engine's own gate detection, field matching,
 * fill loop, e-signature logic, captcha branch and submit boundary all run for
 * real. The only accommodations are (a) a jsdom page instead of Chromium (via
 * the engine's `_testPage` seam), and (b) getBoundingClientRect returns a
 * visible rect because jsdom does no layout — neither changes the logic under
 * test. A live per-portal confirmation still happens against the real deploy;
 * this proves the autonomous machinery completes the path.
 */
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import { JSDOM } from 'jsdom'
import { runAutopilot } from '../services/hamilton/hamiltonAutopilotEngine.js'

// A representative single-page application form presenting, at once: a reCAPTCHA
// widget, a required SSN field (identity proofing), an electronic-signature
// field, and a submit button. On submit it becomes a confirmation page — which
// is how a real portal behaves and what lets the run report a true submission.
function gauntletPage() {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head><title>Scholarship Application</title></head><body>
      <form>
        <div class="g-recaptcha" data-sitekey="6Lc_e2e_test"></div>
        <textarea name="g-recaptcha-response"></textarea>
        <label for="ssn">Social Security Number</label>
        <input id="ssn" name="ssn" type="text" required />
        <label for="sig">Type your full legal name to sign (electronic signature)</label>
        <input id="sig" name="applicant_esignature" type="text" required />
        <button type="submit">Submit application</button>
      </form>
    </body></html>`,
    { url: 'https://hamilton-submit-fixture.invalid/apply' },
  )
  const { window } = dom
  const doc = window.document
  // jsdom performs no layout, so every element's rect is 0×0 and the engine's
  // visibility filter would drop them. Give elements a visible rect — this
  // changes nothing about the matching/fill logic under test.
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { width: 160, height: 24, top: 0, left: 0, right: 160, bottom: 24, x: 0, y: 0 }
  }
  // jsdom implements textContent but not innerText (which needs layout); the
  // engine's button detector reads innerText. Alias it to textContent so a
  // <button>Submit</button> is seen — a rendering accommodation, not logic.
  if (!Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'innerText')) {
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
      configurable: true,
      get() { return this.textContent },
      set(v) { this.textContent = v },
    })
  }

  let submitted = false

  const withGlobals = (fn, arg) => {
    const g = globalThis
    const saved = { document: g.document, window: g.window, Node: g.Node, Element: g.Element, CSS: g.CSS, getComputedStyle: g.getComputedStyle }
    g.document = doc
    g.window = window
    g.Node = window.Node
    g.Element = window.Element
    g.CSS = window.CSS || { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&') }
    g.getComputedStyle = window.getComputedStyle.bind(window)
    try { return fn(arg) } finally { Object.assign(g, saved) }
  }

  function wrapHandle(el) {
    if (!el) return null
    return {
      evaluate: async (fn) => withGlobals(() => fn(el)),
      fill: async (v) => { el.value = String(v); el.dispatchEvent(new window.Event('input', { bubbles: true })); el.dispatchEvent(new window.Event('change', { bubbles: true })) },
      check: async () => { el.checked = true; el.dispatchEvent(new window.Event('change', { bubbles: true })) },
      selectOption: async () => {},
      setInputFiles: async () => {},
      press: async () => {},
      type: async (v) => { el.value = `${el.value || ''}${v}` },
      click: async () => {
        const type = (el.getAttribute('type') || '').toLowerCase()
        if (type === 'submit' || /submit/i.test(el.textContent || '')) {
          submitted = true
          // The portal becomes a confirmation page once submitted.
          doc.body.innerHTML = '<h1>Application submitted</h1><p>Thank you. Your confirmation number is E2E-CONF-4821.</p>'
          doc.title = 'Application submitted'
        }
      },
    }
  }

  const page = {
    _submitted: () => submitted,
    _removeCaptcha: () => { const c = doc.querySelector('[data-sitekey]'); if (c) c.remove() },
    url: () => 'https://hamilton-submit-fixture.invalid/apply',
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
        // A selector jsdom can't parse (e.g. an `i` attribute flag it rejects):
        // test each comma part so a supported branch still matches.
        for (const part of String(sel).split(',')) {
          try { const e = doc.querySelector(part.trim()); if (e) return wrapHandle(e) } catch { /* skip this part */ }
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
  return page
}

const FULL_AUTH = {
  submit_applications: true,
  complete_forms: true,
  generate_narratives: true,
  upload_documents: true,
  use_standing_attestation: true,
  use_saved_session: true,
  use_saved_credentials_reference: true,
}

describe('E2E: full automation completes the portal gauntlet with no human hand-off', () => {
  it('solves the captcha, fills the SSN from the vault, e-signs, and clicks submit — autonomously', async () => {
    const page = gauntletPage()
    // The solver stands in for the CapSolver call (verified live separately);
    // like a real solver, a success removes the challenge widget.
    const solveCaptcha = vi.fn(async (livePage) => { livePage._removeCaptcha(); return { solved: true, vendor: 'recaptcha' } })
    // The irreversible-boundary gate the orchestrator supplies — here it allows,
    // which is what proves the run REACHED the submit boundary autonomously.
    const beforeSubmit = vi.fn(async () => ({ allow: true, reason: 'authorized', decision: {} }))

    const result = await runAutopilot({
      url: 'https://hamilton-submit-fixture.invalid/apply',
      profile: { basic_information: { first_name: 'Jane', last_name: 'Applicant', email: 'jane@example.org' } },
      authorizations: FULL_AUTH,
      allowAutoSubmit: true,
      fullAutomation: true,
      identityValues: { ssn: '123-45-6789' },
      solveCaptcha,
      beforeSubmit,
      headless: true,
      _testPage: page,
    })

    // 1. The CAPTCHA was solved by the engine's own gate branch.
    expect(solveCaptcha).toHaveBeenCalled()
    const traceSteps = (result.trace || []).map((t) => t.step)
    expect(traceSteps).toContain('captcha_result')
    expect((result.trace || []).find((t) => t.step === 'captcha_result')?.detail?.solved).toBe(true)

    // 2. The SSN was filled FROM THE VAULT — and its value never entered the trace.
    const ssnFill = (result.filled_fields || []).find((f) => f.key === 'id_ssn')
    expect(ssnFill).toBeTruthy()
    expect(ssnFill.source).toBe('identity_vault')
    expect(JSON.stringify(result.filled_fields)).not.toContain('123-45-6789')

    // 3. The applicant's electronic signature was typed.
    expect(traceSteps).toContain('signature_typed')

    // 4. Hamilton REACHED the irreversible submit boundary and clicked — no human
    //    hand-off blocker anywhere in the run.
    expect(beforeSubmit).toHaveBeenCalled()
    expect(page._submitted()).toBe(true)
    expect(result.requires_human_handoff).not.toBe(true)
    // The portal returned a confirmation reference, so the run reports a REAL
    // external submission — the whole gauntlet completed autonomously.
    expect(result.status).toBe('submitted')
    // And no human-required gate stopped it anywhere.
    expect(result.blocker_kind ?? null).toBe(null)
  })

  it('with the SSN NOT in the vault, the run asks for it by name instead of fabricating', async () => {
    const page = gauntletPage()
    const solveCaptcha = vi.fn(async (livePage) => { livePage._removeCaptcha(); return { solved: true, vendor: 'recaptcha' } })
    const result = await runAutopilot({
      url: 'https://hamilton-submit-fixture.invalid/apply',
      profile: { basic_information: { first_name: 'Jane', last_name: 'Applicant', email: 'jane@example.org' } },
      authorizations: FULL_AUTH,
      allowAutoSubmit: true,
      fullAutomation: true,
      identityValues: {}, // nothing on file
      solveCaptcha,
      beforeSubmit: async () => ({ allow: true, reason: 'authorized', decision: {} }),
      headless: true,
      _testPage: page,
    })
    // It stops with a NAMED identity request — never fabricates, never submits.
    expect(result.status).toBe('blocked')
    expect(result.blocker_kind).toBe('identity_proof')
    expect(result.missing_identity_kinds).toContain('ssn')
    expect(page._submitted()).toBe(false)
  })
})
