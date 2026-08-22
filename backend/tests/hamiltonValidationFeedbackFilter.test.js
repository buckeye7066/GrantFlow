/**
 * A page-feedback / fraud-report widget must not block a real application.
 *
 * Live evidence 2026-08-21 (Anastasia's run): a real TANF submission was hard-
 * blocked with "Was this page helpful? field is required" — a government-site
 * feedback survey that sits in the same <form> as the real submit control, so
 * its required Yes/No radio failed checkValidity() and sank the application.
 * detectNativeValidationErrors now skips such widgets; a genuine unfilled
 * required APPLICATION field still blocks, exactly as before.
 */
import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { _internal } from '../services/hamilton/hamiltonAutopilotEngine.js'

const { detectNativeValidationErrors } = _internal

// Minimal page wrapper: $eval runs the fn against a jsdom form.
function pageFor(html) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`)
  const doc = dom.window.document
  return {
    $eval: async (sel, fn, arg) => {
      const g = globalThis
      const saved = { window: g.window, document: g.document }
      g.window = dom.window; g.document = doc
      try { return fn(doc.querySelector(sel), arg) } finally { Object.assign(g, saved) }
    },
  }
}

const SUBMIT = '<button type="submit" data-hamilton-btn="b0">Submit application</button>'

describe('detectNativeValidationErrors — feedback widgets never block submission', () => {
  it('ignores a required "Was this page helpful?" feedback radio in the same form', async () => {
    const page = pageFor(`
      <form>
        <input name="first_name" value="Jane" required />
        <fieldset>
          <legend>Was this page helpful?</legend>
          <input type="radio" name="page_helpful" required />
        </fieldset>
        ${SUBMIT}
      </form>`)
    // Every real application field is filled; only the feedback radio is empty.
    const errors = await detectNativeValidationErrors(page, 'b0')
    expect(errors).toEqual([])
  })

  it('ignores a "Report suspected fraud" and a newsletter widget', async () => {
    const page = pageFor(`
      <form>
        <input name="email" value="jane@example.org" required />
        <input name="report_fraud_ack" aria-label="Report suspected fraud" required />
        <input name="newsletter_signup" aria-label="Subscribe to our newsletter" required />
        ${SUBMIT}
      </form>`)
    expect(await detectNativeValidationErrors(page, 'b0')).toEqual([])
  })

  it('STILL blocks a genuinely unfilled required APPLICATION field', async () => {
    const page = pageFor(`
      <form>
        <label for="ssn">Social Security Number</label>
        <input id="ssn" name="ssn" required />
        <fieldset><legend>Was this page helpful?</legend><input type="radio" name="page_helpful" required /></fieldset>
        ${SUBMIT}
      </form>`)
    const errors = await detectNativeValidationErrors(page, 'b0')
    expect(errors.length).toBe(1)
    expect(errors[0]).toMatch(/Social Security Number|ssn/i)
    // The feedback radio is NOT reported.
    expect(errors.join(' ')).not.toMatch(/helpful/i)
  })

  it('returns [] when everything real is valid', async () => {
    const page = pageFor(`<form><input name="first_name" value="Jane" required />${SUBMIT}</form>`)
    expect(await detectNativeValidationErrors(page, 'b0')).toEqual([])
  })
})
