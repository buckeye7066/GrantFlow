/**
 * Engine gate honesty — the false stops measured on a real full-automation
 * profile (prod, 2026-08-31, 75 "Needs you" cards) and the behaviour that
 * replaces each of them:
 *
 *   - `http://` saved links on PUBLIC funder sites were refused as "private,
 *     loopback, or unsafe" (aauw.org, nsf.gov, jkcf.org) → upgraded to https.
 *   - an INVISIBLE reCAPTCHA (v3 badge, Gravity Forms on mtsu.edu) was a wall
 *     at page-open, and the solver was sent a V2 task for a V3 key
 *     (ERROR_INVALID_TASK_DATA) → deferred to the submit boundary; v3 task.
 *   - captcha-NAMED markup with no solvable challenge parked five tasks → inert.
 *   - a credit union's online-banking password box was a "login wall" → an
 *     incidental widget on a content page is read past.
 *   - a Donate (Stripe) iframe on a scholarship listing was a "payment step" →
 *     payment needs a card field or a fee on the page, and names amount + URL.
 *   - "Execution context was destroyed" / "Download is starting" / a 25s
 *     timeout each killed a task → retried, routed to the document pathway,
 *     retried with a longer commit-only wait.
 *   - landing pages whose apply control is an anchor dead-ended → apply LINKS
 *     are followed.
 *   - a newsletter form's Submit was clicked as an "application" and then a
 *     human was asked to verify the portal → refused, degraded honestly.
 *
 * Every "no longer stops" assertion here fails on the pre-change engine.
 */
import { describe, it, expect, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { runAutopilot, _internal } from '../services/hamilton/hamiltonAutopilotEngine.js'
import {
  normalizeBrowserTargetUrl,
  isHamiltonBrowserTargetAllowed,
} from '../services/hamilton/controlledBetaBrowserPolicy.js'
import {
  readCaptchaChallenge,
  requestSolverToken,
  solverTaskPlans,
} from '../services/hamilton/hamiltonCaptchaSolver.js'
import { classifyBlocker } from '../services/hamilton/hamiltonBlockerClassifier.js'

const {
  detectGate, isIncidentalLoginWidget, readCaptchaShape, detectPaymentGate,
  retryOnContextLoss, navigateWithRecovery, DocumentDownloadTarget,
  detectApplyLinks, isContactOrNewsletterForm,
} = _internal

// ── jsdom-backed fake Playwright page (same accommodations as the e2e test) ──
function jsdomPage(html, { url = 'https://portal.example.org/apply', bodyTextLength = null } = {}) {
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
  if (bodyTextLength) {
    const filler = doc.createElement('p')
    filler.textContent = 'x'.repeat(bodyTextLength)
    doc.body.appendChild(filler)
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
      check: async () => { el.checked = true },
      selectOption: async () => {},
      setInputFiles: async () => {},
      press: async () => {},
      type: async (v) => { el.value = `${el.value || ''}${v}` },
      scrollIntoViewIfNeeded: async () => {},
      click: async () => {
        const type = (el.getAttribute('type') || '').toLowerCase()
        if (type === 'submit' || /submit/i.test(el.textContent || '')) {
          submitted = true
          doc.body.innerHTML = '<h1>Application submitted</h1><p>Thank you. Your confirmation number is GATE-CONF-9931.</p>'
          doc.title = 'Application submitted'
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
    _submitted: () => submitted,
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
const PROFILE = { basic_information: { first_name: 'Jane', last_name: 'Applicant', email: 'jane@example.org' } }

// ── E. public http:// links are upgraded, never refused ─────────────────────
describe('normalizeBrowserTargetUrl — public http:// saved links become https', () => {
  it.each([
    ['http://www.aauw.org/what-we-do/educational-funding-and-awards/international-fellowships/', 'https://www.aauw.org/what-we-do/educational-funding-and-awards/international-fellowships/'],
    ['http://www.nsf.gov/funding/pgm_summ.jsp?pims_id=506311', 'https://www.nsf.gov/funding/pgm_summ.jsp?pims_id=506311'],
    ['http://www.jkcf.org/our-scholarships/', 'https://www.jkcf.org/our-scholarships/'],
    ['http://www.blackjacksmill.com/index-4.html', 'https://www.blackjacksmill.com/index-4.html'],
  ])('%s → %s and the target is then allowed', (input, expected) => {
    expect(isHamiltonBrowserTargetAllowed(input)).toBe(false) // the old stop
    const out = normalizeBrowserTargetUrl(input)
    expect(out).toBe(expected)
    expect(isHamiltonBrowserTargetAllowed(out)).toBe(true)
  })
  it('never widens the SSRF floor: private / loopback / metadata hosts stay http and stay refused', () => {
    for (const u of ['http://127.0.0.1/admin', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data', 'http://localhost:3000/']) {
      expect(normalizeBrowserTargetUrl(u)).toBe(u)
      expect(isHamiltonBrowserTargetAllowed(normalizeBrowserTargetUrl(u))).toBe(false)
    }
  })
  it('leaves https, credentials-bearing, and non-URL input alone', () => {
    expect(normalizeBrowserTargetUrl('https://www.nsf.gov/x')).toBe('https://www.nsf.gov/x')
    expect(normalizeBrowserTargetUrl('http://user:pw@www.nsf.gov/x')).toBe('http://user:pw@www.nsf.gov/x')
    expect(normalizeBrowserTargetUrl('not a url')).toBe('not a url')
    expect(normalizeBrowserTargetUrl('')).toBe('')
  })
  it('runAutopilot upgrades the URL itself instead of returning controlled_beta_manual_handoff', async () => {
    const page = jsdomPage('<html><body><p>hello</p></body></html>')
    const result = await runAutopilot({
      url: 'http://www.jkcf.org/our-scholarships/', profile: PROFILE, authorizations: FULL_AUTH,
      allowAutoSubmit: false, _testPage: page,
    })
    expect(result.blocker_kind).not.toBe('controlled_beta_manual_handoff')
    expect((result.trace || []).find((t) => t.step === 'url_upgraded_to_https')?.detail?.to).toBe('https://www.jkcf.org/our-scholarships/')
  })
})

// ── D. invisible reCAPTCHA is not a wall; the solver gets the right task ─────
const V3_PAGE = `<!DOCTYPE html><html><head><title>Financial Aid</title>
  <script src="https://www.google.com/recaptcha/api.js?render=6Ld_9isqAAAAAJXHb5txPK8uiAkiOxFhYnkCbQ_Z&ver=2.2.2"></script></head>
  <body><h1>Non-traditional students</h1><p>Information about aid.</p>
  <form><label for="q">Question</label><input id="q" name="input_1" type="text" /><button type="submit">Submit</button></form>
  <div class="grecaptcha-badge" data-hidden="1"></div></body></html>`

describe('invisible reCAPTCHA (v3 / v2-invisible)', () => {
  it('readCaptchaChallenge reads a v3 render= key off the script tag and marks it v3 + invisible', async () => {
    const page = jsdomPage(V3_PAGE, { url: 'https://www.mtsu.edu/financial-aid/non-traditional/' })
    const ch = await readCaptchaChallenge(page)
    expect(ch).toMatchObject({ type: 'recaptcha', sitekey: '6Ld_9isqAAAAAJXHb5txPK8uiAkiOxFhYnkCbQ_Z', version: 'v3', invisible: true })
  })
  it('readCaptchaShape: badge-only page is invisible; a rendered checkbox widget is not', async () => {
    expect(await readCaptchaShape(jsdomPage(V3_PAGE))).toEqual({ invisible: true, visibleWidget: false })
    const checkbox = jsdomPage('<html><body><form><div class="g-recaptcha" data-sitekey="6Lc_visible"></div><button type="submit">Submit</button></form></body></html>')
    expect(await readCaptchaShape(checkbox)).toEqual({ invisible: false, visibleWidget: true })
  })
  it('detectGate reports the invisible shape instead of a plain captcha wall', async () => {
    const gate = await detectGate(jsdomPage(V3_PAGE))
    expect(gate.kind).toBe('captcha')
    expect(gate.invisible).toBe(true)
  })
  it('solverTaskPlans: v3 first for a v3 challenge, v2 first otherwise, enterprise variants, isInvisible for v2-invisible', () => {
    const v3 = solverTaskPlans({ type: 'recaptcha', sitekey: 'k', pageUrl: 'https://x', version: 'v3', invisible: true, action: 'submit' })
    expect(v3.map((p) => p.task.type)).toEqual(['ReCaptchaV3TaskProxyLess', 'ReCaptchaV2TaskProxyLess'])
    expect(v3[0].task.pageAction).toBe('submit')
    const v2 = solverTaskPlans({ type: 'recaptcha', sitekey: 'k', pageUrl: 'https://x', version: 'v2' })
    expect(v2.map((p) => p.task.type)).toEqual(['ReCaptchaV2TaskProxyLess', 'ReCaptchaV3TaskProxyLess'])
    const v2inv = solverTaskPlans({ type: 'recaptcha', sitekey: 'k', pageUrl: 'https://x', version: 'v2', invisible: true })
    expect(v2inv[0].task.isInvisible).toBe(true)
    const ent = solverTaskPlans({ type: 'recaptcha', sitekey: 'k', pageUrl: 'https://x', version: 'v3', enterprise: true })
    expect(ent[0].task.type).toBe('ReCaptchaV3EnterpriseTaskProxyLess')
    expect(solverTaskPlans({ type: 'hcaptcha', sitekey: 'k', pageUrl: 'https://x' }).map((p) => p.task.type)).toEqual(['HCaptchaTaskProxyLess'])
  })
  it('requestSolverToken retries with the alternate task shape on ERROR_INVALID_TASK_DATA — and only then', async () => {
    const created = []
    let polls = 0
    const fetchImpl = vi.fn(async (u, init) => {
      const body = JSON.parse(init.body)
      if (/createTask/.test(u)) { created.push(body.task.type); return { ok: true, json: async () => ({ taskId: `t${created.length}` }) } }
      polls += 1
      if (body.taskId === 't1') return { ok: true, json: async () => ({ errorId: 1, errorCode: 'ERROR_INVALID_TASK_DATA' }) }
      return { ok: true, json: async () => ({ status: 'ready', solution: { gRecaptchaResponse: 'tok-v3' } }) }
    })
    const env = { CAPTCHA_SOLVER_API_KEY: 'k', CAPTCHA_SOLVER_INTERVAL_MS: '1' }
    const out = await requestSolverToken({ type: 'recaptcha', sitekey: 'k', pageUrl: 'https://x', version: 'v2' }, { env, fetchImpl })
    expect(out.solved).toBe(true)
    expect(out.task_type).toBe('ReCaptchaV3TaskProxyLess')
    expect(created).toEqual(['ReCaptchaV2TaskProxyLess', 'ReCaptchaV3TaskProxyLess'])

    // A timeout is final: one task, no alternate.
    const created2 = []
    const fetch2 = vi.fn(async (u, init) => {
      const body = JSON.parse(init.body)
      if (/createTask/.test(u)) { created2.push(body.task.type); return { ok: true, json: async () => ({ taskId: 'a' }) } }
      return { ok: true, json: async () => ({ status: 'processing' }) }
    })
    const out2 = await requestSolverToken({ type: 'recaptcha', sitekey: 'k', pageUrl: 'https://x', version: 'v2' }, { env: { ...env, CAPTCHA_SOLVER_ATTEMPTS: '1' }, fetchImpl: fetch2 })
    expect(out2.solved).toBe(false)
    expect(out2.reason).toBe('solver_timed_out')
    expect(created2).toEqual(['ReCaptchaV2TaskProxyLess'])
    expect(polls).toBeGreaterThan(0)
  })
  it('runAutopilot reads past an invisible reCAPTCHA, fills the form, and solves at the submit boundary', async () => {
    const page = jsdomPage(`<!DOCTYPE html><html><head><title>Apply</title>
      <script src="https://www.google.com/recaptcha/api.js?render=6Ld_9isqAAAAAJXHb5txPK8uiAkiOxFhYnkCbQ_Z"></script></head>
      <body><form>
        <label for="fn">First name</label><input id="fn" name="first_name" type="text" required />
        <label for="ln">Last name</label><input id="ln" name="last_name" type="text" required />
        <label for="em">Email</label><input id="em" name="email" type="email" required />
        <label for="essay">Personal statement</label><textarea id="essay" name="personal_statement"></textarea>
        <label for="gpa">GPA</label><input id="gpa" name="gpa" type="text" />
        <button type="submit">Submit application</button>
      </form><div class="grecaptcha-badge" data-hidden="1"></div></body></html>`)
    const solveCaptcha = vi.fn(async () => ({ solved: true, vendor: 'recaptcha' }))
    const result = await runAutopilot({
      url: 'https://portal.example.org/apply', profile: PROFILE, authorizations: FULL_AUTH,
      allowAutoSubmit: true, fullAutomation: true, solveCaptcha,
      beforeSubmit: async () => ({ allow: true, reason: 'authorized', decision: {} }),
      _testPage: page,
    })
    const steps = (result.trace || []).map((t) => t.step)
    expect(steps).toContain('captcha_invisible_deferred')
    expect(steps).not.toContain('gate')
    expect(steps).toContain('captcha_refresh_attempt')
    expect(solveCaptcha).toHaveBeenCalledTimes(1) // at the boundary only
    expect(page._submitted()).toBe(true)
    expect(result.status).toBe('submitted')
  })
  it('captcha-named markup with NO solvable challenge is inert, not a wall', async () => {
    const page = jsdomPage(`<html><body><form>
        <label for="fn">First name</label><input id="fn" name="first_name" type="text" required />
        <label for="essay">Essay</label><textarea id="essay" name="essay"></textarea>
        <div class="fusion-form-recaptcha-field captcha-field"></div>
        <button type="submit">Submit application</button>
      </form></body></html>`)
    const solveCaptcha = vi.fn(async () => ({ solved: false, reason: 'no_solvable_challenge' }))
    const result = await runAutopilot({
      url: 'https://cfocoeeregion.com/giving/', profile: PROFILE, authorizations: FULL_AUTH,
      allowAutoSubmit: true, fullAutomation: true, solveCaptcha,
      beforeSubmit: async () => ({ allow: true, reason: 'authorized', decision: {} }),
      _testPage: page,
    })
    const steps = (result.trace || []).map((t) => t.step)
    expect(steps).toContain('captcha_inert')
    expect(result.blocker_kind).not.toBe('captcha')
    expect(page._submitted()).toBe(true)
  })
})

// ── C. an incidental password box is not a login wall ───────────────────────
describe('incidental login widget vs. login wall', () => {
  const BANK_HOME = `<html><head><title>TVFCU — Golf Classic Scholarship</title></head><body>
    <div class="ob-login"><form id="onlineBanking"><span>Online Banking</span>
      <input type="text" name="username" placeholder="Username" /><input type="password" id="password" name="password" placeholder="Password" />
      <button type="submit">Log In</button></form></div>
    <h1>TVFCU Golf Classic Scholarship</h1>
    <form id="apply"><label for="fn">First name</label><input id="fn" name="first_name" /><label for="essay">Essay</label><textarea id="essay" name="essay"></textarea><button type="submit">Submit application</button></form>
    </body></html>`
  it('detectGate reads past the online-banking box on a content page', async () => {
    const page = jsdomPage(BANK_HOME, { url: 'https://www.tvfcu.com/', bodyTextLength: 3500 })
    expect(await isIncidentalLoginWidget(page)).toBe(true)
    const gate = await detectGate(page)
    expect(gate?.kind).not.toBe('login')
  })
  it('a page that IS a login form is still a login gate', async () => {
    const page = jsdomPage('<html><head><title>Sign in</title></head><body><h1>Log in</h1><form><input type="text" name="user" /><input type="password" name="pass" /><button type="submit">Log in</button></form></body></html>', { url: 'https://portal.example.org/account' })
    expect(await isIncidentalLoginWidget(page)).toBe(false)
    expect((await detectGate(page))?.kind).toBe('login')
  })
  it('a /login URL is always a gate, whatever else is on the page', async () => {
    const page = jsdomPage(BANK_HOME, { url: 'https://www.tvfcu.com/login', bodyTextLength: 3500 })
    expect((await detectGate(page))?.kind).toBe('login')
  })
})

// ── K. payment: a Donate widget is not a fee; a real fee names amount + URL ──
describe('payment gate', () => {
  it('a bare Stripe iframe (donate widget) on a scholarship page is NOT a payment step', async () => {
    const page = jsdomPage('<html><body><h1>Bright Lite Scholarship</h1><p>Support students: donate today.</p><iframe src="https://js.stripe.com/v3/elements-inner-card"></iframe></body></html>', { url: 'https://bold.org/scholarships/bright-lite/' })
    expect(await detectPaymentGate(page, 'https://bold.org/scholarships/bright-lite/')).toBeNull()
    expect(await detectGate(page)).toBeNull()
  })
  it('a hosted checkout with a fee on the page IS a payment step, and the message carries amount + URL', async () => {
    const page = jsdomPage('<html><body><h1>Application</h1><p>A non-refundable application fee of $25.00 is due at checkout.</p><iframe src="https://js.stripe.com/v3/elements-inner-card"></iframe></body></html>')
    const gate = await detectGate(page)
    expect(gate.kind).toBe('payment')
    expect(gate.amount).toBe('$25.00')
    expect(gate.detail).toContain('https://portal.example.org/apply')
    expect(gate.detail).toContain('$25.00')
  })
  it('a card-number input is a payment step even without fee copy', async () => {
    const page = jsdomPage('<html><body><form><input autocomplete="cc-number" name="card" /></form></body></html>')
    expect((await detectGate(page))?.kind).toBe('payment')
  })
})

// ── I. robustness ───────────────────────────────────────────────────────────
describe('robustness: navigation races, slow hosts, file targets', () => {
  it('retryOnContextLoss retries an "Execution context was destroyed" race and rethrows anything else', async () => {
    const page = { waitForLoadState: vi.fn(async () => {}), isClosed: () => false }
    let n = 0
    const out = await retryOnContextLoss(page, async () => {
      n += 1
      if (n < 3) throw new Error('page.$$eval: Execution context was destroyed, most likely because of a navigation')
      return 'ok'
    }, { settleMs: 1 })
    expect(out).toBe('ok')
    expect(n).toBe(3)
    await expect(retryOnContextLoss(page, async () => { throw new Error('boom') }, { settleMs: 1 })).rejects.toThrow('boom')
    let m = 0
    await expect(retryOnContextLoss(page, async () => { m += 1; throw new Error('Execution context was destroyed') }, { attempts: 2, settleMs: 1 })).rejects.toThrow(/Execution context/)
    expect(m).toBe(2)
  })
  it('navigateWithRecovery: a timeout earns one longer commit-only retry', async () => {
    const calls = []
    const page = {
      goto: vi.fn(async (u, o) => { calls.push(o); if (calls.length === 1) throw new Error('page.goto: Timeout 25000ms exceeded.') }),
      waitForLoadState: vi.fn(async () => {}),
    }
    const trace = []
    const out = await navigateWithRecovery(page, 'https://www.jjpaf.org/', { navTimeoutMs: 25000, trace })
    expect(out.attempts).toBe(2)
    expect(calls[1]).toMatchObject({ waitUntil: 'commit', timeout: 50000 })
    expect(trace.find((t) => t.step === 'navigate_retry')).toBeTruthy()
  })
  it('navigateWithRecovery: a connection reset is NOT retried (portal_unreachable stays honest)', async () => {
    const page = { goto: vi.fn(async () => { throw new Error('page.goto: net::ERR_CONNECTION_RESET at https://www.tnpromise.gov/') }), waitForLoadState: vi.fn(async () => {}) }
    await expect(navigateWithRecovery(page, 'https://www.tnpromise.gov/', { navTimeoutMs: 100 })).rejects.toThrow(/ERR_CONNECTION_RESET/)
    expect(page.goto).toHaveBeenCalledTimes(1)
  })
  it('navigateWithRecovery: a file target (PDF url, or "Download is starting") is a DocumentDownloadTarget', async () => {
    const page = { goto: vi.fn(async () => { throw new Error('page.goto: Download is starting\nCall log:\n  - navigating to "https://x/form"') }), waitForLoadState: vi.fn(async () => {}) }
    await expect(navigateWithRecovery(page, 'https://x/form', { navTimeoutMs: 100 })).rejects.toBeInstanceOf(DocumentDownloadTarget)
    const page2 = { goto: vi.fn(async () => {}), waitForLoadState: vi.fn(async () => {}) }
    await expect(navigateWithRecovery(page2, 'https://www.ahfc.us/application/files/9016/3104/1530/Fact_Sheet.pdf', { navTimeoutMs: 100 })).rejects.toBeInstanceOf(DocumentDownloadTarget)
    expect(page2.goto).not.toHaveBeenCalled()
  })
  it('runAutopilot turns a file target into the document_download blocker (a pathway, not an engine failure)', async () => {
    const page = jsdomPage('<html><body></body></html>')
    page.goto = async () => { throw new Error('page.goto: Download is starting') }
    const result = await runAutopilot({
      url: 'https://www.ahfc.us/application/files/9016/3104/1530/Fact_Sheet.pdf', profile: PROFILE, authorizations: FULL_AUTH,
      allowAutoSubmit: false, _testPage: page,
    })
    expect(result.status).toBe('blocked')
    expect(result.blocker_kind).toBe('document_download')
    expect(result.document_url).toContain('Fact_Sheet.pdf')
    expect(classifyBlocker({ kind: 'document_download', text: result.blocker_detail }).category).toBe('document_download')
  })
})

// ── B. apply LINKS (anchors) are followed from landing pages ─────────────────
describe('apply-link discovery', () => {
  it('detectApplyLinks returns the real apply anchor and skips "how to apply" prose links', async () => {
    const page = jsdomPage(`<html><body>
      <a href="/how-to-apply">How to apply</a>
      <a href="https://apply.thegatesscholarship.org/">Apply Now</a>
      <a href="/faq">Application FAQ</a>
      <a href="/scholarship-application/">Scholarship application</a>
      <a href="mailto:x@y.org">Apply by email</a>
    </body></html>`, { url: 'https://www.thegatesscholarship.org/' })
    const links = await detectApplyLinks(page)
    const hrefs = links.map((l) => l.href)
    expect(hrefs[0]).toBe('https://apply.thegatesscholarship.org/')
    expect(hrefs).toContain('https://www.thegatesscholarship.org/scholarship-application/')
    expect(hrefs).not.toContain('https://www.thegatesscholarship.org/how-to-apply')
    expect(hrefs).not.toContain('https://www.thegatesscholarship.org/faq')
    expect(hrefs.some((h) => h.startsWith('mailto:'))).toBe(false)
  })
  it('runAutopilot follows the apply anchor from a landing page instead of dead-ending as no_application_form', async () => {
    const page = jsdomPage('<html><body><h1>Tennessee Promise</h1><p>Info.</p><a href="https://apply.tnachieves.org/student/apply">Apply Now</a></body></html>', { url: 'https://www.tnachieves.org/tn-promise' })
    const visited = []
    page.goto = async (u) => {
      visited.push(u)
      if (!/apply\.tnachieves\.org/.test(u)) return // the landing page itself
      page._doc.body.innerHTML = '<form><label for="fn">First name</label><input id="fn" name="first_name" /><label for="essay">Essay</label><textarea id="essay" name="essay"></textarea><button type="submit">Submit application</button></form>'
    }
    const result = await runAutopilot({
      url: 'https://www.tnachieves.org/tn-promise', profile: PROFILE, authorizations: FULL_AUTH,
      allowAutoSubmit: true, fullAutomation: true,
      beforeSubmit: async () => ({ allow: true, reason: 'authorized', decision: {} }),
      _testPage: page,
    })
    expect(visited).toContain('https://apply.tnachieves.org/student/apply')
    const follow = (result.trace || []).find((t) => t.step === 'follow_apply_link')
    expect(follow?.detail?.via).toBe('anchor')
    expect(result.blocker_kind).not.toBe('no_application_form')
    expect(page._submitted()).toBe(true)
  })
})

// ── G. a contact / newsletter form is never "the application" ───────────────
describe('contact / newsletter forms are refused at the submit boundary', () => {
  it('isContactOrNewsletterForm: flagged form with contact-only fields → true; application signals → false', () => {
    expect(isContactOrNewsletterForm({
      submitButton: { isContactForm: true, formFieldCount: 3 },
      fields: [{ label: 'First name' }, { label: 'Last name' }, { label: 'Email' }],
      filled: [{ key: 'first_name' }, { key: 'last_name' }, { key: 'email' }],
    })).toBe(true)
    expect(isContactOrNewsletterForm({
      submitButton: { isContactForm: false, formFieldCount: 3, text: 'Submit' },
      fields: [{ label: 'First name' }, { label: 'Email' }, { label: 'ZIP' }],
      filled: [{ key: 'first_name' }, { key: 'email' }],
      pageTitle: 'Family Promise of Bradley County',
    })).toBe(true)
    // A SHORT real application is never a newsletter: the button or the page says so.
    expect(isContactOrNewsletterForm({
      submitButton: { isContactForm: false, formFieldCount: 3, text: 'Submit application' },
      fields: [{ label: 'First name' }, { label: 'Last name' }, { label: 'Email' }],
      filled: [{ key: 'first_name' }, { key: 'last_name' }, { key: 'email' }],
      pageTitle: 'Application',
    })).toBe(false)
    expect(isContactOrNewsletterForm({
      submitButton: { isContactForm: true, formFieldCount: 3, text: 'Submit' },
      fields: [{ label: 'First name' }, { label: 'Last name' }, { label: 'Email' }],
      filled: [{ key: 'first_name' }, { key: 'last_name' }, { key: 'email' }],
      pageTitle: 'Scholarship Application',
    })).toBe(false)
    expect(isContactOrNewsletterForm({
      submitButton: { isContactForm: true, formFieldCount: 3 },
      fields: [{ label: 'First name' }, { label: 'Personal statement' }, { label: 'Email' }],
      filled: [{ key: 'first_name' }, { key: 'email' }],
    })).toBe(false)
    expect(isContactOrNewsletterForm({
      submitButton: { isContactForm: false, formFieldCount: 12 },
      fields: [{ label: 'First name' }, { label: 'Email' }],
      filled: [{ key: 'first_name' }, { key: 'email' }],
    })).toBe(false)
  })
  it('runAutopilot does NOT click Submit on a "stay informed" newsletter form (the seven prod submission_verification_required cards)', async () => {
    const page = jsdomPage(`<html><body><h1>Family Promise of Bradley County</h1><p>Helping families.</p>
      <form id="mc-embedded-subscribe-form" class="newsletter"><h3>Stay informed</h3>
        <label for="fn">First name</label><input id="fn" name="FNAME" type="text" />
        <label for="ln">Last name</label><input id="ln" name="LNAME" type="text" />
        <label for="em">Email</label><input id="em" name="EMAIL" type="email" />
        <button type="submit">Submit</button></form></body></html>`, { url: 'https://www.familypromisebradleytn.org/' })
    const beforeSubmit = vi.fn(async () => ({ allow: true, reason: 'authorized', decision: {} }))
    const result = await runAutopilot({
      url: 'https://www.familypromisebradleytn.org/', profile: PROFILE, authorizations: FULL_AUTH,
      allowAutoSubmit: true, fullAutomation: true, beforeSubmit, _testPage: page,
    })
    expect(page._submitted()).toBe(false)
    expect(beforeSubmit).not.toHaveBeenCalled()
    expect(result.status).toBe('blocked')
    expect(result.blocker_kind).toBe('no_application_form')
    expect((result.trace || []).some((t) => t.step === 'contact_form_not_application')).toBe(true)
  })
})
