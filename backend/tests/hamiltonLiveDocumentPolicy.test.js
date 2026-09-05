/**
 * Live top-level document revalidation (ported from #1520, 2026-09-05).
 *
 * The engine re-checks the page it is actually ON — not the launch url — right
 * before applicant data is disclosed: before the first fill on a page, before
 * a document upload, and before the submit click. The orchestrator answers
 * through `validatePortalUrl` from the per-host portal policy registry, and
 * the submit boundary receives the live url.
 *
 * Drives the REAL runAutopilot against a jsdom page (the `_testPage` seam), so
 * what is proven is the engine's own control flow, not a mock of it.
 */
import { describe, it, expect, vi } from 'vitest'
import { runAutopilot } from '../services/hamilton/hamiltonAutopilotEngine.js'
import { makeJsdomPortalPage } from './helpers/jsdomPortalPage.js'

const FORM = `<!DOCTYPE html><html><head><title>Apply</title></head><body>
  <h1>Scholarship application</h1>
  <form>
    <label for="fn">First name</label><input id="fn" name="first_name" type="text" required />
    <label for="ln">Last name</label><input id="ln" name="last_name" type="text" required />
    <label for="em">Email</label><input id="em" name="email" type="email" required />
    <button type="submit">Submit application</button>
  </form>
</body></html>`

const PROFILE = { basic_information: { first_name: 'Jane', last_name: 'Applicant', email: 'jane@example.org' } }
const FULL_AUTH = {
  submit_applications: true, complete_forms: true, generate_narratives: false,
  upload_documents: false, use_standing_attestation: true, use_saved_session: true,
}

describe('runAutopilot — live document policy hook', () => {
  it('refuses to fill when the live host is policy-forbidden: nothing typed, nothing submitted', async () => {
    const page = makeJsdomPortalPage(FORM, { url: 'https://studentaid.gov/apply' })
    const validatePortalUrl = vi.fn(async (liveUrl) => ({
      allow: false, reason: `portal_terms_forbid_automation:${new URL(liveUrl).hostname}`,
    }))
    const beforeSubmit = vi.fn(async () => ({ allow: true, reason: 'authorized', decision: {} }))
    const result = await runAutopilot({
      url: 'https://studentaid.gov/apply', profile: PROFILE, authorizations: FULL_AUTH,
      allowAutoSubmit: true, fullAutomation: true, validatePortalUrl, beforeSubmit, _testPage: page,
    })
    expect(result.status).toBe('blocked')
    expect(result.blocker_kind).toBe('portal_policy_block')
    expect(result.blocker_detail).toContain('portal_terms_forbid_automation:studentaid.gov')
    expect(result.filled_fields).toEqual([])
    expect(page._submitted()).toBe(false)
    expect(beforeSubmit).not.toHaveBeenCalled()
    expect(validatePortalUrl).toHaveBeenCalledWith('https://studentaid.gov/apply', { stage: 'before_fill' })
    const block = (result.trace || []).find((t) => t.step === 'portal_policy_block')
    expect(block?.detail).toMatchObject({ stage: 'before_fill', url: 'https://studentaid.gov/apply' })
  })

  it('a hook that throws is a refusal, never a crashed run', async () => {
    const page = makeJsdomPortalPage(FORM, { url: 'https://portal.example.org/apply' })
    const result = await runAutopilot({
      url: 'https://portal.example.org/apply', profile: PROFILE, authorizations: FULL_AUTH,
      allowAutoSubmit: true, fullAutomation: true,
      validatePortalUrl: async () => { throw new Error('registry offline') },
      beforeSubmit: async () => ({ allow: true, reason: 'authorized', decision: {} }),
      _testPage: page,
    })
    expect(result.status).toBe('blocked')
    expect(result.blocker_kind).toBe('portal_policy_block')
    expect(result.blocker_detail).toContain('portal_policy_error:registry offline')
    expect(page._submitted()).toBe(false)
  })

  it('an allowing hook lets a real public portal fill and submit; the submit boundary gets the LIVE url', async () => {
    const page = makeJsdomPortalPage(FORM, { url: 'https://portal.example.org/apply' })
    const validatePortalUrl = vi.fn(async () => ({ allow: true }))
    const beforeSubmit = vi.fn(async () => ({ allow: true, reason: 'authorized', decision: {} }))
    const result = await runAutopilot({
      url: 'https://portal.example.org/apply', profile: PROFILE, authorizations: FULL_AUTH,
      allowAutoSubmit: true, fullAutomation: true, validatePortalUrl, beforeSubmit, _testPage: page,
    })
    expect(result.status).toBe('submitted')
    expect(page._submitted()).toBe(true)
    expect(result.filled_fields.map((f) => f.key)).toEqual(expect.arrayContaining(['first_name', 'last_name', 'email']))
    const stages = validatePortalUrl.mock.calls.map(([, opts]) => opts.stage)
    expect(stages).toContain('before_fill')
    expect(stages).toContain('before_submit')
    expect(beforeSubmit).toHaveBeenCalledWith({ url: 'https://portal.example.org/apply' })
  })

  it('without a hook the engine behaves exactly as before (public portal proceeds)', async () => {
    const page = makeJsdomPortalPage(FORM, { url: 'https://portal.example.org/apply' })
    const result = await runAutopilot({
      url: 'https://portal.example.org/apply', profile: PROFILE, authorizations: FULL_AUTH,
      allowAutoSubmit: true, fullAutomation: true,
      beforeSubmit: async () => ({ allow: true, reason: 'authorized', decision: {} }),
      _testPage: page,
    })
    expect(result.status).toBe('submitted')
    expect((result.trace || []).some((t) => t.step === 'portal_policy_block')).toBe(false)
  })
})
