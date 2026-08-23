/**
 * REAL-BROWSER verification of the portal signup adapter.
 *
 * The rest of the signup suite drives genericSignupAdapter against a FAKE page,
 * so the actual Playwright selector/fill/submit/classify logic had never touched
 * a real DOM — which is exactly the "account setup is deploy-but-unverified"
 * gap. This test launches a real headless Chromium, loads a realistic signup
 * form via setContent, and proves end-to-end that:
 *   - the adapter FINDS and FILLS the real form fields with Hamilton's identity
 *     (the applicant's name + Hamilton's own email/phone), and the values really
 *     land in the inputs (the success page echoes them back);
 *   - a genuine post-submit success is classified 'registered';
 *   - a CAPTCHA on the form is caught as a hard blocker and NEVER fabricated into
 *     a success (the honesty rail);
 *   - an "email already registered" page is classified 'already_exists'.
 *
 * It is NOT a specific live portal (I have no prod access), but it exercises the
 * real browser + real DOM path that the fake-page tests cannot.
 *
 * Skips gracefully if the Playwright chromium binary is not installed, so a
 * browserless CI runner is never reddened by it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import { genericSignupAdapter, buildSignupIdentity } from '../services/hamilton/hamiltonPortalSignupAdapter.js'
import { CHROMIUM_CONTAINER_ARGS } from '../services/hamilton/browserLaunch.js'

let chromium = null
let browserBinaryPresent = false
try {
  ({ chromium } = await import('playwright'))
  const exe = chromium.executablePath?.()
  browserBinaryPresent = Boolean(exe && fs.existsSync(exe))
} catch { browserBinaryPresent = false }

const run = browserBinaryPresent ? describe : describe.skip

// A realistic signup form. On submit it validates the fields are non-empty and,
// if so, replaces the body with a success page that ECHOES the submitted email +
// name — so a 'registered' result proves the adapter actually filled them.
const SIGNUP_FORM = `
  <form id="signup" onsubmit="return handle(event)">
    <input type="email" name="email" autocomplete="email" />
    <input type="password" name="password" autocomplete="new-password" />
    <input type="password" name="confirm_password" />
    <input type="text" name="first_name" autocomplete="given-name" />
    <input type="text" name="last_name" autocomplete="family-name" />
    <input type="tel" name="phone" />
    <button type="submit">Create account</button>
  </form>
  <script>
    function handle(e){
      e.preventDefault();
      var f=document.forms['signup'];
      var email=f.email.value, pw=f.password.value, fn=f.first_name.value, ln=f.last_name.value, ph=f.phone.value;
      if(email && pw && fn && ln){
        document.body.innerHTML='<h1>Account created</h1><p>Welcome, <span id="who">'+fn+' '+ln+'</span> ('+email+', '+ph+')</p>';
      } else {
        document.body.innerHTML+='<div class="error" role="alert">All fields are required</div>';
      }
      return false;
    }
  </script>`

let browser
beforeAll(async () => { if (browserBinaryPresent) browser = await chromium.launch({ headless: true, args: [...CHROMIUM_CONTAINER_ARGS] }) }, 60_000)
afterAll(async () => { await browser?.close?.() })

async function pageWith(html) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.setContent(`<!DOCTYPE html><html><body>${html}</body></html>`, { waitUntil: 'domcontentloaded' })
  return page
}

run('genericSignupAdapter against a real headless browser', () => {
  const identity = buildSignupIdentity({
    profile: { first_name: 'Jordan', last_name: 'Rivera' },
    identityEmail: 'Hamilton@axiombiolabs.org',
    password: 'Fixture-Pw-Not-A-Secret-123',
  })

  it('fills the real form with Hamilton\'s identity and classifies a genuine success as registered', async () => {
    const page = await pageWith(SIGNUP_FORM)
    const res = await genericSignupAdapter(page, { ...identity, phone: '423-504-7778' }, {})
    expect(res.status).toBe('registered')
    // The success page echoes what the adapter actually typed — proof the fill
    // landed in the real inputs, not just that a code path returned "registered".
    const body = await page.evaluate(() => document.body.innerText)
    expect(body).toContain('Jordan Rivera')
    expect(body).toContain('Hamilton@axiombiolabs.org')
    await page.context().close()
  })

  it('NEVER fabricates success when a CAPTCHA guards the form (honesty rail)', async () => {
    const page = await pageWith(`<div class="g-recaptcha" data-sitekey="x"></div>${SIGNUP_FORM}`)
    const res = await genericSignupAdapter(page, identity, {})
    expect(res.status).toBe('blocked')
    expect(res.blocker_kind || res.blockerType).toMatch(/captcha/i)
    await page.context().close()
  })

  it('classifies an already-registered email as already_exists (never a new duplicate)', async () => {
    // A form whose submit reports the email is taken.
    const takenForm = SIGNUP_FORM.replace(
      "document.body.innerHTML='<h1>Account created</h1><p>Welcome, <span id=\"who\">'+fn+' '+ln+'</span> ('+email+', '+ph+')</p>';",
      "document.body.innerHTML='<h1>Sign up</h1><p class=\"error\">An account with this email already exists.</p>';",
    )
    const page = await pageWith(takenForm)
    const res = await genericSignupAdapter(page, identity, {})
    expect(res.status).toBe('already_exists')
    await page.context().close()
  })

  it('hands off (never claims success) when the form persists after submit', async () => {
    // A form that ignores submit entirely — the password field stays on screen.
    const stuckForm = `
      <form id="signup"><input type="email" name="email" />
      <input type="password" name="password" autocomplete="new-password" />
      <input type="text" name="first_name" /><input type="text" name="last_name" />
      <button type="submit" onclick="return false">Create account</button></form>`
    const page = await pageWith(stuckForm)
    const res = await genericSignupAdapter(page, identity, {})
    expect(res.status).toBe('blocked') // no_progress → side-by-side handoff, not a fake success
    await page.context().close()
  })
})
