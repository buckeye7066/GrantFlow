/**
 * A homepage SEARCH BOX is never an application (prod 2026-07-03/04).
 *
 * Eleven 'submitted' autopilot runs for one profile navigated to
 * https://www.questbridge.org/ (the homepage), inspected field_count 1 and a
 * single button 'Submit', filled 0 fields, clicked the site-search 'Submit'
 * and recorded status 'submitted' with confirmation null. Those rows predate
 * the evidence-honesty rails; this suite pins that the CURRENT engine can
 * never reproduce them through either door:
 *
 *   1. nothing filled + zero recognised fields → no_application_form
 *      (the submit-hunt truthfulness gate), and
 *   2. even when the LLM field layer FILLS the search box (a text/search
 *      input is "answerable"), the one-field bare-'Submit' search form is
 *      refused at the submit boundary (isContactOrNewsletterForm) — the
 *      click never happens, so no evidence and no 'submitted'.
 *
 * Engine-level, driven through the real runAutopilot on a jsdom page whose
 * submit handler would replace the body with a confirmation banner if it were
 * ever clicked.
 */
import { describe, it, expect } from 'vitest'
import { runAutopilot, SUBMIT_BUTTON_EXCLUDE_RX, _internal } from '../services/hamilton/hamiltonAutopilotEngine.js'
import { makeJsdomPortalPage } from './helpers/jsdomPortalPage.js'

const FULL_AUTH = {
  submit_applications: true,
  complete_forms: true,
  generate_narratives: true,
  upload_documents: true,
  use_standing_attestation: true,
  use_saved_session: true,
  use_saved_credentials_reference: true,
}
const PROFILE = {
  applicant_type: 'student',
  basic_information: { first_name: 'Robert', last_name: 'White', email: 'robert@example.org', phone: '4235550100' },
  student_info: { school_name: 'Cleveland High School', degree_level: 'High school senior' },
}

const HOMEPAGE_URL = 'https://hamilton-submit-fixture.invalid/'
function homepage() {
  return makeJsdomPortalPage(
    `<!DOCTYPE html><html><head><title>QuestBridge</title></head><body>
      <h1>QuestBridge</h1>
      <p>Connecting the nation's brightest students from low-income backgrounds with leading colleges.</p>
      <form id="site-search" action="/search" role="search">
        <label for="q">Search</label>
        <input id="q" name="q" type="search" placeholder="Search" />
        <button type="submit">Submit</button>
      </form>
      <p>Learn about the National College Match.</p>
    </body></html>`,
    { url: HOMEPAGE_URL, confirmationHtml: '<h1>Application submitted</h1><p>Your confirmation number is FAKE-99123.</p>' },
  )
}

async function run(page, extra = {}) {
  return runAutopilot({
    url: HOMEPAGE_URL,
    profile: PROFILE,
    authorizations: FULL_AUTH,
    allowAutoSubmit: true,
    fullAutomation: true,
    beforeSubmit: async () => ({ allow: true, reason: 'authorized', decision: {} }),
    headless: true,
    _testPage: page,
    ...extra,
  })
}

describe('a one-field homepage search form can never become a submitted application', () => {
  it('door 1: nothing filled, no recognised field → no_application_form, no click, never submitted', async () => {
    const page = homepage()
    const result = await run(page)
    expect(result.status).not.toBe('submitted')
    expect(result.status).toBe('blocked')
    expect(result.blocker_kind).toBe('no_application_form')
    expect(page._submitted()).toBe(false)
    expect((result.trace || []).map((t) => t.step)).not.toContain('submit_attempt')
  })

  it('door 2: the LLM layer FILLS the search box — the bare-Submit one-field search form is still refused at the boundary', async () => {
    const page = homepage()
    const result = await run(page, {
      answerUnknownField: async () => ({ value: 'scholarships for high school seniors', free_text: true, grounded_in: ['student_info'] }),
    })
    expect(result.status).not.toBe('submitted')
    expect(page._submitted()).toBe(false)
    expect((result.trace || []).map((t) => t.step)).not.toContain('submit_attempt')
    expect(result.confirmation_reference ?? null).toBeNull()
  })

  it('the exclude pattern and truthfulness gate cover the recorded prod shape (button "Submit", field_count 1, filled 0)', () => {
    // "Submit" alone is NOT excluded by text (it is the real submit word) — the
    // gate is structural: a Submit with nothing filled and no recognised
    // field is not actionable.
    expect(SUBMIT_BUTTON_EXCLUDE_RX.test('Submit')).toBe(false)
    expect(SUBMIT_BUTTON_EXCLUDE_RX.test('Submit search')).toBe(true)
    const buttons = [{ bid: 1, text: 'Submit', inForm: true, formFieldCount: 1 }]
    expect(_internal.actionableSubmitButtons(buttons, { anyFieldFilled: false, recognizedFieldCount: 0 })).toEqual([])
  })
})
