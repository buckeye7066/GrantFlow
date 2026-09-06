/**
 * Round two of the 2026-09-06 own-portal run, measured in prod after #1580:
 * the engine followed the Students SSO hop to login.microsoftonline.com and
 * `login_result: false` fired within a second. Two causes, both pinned here:
 *   1. the classifier's copy of the registry entry dropped `idp_hosts`, so the
 *      vault credential carried no allowed IdP host and attemptLogin refused
 *      the Microsoft page on origin;
 *   2. Microsoft renders the password box in the DOM on the USERNAME step,
 *      hidden — attemptLogin took the one-step path, the hidden fill timed
 *      out, and "still a password box" read as a failed login.
 * Plus the sign-in page's own instruction ("Students: username@mtmail.mtsu.edu")
 * — a bare PipelineMT username is completed to that UPN.
 */
import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { classifyFundingSource } from '../services/hamilton/hamiltonAutomationClassifier.js'
import { ssoCredentialFromVault } from '../services/hamilton/hamiltonOwnPortalAccess.js'
import { _internal } from '../services/hamilton/hamiltonAutopilotEngine.js'

const { attemptLogin } = _internal

const mtsuStudent = { education: { current_institution: 'Middle Tennessee State University' } }
const dreamRow = { title: 'DREAM Scholarship', sponsor: 'Middle Tennessee State University', application_url: 'https://mtsu.edu/scholarships', application_mode: 'portal' }

describe('the resolved own-institution portal carries its IdP hosts and UPN domain', () => {
  it('classifyFundingSource → own_institution_portal has idp_hosts + sso_username_domain', () => {
    const c = classifyFundingSource({ opportunity: dreamRow, profile: mtsuStudent })
    expect(c.own_institution_portal?.portal_host).toBe('mtsu.scholarships.ngwebsolutions.com')
    expect(c.own_institution_portal?.idp_hosts).toContain('login.microsoftonline.com')
    expect(c.own_institution_portal?.idp_hosts).toContain('nextgensso.com')
    expect(c.own_institution_portal?.sso_username_domain).toBe('mtmail.mtsu.edu')
  })

  it('the vault credential built from that object allows the IdP hosts and completes a bare username to the UPN', () => {
    const c = classifyFundingSource({ opportunity: dreamRow, profile: mtsuStudent })
    const cred = ssoCredentialFromVault({ ownPortal: c.own_institution_portal, identityValues: { sso_username: 'jd2x', sso_password: 'pw' } })
    expect(cred.allowed_hosts).toEqual(expect.arrayContaining(['mtsu.scholarships.ngwebsolutions.com', 'nextgensso.com', 'login.microsoftonline.com']))
    expect(cred.username).toBe('jd2x@mtmail.mtsu.edu')
    const upn = ssoCredentialFromVault({ ownPortal: c.own_institution_portal, identityValues: { sso_username: 'jd2x@mtmail.mtsu.edu', sso_password: 'pw' } })
    expect(upn.username).toBe('jd2x@mtmail.mtsu.edu')
  })
})

// Minimal fake page whose handles report visibility (Playwright's isVisible).
function fakePage(html, { url, onSubmit }) {
  const dom = new JSDOM(html, { url })
  const doc = dom.window.document
  const wrap = (el) => el && ({
    isVisible: async () => el.getAttribute('data-hidden') !== '1',
    fill: async (v) => { if (el.getAttribute('data-hidden') === '1') throw new Error('fill: element is not visible'); el.value = String(v) },
    press: async () => {},
    click: async () => onSubmit(doc, el),
  })
  const q = (sel) => { try { return doc.querySelector(sel) } catch { return null } }
  return {
    url: () => url,
    waitForLoadState: async () => {},
    title: async () => doc.title,
    $: async (sel) => wrap(q(sel)),
    $$: async () => [],
    $$eval: async (sel, fn, arg) => fn(Array.from(doc.querySelectorAll(sel)), arg),
    $eval: async (sel, fn, arg) => fn(doc.querySelector(sel), arg),
    evaluate: async (fn, arg) => fn(arg),
    waitForSelector: async (sel) => { const el = q(sel); if (!el || el.getAttribute('data-hidden') === '1') return null; return wrap(el) },
  }
}

const MS_URL = 'https://login.microsoftonline.com/762ebf40-80b2-40ba-86fe-6dd409acb499/saml2?SAMLRequest=x'
// The live Microsoft username step: loginfmt visible, passwd present but hidden.
const MS_STEP1 = '<html><body><form><input type="email" name="loginfmt" id="i0116" /><input type="password" name="passwd" id="i0118" data-hidden="1" /><input type="submit" id="idSIButton9" value="Next" /></form><p>Students: username@mtmail.mtsu.edu</p></body></html>'

describe('attemptLogin on the live Microsoft shape', () => {
  const cred = ssoCredentialFromVault({
    ownPortal: classifyFundingSource({ opportunity: dreamRow, profile: mtsuStudent }).own_institution_portal,
    identityValues: { sso_username: 'jd2x', sso_password: 'pw-1' },
  })

  it('a HIDDEN password box is the username-first shape: username → Next → password → signed in', async () => {
    const typed = []
    const page = fakePage(MS_STEP1, {
      url: MS_URL,
      onSubmit: (doc, el) => {
        if (el.value === 'Next') {
          typed.push(doc.querySelector('input[name="loginfmt"]').value)
          doc.body.innerHTML = '<form><input type="password" name="passwd" id="i0118" /><input type="submit" id="idSIButton9" value="Sign in" /></form>'
        } else {
          typed.push(doc.querySelector('input[name="passwd"]').value)
          doc.body.innerHTML = '<h1>Scholarship Manager</h1><p>Welcome back.</p>'
        }
      },
    })
    expect(await attemptLogin(page, cred)).toBe(true)
    expect(typed).toEqual(['jd2x@mtmail.mtsu.edu', 'pw-1'])
  })

  it('without the registry IdP hosts the same page is refused on origin (the #1580 failure)', async () => {
    const page = fakePage(MS_STEP1, { url: MS_URL, onSubmit: () => {} })
    const bare = { username: 'jd2x@mtmail.mtsu.edu', password: 'pw-1', portal_host: 'mtsu.scholarships.ngwebsolutions.com' }
    expect(await attemptLogin(page, bare)).toBe(false)
  })
})

describe('attemptLoginDetailed says WHY a sign-in failed', () => {
  const { attemptLoginDetailed } = _internal
  const cred = ssoCredentialFromVault({
    ownPortal: classifyFundingSource({ opportunity: dreamRow, profile: mtsuStudent }).own_institution_portal,
    identityValues: { sso_username: 'jd2x', sso_password: 'pw-1' },
  })

  it('a rejected password carries the provider text', async () => {
    const page = fakePage('<html><body><form><input type="email" name="loginfmt" /><input type="password" name="passwd" /><input type="submit" id="idSIButton9" value="Sign in" /></form></body></html>', {
      url: MS_URL,
      onSubmit: (doc) => { doc.body.innerHTML = '<form><div id="passwordError">Your account or password is incorrect. If you don\'t remember your password, reset it now.</div><input type="password" name="passwd" /><input type="submit" id="idSIButton9" value="Sign in" /></form>' },
    })
    const v = await attemptLoginDetailed(page, cred)
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('password_rejected')
    expect(v.said).toMatch(/account or password is incorrect/i)
    expect(v.url).toBe(MS_URL)
  })

  it('an unknown username carries the provider text', async () => {
    const page = fakePage(MS_STEP1, {
      url: MS_URL,
      onSubmit: (doc) => { doc.body.innerHTML = '<form><div id="usernameError">We couldn\'t find an account with that username. Try another, or get a new Microsoft account.</div><input type="email" name="loginfmt" /><input type="submit" id="idSIButton9" value="Next" /></form>' },
    })
    const v = await attemptLoginDetailed(page, cred)
    expect(v).toMatchObject({ ok: false, reason: 'username_not_accepted' })
    expect(v.said).toMatch(/couldn't find an account/i)
  })

  it('a host outside the scope is origin_refused', async () => {
    const page = fakePage(MS_STEP1, { url: 'https://evil.example.net/login', onSubmit: () => {} })
    expect((await attemptLoginDetailed(page, cred)).reason).toBe('origin_refused')
  })
})
