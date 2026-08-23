/**
 * E2E (jsdom, real engine): the EXACT shape of the live run that blocked in
 * prod on 2026-08-22 — a real student profile's U.S. Bank Student Scholarship form.
 *
 * The live run solved the captcha and filled 8 fields, then failed the
 * portal's native validation on:
 *   - City (the profile stores ONE address blob; City/State were never split)
 *   - "I am a college-bound student, accepted or enrolled at an undergraduate…"
 *   - "I am an undergraduate student or a trade/vocational school student…"
 *   - "I am not a graduate student, an international student, or a student
 *      attending a college outside the U.S."
 *   - "I have read and agree to the … Official Rules"
 * and the page also carried "Submit all selections" on a facet filter.
 *
 * Under full automation, with a profile that DECLARES enrollment at a U.S.
 * undergraduate school, every one of those is provable — so the run must end
 * `submitted`. With a profile that declares none of it, the boxes must stay
 * unticked and become NAMED asks — never a guess.
 */
import { describe, it, expect, vi } from 'vitest'
import { runAutopilot } from '../services/hamilton/hamiltonAutopilotEngine.js'
import { makeJsdomPortalPage } from './helpers/jsdomPortalPage.js'

function usBankPage() {
  return makeJsdomPortalPage(
    `<!DOCTYPE html><html><head><title>U.S. Bank Student Scholarship</title></head><body>
      <form id="filters"><label>Topic <select name="topic"><option>All</option></select></label>
        <button type="button">Submit all selections</button></form>
      <form id="application">
        <label for="fn">First Name</label><input id="fn" name="first_name" type="text" required />
        <label for="ln">Last Name</label><input id="ln" name="last_name" type="text" required />
        <label for="dob">Date of Birth</label><input id="dob" name="dob" type="text" required />
        <label for="a1">Address Line 1</label><input id="a1" name="address1" type="text" required />
        <label for="city">City</label><input id="city" name="city" type="text" required />
        <label for="st">State</label>
        <select id="st" name="state" required>
          <option value="">Select a state</option>
          <option value="GA">Georgia</option>
          <option value="TN">Tennessee</option>
          <option value="TX">Texas</option>
        </select>
        <label for="zip">ZIP Code</label><input id="zip" name="zip" type="text" required />
        <label for="em">Email</label><input id="em" name="email" type="email" required />
        <label for="ph">Phone</label><input id="ph" name="phone" type="text" required />
        <label for="sch">School</label><input id="sch" name="school" type="text" required />
        <div>
          <input id="e1" name="00N60000002Q0h5" type="checkbox" required />
          <label for="e1">I am 18 years old or older.</label>
          <input id="e2" name="00N60000002Q0h6" type="checkbox" required />
          <label for="e2">I am 17 years old, and my parent/guardian is aware that I am registering.</label>
          <input id="e3" name="00N60000002Q0h7" type="checkbox" required />
          <label for="e3">I am a college-bound student, accepted or enrolled at an undergraduate, trade or vocational school as of September 1, 2027. The school is an eligible, accredited two- or four-year U.S. brick-and-mortar or online college or university or trade or vocational school.</label>
          <input id="e4" name="00N60000002Q0h8" type="checkbox" required />
          <label for="e4">I am not a graduate student, an international student, or a student attending a college outside the U.S.</label>
          <input id="e5" name="00N60000002Q0h9" type="checkbox" required />
          <label for="e5">I have read and agree to the 2026 U.S. Bank Student Scholarship Sweepstakes Official Rules (linked above).</label>
        </div>
        <button type="submit">Submit and continue</button>
      </form>
    </body></html>`,
  )
}

const FULL_AUTH = {
  submit_applications: true,
  complete_forms: true,
  generate_narratives: false,
  upload_documents: true,
  use_standing_attestation: true,
  use_saved_session: true,
  use_saved_credentials_reference: true,
}

// The live profile: ONE address blob, no city/state/zip columns, enrolled at MTSU.
const STUDENT_PROFILE_SHAPE = {
  applicant_type: 'student',
  basic_information: {
    first_name: 'Avery', last_name: 'Stonebrook',
    email: 'applicant@example.org', phone: '4235550100',
    address: '3940 Eveningside Dr. NE \nCleveland, TN 37312',
  },
  student_info: { school_name: 'Middle Tennessee State University', degree_level: "Bachelor's" },
}

describe('E2E: the U.S. Bank form shape that blocked in prod (2026-08-22)', () => {
  it('splits the address, selects the state, affirms provable eligibility, agrees to the rules, and SUBMITS', async () => {
    const page = usBankPage()
    const beforeSubmit = vi.fn(async () => ({ allow: true, reason: 'authorized', decision: {} }))
    const result = await runAutopilot({
      url: 'https://hamilton-submit-fixture.invalid/apply',
      profile: STUDENT_PROFILE_SHAPE,
      authorizations: FULL_AUTH,
      allowAutoSubmit: true,
      fullAutomation: true,
      identityValues: { date_of_birth: '2006-05-14' }, // 20 years old on the live run date
      beforeSubmit,
      headless: true,
      _testPage: page,
    })
    const steps = (result.trace || []).map((t) => t.step)
    const filledByKey = Object.fromEntries((result.filled_fields || []).map((f) => [f.key, f.value]))

    // The address blob was split — City and State came from it, not left blank.
    expect(filledByKey.city).toBe('Cleveland')
    expect(filledByKey.zip).toBe('37312')
    expect(filledByKey.address1).toBe('3940 Eveningside Dr. NE')
    // The state <select> was set from "TN" (the profile) → the "Tennessee"
    // option. (The live DOM is the confirmation page post-submit, so this is
    // read from the run's filled record, which survives.)
    // The alternate-spelling path turned the profile's "TN" into the option "Tennessee".
    expect(['TN', 'Tennessee']).toContain(filledByKey.state)

    // Age: the 18+ box was affirmed and the 17-year-old alternate relaxed.
    const affirmed = (result.trace || []).find((t) => t.step === 'eligibility_affirmed')?.detail?.items || []
    const relaxed = (result.trace || []).find((t) => t.step === 'eligibility_alternate_relaxed')?.detail?.items || []
    expect(affirmed.some((s) => /18 years old or older/.test(s))).toBe(true)
    expect(relaxed.some((s) => /17 years old/.test(s))).toBe(true)

    // Eligibility statements PROVABLE from the declared profile were affirmed.
    expect(affirmed.some((s) => /college-bound student/.test(s))).toBe(true)
    expect(affirmed.some((s) => /not a graduate student/.test(s))).toBe(true)

    // "I have read and agree to the Official Rules" is consent the full-automation grant carries.
    const attested = (result.trace || []).find((t) => t.step === 'attestation_checked')?.detail?.items || []
    expect(attested.some((s) => /agree to the .*official rules/i.test(s))).toBe(true)

    // The facet filter's "Submit all selections" was never treated as the application submit.
    expect(page._clicks()).not.toContain('Submit all selections')

    // Nothing was left for a human: the run reached the boundary and submitted.
    expect(steps).not.toContain('submit_native_validation_failed')
    expect(beforeSubmit).toHaveBeenCalled()
    expect(page._submitted()).toBe(true)
    expect(result.status).toBe('submitted')
    expect(result.blocker_kind ?? null).toBe(null)
  })

  it('a RULE-mis-claimed required <select> falls through to the grounded answerer instead of failing silently (the "hear about our scholarship PROGRAM → major rule" class, 2026-08-23)', async () => {
    // The live form's survey select: its label contains "program", so
    // matchFieldKey claims it for the `major` rule and every run tried
    // selectOption("Forensic Science") — not an option — and failed silently.
    const page = makeJsdomPortalPage(
      `<!DOCTYPE html><html><head><title>U.S. Bank Student Scholarship</title></head><body>
        <form id="application">
          <label for="fn">First Name</label><input id="fn" name="first_name" type="text" required />
          <label for="ln">Last Name</label><input id="ln" name="last_name" type="text" required />
          <label for="em">Email</label><input id="em" name="email" type="email" required />
          <label for="maj">Major</label><input id="maj" name="major" type="text" />
          <label for="hear">Where did you hear about our scholarship program?</label>
          <select id="hear" name="00N60000002Q0ho" required>
            <option value="">Select</option>
            <option value="High school">High school</option>
            <option value="Scholarship finder website">Scholarship finder website</option>
            <option value="Search engine">Search engine</option>
          </select>
          <button type="submit">Submit and continue</button>
        </form>
      </body></html>`,
    )
    const answerUnknownField = vi.fn(async (f) => (
      /hear about our scholarship/i.test(String(f.label || ''))
        ? { value: 'Scholarship finder website', free_text: false, grounded_in: ['portal_survey_answers.heard_about_scholarship_program_via'] }
        : null
    ))
    const result = await runAutopilot({
      url: 'https://hamilton-submit-fixture.invalid/apply',
      profile: {
        ...STUDENT_PROFILE_SHAPE,
        education: { intended_major: 'Forensic Science' },
      },
      authorizations: { ...FULL_AUTH, generate_narratives: true },
      allowAutoSubmit: true,
      fullAutomation: true,
      identityValues: { date_of_birth: '2006-05-14' },
      beforeSubmit: async () => ({ allow: true, reason: 'authorized', decision: {} }),
      headless: true,
      _testPage: page,
      answerUnknownField,
    })
    // The mis-claimed select was answered among the portal's OWN options (the
    // live DOM is the confirmation page post-submit, so read the run's filled
    // record, which survives)…
    const answered = (result.filled_fields || []).find((f) => /^q:Where did you hear/.test(String(f.key)))
    expect(answered?.value).toBe('Scholarship finder website')
    expect(answered?.source).toBe('llm_field_answer')
    // …recorded as an LLM answer that names the rule it was released from…
    const llm = (result.trace || []).find((t) => t.step === 'llm_field_answer'
      && /hear about our scholarship/i.test(String(t.detail?.label || '')))
    expect(llm?.detail?.misclaimed_rule).toBe('major')
    // …and the run submits instead of failing native validation forever.
    expect((result.trace || []).map((t) => t.step)).not.toContain('submit_native_validation_failed')
    expect(result.status).toBe('submitted')
  })

  it('landing on the form\'s OWN declared receipt page (retURL) after the click is confirmation evidence (the receipt-silent-portal class, 2026-08-23)', async () => {
    const FORM_URL = 'https://hamilton-submit-fixture.invalid/apply'
    const RECEIPT_URL = 'https://hamilton-submit-fixture.invalid/apply/thank-you.html'
    // The post-click page is BLAND — no acknowledgement text, no reference —
    // exactly what a web-to-lead retURL landing looks like.
    const page = makeJsdomPortalPage(
      `<!DOCTYPE html><html><head><title>Scholarship</title></head><body>
        <form id="application">
          <input type="hidden" name="retURL" value="${RECEIPT_URL}" />
          <label for="fn">First Name</label><input id="fn" name="first_name" type="text" required />
          <label for="em">Email</label><input id="em" name="email" type="email" required />
          <button type="submit">Submit and continue</button>
        </form>
      </body></html>`,
      { url: FORM_URL, confirmationHtml: '<h1>Community</h1><p>About our programs.</p>' },
    )
    let currentUrl = FORM_URL
    page.url = () => currentUrl
    const origWait = page.waitForLoadState
    page.waitForLoadState = async (...a) => {
      if (page._submitted()) {
        currentUrl = RECEIPT_URL
        // A real retURL landing carries no "submitted" banner — the helper's
        // default post-click title would trip the acknowledgement detector
        // and mask the declared-receipt path this test exists to pin.
        page._doc.title = 'Community'
      }
      return origWait(...a)
    }
    const result = await runAutopilot({
      url: FORM_URL,
      profile: STUDENT_PROFILE_SHAPE,
      authorizations: FULL_AUTH,
      allowAutoSubmit: true,
      fullAutomation: true,
      beforeSubmit: async () => ({ allow: true, reason: 'authorized', decision: {} }),
      headless: true,
      _testPage: page,
    })
    const steps = (result.trace || []).map((t) => t.step)
    expect(steps).toContain('declared_receipt_url')
    expect(result.status).toBe('submitted')
    expect(result.confirmation_evidence).toBe('declared_receipt_url')
  })

  it('bouncing back to the ORIGIN form BLANK with the declared receipt page never reached is a PROVABLE rejection — retry-safe, never quarantined (the expired-captcha class, 2026-08-23)', async () => {
    const FORM_URL = 'https://hamilton-submit-fixture.invalid/apply'
    const FORM_BODY = `
      <form id="application">
        <input type="hidden" name="retURL" value="https://hamilton-submit-fixture.invalid/apply/thank-you.html" />
        <label for="fn">First Name</label><input id="fn" name="first_name" type="text" required />
        <label for="em">Email</label><input id="em" name="email" type="email" required />
        <button type="submit">Submit and continue</button>
      </form>`
    // Post-click "confirmation" = the SAME form, re-rendered blank, same URL.
    const page = makeJsdomPortalPage(
      `<!DOCTYPE html><html><head><title>Scholarship</title></head><body>${FORM_BODY}</body></html>`,
      { url: FORM_URL, confirmationHtml: FORM_BODY },
    )
    const origWait = page.waitForLoadState
    page.waitForLoadState = async (...a) => {
      // A real rejection-bounce reloads the form page under its own title —
      // the helper's default post-click title would fabricate an
      // acknowledgement the portal never showed.
      if (page._submitted()) page._doc.title = 'Scholarship'
      return origWait(...a)
    }
    const result = await runAutopilot({
      url: FORM_URL,
      profile: STUDENT_PROFILE_SHAPE,
      authorizations: FULL_AUTH,
      allowAutoSubmit: true,
      fullAutomation: true,
      beforeSubmit: async () => ({ allow: true, reason: 'authorized', decision: {} }),
      headless: true,
      _testPage: page,
    })
    expect(result.status).toBe('blocked')
    expect(result.blocker_kind).toBe('submit_rejected_bounce')
    expect(result.provably_not_submitted).toBe(true)
    expect((result.trace || []).map((t) => t.step)).toContain('submit_rejected_bounce')
  })

  it('with a profile that declares NO enrollment, the eligibility boxes stay unticked and become named asks', async () => {
    const page = usBankPage()
    const result = await runAutopilot({
      url: 'https://hamilton-submit-fixture.invalid/apply',
      profile: {
        basic_information: {
          first_name: 'Jane', last_name: 'Applicant', email: 'jane@example.org', phone: '5555550100',
          address: '1 Main St\nNashville, TN 37201',
        },
      },
      authorizations: FULL_AUTH,
      allowAutoSubmit: true,
      fullAutomation: true,
      identityValues: { date_of_birth: '2006-05-14' },
      beforeSubmit: async () => ({ allow: true, reason: 'authorized', decision: {} }),
      headless: true,
      _testPage: page,
    })
    // Never a guess: the enrollment statements are NOT ticked…
    expect(page._doc.querySelector('#e3').checked).toBe(false)
    expect(page._doc.querySelector('#e4').checked).toBe(false)
    // …and the run names them as required questions the profile cannot answer.
    const asks = (result.unanswered_required_fields || []).map((u) => u.label)
    expect(asks.some((l) => /college-bound student/.test(l))).toBe(true)
    expect(asks.some((l) => /not a graduate student/.test(l))).toBe(true)
    expect((result.unanswered_required_fields || []).find((u) => /college-bound/.test(u.label))?.type).toBe('checkbox')
    expect(page._submitted()).toBe(false)
    expect(result.status).toBe('blocked')
  })
})
