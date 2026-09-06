/**
 * A SCHOOL PORTAL'S SIGN-IN IS REACHED, NOT MISTAKEN FOR AN EMPTY PAGE
 * (prod 2026-09-06, Anastasia's MTSU tasks). Live trace on
 * mtsu.scholarships.ngwebsolutions.com with the PipelineMT SSO pair in the
 * vault: page → inspect `field_count 0, button_options ["Continue Working"]`
 * → fill 0 → (clicked "Continue Working" as Next) → page → inspect → fill 0 →
 * `no_application_form: next_without_fields`. The landing page's real way
 * forward is its "Students" button, a SAML hop (nextgensso.com) into MTSU's
 * Microsoft tenant, whose first page asks for the USERNAME with no password
 * field — invisible to the password-only login heuristic.
 */
import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { runAutopilot, _internal } from '../services/hamilton/hamiltonAutopilotEngine.js'
import { ssoCredentialFromVault } from '../services/hamilton/hamiltonOwnPortalAccess.js'
import { resolveInstitutionScholarshipPortal } from '../config/institutionScholarshipPortals.js'

const { detectGate, attemptLogin, detectSsoEntryLinks, detectIdpLoginSurface, NEXT_BUTTON_EXCLUDE_RX } = _internal

// ── jsdom-backed fake Playwright page (same accommodations as the gate-honesty test) ──
function jsdomPage(html, { url = 'https://portal.example.org/apply', onSubmit = null } = {}) {
  const dom = new JSDOM(html, { url })
  const { window } = dom
  const doc = window.document
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.getAttribute && this.getAttribute('data-hidden') === '1') return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 }
    return { width: 160, height: 24, top: 0, left: 0, right: 160, bottom: 24, x: 0, y: 0 }
  }
  if (!Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'innerText')) {
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
      configurable: true,
      get() { return this.textContent },
      set(v) { this.textContent = v },
    })
  }
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
      fill: async (v) => { el.value = String(v); el.dispatchEvent(new window.Event('input', { bubbles: true })) },
      check: async () => { el.checked = true },
      selectOption: async () => {},
      setInputFiles: async () => {},
      press: async () => {},
      type: async (v) => { el.value = `${el.value || ''}${v}` },
      scrollIntoViewIfNeeded: async () => {},
      click: async () => {
        const type = (el.getAttribute('type') || '').toLowerCase()
        if ((type === 'submit' || /submit|next|sign in|yes/i.test(el.textContent || el.value || '')) && typeof onSubmit === 'function') {
          onSubmit(doc, el)
        } else {
          el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        }
      },
    }
  }
  const q = (sel) => {
    try { return doc.querySelector(sel) } catch {
      for (const part of String(sel).split(',')) {
        try { const e = doc.querySelector(part.trim()); if (e) return e } catch { /* skip */ }
      }
      return null
    }
  }
  const page = {
    _doc: doc,
    url: () => url,
    content: async () => doc.documentElement.outerHTML,
    title: async () => doc.title,
    goto: async () => {},
    isClosed: () => false,
    waitForLoadState: async () => {},
    waitForNavigation: async () => {},
    waitForTimeout: async () => {},
    screenshot: async () => Buffer.from('PNG'),
    locator: (sel) => ({
      count: async () => { try { return doc.querySelectorAll(sel).length } catch { return 0 } },
      first: () => ({ click: async () => {} }),
      innerText: async () => { const el = q(sel); return el ? (el.textContent || '') : '' },
    }),
    $: async (sel) => wrapHandle(q(sel)),
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
  submit_applications: true, complete_forms: true, generate_narratives: true,
  upload_documents: true, use_standing_attestation: true, use_saved_session: true,
  use_saved_credentials_reference: true,
}
const PROFILE = { basic_information: { first_name: 'Anastasia', last_name: 'White', email: 'student@example.org' } }

// The live NGWeb landing (mtsu.scholarships.ngwebsolutions.com, 2026-09-06),
// reduced to the controls that matter: a Students SSO link, an ADMIN SSO link,
// and the session-timeout "Continue Working" button.
const NGWEB_LANDING = `<!DOCTYPE html><html><head><title>Scholarship Manager</title></head><body>
  <form name="aspnetForm" method="post" action="./Cmx_Content.aspx?cpId=1276" id="aspnetForm">
    <h1>Welcome to the MTSU Scholarship Manager</h1>
    <p>Students: use your PipelineMT login to apply. One General Application covers every scholarship.</p>
    <a class="btn btn-primary" id="StudentsButton" href="https://nextgensso.com/sp/startSSO.ping?SpSessionAuthnAdapterId=mtsuScholarSP&amp;TargetResource=https://mtsu.scholarships.ngwebsolutions.com/scholarx_studentlanding.aspx">Students</a>
    <a class="btn" href="https://nextgensso.com/sp/startSSO.ping?SpSessionAuthnAdapterId=mtsuScholarSP&amp;TargetResource=https://mtsu.scholarships.ngwebsolutions.com/scholarx_adminportal.aspx">Administrators</a>
    <input id="ngSessionTimeoutButton" type="button" class="btn btn-sm btn-primary" value="Continue Working" onclick="location.reload();" />
  </form></body></html>`
const NGWEB_URL = 'https://mtsu.scholarships.ngwebsolutions.com/CMXAdmin/Cmx_Content.aspx?cpId=1276'

const mtsu = resolveInstitutionScholarshipPortal('Middle Tennessee State University')
const SSO_CRED = ssoCredentialFromVault({ ownPortal: mtsu, identityValues: { sso_username: 'aw2x@mtmail.mtsu.edu', sso_password: 'pw' } })

describe('the NGWeb landing page', () => {
  it('detectSsoEntryLinks finds the Students SSO hop first and refuses the admin one', async () => {
    const links = await detectSsoEntryLinks(jsdomPage(NGWEB_LANDING, { url: NGWEB_URL }))
    expect(links.length).toBe(1)
    expect(links[0].text).toBe('Students')
    expect(links[0].href).toMatch(/nextgensso\.com\/sp\/startSSO\.ping/)
    expect(links[0].href).toMatch(/scholarx_studentlanding/)
  })

  it('"Continue Working" is a session-timeout dismissal, never a Next button', () => {
    expect(NEXT_BUTTON_EXCLUDE_RX.test('Continue Working')).toBe(true)
    expect(NEXT_BUTTON_EXCLUDE_RX.test('Stay signed in')).toBe(true)
    expect(NEXT_BUTTON_EXCLUDE_RX.test('Continue')).toBe(false)
    expect(NEXT_BUTTON_EXCLUDE_RX.test('Save & Continue')).toBe(false)
  })

  it('with the vault SSO pair in hand, runAutopilot follows the Students entry instead of clicking Continue Working', async () => {
    const page = jsdomPage(NGWEB_LANDING, { url: NGWEB_URL })
    const result = await runAutopilot({
      url: NGWEB_URL, profile: PROFILE, authorizations: FULL_AUTH, allowAutoSubmit: false,
      loginCredential: SSO_CRED, _testPage: page,
    })
    const steps = (result.trace || []).map((t) => t.step)
    const follow = (result.trace || []).find((t) => t.step === 'sso_entry_follow')
    expect(follow?.detail?.href).toMatch(/startSSO/)
    expect(follow?.detail?.text).toBe('Students')
    // The old failure: two blind "Next" clicks on Continue Working, then next_without_fields.
    expect(steps).not.toContain('validation_after_next')
    expect((result.trace || []).find((t) => t.step === 'no_application_form')?.detail?.reason).not.toBe('next_without_fields')
  })

  it('with NO login in hand the entry is not followed and the page is honestly form-less on ONE visit', async () => {
    const page = jsdomPage(NGWEB_LANDING, { url: NGWEB_URL })
    const result = await runAutopilot({
      url: NGWEB_URL, profile: PROFILE, authorizations: FULL_AUTH, allowAutoSubmit: false, _testPage: page,
    })
    const steps = (result.trace || []).map((t) => t.step)
    expect(steps).not.toContain('sso_entry_follow')
    expect(result.pages_visited).toBe(1)
    expect(['no_application_form', 'listing_page', 'no_progress']).toContain(result.blocker_kind)
  })
})

describe('identity-provider pages are login / 2FA gates', () => {
  const MS_USERNAME_PAGE = `<html><head><title>Sign in to your account</title></head><body>
    <form><input type="email" name="loginfmt" id="i0116" placeholder="Email, phone, or Skype" />
    <input type="submit" id="idSIButton9" value="Next" /></form></body></html>`
  const MS_URL = 'https://login.microsoftonline.com/762ebf40-80b2-40ba-86fe-6dd409acb499/saml2?SAMLRequest=abc'

  it('a username-first Microsoft page (no password field) is a login gate', async () => {
    const page = jsdomPage(MS_USERNAME_PAGE, { url: MS_URL })
    expect(await detectIdpLoginSurface(page, MS_URL)).toBe(true)
    const gate = await detectGate(page)
    expect(gate).toMatchObject({ kind: 'login', idp: true })
  })

  it('a Microsoft one-time-code page (name="otc") and a push-approval prompt are 2FA gates', async () => {
    const otc = jsdomPage('<html><body><form><input name="otc" id="idTxtBx_SAOTCC_OTC" /><input type="submit" value="Verify" /></form></body></html>', { url: 'https://login.microsoftonline.com/common/login' })
    expect((await detectGate(otc))?.kind).toBe('2fa')
    const push = jsdomPage('<html><body><h1>Approve sign in request</h1><p>Open your Authenticator app, and enter the number shown to sign in.</p></body></html>', { url: 'https://login.microsoftonline.com/common/login' })
    expect((await detectGate(push))?.kind).toBe('2fa')
  })

  it('the same username-first shape on an ordinary funder host is NOT a login gate (a newsletter box is not a wall)', async () => {
    const page = jsdomPage('<html><body><p>Scholarship info</p><form><input type="email" name="email" /><input type="submit" value="Subscribe" /></form></body></html>', { url: 'https://funder.org/scholarship' })
    expect(await detectIdpLoginSurface(page, 'https://funder.org/scholarship')).toBe(false)
    expect(await detectGate(page)).toBeNull()
  })
})

describe('attemptLogin with the school SSO pair', () => {
  const ONE_STEP = `<html><body><form><input type="email" name="loginfmt" /><input type="password" name="passwd" /><input type="submit" id="idSIButton9" value="Sign in" /></form></body></html>`

  it('types the vault pair on a registry-declared IdP host and reports success once no password box remains', async () => {
    const page = jsdomPage(ONE_STEP, {
      url: 'https://login.microsoftonline.com/tenant/saml2',
      onSubmit: (doc) => { doc.body.innerHTML = '<h1>Scholarship Manager</h1><p>Welcome, Anastasia. Qualified Opportunities 0.</p>' },
    })
    expect(SSO_CRED.allowed_hosts).toContain('login.microsoftonline.com')
    expect(await attemptLogin(page, SSO_CRED)).toBe(true)
  })

  it('username-first: submits the username, then the password once it appears', async () => {
    const page = jsdomPage(`<html><body><form><input type="email" name="loginfmt" /><input type="submit" id="idSIButton9" value="Next" /></form></body></html>`, {
      url: 'https://login.microsoftonline.com/tenant/saml2',
      onSubmit: (doc, el) => {
        if (el.value === 'Next') {
          doc.body.innerHTML = '<form><input type="password" name="passwd" /><input type="submit" id="idSIButton9" value="Sign in" /></form>'
        } else {
          doc.body.innerHTML = '<h1>Scholarship Manager</h1><p>Welcome back.</p>'
        }
      },
    })
    expect(await attemptLogin(page, SSO_CRED)).toBe(true)
  })

  it('a multi-factor prompt after the password is NOT a completed login', async () => {
    const page = jsdomPage(ONE_STEP, {
      url: 'https://login.microsoftonline.com/tenant/saml2',
      onSubmit: (doc) => { doc.body.innerHTML = '<h1>Approve sign in request</h1><p>Open your Authenticator app and enter the number shown.</p>' },
    })
    expect(await attemptLogin(page, SSO_CRED)).toBe(false)
  })

  it('the pair is NEVER typed on a host outside the portal + its declared IdPs', async () => {
    const page = jsdomPage(ONE_STEP, { url: 'https://evil.example.net/login', onSubmit: (doc) => { doc.body.innerHTML = '<h1>Signed in</h1>' } })
    expect(await attemptLogin(page, SSO_CRED)).toBe(false)
    expect(page._doc.querySelector('input[name="loginfmt"]').value).toBe('')
  })
})
